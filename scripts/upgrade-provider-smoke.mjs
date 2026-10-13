import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer as createViteServer } from "vite";

const CANONICAL_ORIGIN = "http://127.0.0.1:5173";
const RUN_WAIT_TIMEOUT_MS = 75_000;
const LOCAL_REQUEST_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 400;
const START_LOCATION_ID = "loc:prontera";
const DESTINATION_LOCATION_ID = "loc:morroc";
const DESTINATION_NPC_ID = "npc:morroc_guard";
const MOVEMENT_ACTION = "Aku berangkat ke Morroc.";
const PROVIDERS = [
  { provider: "gemini", model: "gemini-2.5-flash" },
  { provider: "openrouter", model: "google/gemini-3.8-flash" },
];

class SmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function safeMessage(value) {
  return String(value ?? "Smoke step failed.")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]")
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(
      /\b(api[-_ ]?key|authorization|token)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function toError(error) {
  if (!(error instanceof SmokeError)) {
    return { code: "SMOKE_ERROR", message: "Provider smoke step failed." };
  }
  return {
    code: error.code.replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80),
    message: safeMessage(error.message),
  };
}

async function api(
  base,
  path,
  { method = "GET", body, timeoutMs = LOCAL_REQUEST_TIMEOUT_MS } = {},
) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: CANONICAL_ORIGIN,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SmokeError(
      error?.name === "TimeoutError" ? "LOCAL_API_TIMEOUT" : "LOCAL_API_ERROR",
      "Local smoke API request failed.",
    );
  }

  if (response.status === 204) return undefined;
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new SmokeError(
      "LOCAL_API_INVALID_RESPONSE",
      "Local smoke API returned invalid JSON.",
    );
  }
  if (!response.ok) {
    throw new SmokeError(
      typeof payload?.code === "string" ? payload.code : "LOCAL_API_ERROR",
      typeof payload?.message === "string"
        ? payload.message
        : "Local smoke API request failed.",
    );
  }
  return payload;
}

async function loadJson(url, label) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    throw new SmokeError(
      "FIXTURE_LOAD_FAILED",
      `${label} could not be loaded or parsed.`,
    );
  }
}

function validateFixture(fixture, pack) {
  const definition = fixture?.definition;
  if (
    !definition ||
    typeof definition !== "object" ||
    !Array.isArray(definition.npcs)
  ) {
    throw new SmokeError(
      "UNSUPPORTED_FIXTURE",
      "The original Ragnarok fixture is missing its game definition or NPCs.",
    );
  }
  if (
    definition.worldMap !== undefined ||
    definition.lorebookRefs !== undefined
  ) {
    throw new SmokeError(
      "UNSUPPORTED_FIXTURE",
      "The original Ragnarok fixture already contains world bindings; this smoke expects the curated pack to provide them.",
    );
  }
  if (!definition.npcs.some((npc) => npc.id === DESTINATION_NPC_ID)) {
    throw new SmokeError(
      "UNSUPPORTED_FIXTURE",
      `The original Ragnarok fixture does not define ${DESTINATION_NPC_ID}.`,
    );
  }
  if (
    pack?.format !== "fworld-lorebook" ||
    typeof pack.pack?.id !== "string" ||
    !Number.isSafeInteger(pack.pack.version) ||
    !Array.isArray(pack.entries) ||
    !Array.isArray(pack.links)
  ) {
    throw new SmokeError(
      "UNSUPPORTED_FIXTURE",
      "The curated Prontera lorebook does not have the supported pack shape.",
    );
  }

  const locations = new Set(
    pack.entries
      .filter((entry) => entry.kind === "location")
      .map((entry) => entry.id),
  );
  const hasConnection = pack.links.some(
    (link) =>
      link.relation === "CONNECTED_TO" &&
      ((link.fromId === START_LOCATION_ID &&
        link.toId === DESTINATION_LOCATION_ID) ||
        (link.fromId === DESTINATION_LOCATION_ID &&
          link.toId === START_LOCATION_ID)),
  );
  const mappedNpc = pack.entries.find(
    (entry) => entry.metadata?.actorId === DESTINATION_NPC_ID,
  );
  const hasLocalNpc = pack.links.some(
    (link) =>
      link.relation === "PRESENT_AT" &&
      link.fromId === mappedNpc?.id &&
      link.toId === DESTINATION_LOCATION_ID,
  );
  if (
    !locations.has(START_LOCATION_ID) ||
    !locations.has(DESTINATION_LOCATION_ID) ||
    !hasConnection ||
    !hasLocalNpc
  ) {
    throw new SmokeError(
      "UNSUPPORTED_FIXTURE",
      "The curated lorebook must connect Prontera to Morroc and place the fixture's Morroc guard there.",
    );
  }
}

function versionedSession(record) {
  if (
    !record?.value ||
    !Number.isSafeInteger(record.revision) ||
    !record.value.state?.world
  ) {
    throw new SmokeError(
      "SESSION_READBACK_INVALID",
      "Session API did not return a versioned session with world state.",
    );
  }
  return record;
}

function appendStep(report, name, status) {
  report.steps.push({ name, status });
}

async function checkedStep(report, name, action) {
  try {
    const result = await action();
    appendStep(report, name, "succeeded");
    return result;
  } catch (error) {
    appendStep(report, name, "failed");
    throw error;
  }
}

function requireSucceeded(run) {
  if (run.status === "running") {
    throw new SmokeError(
      "RUN_TIMEOUT",
      "Run remained active at the server's 60-second run deadline.",
    );
  }
  if (run.status !== "succeeded") {
    throw new SmokeError(
      typeof run.error?.code === "string"
        ? run.error.code
        : `RUN_${run.status.toUpperCase()}`,
      typeof run.error?.message === "string"
        ? run.error.message
        : `Provider run ended with status ${run.status}.`,
    );
  }
}

async function startAndPollRun(
  base,
  report,
  runIds,
  sessionId,
  revision,
  kind,
  input,
) {
  const opening = kind === "opening";
  const name = opening ? "opening" : "movement";
  const requestId = randomUUID();
  const deadline = Date.now() + RUN_WAIT_TIMEOUT_MS;
  const sessionPath = `/sessions/${encodeURIComponent(sessionId)}`;
  const actionPath = opening ? "opening" : "turns";
  runIds[name] = requestId;

  try {
    let run = await api(base, `${sessionPath}/${actionPath}`, {
      method: "POST",
      body: {
        requestId,
        expectedRevision: revision,
        ...(opening ? {} : { input }),
      },
    });
    if (run?.requestId !== requestId || typeof run.status !== "string") {
      throw new SmokeError(
        "RUN_RESPONSE_INVALID",
        "Run API did not return the requested run status.",
      );
    }

    while (run.status === "running" && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
      );
      const pollRemaining = deadline - Date.now();
      if (pollRemaining <= 0) break;
      run = await api(
        base,
        `${sessionPath}/runs/${encodeURIComponent(requestId)}`,
        { timeoutMs: Math.min(LOCAL_REQUEST_TIMEOUT_MS, pollRemaining) },
      );
      if (typeof run?.status !== "string") {
        throw new SmokeError(
          "RUN_RESPONSE_INVALID",
          "Run status API returned an invalid result.",
        );
      }
    }

    appendStep(report, name, run.status);
    return { requestId, run };
  } catch (error) {
    appendStep(report, name, "failed");
    throw error;
  }
}

async function runProvider(base, provider, pack, fixture) {
  const startedAt = performance.now();
  const report = {
    provider: provider.provider,
    model: provider.model,
    status: "NOT VERIFIED",
    steps: [],
    usage: { opening: null, movement: null },
    elapsedMs: 0,
    error: null,
  };
  let sessionId;
  const runIds = {};
  const definition = structuredClone(fixture.definition);
  definition.id = randomUUID();
  definition.startingLocationId = START_LOCATION_ID;
  definition.lorebookRefs = [
    { packId: pack.pack.id, version: pack.pack.version },
  ];

  try {
    const started = await checkedStep(report, "session-start", () =>
      api(base, "/sessions/start", {
        method: "POST",
        body: {
          definition,
          ai: { provider: provider.provider, model: provider.model },
        },
      }),
    );
    const initial = await checkedStep(report, "session-start-readback", () => {
      const record = versionedSession(started?.session);
      sessionId = record.value.id;
      if (
        typeof sessionId !== "string" ||
        record.value.state.world.locationId !== START_LOCATION_ID
      ) {
        throw new SmokeError(
          "SESSION_START_LOCATION_MISMATCH",
          "The fixture session did not start at Prontera.",
        );
      }
      return record;
    });

    const openingState = structuredClone(initial.value.state);
    const opening = await startAndPollRun(
      base,
      report,
      runIds,
      sessionId,
      initial.revision,
      "opening",
    );
    requireSucceeded(opening.run);

    const afterOpening = await checkedStep(
      report,
      "opening-readback",
      async () => {
        const record = versionedSession(
          await api(base, `/sessions/${encodeURIComponent(sessionId)}`),
        );
        if (
          record.revision <= initial.revision ||
          record.value.nextSequence <= initial.value.nextSequence ||
          !isDeepStrictEqual(record.value.state, openingState)
        ) {
          throw new SmokeError(
            "OPENING_STATE_CHANGED",
            "The committed opening did not preserve the session world and effects state.",
          );
        }
        return record;
      },
    );

    const movement = await startAndPollRun(
      base,
      report,
      runIds,
      sessionId,
      afterOpening.revision,
      "turn",
      MOVEMENT_ACTION,
    );
    requireSucceeded(movement.run);

    await checkedStep(report, "movement-readback", async () => {
      const session = versionedSession(
        await api(base, `/sessions/${encodeURIComponent(sessionId)}`),
      );
      const world = await api(
        base,
        `/sessions/${encodeURIComponent(sessionId)}/world`,
      );
      const people = Array.isArray(world.people) ? world.people : [];
      if (
        session.revision <= afterOpening.revision ||
        session.value.nextSequence <= afterOpening.value.nextSequence ||
        world.location?.id !== DESTINATION_LOCATION_ID ||
        !people.some((person) => person.id === DESTINATION_NPC_ID)
      ) {
        throw new SmokeError(
          "MOVEMENT_READBACK_MISMATCH",
          "The player-world readback did not show Morroc and its local guard participant.",
        );
      }
    });
  } catch (error) {
    report.error = toError(error);
    if (sessionId && !report.steps.some((step) => step.name === "movement")) {
      appendStep(report, "movement", "not-run");
    }
  }

  if (sessionId) {
    for (const key of ["opening", "movement"]) {
      if (!runIds[key]) continue;
      try {
        const query = new URLSearchParams({ requestId: runIds[key] });
        report.usage[key] = await api(
          base,
          `/sessions/${encodeURIComponent(sessionId)}/usage?${query}`,
        );
        appendStep(report, `${key}-usage`, "succeeded");
      } catch (error) {
        appendStep(report, `${key}-usage`, "failed");
        if (!report.error) report.error = toError(error);
      }
    }
  }

  report.elapsedMs = Math.round(performance.now() - startedAt);
  if (
    !report.error &&
    report.steps.length > 0 &&
    report.steps.every((step) => step.status === "succeeded")
  ) {
    report.status = "VERIFIED";
  } else if (!report.error) {
    report.error = {
      code: "SMOKE_INCOMPLETE",
      message:
        "One or more provider smoke steps did not complete successfully.",
    };
  }
  return report;
}

async function cleanup({ httpServer, database, vite, tempDirectory }) {
  const errors = [];
  try {
    if (httpServer) {
      httpServer.closeAllConnections?.();
      if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(resolve));
      }
    }
  } catch {
    errors.push("HTTP server cleanup failed.");
  }
  try {
    database?.close();
  } catch {
    errors.push("Temporary database cleanup failed.");
  }
  try {
    await vite?.close();
  } catch {
    errors.push("Vite cleanup failed.");
  }
  try {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  } catch {
    errors.push("Temporary directory cleanup failed.");
  }
  return errors;
}

async function main() {
  const resources = {};
  let output;
  try {
    resources.tempDirectory = await mkdtemp(
      join(tmpdir(), "fworld-provider-smoke-"),
    );
    resources.vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    const [serverApi, databaseApi] = await Promise.all([
      resources.vite.ssrLoadModule("/server/main.ts"),
      resources.vite.ssrLoadModule("/server/db.ts"),
    ]);
    const databasePath = join(resources.tempDirectory, "provider-smoke.sqlite");
    resources.database = new databaseApi.GameDatabase(databasePath);
    resources.httpServer = serverApi.createHttpServer(
      { current: resources.database, path: databasePath },
      {
        development: true,
        allowedHosts: ["*"],
        backupDirectory: join(resources.tempDirectory, "backups"),
        envFilePath: join(resources.tempDirectory, "provider-smoke.env"),
      },
    );
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        resources.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        resources.httpServer.off("error", onError);
        resolve();
      };
      resources.httpServer.once("error", onError);
      resources.httpServer.once("listening", onListening);
      resources.httpServer.listen(0, "127.0.0.1");
    });

    const address = resources.httpServer.address();
    if (!address || typeof address === "string") {
      throw new SmokeError(
        "LOCAL_SERVER_START_FAILED",
        "Local HTTP server did not bind a TCP port.",
      );
    }
    const base = `http://127.0.0.1:${address.port}/api`;
    const settings = await api(base, "/ai/settings");
    const configured = PROVIDERS.filter(
      ({ provider }) => settings?.providers?.[provider]?.configured === true,
    );

    if (!configured.length) {
      output = {
        status: "NOT VERIFIED",
        providers: [],
        error: {
          code: "NO_CONFIGURED_PROVIDERS",
          message:
            "No provider credentials are configured in the server environment.",
        },
      };
    } else {
      let fixture;
      let pack;
      let sharedFailure;
      let sharedFailureStep = "fixture-validation";
      try {
        fixture = await loadJson(
          new URL("../tests/fixtures/upgrade-ragnarok.json", import.meta.url),
          "Original Ragnarok fixture",
        );
        pack = await loadJson(
          new URL("../examples/lorebook-prontera.json", import.meta.url),
          "Curated Prontera lorebook",
        );
        validateFixture(fixture, pack);
        sharedFailureStep = "lorebook-import";
        const imported = await api(base, "/lorebooks/import", {
          method: "POST",
          body: { lorebook: pack },
        });
        if (
          imported?.pack?.id !== pack.pack.id ||
          imported?.pack?.version !== pack.pack.version
        ) {
          throw new SmokeError(
            "LOREBOOK_IMPORT_MISMATCH",
            "Lorebook import did not confirm the curated pack and version.",
          );
        }
      } catch (error) {
        sharedFailure = toError(error);
      }

      const reports = [];
      for (const provider of configured) {
        if (sharedFailure) {
          reports.push({
            provider: provider.provider,
            model: provider.model,
            status: "NOT VERIFIED",
            steps: [{ name: sharedFailureStep, status: "failed" }],
            usage: { opening: null, movement: null },
            elapsedMs: 0,
            error: sharedFailure,
          });
        } else {
          reports.push(await runProvider(base, provider, pack, fixture));
        }
      }
      output = {
        status: reports.every((report) => report.status === "VERIFIED")
          ? "VERIFIED"
          : "NOT VERIFIED",
        providers: reports,
      };
    }
  } catch (error) {
    output = { status: "NOT VERIFIED", providers: [], error: toError(error) };
  }

  const cleanupErrors = await cleanup(resources);
  if (cleanupErrors.length) {
    output.status = "NOT VERIFIED";
    output.cleanup = cleanupErrors;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.status !== "VERIFIED") process.exitCode = 1;
}

await main();
