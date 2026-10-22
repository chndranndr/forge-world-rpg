import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpProbe } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_ORIGIN = "http://127.0.0.1:5173";
const GOOGLE_ORIGIN = "https://generativelanguage.googleapis.com";
const FAKE_KEY = "offline-framework-verify-key";
const MODEL = "gemini-2.5-flash";
const ENV_NAMES = [
  "FWORLD_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "FWORLD_GEMINI_CONTEXT_CACHE",
  "FWORLD_DATA_DIR",
  "FWORLD_BACKUP_DIR",
];

const savedEnvironment = new Map();
const loopbackOrigins = new Set();
const blockedFetches = [];
const cacheCreates = [];
const generations = [];
let cachePlan = [];
let generationPlan = [];
let phase = "setup";
let originalFetch;
let tempDirectory;
let vite;
let databaseApi;
let serverApi;
let db;
let httpServer;
let baseUrl;

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function narrative(text, { effects = [], choices = [] } = {}) {
  return JSON.stringify({ narrative: text, effects, choices });
}

function googleText(
  text,
  usage = { promptTokenCount: 100, candidatesTokenCount: 10 },
) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { ...usage },
  };
}

function googleTool(name, args, thoughtSignature) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { name, args },
              ...(thoughtSignature ? { thoughtSignature } : {}),
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 10 },
  };
}

function cacheSuccess(tokenCount) {
  return new Response(
    JSON.stringify({
      name: `cachedContents/${randomUUID().replaceAll("-", "")}`,
      expireTime: new Date(Date.now() + 300_000).toISOString(),
      usageMetadata: { totalTokenCount: tokenCount },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function installFetchBoundary() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (loopbackOrigins.has(url.origin)) return originalFetch(request);
    if (url.origin !== GOOGLE_ORIGIN) {
      blockedFetches.push(`${url.origin}${url.pathname}`);
      throw new Error(`Blocked outbound fetch to ${url.origin}${url.pathname}`);
    }
    assert.equal(
      request.headers.get("x-goog-api-key"),
      FAKE_KEY,
      "Google calls must use the isolated fake credential.",
    );
    if (url.pathname === "/v1beta/cachedContents") {
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "error");
      const body = JSON.parse(await request.text());
      cacheCreates.push({ phase, body });
      if (!cachePlan.length) {
        throw new Error("Unexpected offline cache creation.");
      }
      return cachePlan.shift()();
    }
    if (url.pathname === `/v1beta/models/${MODEL}:generateContent`) {
      const body = JSON.parse(await request.text());
      generations.push({ phase, body, redirect: request.redirect });
      if (!generationPlan.length) {
        throw new Error("Unexpected offline generation.");
      }
      return generationPlan.shift()();
    }
    blockedFetches.push(`${url.origin}${url.pathname}`);
    throw new Error(`Blocked unexpected Google path ${url.pathname}`);
  };
}

async function requestJson(method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
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
  return { status: response.status, body: parsed };
}

function expectStatus(result, expected, label) {
  assert.ok(
    expected.includes(result.status),
    `${label}: expected HTTP ${expected.join("/")}, got ${result.status} (${result.body?.code ?? "no code"}: ${result.body?.message ?? ""})`,
  );
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function reservePort() {
  const probe = createHttpProbe();
  const base = await listen(probe, 0);
  await closeServer(probe);
  return Number(new URL(base).port);
}

async function getSession(sessionId) {
  const result = await requestJson(
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  expectStatus(result, [200], "Reading session");
  return result.body;
}

async function getRun(sessionId, requestId) {
  const result = await requestJson(
    "GET",
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(requestId)}`,
  );
  expectStatus(result, [200], "Reading run");
  return result.body;
}

async function waitForRun(sessionId, requestId) {
  const deadline = Date.now() + 30_000;
  let run;
  do {
    run = await getRun(sessionId, requestId);
    if (run.status !== "running") return run;
    await wait(10);
  } while (Date.now() < deadline);
  throw new Error(`Run ${requestId} did not finish within 30 seconds.`);
}

async function startRun(kind, sessionId, input) {
  const requestId = input.requestId;
  const result = await requestJson(
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/${kind}`,
    input,
  );
  expectStatus(result, [202], `Starting ${kind}`);
  return waitForRun(sessionId, requestId);
}

function definition() {
  return {
    id: `framework-${randomUUID()}`,
    title: "Framework Fixture",
    description: "Offline protocol fixture.",
    genre: "test",
    tone: "calm",
    language: "en",
    scenario: {
      setting: "A foggy pier.",
      startingSituation: "Lanterns bob above black water.",
    },
    attributes: [
      { id: "charm", name: "Charm", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [{ id: "coin", name: "Coin", min: 0, initialValue: 10 }],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [
      {
        id: "lantern",
        name: "Lantern",
        description: "A brass lantern.",
        stackable: false,
        consumable: false,
        effects: [],
        tags: ["light"],
      },
    ],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [
      {
        id: "aiko",
        name: "Aiko",
        personality: ["calm"],
        goals: ["find the key"],
        privateKnowledge: ["Aiko keeps the lighthouse key."],
        initialRelationships: { trust: 1 },
      },
    ],
    startingInventory: [],
    updatedAt: new Date().toISOString(),
  };
}

async function createSession(game, expectedGameRevision) {
  const started = await requestJson("POST", "/api/sessions/start", {
    definition: game.value,
    ...(expectedGameRevision === undefined ? {} : { expectedGameRevision }),
    ai: { provider: "gemini", model: MODEL },
  });
  expectStatus(started, [201], "Starting session");
  return started.body.session;
}

function telemetryFor(sessionId, requestId) {
  const telemetry = db.getContextTelemetry(sessionId, requestId);
  assert.ok(telemetry, `Missing telemetry for ${requestId}`);
  return telemetry;
}

function traceFor(sessionId, requestId) {
  const telemetry = telemetryFor(sessionId, requestId);
  assert.ok(telemetry.trace, `Missing trace for ${requestId}`);
  return telemetry.trace;
}

async function run() {
  tempDirectory = await mkdtemp(join(tmpdir(), "fworld-framework-verify-"));
  for (const name of ENV_NAMES) savedEnvironment.set(name, process.env[name]);
  process.env.FWORLD_GEMINI_API_KEY = FAKE_KEY;
  process.env.GEMINI_API_KEY = FAKE_KEY;
  process.env.FWORLD_GEMINI_CONTEXT_CACHE = "explicit";
  process.env.FWORLD_DATA_DIR = join(tempDirectory, "fallback-data");
  process.env.FWORLD_BACKUP_DIR = join(tempDirectory, "fallback-backups");
  const envDir = join(tempDirectory, "vite-env");
  await mkdir(envDir, { recursive: true });
  installFetchBoundary();
  vite = await createViteServer({
    root: ROOT,
    envDir,
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, serverApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/main.ts"),
  ]);

  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  loopbackOrigins.add(baseUrl);
  db = new databaseApi.GameDatabase(join(tempDirectory, "framework.sqlite"));
  httpServer = serverApi.createHttpServer(
    { current: db, path: join(tempDirectory, "framework.sqlite") },
    {
      contextCacheMode: "explicit",
      allowedHosts: [`127.0.0.1:${port}`],
      allowedOrigins: [CANONICAL_ORIGIN],
      envFilePath: join(tempDirectory, "isolated-provider.env"),
      backupDirectory: join(tempDirectory, "backups"),
    },
  );
  const listening = await listen(httpServer, port);
  assert.equal(listening, baseUrl);

  const health = await requestJson("GET", "/api/health");
  expectStatus(health, [200], "Health");
  assert.equal(health.body.schemaVersion, 5);

  const gameDefinition = definition();
  const createdGame = await requestJson("POST", "/api/games", {
    definition: gameDefinition,
  });
  expectStatus(createdGame, [201], "Creating game");
  const first = await createSession(
    createdGame.body,
    createdGame.body.revision,
  );
  const firstSessionId = first.value.id;
  assert.equal(first.revision, 1);
  const games = await requestJson("GET", "/api/games");
  expectStatus(games, [200], "Listing games");
  const currentGame = games.body.find(
    (entry) => entry.value.id === createdGame.body.value.id,
  );
  assert.ok(currentGame, "Created game must be listed");
  const second = await createSession(createdGame.body, currentGame.revision);
  const secondSessionId = second.value.id;
  const gamesAfterSecond = await requestJson("GET", "/api/games");
  expectStatus(gamesAfterSecond, [200], "Listing games after second session");
  const thirdGame = gamesAfterSecond.body.find(
    (entry) => entry.value.id === createdGame.body.value.id,
  );
  assert.ok(thirdGame, "Created game must still be listed");
  const third = await createSession(createdGame.body, thirdGame.revision);
  const thirdSessionId = third.value.id;

  const scenarios = [];
  const traces = [];
  const revisionAfter = async (sessionId) =>
    (await getSession(sessionId)).revision;
  const recordScenario = async (name, sessionId, requestId, details) => {
    const runRecord = await getRun(sessionId, requestId);
    const trace = traceFor(sessionId, requestId);
    traces.push({ requestId, trace });
    const usage = await requestJson(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/usage?requestId=${encodeURIComponent(requestId)}`,
    );
    expectStatus(usage, [200], `Usage ${name}`);
    scenarios.push({
      name,
      status: runRecord.status,
      revision: await revisionAfter(sessionId),
      usage: {
        inputTokens: usage.body.inputTokens,
        outputTokens: usage.body.outputTokens,
        cachedInputTokens: usage.body.cachedInputTokens,
        reasoningTokens: usage.body.reasoningTokens,
        requests: usage.body.requests,
        failed: usage.body.statuses.failed,
      },
      traceEvents: trace.events.length,
      traceDropped: trace.dropped,
      ...details,
    });
  };

  phase = "opening";
  cachePlan = [() => cacheSuccess(60)];
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(
          googleText(
            narrative("The pier waits.", {
              effects: [
                {
                  type: "ATTRIBUTE_CHANGE",
                  target: "charm",
                  operation: "ADD",
                  value: 5,
                },
              ],
              choices: [{ id: "open-1", label: "Follow the lanterns" }],
            }),
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const openingRequest = randomUUID();
  let revision = (await getSession(firstSessionId)).revision;
  const opening = await startRun("opening", firstSessionId, {
    requestId: openingRequest,
    expectedRevision: revision,
  });
  revision = opening.result.session.revision;
  assert.equal(opening.status, "succeeded");
  assert.equal(opening.result.messages.length, 1);
  assert.equal(
    db.getSession(firstSessionId).state.attributes.charm,
    5,
    "opening effects must not be applied",
  );
  await recordScenario("opening", firstSessionId, openingRequest, {
    messages: opening.result.messages.length,
  });

  phase = "turn-tool";
  cachePlan = [() => cacheSuccess(80)];
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(googleTool("search_memory", { query: "pier" })),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    () =>
      new Response(
        JSON.stringify(
          googleText(
            narrative("The fog lifts; the charm of the pier returns.", {
              effects: [
                {
                  type: "ATTRIBUTE_CHANGE",
                  target: "charm",
                  operation: "ADD",
                  value: 1,
                },
              ],
            }),
            {
              promptTokenCount: 100,
              candidatesTokenCount: 20,
              cachedContentTokenCount: 600,
              thoughtsTokenCount: 4,
            },
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const turnRequest = randomUUID();
  const turnExpectedRevision = revision;
  const turn = await startRun("turns", firstSessionId, {
    requestId: turnRequest,
    expectedRevision: revision,
    input: "I look at the fog.",
  });
  revision = turn.result.session.revision;
  assert.equal(turn.status, "succeeded");
  const afterTurn = db.getSession(firstSessionId);
  assert.equal(afterTurn.state.attributes.charm, 6);
  assert.equal(afterTurn.revision, revision);
  await recordScenario("turn-tool", firstSessionId, turnRequest, {
    messages: db.getHistory(firstSessionId).length,
    toolContinuation: true,
  });

  phase = "turn-repair";
  generationPlan = [
    () =>
      new Response(JSON.stringify(googleText("not valid json")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(
        JSON.stringify(
          googleText(narrative("A calm night settles over the pier.")),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const repairRequest = randomUUID();
  const repair = await startRun("turns", firstSessionId, {
    requestId: repairRequest,
    expectedRevision: revision,
    input: "I wait for the tide.",
  });
  revision = repair.result.session.revision;
  assert.equal(repair.status, "succeeded");
  assert.equal(db.getSession(firstSessionId).revision, revision);
  await recordScenario("turn-repair", firstSessionId, repairRequest, {
    messages: db.getHistory(firstSessionId).length,
    repaired: true,
  });

  phase = "choices";
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(
          googleText(
            narrative("Two paths.", {
              choices: [
                { id: "path-1", label: "Cross the pier" },
                { id: "path-2", label: "Wait for dawn" },
              ],
            }),
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const choicesRequest = randomUUID();
  const beforeChoices = db.getSession(firstSessionId);
  const choices = await startRun("choices", firstSessionId, {
    requestId: choicesRequest,
    expectedRevision: revision,
  });
  assert.equal(choices.status, "succeeded");
  assert.equal(choices.result.choices.length, 2);
  assert.equal(db.getSession(firstSessionId).revision, beforeChoices.revision);
  await recordScenario("choices", firstSessionId, choicesRequest, {
    readOnly: true,
  });

  phase = "audience";
  cachePlan = [() => cacheSuccess(90)];
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(googleText(narrative("Aiko listens and says nothing."))),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const audienceRequest = randomUUID();
  const audience = await startRun("turns", firstSessionId, {
    requestId: audienceRequest,
    expectedRevision: revision,
    input: "Aiko, tell me about the lighthouse.",
  });
  revision = audience.result.session.revision;
  assert.equal(audience.status, "succeeded");
  await recordScenario("changed-audience", firstSessionId, audienceRequest, {
    audience: "npc",
  });

  phase = "duplicate";
  const generationCountBeforeDuplicate = generations.length;
  const duplicate = await requestJson(
    "POST",
    `/api/sessions/${encodeURIComponent(firstSessionId)}/turns`,
    {
      requestId: turnRequest,
      expectedRevision: turnExpectedRevision,
      input: "I look at the fog.",
    },
  );
  expectStatus(duplicate, [202], "Duplicate request");
  assert.equal(duplicate.body.status, "succeeded");
  await waitForRun(firstSessionId, turnRequest);
  assert.equal(
    generations.length,
    generationCountBeforeDuplicate,
    "duplicate request IDs must not call the provider",
  );
  assert.equal(db.getSession(firstSessionId).revision, revision);

  phase = "rejected-create";
  cachePlan = [() => new Response("too small", { status: 400 })];
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(googleText(narrative("Second session begins."))),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const rejectedRequest = randomUUID();
  let secondRevision = (await getSession(secondSessionId)).revision;
  const rejected = await startRun("turns", secondSessionId, {
    requestId: rejectedRequest,
    expectedRevision: secondRevision,
    input: "I enter the second story.",
  });
  secondRevision = rejected.result.session.revision;
  assert.equal(rejected.status, "succeeded");
  const rejectsBefore = cacheCreates.length;
  await recordScenario("provider-rejected", secondSessionId, rejectedRequest, {
    cacheCreates: 1,
  });

  phase = "negative-cache";
  generationPlan = [
    () =>
      new Response(
        JSON.stringify(googleText(narrative("Second session continues."))),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const negativeRequest = randomUUID();
  const negative = await startRun("turns", secondSessionId, {
    requestId: negativeRequest,
    expectedRevision: secondRevision,
    input: "I keep walking.",
  });
  secondRevision = negative.result.session.revision;
  assert.equal(negative.status, "succeeded");
  assert.equal(
    cacheCreates.length,
    rejectsBefore,
    "negative cache must suppress repeated creation",
  );
  await recordScenario("negative-cache", secondSessionId, negativeRequest, {
    cacheCreates: 0,
  });

  phase = "failed-generation";
  const beforeFailure = db.getSession(secondSessionId);
  const historyBeforeFailure = db.getHistory(secondSessionId).length;
  generationPlan = [
    () =>
      new Response(JSON.stringify({ error: { message: "offline failure" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  ];
  const failedRequest = randomUUID();
  const failed = await startRun("turns", secondSessionId, {
    requestId: failedRequest,
    expectedRevision: beforeFailure.revision,
    input: "I try again.",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "RUN_FAILED");
  assert.equal(db.getSession(secondSessionId).revision, beforeFailure.revision);
  assert.equal(
    db.getHistory(secondSessionId).length,
    historyBeforeFailure,
    "failed runs must not commit history",
  );
  await recordScenario("failed-generation", secondSessionId, failedRequest, {
    error: failed.error.code,
  });

  phase = "cache-unavailable";
  cachePlan = [() => new Response("cache down", { status: 500 })];
  generationPlan = [];
  const beforeCacheFailure = db.getSession(thirdSessionId);
  const cacheFailureHistory = db.getHistory(thirdSessionId).length;
  const cacheFailureRequest = randomUUID();
  const cacheFailure = await startRun("turns", thirdSessionId, {
    requestId: cacheFailureRequest,
    expectedRevision: beforeCacheFailure.revision,
    input: "I test the cache boundary.",
  });
  assert.equal(cacheFailure.status, "failed");
  assert.equal(cacheFailure.error.code, "CONTEXT_CACHE_UNAVAILABLE");
  assert.equal(
    db.getSession(thirdSessionId).revision,
    beforeCacheFailure.revision,
  );
  assert.equal(db.getHistory(thirdSessionId).length, cacheFailureHistory);
  assert.equal(
    generations.some((entry) => entry.phase === "cache-unavailable"),
    false,
  );
  await recordScenario(
    "cache-unavailable",
    thirdSessionId,
    cacheFailureRequest,
    {
      error: cacheFailure.error.code,
    },
  );

  const cacheCounts = {
    create: 0,
    reuse: 0,
    bypass: 0,
    invalidate: 0,
  };
  const bypassReasons = {};
  let cacheCreateFailures = 0;
  for (const { trace } of traces) {
    for (const event of trace.events) {
      if (event.kind !== "cache") continue;
      if (event.operation === "create" && event.status === "failed") {
        cacheCreateFailures += 1;
        continue;
      }
      cacheCounts[event.operation] += 1;
      if (event.operation === "bypass") {
        bypassReasons[event.reason ?? "null"] =
          (bypassReasons[event.reason ?? "null"] ?? 0) + 1;
      }
    }
  }
  assert.equal(cacheCounts.create, 3);
  assert.equal(cacheCreateFailures, 1);
  assert.equal(cacheCounts.reuse, 3);
  assert.equal(cacheCounts.invalidate, 0);
  assert.equal(bypassReasons.provider_rejected, 3);
  assert.equal(bypassReasons.repair, 1);

  const toolTrace = traceFor(firstSessionId, turnRequest);
  assert.ok(
    toolTrace.events.some(
      (event) => event.kind === "tool" && event.name === "search_memory",
    ),
  );
  const turnUsage = await requestJson(
    "GET",
    `/api/sessions/${encodeURIComponent(firstSessionId)}/usage?requestId=${encodeURIComponent(turnRequest)}`,
  );
  expectStatus(turnUsage, [200], "Tool-turn usage");
  assert.equal(turnUsage.body.cachedInputTokens, 600);
  assert.equal(turnUsage.body.reasoningTokens, 4);
  assert.equal(turnUsage.body.inputTokens, 1_000);
  assert.equal(turnUsage.body.outputTokens, 34);
  const audienceTrace = traceFor(firstSessionId, audienceRequest);
  assert.ok(
    audienceTrace.events.some(
      (event) => event.kind === "cache" && event.operation === "create",
    ),
  );

  const audienceDynamic = generations
    .filter((entry) => entry.phase === "audience")
    .at(-1).body.contents[0].parts[0].text;
  assert.match(audienceDynamic, /Aiko keeps the lighthouse key/);
  const stableAudience = cacheCreates
    .filter((entry) => entry.phase === "audience")
    .at(-1).body.contents[0].parts[0].text;
  assert.doesNotMatch(stableAudience, /Aiko keeps the lighthouse key/);
  assert.doesNotMatch(JSON.stringify(traces), /Aiko keeps the lighthouse key/);
  assert.deepEqual(blockedFetches, []);

  assert.equal(
    process.env.FWORLD_GEMINI_CONTEXT_CACHE,
    "explicit",
    "fixture environment must stay isolated",
  );

  return {
    status: "passed",
    mode: "offline-fixture",
    liveProvider: false,
    provider: `google-generativeai (${MODEL}) deterministic fixture`,
    scenarios,
    cache: {
      ...cacheCounts,
      bypassReasons,
      creations: cacheCreates.length,
      createFailures: cacheCreateFailures,
    },
    generationAttempts: generations.length,
    traces: traces.map(({ requestId, trace }) => ({
      requestId,
      events: trace.events,
      dropped: trace.dropped,
    })),
    unverified: [
      "live Gemini cachedContents creation and expiry",
      "reported cache-write billing and cost savings",
      "natural-language quality of cached generations",
    ],
  };
}

async function cleanup() {
  await closeServer(httpServer).catch(() => {});
  db?.close();
  await vite?.close();
  globalThis.fetch = originalFetch ?? globalThis.fetch;
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  const report = await run();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        mode: "offline-fixture",
        liveProvider: false,
        error: error instanceof Error ? error.message : String(error),
        blockedFetches,
        cacheCreates: cacheCreates.length,
        generationAttempts: generations.length,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
