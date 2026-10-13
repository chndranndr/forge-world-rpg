import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpProbe } from "node:http";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_ORIGIN = "http://127.0.0.1:5173";
const PROVIDER_URL = new URL("https://openrouter.ai/api/v1/chat/completions");
const FAKE_PROVIDER_KEY = "offline-upgrade-verify-only";
const PACK_FILE = join(ROOT, "examples/lorebook-prontera.json");
const GAME_FILE = join(ROOT, "examples/lorebook-game.json");
const SECRET_ID = "secret:morroc-rest-mark";
const EARLY_EVENT =
  "The courier hid the sealed blue-wax letter beneath the west fountain before the first noon bell.";
const PRIVATE_FACT =
  "Sava privately knows the silver-crescent mark on the courier's second route slip.";
const ISOLATED_ENV_NAMES = [
  "FWORLD_OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "FWORLD_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "FWORLD_DATA_DIR",
  "FWORLD_BACKUP_DIR",
];
const BASE_CHOICES = [
  { id: "choice-1", label: "Ask for the ledger" },
  { id: "choice-2", label: "Check the road note" },
  { id: "choice-3", label: "Wait by the gate" },
];

const args = process.argv.slice(2);
assert.ok(
  args.length <= 1 && args.every((arg) => arg === "--serve"),
  "Only the optional --serve flag is supported.",
);
const serve = args.includes("--serve");

const providerTrace = [];
let providerPlan = [];
let providerCalls = 0;
let acceptanceComplete = false;
let blockedExternalFetches = 0;
let originalFetch;
let vite;
let databaseApi;
let serverApi;
const databaseHandles = new Set();
let mainDatabaseRef;
let portabilityDatabaseRef;
let mainHttpServer;
let portabilityHttpServer;
let mainBaseUrl;
let portabilityBaseUrl;
let tempDirectory;
let keepTempDirectory = false;
const savedEnvironment = new Map();
const allowedLoopbackOrigins = new Set();
const endToEndMs = [];
const observedTelemetry = [];

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function percentiles(values) {
  assert.ok(values.length, "No measurements were captured.");
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    max: Number(sorted.at(-1).toFixed(2)),
  };
}

function narrative({
  text = "The moment passes without changing the record.",
  effects = [],
  world,
  choices = [],
} = {}) {
  return {
    narrative: text,
    effects,
    ...(world ? { world } : {}),
    choices,
  };
}

function providerReply(body, output) {
  const model = typeof body.model === "string" ? body.model : "offline/model";
  const usage = {
    prompt_tokens: 180,
    completion_tokens: 32,
    total_tokens: 212,
  };
  const message = output?.toolCall
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${randomUUID().replaceAll("-", "")}`,
            type: "function",
            function: {
              name: "search_memory",
              arguments: JSON.stringify(output.toolCall),
            },
          },
        ],
      }
    : {
        role: "assistant",
        content: JSON.stringify(output ?? narrative()),
      };
  return Response.json({
    id: `offline-${randomUUID()}`,
    object: "chat.completion",
    created: 1_791_000_000,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: output?.toolCall ? "tool_calls" : "stop",
      },
    ],
    usage,
  });
}

function providerPrompt(body) {
  const system = typeof body.system === "string" ? body.system : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const serialized = JSON.stringify({ system, messages });
  const content = [system];
  for (const message of messages) {
    if (typeof message?.content === "string") content.push(message.content);
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") content.push(part.text);
      }
    }
    if (Array.isArray(message?.tool_calls))
      content.push(JSON.stringify(message.tool_calls));
  }
  const text = content.join("\n");
  const toolResults = messages
    .filter((message) => message?.role === "tool")
    .map((message) => String(message.content ?? ""));
  return {
    text,
    toolResults,
    contextChars: text.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    model: typeof body.model === "string" ? body.model : "unknown",
  };
}

function installNetworkBoundary() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (allowedLoopbackOrigins.has(url.origin)) return originalFetch(request);
    if (
      url.origin === PROVIDER_URL.origin &&
      url.pathname === PROVIDER_URL.pathname
    ) {
      assert.equal(
        request.method,
        "POST",
        "Provider boundary expects a chat-completions POST.",
      );
      assert.match(
        request.headers.get("content-type") ?? "",
        /application\/json/i,
      );
      assert.ok(
        request.headers.get("authorization") === `Bearer ${FAKE_PROVIDER_KEY}`,
        "Provider request must use the isolated fake credential.",
      );
      const output = providerPlan.shift();
      if (!output && !acceptanceComplete)
        throw new Error("Unexpected offline provider call.");
      const body = await request.clone().json();
      const captured = providerPrompt(body);
      providerTrace.push(captured);
      providerCalls += 1;
      return providerReply(body, output ?? narrative());
    }
    blockedExternalFetches += 1;
    throw new Error(`Blocked outbound fetch to ${url.origin}${url.pathname}.`);
  };
}

async function postJson(base, path, body) {
  return requestJson(base, "POST", path, body);
}

async function requestJson(base, method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Origin: CANONICAL_ORIGIN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function expectStatus(result, expected, label) {
  assert.ok(
    expected.includes(result.status),
    `${label}: expected HTTP ${expected.join("/")}, got ${result.status} (${result.body?.code ?? "no error code"}).`,
  );
}

async function listen(httpServer, port = 0) {
  await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolveListen();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, "127.0.0.1");
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(httpServer) {
  if (!httpServer?.listening) return;
  await new Promise((resolveClose, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function reservePort() {
  const probe = createHttpProbe();
  const base = await listen(probe, 0);
  await closeHttpServer(probe);
  return Number(new URL(base).port);
}

async function assertPortAvailable(port) {
  const probe = createHttpProbe();
  try {
    await listen(probe, port);
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `Port ${port} is occupied; --serve will not change or stop the existing service.`,
      );
    }
    throw error;
  } finally {
    await closeHttpServer(probe).catch(() => {});
  }
}

function serverOptions(base, options = {}) {
  return {
    allowedHosts: [`127.0.0.1:${new URL(base).port}`],
    allowedOrigins: [CANONICAL_ORIGIN],
    envFilePath: join(tempDirectory, "isolated-provider.env"),
    backupDirectory: join(tempDirectory, options.backupDirectory ?? "backups"),
    ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}),
  };
}

async function startHttpFixture(
  databasePath,
  { fixedPort = false, staticRoot, backupDirectory } = {},
) {
  const port = fixedPort ? 5173 : await reservePort();
  if (fixedPort) await assertPortAvailable(port);
  const base = `http://127.0.0.1:${port}`;
  const db = new databaseApi.GameDatabase(databasePath);
  databaseHandles.add(db);
  const databaseRef = { current: db, path: databasePath };
  const httpServer = serverApi.createHttpServer(
    databaseRef,
    serverOptions(base, { staticRoot, backupDirectory }),
  );
  try {
    const listeningBase = await listen(httpServer, port);
    assert.equal(listeningBase, base);
    allowedLoopbackOrigins.add(base);
    return { httpServer, databaseRef, base };
  } catch (error) {
    db.close();
    await closeHttpServer(httpServer).catch(() => {});
    throw error;
  }
}

function readSession(wrapper) {
  assert.ok(
    wrapper?.value?.state?.world,
    "Session response omitted world state.",
  );
  return wrapper.value;
}

async function getSession(base, sessionId) {
  const result = await requestJson(
    base,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  expectStatus(result, [200], "Reading session");
  return result.body;
}

async function getRun(base, sessionId, requestId) {
  const result = await requestJson(
    base,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(requestId)}`,
  );
  expectStatus(result, [200], "Reading run");
  return result.body;
}

async function waitForRun(base, sessionId, requestId) {
  const deadline = Date.now() + 30_000;
  let run;
  do {
    run = await getRun(base, sessionId, requestId);
    if (run.status !== "running") return run;
    await wait(10);
  } while (Date.now() < deadline);
  throw new Error(`Run ${requestId} did not finish within 30 seconds.`);
}

async function runRequest({
  base,
  sessionId,
  kind,
  input,
  outputs,
  requestId = `verify-${randomUUID()}`,
  allowUnusedProviderResponses = false,
}) {
  assert.ok(
    Array.isArray(outputs),
    "Each isolated run needs deterministic provider responses.",
  );
  assert.equal(
    providerPlan.length,
    0,
    "A prior run left unused provider responses.",
  );
  providerPlan = structuredClone(outputs);
  const sessionWrapper = await getSession(base, sessionId);
  const before = readSession(sessionWrapper);
  const traceStart = providerTrace.length;
  const callStart = providerCalls;
  const start = performance.now();
  const path =
    kind === "opening"
      ? `/api/sessions/${encodeURIComponent(sessionId)}/opening`
      : kind === "choices"
        ? `/api/sessions/${encodeURIComponent(sessionId)}/choices`
        : `/api/sessions/${encodeURIComponent(sessionId)}/turns`;
  const body = {
    requestId,
    expectedRevision: sessionWrapper.revision,
    ...(kind === "turn" ? { input } : {}),
  };
  const started = await postJson(base, path, body);
  expectStatus(started, [202], `Starting ${kind}`);
  const run = await waitForRun(base, sessionId, requestId);
  const elapsedMs = performance.now() - start;
  endToEndMs.push(elapsedMs);
  const afterWrapper = await getSession(base, sessionId);
  const after = readSession(afterWrapper);
  const traces = providerTrace.slice(traceStart);
  const unusedProviderResponses = providerPlan.length;
  if (!allowUnusedProviderResponses) {
    assert.equal(
      unusedProviderResponses,
      0,
      `Provider response plan was not fully consumed for ${kind}.`,
    );
  }
  providerPlan = [];
  const telemetry = mainDatabaseRef?.current.getContextTelemetry?.(
    sessionId,
    requestId,
  );
  if (telemetry) observedTelemetry.push(telemetry);
  return {
    run,
    before,
    beforeRevision: sessionWrapper.revision,
    after,
    afterWrapper,
    traces,
    telemetry,
    providerCalls: providerCalls - callStart,
    elapsedMs,
    requestId,
  };
}

function assertFailedWithoutCommit(result, label) {
  assert.equal(result.run.status, "failed", `${label} must fail.`);
  assert.ok(
    result.providerCalls > 0,
    `${label} must exercise a narrator proposal.`,
  );
  assert.deepEqual(
    result.after.state,
    result.before.state,
    `${label} changed state.`,
  );
  assert.equal(
    result.afterWrapper.revision,
    result.beforeRevision,
    `${label} changed revision.`,
  );
  assert.equal(
    result.after.nextSequence,
    result.before.nextSequence,
    `${label} advanced history.`,
  );
}

function safeDiagnostic(value) {
  return String(value ?? "")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]")
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(
      /\b(api[-_ ]?key|authorization|token)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function assertSucceeded(run, label) {
  const diagnostic = [
    run.error?.code,
    run.error?.message ? safeDiagnostic(run.error.message) : undefined,
  ]
    .filter(Boolean)
    .join(": ");
  assert.equal(
    run.status,
    "succeeded",
    `${label} failed${diagnostic ? ` with ${diagnostic}` : ""}.`,
  );
}

function locationIdsFromPrompt(prompt, definition) {
  return definition.npcs
    .filter((npc) => prompt.includes(npc.name))
    .map((npc) => npc.id)
    .sort();
}

const RECALL_ACTIONS = [
  ["Prontera", "loc:prontera"],
  ["Prontera Gate", "loc:prontera"],
  ["Morroc", "loc:morroc"],
  ["Morroc town", "loc:morroc"],
  ["Morroc Market", "place:morroc_market"],
  ["the market", "place:morroc_market"],
  ["The Pyramid", "loc:pyramid"],
  ["Pyramid trail", "loc:pyramid"],
  ["Sograt", "loc:sograt"],
  ["Sograt road", "loc:sograt"],
  ["Morroc's Shared Road Ledger", "history:morroc"],
  ["Check the Gate Ledger", "activity:prontera-ledger-check"],
  ["Compare Morroc Route Notes", "activity:morroc-route-notes"],
  ["Ask About an Unclaimed Receipt", "activity:market-receipt-check"],
  ["Read the Pyramid Trail Marker", "activity:pyramid-marker-check"],
  ["Plan a Shaded Rest", "activity:sograt-shade-plan"],
  ["Edrin", "npc:edrin"],
  ["Sava", "npc:sava"],
  ["Nima", "npc:nima"],
  ["Teren", "npc:teren"],
];
const RUNTIME_RECALL_ACTIONS = [
  {
    id: "history-ledger",
    category: "history",
    input:
      "Ask Sava about the history behind Morroc's shared road ledger and parcel handoffs.",
    expectedId: "history:morroc",
  },
  {
    id: "history-couriers",
    category: "history",
    input:
      "Ask Sava what Morroc's history says about two couriers' different last-mile directions.",
    expectedId: "history:morroc",
  },
  {
    id: "history-landmarks",
    category: "history",
    input:
      "Ask Sava why the history of Morroc's road ledger records landmarks rather than names.",
    expectedId: "history:morroc",
  },
  {
    id: "route-landmark",
    category: "local-route",
    input: "Ask Sava which landmark a Morroc route note names.",
    expectedId: "activity:morroc-route-notes",
  },
  {
    id: "route-water-stop",
    category: "local-route",
    input:
      "Ask Sava whether the water stop in a Morroc route note remains usable.",
    expectedId: "activity:morroc-route-notes",
  },
  {
    id: "route-comparison",
    category: "local-route",
    input:
      "Ask Sava how locals compare Morroc route notes without assuming either account is mistaken.",
    expectedId: "activity:morroc-route-notes",
  },
  {
    id: "receipt-blank-line",
    category: "market-receipt",
    input: "Ask Sava what a blank line on a market receipt means.",
    expectedId: "activity:market-receipt-check",
  },
  {
    id: "receipt-handoff",
    category: "market-receipt",
    input:
      "Ask Sava how stall notes check an unclaimed parcel against an ordinary handoff.",
    expectedId: "activity:market-receipt-check",
  },
  {
    id: "receipt-stall",
    category: "market-receipt",
    input:
      "Ask Sava which stall issued a receipt and whether its blank note line was meant for a later name.",
    expectedId: "activity:market-receipt-check",
  },
  {
    id: "market-location",
    category: "market-receipt",
    input: "Ask Sava where a visitor can ask about a Morroc Market receipt.",
    expectedId: "place:morroc_market",
  },
  {
    id: "water-mark",
    category: "discovered-lore",
    input:
      "Ask Sava what the chalk crescent under the western water jar points toward.",
    expectedId: SECRET_ID,
  },
  {
    id: "water-mark-shade",
    category: "discovered-lore",
    input: "Ask Sava what the hidden water-jar mark says about a shaded turn.",
    expectedId: SECRET_ID,
  },
  {
    id: "pyramid-marker",
    category: "pyramid",
    input:
      "Ask Sava what the Pyramid trail marker tells visitors about the townward path.",
    expectedId: "activity:pyramid-marker-check",
  },
  {
    id: "pyramid-return-point",
    category: "pyramid",
    input:
      "Ask Sava what the return-point check near the Pyramid distinguishes.",
    expectedId: "activity:pyramid-marker-check",
  },
  {
    id: "pyramid-landmark",
    category: "pyramid",
    input: "Ask Sava about the stone landmark and its marker near Morroc.",
    expectedId: "loc:pyramid",
  },
  {
    id: "sograt-shade",
    category: "sograt",
    input:
      "Ask Sava how locals compare the next Sograt stretch with shaded places.",
    expectedId: "activity:sograt-shade-plan",
  },
  {
    id: "sograt-rest",
    category: "sograt",
    input: "Ask Sava where people on the Sograt road plan a shaded rest.",
    expectedId: "activity:sograt-shade-plan",
  },
  {
    id: "sograt-open-stretch",
    category: "sograt",
    input: "Ask Sava what an open desert stretch says about shade and water.",
    expectedId: "loc:sograt",
  },
  {
    id: "route-water-landmark",
    category: "local-route",
    input:
      "Ask Sava which landmark a Morroc road note describes near a water stop.",
    expectedId: "activity:morroc-route-notes",
  },
  {
    id: "history-handoffs",
    category: "history",
    input:
      "Ask Sava why Morroc's shared-road ledger history records handoffs, not names.",
    expectedId: "history:morroc",
  },
];

async function verifyLoreCatalog(base, pack, definition) {
  const imported = await postJson(base, "/api/lorebooks/import", {
    lorebook: pack,
    dryRun: true,
  });
  expectStatus(imported, [200], "Dry-run lore import");
  assert.equal(imported.body.dryRun, true);
  assert.equal(imported.body.pack.id, pack.pack.id);
  assert.equal(imported.body.entries, pack.entries.length);
  const emptyBeforePublish = await requestJson(
    base,
    "GET",
    "/api/lorebooks?limit=20&offset=0",
  );
  expectStatus(emptyBeforePublish, [200], "Confirming dry-run has no write");
  assert.equal(emptyBeforePublish.body.total, 0);

  const published = await postJson(base, "/api/lorebooks/import", {
    lorebook: pack,
  });
  expectStatus(published, [201, 200], "Publishing lore pack");
  assert.equal(published.body.dryRun, false);
  assert.equal(published.body.digest.length, 64);
  const duplicate = await postJson(base, "/api/lorebooks/import", {
    lorebook: pack,
  });
  expectStatus(duplicate, [200, 201], "Idempotent lore import");
  assert.equal(duplicate.body.digest, published.body.digest);
  assert.equal(duplicate.body.existing, true);

  const basePath = `/api/lorebooks/${encodeURIComponent(pack.pack.id)}/versions/${pack.pack.version}`;
  const list = await requestJson(
    base,
    "GET",
    "/api/lorebooks?limit=1&offset=0",
  );
  expectStatus(list, [200], "Browsing lore packs");
  assert.equal(list.body.total, 1);
  assert.equal(list.body.packs[0].id, pack.pack.id);
  const listNext = await requestJson(
    base,
    "GET",
    "/api/lorebooks?limit=1&offset=1",
  );
  expectStatus(listNext, [200], "Reading the next lore-pack page");
  assert.equal(listNext.body.total, 1);
  assert.equal(listNext.body.packs.length, 0);
  const page1 = await requestJson(
    base,
    "GET",
    `${basePath}/entries?limit=5&offset=0`,
  );
  const page2 = await requestJson(
    base,
    "GET",
    `${basePath}/entries?limit=5&offset=5`,
  );
  expectStatus(page1, [200], "Reading lore page one");
  expectStatus(page2, [200], "Reading lore page two");
  assert.equal(page1.body.entries.length, 5);
  assert.equal(page2.body.entries.length, 5);
  assert.ok(
    page1.body.entries.every(
      (entry) => !page2.body.entries.some((next) => next.id === entry.id),
    ),
    "Paged lore browsing must not repeat entries.",
  );
  assert.ok(page1.body.entries.every((entry) => entry.visibility === "public"));
  assert.ok(page2.body.entries.every((entry) => entry.visibility === "public"));
  assert.ok(!page1.body.entries.some((entry) => entry.id === SECRET_ID));
  assert.ok(
    !page1.body.entries.some(
      (entry) => entry.id === "secret:narrator-ledger-cue",
    ),
  );

  const search = await requestJson(
    base,
    "GET",
    `${basePath}/entries?query=${encodeURIComponent("Morroc")}&limit=10&offset=0`,
  );
  expectStatus(search, [200], "Searching lore entries");
  assert.ok(search.body.entries.some((entry) => entry.id === "loc:morroc"));
  assert.ok(
    !search.body.entries.some((entry) => entry.id.startsWith("secret:")),
  );
  const links = await requestJson(
    base,
    "GET",
    `${basePath}/links?entryId=${encodeURIComponent("loc:morroc")}&limit=10&offset=0`,
  );
  expectStatus(links, [200], "Browsing lore links");
  assert.ok(links.body.links.length > 0);

  const preview = await postJson(base, "/api/lorebooks/preview", {
    definition,
    locationId: "loc:morroc",
    query: "market receipts",
  });
  expectStatus(preview, [200], "Previewing bound lore");
  assert.equal(preview.body.locationId, "loc:morroc");
  assert.ok(Array.isArray(preview.body.entries));
  assert.ok(Array.isArray(preview.body.activeNpcIds));
  assert.ok(
    preview.body.entries.some((entry) => entry.id === "place:morroc_market"),
  );
  assert.ok(
    !preview.body.entries.some((entry) => entry.visibility !== "public"),
  );

  const invalid = structuredClone(definition);
  invalid.id = `invalid-binding-${randomUUID()}`;
  invalid.lorebookRefs = [
    { packId: pack.pack.id, version: pack.pack.version + 100 },
  ];
  const badBinding = await postJson(base, "/api/games", {
    definition: invalid,
  });
  expectStatus(
    badBinding,
    [400, 409],
    "Rejecting a missing pinned pack version",
  );
  assert.ok(
    ["LORE_DEPENDENCY_MISSING", "INVALID_LORE_BINDING"].includes(
      badBinding.body.code,
    ),
    "Missing pack version must return an actionable lore binding error.",
  );

  let recallHits = 0;
  for (const [query, entryId] of RECALL_ACTIONS) {
    assert.ok(
      pack.entries.some((entry) => entry.id === entryId),
      `Recall target ${entryId} must be in the pack.`,
    );
    const result = await requestJson(
      base,
      "GET",
      `${basePath}/entries?query=${encodeURIComponent(query)}&limit=5&offset=0`,
    );
    expectStatus(result, [200], "Measuring fixed lore recall action");
    assert.ok(result.body.entries.length <= 5);
    if (result.body.entries.some((entry) => entry.id === entryId))
      recallHits += 1;
  }
  assert.equal(RECALL_ACTIONS.length, 20);

  return {
    published: published.body,
    basePath,
    recall: { actions: 20, k: 5, hits: recallHits, rate: recallHits / 20 },
  };
}

async function createGameAndSession(base, definition, gameId) {
  const gameDefinition = {
    ...structuredClone(definition),
    id: gameId,
    updatedAt: new Date().toISOString(),
  };
  const created = await postJson(base, "/api/games", {
    definition: gameDefinition,
  });
  expectStatus(created, [201], "Creating bound sample game");
  assert.equal(
    created.body.value.lorebookRefs[0].packId,
    gameDefinition.lorebookRefs[0].packId,
  );
  const started = await postJson(base, "/api/sessions/start", {
    definition: created.body.value,
    expectedGameRevision: created.body.revision,
    ai: { provider: "openrouter", model: "offline/upgrade-verify" },
  });
  expectStatus(started, [201], "Starting bound sample session");
  const sessionId = started.body.session.value.id;
  assert.equal(
    started.body.session.value.state.world.locationId,
    "loc:prontera",
  );
  assert.deepEqual(
    started.body.session.value.lorebookRefs,
    gameDefinition.lorebookRefs,
  );
  return {
    gameDefinition,
    game: created.body.value,
    gameRevision: created.body.revision,
    sessionId,
    started: started.body,
  };
}

function hasWorldPeople(world) {
  return Array.isArray(world.people);
}

async function assertWorld(base, sessionId, locationId, locationName) {
  const result = await requestJson(
    base,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/world`,
  );
  expectStatus(result, [200], "Reading public session world");
  const world = result.body;
  assert.equal(world.location?.id, locationId);
  assert.ok(
    String(world.location?.name ?? "")
      .toLowerCase()
      .includes(locationName.toLowerCase()),
  );
  assert.ok(!JSON.stringify(world).includes("secret:narrator-ledger-cue"));
  return world;
}

async function verifyLongReplay(base, sessionId, databaseRef) {
  const early = await runRequest({
    base,
    sessionId,
    kind: "turn",
    input:
      "I witness a courier hide a sealed blue-wax letter beneath the west fountain before noon.",
    outputs: [narrative({ text: EARLY_EVENT })],
  });
  assertSucceeded(early.run, "Early event turn");
  assert.ok(
    early.run.result?.messages?.some(
      (message) => message.content === EARLY_EVENT,
    ),
  );

  const replayLatencies = [];
  for (let index = 0; index < 101; index += 1) {
    const start = performance.now();
    const result = await runRequest({
      base,
      sessionId,
      kind: "turn",
      input: `Continue the ordinary journey, observation ${index + 1}.`,
      outputs: [narrative()],
    });
    const elapsed = performance.now() - start;
    replayLatencies.push(elapsed);
    assertSucceeded(result.run, `Replay turn ${index + 1}`);
    assert.deepEqual(
      result.run.result?.choices,
      [],
      "Empty suggestions must remain valid.",
    );
  }
  assert.equal(replayLatencies.length, 101);

  const session = readSession(await getSession(base, sessionId));
  assert.ok(
    session.nextSequence >= 204,
    "More than 100 normal turns must have reached SQLite.",
  );
  const summaryDeadline = Date.now() + 10_000;
  let summaries = [];
  do {
    summaries = databaseRef.current.getStorySummaries(sessionId, {
      query: "blue wax letter west fountain",
      limit: 10,
    });
    if (summaries.length) break;
    await wait(25);
  } while (Date.now() < summaryDeadline);
  assert.ok(
    summaries.length > 0,
    "Committed early event must be represented by scoped episode summaries.",
  );
  assert.ok(
    summaries.some((summary) => summary.summary.includes(EARLY_EVENT)),
    "Relevant extractive summary must retain the exact early consequential event.",
  );
  const publicHits = databaseRef.current.searchMemory(
    sessionId,
    "blue wax letter west fountain",
  );
  assert.ok(
    publicHits.some((hit) => hit.excerpt.toLowerCase().includes("blue-wax")),
  );

  const result = await runRequest({
    base,
    sessionId,
    kind: "turn",
    input:
      "Search the committed story memory for the courier's blue-wax letter and its hiding place.",
    outputs: [
      {
        toolCall: { query: "blue wax letter west fountain", npcId: undefined },
      },
      narrative(),
    ],
  });
  assertSucceeded(result.run, "Long-memory recall turn");
  assert.ok(
    result.traces[0]?.text.includes(EARLY_EVENT),
    "The bounded narrator prompt must retrieve the early event from scoped summaries before the tool response.",
  );
  assert.ok(
    result.traces.some((trace) =>
      trace.toolResults.some((content) => content.includes("blue-wax")),
    ),
    "Actual narrator search_memory tool result must recall the early event.",
  );
  assert.ok(
    result.traces.every((trace) => trace.contextChars <= 24_000),
    "Captured provider prompts must remain within the narrator context cap.",
  );
  return {
    turns: replayLatencies.length + 1,
    replayTurns: replayLatencies.length,
    earlyEvent: "committed normal-turn narrator message",
    summaries: summaries.length,
    recalledByTool: true,
    replayLatencyMs: percentiles(replayLatencies),
  };
}

async function runToolSearch(
  base,
  sessionId,
  npcId,
  query,
  allowDenied = false,
) {
  const result = await runRequest({
    base,
    sessionId,
    kind: "turn",
    input: "Ask Sava to review only the details she is entitled to know.",
    outputs: [{ toolCall: { query, npcId } }, narrative()],
    allowUnusedProviderResponses: allowDenied,
  });
  return {
    run: result.run,
    results: result.traces.flatMap((trace) => trace.toolResults),
  };
}
async function verifyRuntimeLoreRecall(base, sessionId, databaseRef, pack) {
  const k = 5;
  const entryIds = new Set(pack.entries.map((entry) => entry.id));
  const rows = [];
  let invalidProposalRuns = 0;
  let worldStateChangedTurns = 0;
  let providerRequestCount = 0;

  assert.equal(
    RUNTIME_RECALL_ACTIONS.length,
    20,
    "Runtime lore recall must use exactly 20 fixed actions.",
  );
  for (const action of RUNTIME_RECALL_ACTIONS) {
    assert.ok(
      entryIds.has(action.expectedId),
      `Runtime recall target ${action.expectedId} must be in the sample pack.`,
    );
    const storedBefore = databaseRef.current.getSession(sessionId);
    assert.ok(storedBefore, "Runtime recall session must remain persisted.");
    assert.equal(
      storedBefore.state.world.locationId,
      "loc:morroc",
      "Runtime recall must remain at Morroc.",
    );
    const worldBefore = structuredClone(storedBefore.state.world);
    const result = await runRequest({
      base,
      sessionId,
      kind: "turn",
      input: action.input,
      outputs: [narrative()],
    });
    providerRequestCount += result.providerCalls;
    if (result.run.status !== "succeeded") invalidProposalRuns += 1;
    assertSucceeded(result.run, `Runtime recall action ${action.id}`);
    assert.equal(
      result.providerCalls,
      1,
      `Runtime recall action ${action.id} must use one deterministic provider response.`,
    );
    assert.ok(
      result.telemetry,
      `Runtime recall action ${action.id} must persist context telemetry.`,
    );
    assert.ok(Array.isArray(result.telemetry.selectedLoreIds));
    const loreSection = result.telemetry.sections?.lore;
    assert.ok(
      loreSection,
      `Runtime recall action ${action.id} must report the lore section.`,
    );
    assert.equal(
      loreSection.count,
      result.telemetry.selectedLoreIds.length,
      "Lore telemetry count must match persisted selected IDs.",
    );
    assert.ok(
      result.telemetry.contextChars <= 24_000,
      `Runtime recall action ${action.id} exceeded the character budget.`,
    );
    assert.ok(
      result.telemetry.approximateTokens <= 6_000,
      `Runtime recall action ${action.id} exceeded the token estimate budget.`,
    );
    assert.ok(
      loreSection.chars <= 2_600,
      `Runtime recall action ${action.id} exceeded the lore-section budget.`,
    );
    assert.ok(
      result.telemetry.selectedLoreIds.length <= 24,
      "Runtime lore candidates must stay within the candidate cap.",
    );

    const trace = result.traces.at(-1);
    assert.ok(
      trace,
      `Runtime recall action ${action.id} must capture its actual provider prompt.`,
    );
    assert.ok(
      trace.contextChars <= 24_000,
      `Runtime recall action ${action.id} exceeded the provider prompt character budget.`,
    );
    const promptLoreIds = result.telemetry.selectedLoreIds.filter((id) =>
      trace.text.includes(id),
    );
    assert.deepEqual(
      promptLoreIds,
      result.telemetry.selectedLoreIds,
      `Runtime recall action ${action.id} telemetry must match lore IDs in the actual provider prompt.`,
    );
    const expectedSelected = result.telemetry.selectedLoreIds.includes(
      action.expectedId,
    );
    const expectedSelectedAtK = result.telemetry.selectedLoreIds
      .slice(0, k)
      .includes(action.expectedId);
    const expectedInProviderPrompt = promptLoreIds.includes(action.expectedId);
    const expectedInProviderPromptAtK = promptLoreIds
      .slice(0, k)
      .includes(action.expectedId);
    assert.equal(
      expectedSelected,
      expectedInProviderPrompt,
      `Runtime recall action ${action.id} selection must be present in the actual provider prompt.`,
    );
    const storedAfter = databaseRef.current.getSession(sessionId);
    assert.ok(
      storedAfter,
      "Runtime recall session must remain persisted after a turn.",
    );
    const worldUnchanged = isDeepStrictEqual(
      storedAfter.state.world,
      worldBefore,
    );
    if (!worldUnchanged) worldStateChangedTurns += 1;
    assert.ok(
      worldUnchanged,
      `Question action ${action.id} changed world state.`,
    );
    rows.push({
      actionId: action.id,
      category: action.category,
      expectedLoreId: action.expectedId,
      selectedLoreIds: result.telemetry.selectedLoreIds,
      selectedCount: result.telemetry.selectedLoreIds.length,
      expectedSelected,
      expectedSelectedAtK,
      expectedInProviderPrompt,
      expectedInProviderPromptAtK,
      contextChars: result.telemetry.contextChars,
      approximateTokens: result.telemetry.approximateTokens,
      loreChars: loreSection.chars,
      loreCount: loreSection.count,
      loreOmitted: loreSection.omitted,
      providerPromptChars: trace.contextChars,
      worldUnchanged,
      providerCalls: result.providerCalls,
      elapsedMs: Number(result.elapsedMs.toFixed(2)),
    });
  }

  const recallHits = rows.filter((row) => row.expectedSelectedAtK).length;
  const providerPromptHits = rows.filter(
    (row) => row.expectedInProviderPromptAtK,
  ).length;
  assert.equal(
    recallHits,
    rows.length,
    "Every fixed runtime lore query must retrieve its target within the first five prompt entries.",
  );
  assert.equal(
    invalidProposalRuns,
    0,
    "Runtime recall questions must not produce failed proposals.",
  );
  assert.equal(
    worldStateChangedTurns,
    0,
    "Runtime recall questions must preserve all world state.",
  );
  assert.equal(
    providerRequestCount,
    20,
    "Each fixed runtime recall action must make one provider-boundary request.",
  );
  return {
    actions: rows.length,
    k,
    recallAtK: { hits: recallHits, rate: recallHits / rows.length },
    providerPromptRecallAtK: {
      hits: providerPromptHits,
      rate: providerPromptHits / rows.length,
    },
    selectedLoreCount: percentiles(rows.map((row) => row.selectedCount)),
    contextChars: percentiles(rows.map((row) => row.contextChars)),
    approximateTokens: percentiles(rows.map((row) => row.approximateTokens)),
    loreSectionChars: percentiles(rows.map((row) => row.loreChars)),
    providerPromptChars: percentiles(
      rows.map((row) => row.providerPromptChars),
    ),
    localEndToEndMs: percentiles(rows.map((row) => row.elapsedMs)),
    budgets: {
      contextChars: 24_000,
      approximateTokens: 6_000,
      loreSectionChars: 2_600,
      candidateCap: 24,
    },
    structuralWorldInvariants: {
      questionTurns: rows.length,
      worldUnchangedTurns: rows.filter((row) => row.worldUnchanged).length,
      worldStateChangedTurns,
      invalidProposalRuns,
    },
    providerStubUsage: {
      requests: providerRequestCount,
      syntheticPerRequest: {
        promptTokens: 180,
        completionTokens: 32,
        totalTokens: 212,
      },
      actualBilledUsage: "NOT_VERIFIED",
    },
    naturalLanguageContradictionRate:
      "NOT_VERIFIED; deterministic provider prose is not scored",
    rows,
  };
}

async function verifyPortability(sourcePackExport, saveBundle, tempPath) {
  const fixture = await startHttpFixture(tempPath, {
    backupDirectory: "portable-backups",
  });
  portabilityHttpServer = fixture.httpServer;
  portabilityDatabaseRef = fixture.databaseRef;
  portabilityBaseUrl = fixture.base;

  const missing = await postJson(portabilityBaseUrl, "/api/saves", saveBundle);
  expectStatus(
    missing,
    [400, 409],
    "Rejecting a save with a missing exact lore dependency",
  );
  assert.equal(missing.body.code, "LORE_DEPENDENCY_MISSING");
  const untouched = await requestJson(portabilityBaseUrl, "GET", "/api/games");
  expectStatus(untouched, [200], "Checking missing-pack restore atomicity");
  assert.equal(
    untouched.body.length,
    0,
    "Missing-pack restore must write no game.",
  );

  const install = await postJson(portabilityBaseUrl, "/api/lorebooks/import", {
    lorebook: sourcePackExport,
  });
  expectStatus(
    install,
    [200, 201],
    "Installing portable exact lore dependency",
  );
  assert.equal(install.body.digest, saveBundle.loreDependencies[0].digest);
  const restored = await postJson(portabilityBaseUrl, "/api/saves", saveBundle);
  expectStatus(restored, [201], "Restoring save after dependency installation");
  const importedSessionId = restored.body.sessionId;
  const importedSession = await getSession(
    portabilityBaseUrl,
    importedSessionId,
  );
  assert.deepEqual(
    importedSession.value.lorebookRefs,
    saveBundle.loreDependencies.map(({ packId, version }) => ({
      packId,
      version,
    })),
  );
  const publicWorld = importedSession.value.state.world;
  for (const field of [
    "activeCharacters",
    "flags",
    "discoveredLoreIds",
    "npcPresence",
  ]) {
    assert.equal(
      Object.hasOwn(publicWorld, field),
      false,
      `Player session projection must omit ${field}.`,
    );
  }
  const storedImportedSession =
    portabilityDatabaseRef.current.getSession(importedSessionId);
  assert.ok(
    storedImportedSession?.worldMap,
    "Portable save must retain its pinned world projection in storage.",
  );
  const importedWorld = storedImportedSession.state.world;
  const exportedWorld = saveBundle.session.state.world;
  for (const field of [
    "locationId",
    "location",
    "time",
    "scene",
    "activeCharacters",
  ]) {
    assert.deepEqual(
      importedWorld[field],
      exportedWorld[field],
      `Portable save must preserve stored world field ${field}.`,
    );
  }
  assert.deepEqual(storedImportedSession.worldMap, saveBundle.session.worldMap);
  const backup = await postJson(portabilityBaseUrl, "/api/backups", {});
  expectStatus(backup, [201], "Creating isolated SQLite backup");
  const backupList = await requestJson(
    portabilityBaseUrl,
    "GET",
    "/api/backups",
  );
  expectStatus(backupList, [200], "Listing isolated SQLite backups");
  assert.ok(backupList.body.some((entry) => entry.id === backup.body.id));
  const restoredBackup = await postJson(
    portabilityBaseUrl,
    `/api/backups/${encodeURIComponent(backup.body.id)}/restore`,
    {},
  );
  expectStatus(restoredBackup, [204], "Restoring isolated SQLite backup");
  databaseHandles.add(portabilityDatabaseRef.current);
  const afterBackupRestore = await getSession(
    portabilityBaseUrl,
    importedSessionId,
  );
  assert.deepEqual(
    afterBackupRestore.value.lorebookRefs,
    importedSession.value.lorebookRefs,
  );
  assert.deepEqual(
    afterBackupRestore.value.state.world,
    importedSession.value.state.world,
  );
  const storedAfterBackupRestore =
    portabilityDatabaseRef.current.getSession(importedSessionId);
  assert.deepEqual(
    storedAfterBackupRestore?.worldMap,
    storedImportedSession.worldMap,
  );
  assert.ok(storedAfterBackupRestore);
  assert.deepEqual(storedAfterBackupRestore.state.world, exportedWorld);
  await closeHttpServer(portabilityHttpServer);
  return {
    importedGameId: restored.body.gameId,
    importedSessionId,
    backupId: backup.body.id,
  };
}

async function runAcceptance() {
  if (serve) await assertPortAvailable(5173);
  tempDirectory = await mkdtemp(join(tmpdir(), "fworld-upgrade-verify-"));
  for (const name of ISOLATED_ENV_NAMES)
    savedEnvironment.set(name, process.env[name]);
  process.env.FWORLD_OPENROUTER_API_KEY = FAKE_PROVIDER_KEY;
  process.env.OPENROUTER_API_KEY = FAKE_PROVIDER_KEY;
  process.env.FWORLD_GEMINI_API_KEY = FAKE_PROVIDER_KEY;
  process.env.GEMINI_API_KEY = FAKE_PROVIDER_KEY;
  process.env.FWORLD_DATA_DIR = join(tempDirectory, "fallback-data");
  process.env.FWORLD_BACKUP_DIR = join(tempDirectory, "fallback-backups");
  const envDir = join(tempDirectory, "vite-env");
  await mkdir(envDir, { recursive: true });

  installNetworkBoundary();
  vite = await createViteServer({
    root: ROOT,
    envDir,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  const [databaseModule, mainModule, templateModule] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/shared/template.ts"),
  ]);
  databaseApi = databaseModule;
  serverApi = mainModule;

  const pack = JSON.parse(await readFile(PACK_FILE, "utf8"));
  const template = JSON.parse(await readFile(GAME_FILE, "utf8"));
  assert.equal(pack.format, "fworld-lorebook");
  assert.equal(pack.pack.id, "fworld-original-ro");
  assert.equal(template.format, "fworld-template");
  const parsedTemplate = templateModule.parseTemplate(template);
  const definition = {
    ...parsedTemplate.draft,
    id: `upgrade-${randomUUID()}`,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(definition.startingLocationId, "loc:prontera");
  assert.deepEqual(definition.lorebookRefs, [
    { packId: pack.pack.id, version: pack.pack.version },
  ]);
  for (const id of [
    "loc:prontera",
    "loc:morroc",
    "place:morroc_market",
    "loc:pyramid",
    "loc:sograt",
    SECRET_ID,
    "secret:narrator-ledger-cue",
  ]) {
    assert.ok(
      pack.entries.some((entry) => entry.id === id),
      `Sample is missing ${id}.`,
    );
  }
  const secret = pack.entries.find((entry) => entry.id === SECRET_ID);
  assert.deepEqual(secret.metadata.discoverAt, ["loc:morroc"]);
  assert.ok(secret.metadata.discoveryKeywords.includes("chalk crescent"));
  assert.equal(
    pack.entries.find((entry) => entry.id === "secret:narrator-ledger-cue")
      .visibility,
    "narrator",
  );

  const staticClientReady = serve
    ? await stat(join(ROOT, "dist/client/index.html"))
        .then((entry) => entry.isFile())
        .catch(() => false)
    : true;
  assert.ok(
    staticClientReady,
    "--serve requires dist/client/index.html from an existing build.",
  );
  const fixturePath = join(tempDirectory, "main.sqlite");
  const staticRoot = serve ? join(ROOT, "dist/client") : undefined;
  const mainFixture = await startHttpFixture(fixturePath, {
    fixedPort: serve,
    staticRoot,
  });
  mainHttpServer = mainFixture.httpServer;
  mainBaseUrl = mainFixture.base;
  mainDatabaseRef = mainFixture.databaseRef;
  const databaseRef = mainDatabaseRef;

  const health = await requestJson(mainBaseUrl, "GET", "/api/health");
  expectStatus(health, [200], "Health check");
  assert.equal(health.body.status, "ok");

  const catalog = await verifyLoreCatalog(mainBaseUrl, pack, definition);
  const gameId = definition.id;
  const created = await createGameAndSession(mainBaseUrl, definition, gameId);
  const sessionId = created.sessionId;
  const sessionBeforeOpening = await getSession(mainBaseUrl, sessionId);
  const openingRequestId = `opening-${randomUUID()}`;
  const openingCallStart = providerCalls;
  const openingStart = performance.now();
  providerPlan = [
    narrative({
      text: "You arrive at the quiet Prontera gate.",
      world: { location: "Morroc", locationId: "loc:morroc" },
      choices: BASE_CHOICES,
    }),
  ];
  const openingStarted = await postJson(
    mainBaseUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/opening`,
    {
      requestId: openingRequestId,
      expectedRevision: sessionBeforeOpening.revision,
    },
  );
  expectStatus(openingStarted, [202], "Starting opening scene");
  const opening = await waitForRun(mainBaseUrl, sessionId, openingRequestId);
  endToEndMs.push(performance.now() - openingStart);
  assertSucceeded(opening, "Opening");
  assert.equal(providerCalls - openingCallStart, 1);
  assert.equal(providerPlan.length, 0);
  const openingTelemetry = databaseRef.current.getContextTelemetry(
    sessionId,
    openingRequestId,
  );
  assert.ok(openingTelemetry, "Opening should persist context telemetry.");
  observedTelemetry.push(openingTelemetry);
  assert.deepEqual(
    readSession(await getSession(mainBaseUrl, sessionId)).state,
    sessionBeforeOpening.value.state,
  );
  const pronteraWorld = await assertWorld(
    mainBaseUrl,
    sessionId,
    "loc:prontera",
    "Prontera",
  );
  const pronteraPrompt = providerTrace.at(-1);
  const pronteraActor = created.gameDefinition.npcs.find(
    (npc) => npc.id === "npc:prontera_guard",
  );
  const morrocActor = created.gameDefinition.npcs.find(
    (npc) => npc.id === "npc:morroc_guard",
  );
  assert.ok(
    pronteraActor && morrocActor,
    "Sample actor IDs must match the lore pack mapping.",
  );
  assert.ok(
    pronteraPrompt.text.includes(pronteraActor.name),
    "Prontera prompt must include the local guard.",
  );
  assert.ok(
    !pronteraPrompt.text.includes(morrocActor.name),
    "Prontera prompt must omit the remote Morroc guard.",
  );
  const pronteraNpcIds = locationIdsFromPrompt(
    pronteraPrompt.text,
    created.gameDefinition,
  );
  assert.ok(
    hasWorldPeople(pronteraWorld),
    "Prontera world projection should expose permitted local people.",
  );
  const emptySuggestions = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "choices",
    outputs: [
      narrative({ text: "No useful suggestion is available.", choices: [] }),
    ],
  });
  assertSucceeded(emptySuggestions.run, "Empty suggestions");
  assert.deepEqual(emptySuggestions.run.result?.choices, []);
  assert.equal(
    emptySuggestions.run.result?.boundRevision,
    emptySuggestions.beforeRevision,
  );
  assert.deepEqual(emptySuggestions.after.state, emptySuggestions.before.state);
  assert.equal(
    emptySuggestions.afterWrapper.revision,
    emptySuggestions.beforeRevision,
  );
  assert.equal(
    emptySuggestions.after.nextSequence,
    emptySuggestions.before.nextSequence,
  );
  const emptyChoicesVerified = true;

  const wrongPlaceDiscovery = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Inspect the western water jar for the chalk crescent.",
    outputs: [
      narrative({ effects: [{ type: "DISCOVER_LORE", loreId: SECRET_ID }] }),
      narrative({ effects: [{ type: "DISCOVER_LORE", loreId: SECRET_ID }] }),
    ],
    allowUnusedProviderResponses: true,
  });
  assertFailedWithoutCommit(
    wrongPlaceDiscovery,
    "Discovery from the wrong source location",
  );

  const mention = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "I remember a story someone told me about Morroc.",
    outputs: [
      narrative({ world: { location: "Morroc", locationId: "loc:morroc" } }),
    ],
  });
  assertSucceeded(mention.run, "Conversational destination mention");
  assert.deepEqual(
    mention.after.state.world,
    mention.before.state.world,
    "Mentioning a destination must not change mapped world state.",
  );
  assert.ok(mention.afterWrapper.revision > mention.beforeRevision);

  const travel = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "I explicitly travel from Prontera to Morroc.",
    outputs: [
      narrative({
        text: "The marked road reaches Morroc.",
        world: {
          location: "Morroc",
          locationId: "loc:morroc",
          time: "13:00",
          scene: "At the Morroc gate.",
        },
      }),
    ],
  });
  assertSucceeded(travel.run, "Prontera to Morroc travel");
  assert.equal(travel.after.state.world.locationId, "loc:morroc");
  await assertWorld(mainBaseUrl, sessionId, "loc:morroc", "Morroc");
  const morrocLocalTurn = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Ask the local Morroc gatekeeper for a route note.",
    outputs: [narrative()],
  });
  assertSucceeded(morrocLocalTurn.run, "Morroc local turn");
  const morrocPrompt = morrocLocalTurn.traces.at(-1);
  assert.ok(
    morrocPrompt.text.includes(morrocActor.name),
    "Morroc prompt must switch to its local gatekeeper.",
  );
  assert.ok(
    !morrocPrompt.text.includes(pronteraActor.name),
    "Morroc prompt must omit the remote Prontera guard.",
  );
  const morrocNpcIds = locationIdsFromPrompt(
    morrocPrompt.text,
    created.gameDefinition,
  );
  const morrocWorld = await assertWorld(
    mainBaseUrl,
    sessionId,
    "loc:morroc",
    "Morroc",
  );
  assert.ok(
    hasWorldPeople(morrocWorld),
    "Morroc world projection should expose permitted local people.",
  );
  const reporterNpcLocality = {
    prontera: pronteraNpcIds,
    morroc: morrocNpcIds,
  };

  const unknownDestination = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "I explicitly travel to the unreachable Moon Archive.",
    outputs: [
      narrative({
        world: { location: "Prontera", locationId: "loc:prontera" },
      }),
    ],
  });
  assertSucceeded(unknownDestination.run, "Unknown destination action");
  assert.deepEqual(
    unknownDestination.after.state.world,
    unknownDestination.before.state.world,
    "A narrator proposal must not bypass unknown travel resolution.",
  );
  assert.ok(
    unknownDestination.afterWrapper.revision >
      unknownDestination.beforeRevision,
  );
  const validDiscovery = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Inspect under the western water jar for the chalk crescent.",
    outputs: [
      narrative({ effects: [{ type: "DISCOVER_LORE", loreId: SECRET_ID }] }),
    ],
  });
  assertSucceeded(validDiscovery.run, "Authored discovery at its source");
  const storedDiscoveredSession = databaseRef.current.getSession(sessionId);
  assert.ok(
    storedDiscoveredSession?.state.world.discoveredLoreIds?.includes(SECRET_ID),
  );
  const discoveredWorld = await requestJson(
    mainBaseUrl,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/world`,
  );
  expectStatus(discoveredWorld, [200], "Reading discovered session world");
  assert.ok(Array.isArray(discoveredWorld.body.discoveries));
  assert.ok(
    discoveredWorld.body.discoveries.some((entry) => entry.id === SECRET_ID),
  );
  const runtimeRecallAtK = await verifyRuntimeLoreRecall(
    mainBaseUrl,
    sessionId,
    databaseRef,
    pack,
  );

  const invalidProposalBefore = await getSession(mainBaseUrl, sessionId);
  const invalidEffect = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Set an undeclared world flag.",
    outputs: [
      narrative({
        effects: [
          { type: "SET_FLAG", target: "upgrade-undeclared-flag", value: true },
        ],
      }),
      narrative({
        effects: [
          { type: "SET_FLAG", target: "upgrade-undeclared-flag", value: true },
        ],
      }),
    ],
    allowUnusedProviderResponses: true,
  });
  assertFailedWithoutCommit(invalidEffect, "Undeclared flag proposal");
  assert.equal(invalidProposalBefore.revision, invalidEffect.beforeRevision);

  const presentNpcId = "npc:morroc_guard";
  const unawareNpcId = "npc:prontera_guard";
  const privateResult = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Privately ask Sava to remember this silver-crescent route detail.",
    outputs: [
      narrative({
        effects: [
          {
            type: "ADD_FACT",
            text: PRIVATE_FACT,
            visibility: "private",
            knownBy: ["player", presentNpcId],
            revealableTo: [],
          },
        ],
      }),
    ],
  });
  assertSucceeded(privateResult.run, "Private fact turn");
  const knownHistory = databaseRef.current.getRecentHistory(
    sessionId,
    24,
    presentNpcId,
  );
  const unawareHistory = databaseRef.current.getRecentHistory(
    sessionId,
    24,
    unawareNpcId,
  );
  assert.ok(
    knownHistory.some((message) => message.content.includes("silver-crescent")),
  );
  assert.ok(
    !unawareHistory.some((message) =>
      message.content.includes("silver-crescent"),
    ),
  );
  assert.ok(
    databaseRef.current
      .searchMemory(sessionId, "silver-crescent route slip", presentNpcId)
      .some((hit) => hit.excerpt.includes("silver-crescent")),
  );
  assert.ok(
    !databaseRef.current
      .searchMemory(sessionId, "silver-crescent route slip", unawareNpcId)
      .some((hit) => hit.excerpt.includes("silver-crescent")),
  );
  assert.equal(
    databaseRef.current
      .searchMemory(sessionId, "silver-crescent route slip")
      .some(
        (hit) => hit.kind === "fact" && hit.excerpt.includes("silver-crescent"),
      ),
    true,
    "Player scope must retrieve a player-known private fact.",
  );
  const deniedPrivate = await runToolSearch(
    mainBaseUrl,
    sessionId,
    unawareNpcId,
    "silver-crescent route slip",
    true,
  );
  assert.ok(
    deniedPrivate.results.every(
      (content) => !content.includes("silver-crescent"),
    ),
    "An unaware NPC scope must not retrieve the private fact.",
  );
  assert.ok(
    deniedPrivate.run.status === "failed" || deniedPrivate.results.length > 0,
    "The unaware NPC scope must be denied or return an explicit filtered result.",
  );
  const allowedPrivate = await runToolSearch(
    mainBaseUrl,
    sessionId,
    presentNpcId,
    "silver-crescent route slip",
  );
  assertSucceeded(allowedPrivate.run, "Allowed private memory retrieval");
  assert.ok(
    allowedPrivate.results.some((content) =>
      content.includes("silver-crescent"),
    ),
    "The authored recipient may retrieve the private fact.",
  );
  const unknownNpcId = "npc:upgrade-unknown";
  assert.ok(
    !created.gameDefinition.npcs.some((npc) => npc.id === unknownNpcId),
  );
  assert.throws(
    () => databaseRef.current.getRecentHistory(sessionId, 24, unknownNpcId),
    /NPC tidak ditemukan pada session\./,
  );
  assert.throws(
    () =>
      databaseRef.current.searchMemory(
        sessionId,
        "silver-crescent route slip",
        unknownNpcId,
      ),
    /NPC tidak ditemukan pada session\./,
  );
  const deniedUnknownNpc = await runToolSearch(
    mainBaseUrl,
    sessionId,
    unknownNpcId,
    "silver-crescent route slip",
    true,
  );
  assert.ok(
    deniedUnknownNpc.results.every(
      (content) => !content.includes("silver-crescent"),
    ),
  );
  assert.ok(
    deniedUnknownNpc.run.status === "failed" ||
      deniedUnknownNpc.results.length > 0,
    "Unknown NPC scope must be rejected or return an explicit filtered result.",
  );

  const resourceId = Object.keys(created.gameDefinition.player.resources)[0];
  assert.ok(
    resourceId,
    "Sample game must have a bounded resource for deterministic effect control.",
  );
  const resourceBefore = privateResult.after.state.resources[resourceId];
  const exactlyOnceFact =
    "The route ledger was balanced after the water purchase.";
  const effectRun = await runRequest({
    base: mainBaseUrl,
    sessionId,
    kind: "turn",
    input: "Balance the route ledger and collect the agreed seven coins.",
    outputs: [
      narrative({
        effects: [
          {
            type: "RESOURCE_CHANGE",
            target: resourceId,
            operation: "ADD",
            value: 7,
          },
          { type: "ADD_FACT", text: exactlyOnceFact },
        ],
      }),
    ],
  });
  assertSucceeded(effectRun.run, "Idempotent effects turn");
  assert.equal(effectRun.after.state.resources[resourceId], resourceBefore + 7);
  assert.equal(
    effectRun.after.state.facts.filter((fact) => fact.text === exactlyOnceFact)
      .length,
    1,
  );

  const beforeReopenProviderCalls = providerCalls;
  const beforeReopenTrace = providerTrace.length;
  databaseRef.current.close();
  databaseRef.current = new databaseApi.GameDatabase(fixturePath);
  databaseHandles.add(databaseRef.current);
  const retry = await postJson(
    mainBaseUrl,
    `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      requestId: effectRun.requestId,
      expectedRevision: effectRun.beforeRevision,
      input: "Balance the route ledger and collect the agreed seven coins.",
    },
  );
  expectStatus(retry, [202], "Retrying committed request after SQLite reopen");
  const retriedRun = await waitForRun(
    mainBaseUrl,
    sessionId,
    effectRun.requestId,
  );
  assertSucceeded(retriedRun, "Committed retry after reopen");
  assert.equal(
    providerCalls,
    beforeReopenProviderCalls,
    "Committed retry must not call the provider.",
  );
  assert.equal(providerTrace.length, beforeReopenTrace);
  const afterRetry = readSession(await getSession(mainBaseUrl, sessionId));
  assert.equal(afterRetry.state.resources[resourceId], resourceBefore + 7);
  assert.equal(
    afterRetry.state.facts.filter((fact) => fact.text === exactlyOnceFact)
      .length,
    1,
  );

  const saveResponse = await requestJson(
    mainBaseUrl,
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/save`,
  );
  expectStatus(saveResponse, [200], "Exporting lore-bound v2 save");
  const saveBundle = saveResponse.body;
  assert.equal(saveBundle.format, "fworld-save");
  assert.equal(saveBundle.version, 2);
  assert.ok(Array.isArray(saveBundle.loreDependencies));
  assert.equal(saveBundle.loreDependencies.length, 1);
  const packExport = await requestJson(
    mainBaseUrl,
    "GET",
    `${catalog.basePath}/export`,
  );
  expectStatus(packExport, [200], "Exporting portable lore dependency");
  assert.equal(packExport.body.pack.id, pack.pack.id);
  assert.equal(packExport.body.pack.version, pack.pack.version);
  assert.equal(packExport.body.entries.length, pack.entries.length);

  const longReplay = await verifyLongReplay(
    mainBaseUrl,
    sessionId,
    databaseRef,
  );
  const lateWorld = await assertWorld(
    mainBaseUrl,
    sessionId,
    "loc:morroc",
    "Morroc",
  );
  assert.ok(
    hasWorldPeople(lateWorld),
    "World projection should expose permitted local people.",
  );

  const catalogRecallAt5 = catalog.recall;
  const telemetry = {
    providerPromptChars: percentiles(
      providerTrace.map((trace) => trace.contextChars),
    ),
    runtimeContextChars: percentiles(
      observedTelemetry.map((entry) => entry.contextChars),
    ),
    runtimeApproximateTokens: percentiles(
      observedTelemetry.map((entry) => entry.approximateTokens),
    ),
    tokenEstimateMethods: [
      ...new Set(observedTelemetry.map((entry) => entry.tokenEstimateMethod)),
    ],
    localEndToEndMs: percentiles(endToEndMs),
    capturedPrompts: providerTrace.length,
    promptDigests: providerTrace
      .slice(0, 4)
      .map(({ sha256, contextChars }) => ({ sha256, contextChars })),
  };
  assert.ok(
    providerTrace.every((trace) => trace.contextChars <= 24_000),
    "Captured narrator prompts must remain within the 24,000 character cap.",
  );
  assert.ok(
    observedTelemetry.every((entry) => entry.contextChars <= 24_000),
    "Persisted narrator context telemetry must remain within the 24,000 character cap.",
  );
  assert.ok(
    observedTelemetry.every((entry) =>
      Number.isFinite(entry.approximateTokens),
    ),
    "Runtime telemetry must include token estimates.",
  );
  const portability = await verifyPortability(
    packExport.body,
    saveBundle,
    join(tempDirectory, "portable.sqlite"),
  );
  assert.equal(
    blockedExternalFetches,
    0,
    "No external fetch may escape the deterministic provider stub.",
  );

  return {
    status: "passed",
    invocation: serve
      ? "node scripts/upgrade-verify.mjs --serve"
      : "node scripts/upgrade-verify.mjs",
    mode: serve
      ? "isolated-http-static-server"
      : "isolated-http-ephemeral-port",
    canonicalUrl: serve ? CANONICAL_ORIGIN : undefined,
    origin: CANONICAL_ORIGIN,
    httpBaseUrl: mainBaseUrl,
    fixture: {
      packId: pack.pack.id,
      packVersion: pack.pack.version,
      entries: pack.entries.length,
      publishedDigest: catalog.published.digest,
      gameId,
      sessionId,
    },
    runtime: {
      http: "createHttpServer",
      database: "temporary file-backed SQLite",
    },
    providerBoundary: {
      protocol: "OpenRouter-compatible chat-completions",
      fakeCredentialVerified: true,
      deterministicResponses: true,
      requests: providerCalls,
      blockedExternalFetches,
    },
    coverage: {
      importDryRunAndPublish: true,
      pagedBrowseSearchPreviewAndBinding: true,
      sessionStartOpening: true,
      pronteraToMorrocAndNpcLocality: reporterNpcLocality,
      emptySuggestions: emptyChoicesVerified,
      conversationDoesNotTeleport: true,
      unknownDestinationPreservesStateAndRevision: true,
      discoverySourceGate: true,
      privateUnawareAndUnknownNpcRetrieval: true,
      effectsExactlyOnceAcrossDatabaseReopen: true,
      longReplay,
      portableSaveAndBackupRestore: portability,
      deterministicProposalFailures: [
        "wrong-location discovery",
        "conversation destination mention",
        "unknown destination",
        "undeclared flag",
      ],
    },
    metrics: {
      catalogBrowseRecallAt5: catalogRecallAt5,
      runtimeLoreRecallAtK: runtimeRecallAtK,
      narratorContext: telemetry,
      capturedPrompts: telemetry.capturedPrompts,
      promptDigests: telemetry.promptDigests,
      actualBilledUsage: "NOT_VERIFIED",
      naturalLanguageContradictionRate:
        "NOT_VERIFIED; offline structural assertions only",
    },
    residualBlockedInterfaces: [
      "Real provider authentication, billing, and natural-language quality are not exercised by the offline boundary stub.",
      "P4 external/wiki ingestion and large-corpus benchmarks are excluded by contract.",
      "Browser UI smoke is separate; run this script with --serve for its isolated fixture.",
    ],
  };
}

async function cleanup() {
  await closeHttpServer(portabilityHttpServer).catch(() => {});
  await closeHttpServer(mainHttpServer).catch(() => {});
  for (const database of databaseHandles) {
    try {
      database.close();
    } catch {}
  }
  await vite?.close().catch(() => {});
  globalThis.fetch = originalFetch ?? globalThis.fetch;
  for (const name of ISOLATED_ENV_NAMES) {
    if (!savedEnvironment.has(name)) continue;
    const previous = savedEnvironment.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  if (tempDirectory && !keepTempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

try {
  const report = await runAcceptance();
  acceptanceComplete = true;
  console.log(JSON.stringify(report, null, 2));
  if (serve) {
    keepTempDirectory = true;
    console.log(`READY ${CANONICAL_ORIGIN}`);
    await new Promise((resolveShutdown) => {
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolveShutdown();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    keepTempDirectory = false;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "failed", error: message }));
  process.exitCode = 1;
} finally {
  await cleanup();
}
