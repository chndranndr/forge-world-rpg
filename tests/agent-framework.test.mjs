import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer } from "vite";

const GOOGLE = "https://generativelanguage.googleapis.com";
const CACHE_URL = `${GOOGLE}/v1beta/cachedContents`;
const GENERATE_URL = (model) =>
  `${GOOGLE}/v1beta/models/${model}:generateContent`;

let server;
let agent;
let contextModule;
let runtimeModule;
let cacheModule;
let serverApi;

test.before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [agent, contextModule, runtimeModule, cacheModule, serverApi] =
    await Promise.all([
      server.ssrLoadModule("/server/agent.ts"),
      server.ssrLoadModule("/server/agent/context.ts"),
      server.ssrLoadModule("/server/agent/runtime.ts"),
      server.ssrLoadModule("/server/agent/gemini-cache.ts"),
      server.ssrLoadModule("/server/main.ts"),
    ]);
});

test.after(async () => {
  await server?.close();
});

function makeSession(provider = "gemini", model = "gemini-2.5-flash") {
  const definitionSnapshot = {
    id: "game-1",
    title: "Kedai Senja",
    scenario: { setting: "Kedai kecil.", startingSituation: "Hujan turun." },
    attributes: [
      { id: "charm", name: "Charm", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [{ id: "yen", name: "Yen", min: 0, initialValue: 100 }],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [
      {
        id: "umbrella",
        name: "Umbrella",
        description: "A blue umbrella.",
        stackable: false,
        consumable: false,
        effects: [],
        tags: ["rain"],
      },
    ],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [
      {
        id: "aiko",
        name: "Aiko",
        description: "A photographer.",
        personality: ["quiet"],
        goals: ["find her brother"],
        privateKnowledge: ["She knows the lighthouse secret."],
        initialRelationships: { trust: 0 },
      },
    ],
    startingInventory: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    id: "session-1",
    gameId: definitionSnapshot.id,
    definitionSnapshot,
    state: {
      attributes: { charm: 5 },
      resources: { yen: 100 },
      inventory: [{ itemId: "umbrella", quantity: 1 }],
      relationships: [{ npcId: "aiko", values: { trust: 3 } }],
      facts: [
        {
          id: "public-1",
          text: "Ren works at the cafe.",
          visibility: "public",
          knownBy: [],
          createdAt: "2026-10-01T00:00:00.000Z",
          source: "story",
        },
        {
          id: "private-1",
          text: "Ren entered the lighthouse last night.",
          visibility: "private",
          knownBy: [],
          createdAt: "2026-10-01T00:00:00.000Z",
          source: "story",
        },
      ],
      world: {
        location: "Cafe Nami",
        time: "19:45",
        scene: "Aiko waits by the window.",
        activeCharacters: ["player", "aiko"],
      },
    },
    ai: { provider, model },
    nextSequence: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function makeInput(overrides = {}) {
  return {
    session: makeSession(),
    history: [],
    kind: "turn",
    playerAction: "I offer Aiko my umbrella.",
    providerKey: "server-only-test-key",
    searchMemory: async () => [],
    onAttemptStart: () => {},
    onAttemptFinish: () => {},
    ...overrides,
  };
}

function textReply(
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

function lengthReply(text) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "MAX_TOKENS",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
  };
}

function toolReply(name, args, { thoughtSignature, usage } = {}) {
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
    usageMetadata: {
      ...(usage ?? { promptTokenCount: 100, candidatesTokenCount: 10 }),
    },
  };
}

function cacheCreateReply(expireAt, tokenCount = 42) {
  return {
    name: `cachedContents/${randomUUID().replaceAll("-", "")}`,
    expireTime: new Date(expireAt).toISOString(),
    ...(tokenCount === null
      ? {}
      : { usageMetadata: { totalTokenCount: tokenCount } }),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function staticParts(prompt, system, extra = {}) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: system }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: "search_memory",
            description: "search",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { maxOutputTokens: 4096 },
    ...extra,
  };
}

function makeContext(overrides = {}) {
  return {
    system: "SYSTEM PROMPT with private lighthouse secret.",
    prompt: JSON.stringify({
      kind: "turn",
      playerAction: "I offer Aiko my umbrella.",
      context: {
        game: { title: "Kedai Senja" },
        scenario: { setting: "Kedai kecil." },
        player: { name: "Ren" },
        state: { facts: { public: [] } },
      },
      recentMessages: [],
    }),
    stablePrompt: JSON.stringify({
      format: "fworld-knowledge-v1",
      context: {
        game: { title: "Kedai Senja" },
        scenario: { setting: "Kedai kecil." },
        player: { name: "Ren" },
      },
    }),
    dynamicPrompt: JSON.stringify({
      kind: "turn",
      playerAction: "I offer Aiko my umbrella.",
      context: {
        state: { facts: { public: [] } },
        knowledgeFormat: "fworld-knowledge-v1",
      },
      recentMessages: [],
    }),
    audience: { kind: "player" },
    telemetry: {
      contextChars: 0,
      approximateTokens: 0,
      tokenEstimateMethod: "test",
      sections: {},
      selectedLoreIds: [],
      omissions: [],
      toolCalls: 0,
      repairs: 0,
    },
    ...overrides,
  };
}

function transport(handler) {
  const generated = [];
  const created = [];
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url === CACHE_URL) {
      created.push({ body, init });
      return handler.create(body, created.length, init);
    }
    if (url.includes(":generateContent")) {
      generated.push({ url, body, init });
      return handler.generate(body, generated.length, init);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetch: fetchImpl, generated, created };
}

function clientWith(
  handler,
  { now = () => Date.now(), mode = "explicit" } = {},
) {
  const fake = transport(handler);
  const client = new cacheModule.GeminiContextCache({
    mode,
    fetch: fake.fetch,
    now,
  });
  return { client, ...fake };
}

const DEFAULT_SCOPE = {};

async function acquire(
  client,
  {
    scope = DEFAULT_SCOPE,
    model = "gemini-2.5-flash",
    apiKey = "cache-test-key",
    context = makeContext(),
    sessionId = "session-1",
    audience = context.audience,
    lorebookRefs = [],
    body = staticParts(context.prompt, context.system),
    signal = new AbortController().signal,
    onTrace,
  } = {},
) {
  const wrapper = client.fetchFor({
    provider: "gemini",
    databaseScope: scope,
    sessionId,
    audience,
    lorebookRefs,
    model,
    apiKey,
    context,
    signal,
    ...(onTrace ? { onTrace } : {}),
  });
  assert.ok(wrapper, "explicit cache should return a fetch wrapper");
  const response = await wrapper(GENERATE_URL(model), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return response;
}

test("stable knowledge is partitioned without actor-private or undiscovered data", () => {
  const session = makeSession();
  const undiscovered = {
    id: "lore:undiscovered-secret",
    kind: "secret",
    name: "Undiscovered secret",
    aliases: [],
    summary: "Canonical undiscovered summary.",
    body: "Canonical undiscovered body text.",
    tags: [],
    visibility: "discovery",
    metadata: { discoverAt: ["loc:elsewhere"] },
    provenance: { sourceId: "test" },
  };
  const handle = "discovery-candidate:opaque-handle";
  const context = contextModule.buildNarratorContext(
    {
      session,
      history: [
        {
          id: "m-1",
          sessionId: session.id,
          turnId: "t-1",
          sequence: 0,
          role: "PLAYER",
          content: "Private history marker.",
          visibility: "private",
          knownBy: [],
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      kind: "turn",
      playerAction: "I look around the cafe.",
      lore: [undiscovered],
    },
    new Map([[undiscovered.id, handle]]),
    new Map([[handle, undiscovered.id]]),
  );
  const stable = JSON.parse(context.stablePrompt);
  const dynamic = JSON.parse(context.dynamicPrompt);
  const full = JSON.parse(context.prompt);
  assert.deepEqual(stable, {
    format: "fworld-knowledge-v1",
    context: {
      game: full.context.game,
      scenario: full.context.scenario,
      player: full.context.player,
    },
  });
  assert.equal(dynamic.knowledgeFormat, undefined);
  assert.equal(dynamic.context.knowledgeFormat, "fworld-knowledge-v1");
  assert.deepEqual(
    { ...dynamic.context, knowledgeFormat: undefined },
    {
      ...Object.fromEntries(
        Object.entries(full.context).filter(
          ([key]) => !["game", "scenario", "player"].includes(key),
        ),
      ),
      knowledgeFormat: undefined,
    },
  );
  for (const secret of [
    "She knows the lighthouse secret.",
    "Private history marker.",
    "Canonical undiscovered summary.",
    "Canonical undiscovered body text.",
    "lore:undiscovered-secret",
    handle,
  ]) {
    assert.equal(context.stablePrompt.includes(secret), false, secret);
  }
  assert.equal(context.dynamicPrompt.includes(handle), true);
  assert.equal(context.dynamicPrompt.includes("private-1"), false);
  assert.deepEqual(context.audience, { kind: "player" });
  assert.ok(JSON.parse(context.stablePrompt).context.player.name === "Ren");
});

test("changed turns reuse one resource while identities stay isolated", async () => {
  let clock = Date.UTC(2026, 9, 20);
  const { client, created, generated } = clientWith(
    {
      create: () => jsonResponse(cacheCreateReply(clock + 300_000)),
      generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
    },
    { now: () => clock },
  );
  const scope = {};
  const first = makeContext();
  await acquire(client, { scope, context: first });
  assert.equal(created.length, 1);
  assert.equal(created[0].body.contents[0].parts[0].text, first.stablePrompt);
  assert.equal(generated[0].body.cachedContent !== undefined, true);
  assert.equal(generated[0].body.systemInstruction, undefined);
  assert.equal(generated[0].body.tools, undefined);
  assert.equal(generated[0].body.toolConfig, undefined);
  assert.equal(
    generated[0].body.contents[0].parts[0].text,
    first.dynamicPrompt,
  );
  assert.equal(generated[0].init.redirect, "error");

  const second = makeContext({
    prompt: JSON.stringify({
      kind: "turn",
      playerAction: "I step outside.",
      context: { state: { facts: { public: [] } } },
      recentMessages: [],
    }),
    dynamicPrompt: JSON.stringify({
      kind: "turn",
      playerAction: "I step outside.",
      context: {
        state: { facts: { public: [] } },
        knowledgeFormat: "fworld-knowledge-v1",
      },
      recentMessages: [],
    }),
  });
  await acquire(client, { scope, context: second });
  assert.equal(created.length, 1, "changed action/state must reuse");
  assert.equal(generated.length, 2);
  assert.match(generated[1].body.contents[0].parts[0].text, /I step outside/);
  assert.doesNotMatch(
    generated[1].body.contents[0].parts[0].text,
    /offer Aiko/,
  );

  const variants = [
    { context: makeContext({ stablePrompt: `${first.stablePrompt} ` }) },
    { context: makeContext({ system: "different system" }) },
    { model: "gemini-2.5-pro" },
    { sessionId: "session-2" },
    { audience: { kind: "npc", npcId: "aiko" } },
    { lorebookRefs: [{ packId: "pack", version: 1 }] },
    { apiKey: "rotated-key" },
    {
      body: staticParts(first.prompt, first.system, {
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_item_details",
                description: "item",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      }),
    },
  ];
  for (const variant of variants) {
    const before = created.length;
    await acquire(client, {
      scope,
      context: first,
      ...variant,
    });
    assert.equal(
      created.length,
      before + 1,
      `variant must create a new resource: ${JSON.stringify(
        Object.keys(variant),
      )}`,
    );
  }
  const otherScope = {};
  const beforeScope = created.length;
  await acquire(client, { scope: otherScope, context: first });
  assert.equal(created.length, beforeScope + 1, "scope must partition");
  await acquire(client, { scope, context: first });
  assert.equal(
    created.length,
    beforeScope + 1,
    "returning to the original identity reuses",
  );
});

test("expiry, capacity, and busy reservations bypass without unsafe reuse", async () => {
  let clock = Date.UTC(2026, 9, 20);
  const { client, created, generated } = clientWith(
    {
      create: () => jsonResponse(cacheCreateReply(clock + 10_000)),
      generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
    },
    { now: () => clock },
  );
  await acquire(client, { context: makeContext() });
  assert.equal(created.length, 1);
  clock += 6_000;
  await acquire(client, { context: makeContext() });
  assert.equal(created.length, 1, "inside the safety window must not reuse");
  assert.equal(generated.length, 2);
  assert.equal(generated[1].body.cachedContent, undefined);
  clock += 4_100;
  await acquire(client, { context: makeContext() });
  assert.equal(created.length, 2, "actual expiry allows a fresh resource");

  let capacityClock = Date.UTC(2026, 9, 21);
  const capacity = clientWith(
    {
      create: () => jsonResponse(cacheCreateReply(capacityClock + 300_000)),
      generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
    },
    { now: () => capacityClock },
  );
  for (let index = 0; index < 32; index += 1) {
    await acquire(capacity.client, {
      context: makeContext({
        stablePrompt: JSON.stringify({ index, format: "fworld-knowledge-v1" }),
      }),
    });
  }
  assert.equal(capacity.created.length, 32);
  await acquire(capacity.client, {
    context: makeContext({
      stablePrompt: JSON.stringify({
        index: 32,
        format: "fworld-knowledge-v1",
      }),
    }),
  });
  assert.equal(capacity.created.length, 32, "capacity must not create");
  assert.equal(capacity.generated.at(-1).body.cachedContent, undefined);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const busy = clientWith({
    create: async () => {
      await gate;
      return jsonResponse(cacheCreateReply(Date.now() + 300_000));
    },
    generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
  });
  const pending = acquire(busy.client, { context: makeContext() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(busy.created.length, 1);
  await acquire(busy.client, { context: makeContext() });
  assert.equal(
    busy.created.length,
    1,
    "concurrent acquisition must not create",
  );
  assert.equal(busy.generated.length, 1);
  assert.equal(busy.generated[0].body.cachedContent, undefined);
  release();
  await pending;
  assert.equal(busy.created.length, 1);

  let attempts = 0;
  const failing = clientWith({
    create: () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network down");
      return jsonResponse(cacheCreateReply(Date.now() + 300_000));
    },
    generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
  });
  await assert.rejects(
    acquire(failing.client, { context: makeContext() }),
    (error) => error instanceof cacheModule.ContextCacheError,
  );
  assert.equal(attempts, 1);
  await acquire(failing.client, { context: makeContext() });
  assert.equal(attempts, 2, "a failed reservation must not poison later runs");
});

test("provider_rejected creates are negatively cached but other failures fail closed", async () => {
  const traces = [];
  let creates = 0;
  const onTrace = (event) => traces.push(event);
  const rejected = clientWith({
    create: () => {
      creates += 1;
      return new Response("provider rejected cache size", { status: 400 });
    },
    generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
  });
  const context = makeContext();
  await acquire(rejected.client, { context, onTrace });
  assert.equal(creates, 1);
  assert.equal(rejected.generated.length, 1);
  assert.equal(
    rejected.generated[0].body.contents[0].parts[0].text,
    context.prompt,
    "provider rejection must send the original body",
  );
  assert.equal(rejected.generated[0].body.cachedContent, undefined);
  await acquire(rejected.client, { context, onTrace });
  assert.equal(creates, 1, "negative result must be reused");
  assert.ok(
    traces.filter(
      (event) =>
        event.kind === "cache" &&
        event.operation === "bypass" &&
        event.reason === "provider_rejected",
    ).length >= 2,
  );

  const failureModes = [
    async () => jsonResponse({ unexpected: true }),
    async () => new Response("nope", { status: 401 }),
    async () => new Response("nope", { status: 500 }),
    async () => {
      throw new TypeError("fetch failed");
    },
  ];
  for (const mode of failureModes) {
    const failing = clientWith({
      create: mode,
      generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
    });
    await assert.rejects(
      acquire(failing.client, { context: makeContext() }),
      (error) => error instanceof cacheModule.ContextCacheError,
    );
    assert.equal(failing.generated.length, 0);
  }

  let generationCalls = 0;
  const failureTraces = [];
  const cachedFailure = clientWith({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: () => {
      generationCalls += 1;
      return new Response("broken", { status: 500 });
    },
  });
  const response = await acquire(cachedFailure.client, {
    context: makeContext(),
    onTrace: (event) => failureTraces.push(event),
  });
  assert.equal(response.status, 500);
  assert.equal(generationCalls, 1, "cached failures must not be retried");
  assert.ok(
    failureTraces.some(
      (event) => event.kind === "cache" && event.operation === "invalidate",
    ),
  );
  await acquire(cachedFailure.client, { context: makeContext() });
  assert.equal(
    cachedFailure.created.length,
    1,
    "invalidated resources stay occupied until expiry",
  );
  assert.equal(cachedFailure.generated[1].body.cachedContent, undefined);
});

test("cache creation cancelled by the run signal is not installed", async () => {
  let releaseCreation;
  const gate = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  let signal;
  const gated = clientWith({
    create: async () => {
      await gate;
      return jsonResponse(cacheCreateReply(Date.now() + 300_000));
    },
    generate: () => jsonResponse(textReply('{"narrative":"ok"}')),
  });
  const controller = new AbortController();
  signal = controller.signal;
  const pending = acquire(gated.client, { context: makeContext(), signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));
  releaseCreation();
  await assert.rejects(
    pending,
    (error) => error instanceof cacheModule.ContextCacheError,
  );
  await acquire(gated.client, { context: makeContext() });
  assert.equal(
    gated.created.length,
    1,
    "an aborted creation cannot be reused or recreated before expiry",
  );
  assert.equal(gated.generated[0].body.cachedContent, undefined);
});

async function withGlobalFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function createCacheTransport({ create, generate, now = () => Date.now() }) {
  const fake = transport({ create, generate });
  const client = new cacheModule.GeminiContextCache({
    mode: "explicit",
    fetch: fake.fetch,
    now,
  });
  return { client, ...fake };
}

test("tool continuations use one cached resource but keep local tool authority", async () => {
  const searchCalls = [];
  const attempts = [];
  let telemetry;
  const cache = createCacheTransport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000, 64)),
    generate: (_body, call) =>
      jsonResponse(
        call === 1
          ? toolReply(
              "search_memory",
              { query: "lighthouse" },
              {
                thoughtSignature: "sig-abc",
                usage: { promptTokenCount: 1_000, candidatesTokenCount: 10 },
              },
            )
          : textReply(
              JSON.stringify({
                narrative: "The lamp glows over the harbour.",
                effects: [],
              }),
              {
                promptTokenCount: 500,
                candidatesTokenCount: 20,
                cachedContentTokenCount: 400,
                thoughtsTokenCount: 5,
              },
            ),
      ),
  });
  const session = makeSession();
  const result = await agent.runNarrator(
    makeInput({
      session,
      playerAction: "I ask Aiko about the lighthouse.",
      searchMemory: async (query, options) => {
        searchCalls.push({ query, options });
        return [
          {
            kind: "fact",
            id: "fact-1",
            text: "The lighthouse keeper left a note.",
            visibility: "public",
            knownBy: ["player", "aiko"],
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ];
      },
      onAttemptFinish: (event) => attempts.push(event),
      onContext: (value) => {
        telemetry = value;
      },
      contextCache: { client: cache.client, databaseScope: {} },
    }),
    {
      generateText: undefined,
    },
  );
  assert.equal(result.response.narrative, "The lamp glows over the harbour.");
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].query, "lighthouse");
  assert.equal(searchCalls[0].options.npcId, "aiko");
  assert.ok(searchCalls[0].options.signal);
  assert.equal(cache.created.length, 1);
  assert.equal(cache.generated.length, 2);
  const first = cache.generated[0].body;
  assert.equal(typeof first.cachedContent, "string");
  assert.equal(first.systemInstruction, undefined);
  assert.equal(first.tools, undefined);
  assert.equal(first.toolConfig, undefined);
  const firstText = first.contents[0].parts[0].text;
  assert.match(firstText, /I ask Aiko about the lighthouse/);
  assert.doesNotMatch(firstText, /Kedai Senja|Kedai kecil|Hujan turun/);
  const stableBody = cache.created[0].body.contents[0].parts[0].text;
  assert.match(stableBody, /Kedai Senja/);
  assert.doesNotMatch(stableBody, /Aiko|lighthouse secret|umbrella|I ask Aiko/);
  const continuation = cache.generated[1].body;
  assert.equal(continuation.cachedContent, first.cachedContent);
  assert.match(JSON.stringify(continuation.contents), /search_memory/);
  assert.match(JSON.stringify(continuation.contents), /sig-abc/);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    {
      step: attempts[0].step,
      usage: attempts[0].usage,
      cached: attempts[0].cachedInputTokens,
      reasoning: attempts[0].reasoningTokens,
      finishReason: attempts[0].finishReason,
    },
    {
      step: 1,
      usage: { inputTokens: 1_000, outputTokens: 10, totalTokens: 1_010 },
      cached: null,
      reasoning: null,
      finishReason: "tool-calls",
    },
  );
  assert.deepEqual(
    {
      step: attempts[1].step,
      usage: attempts[1].usage,
      cached: attempts[1].cachedInputTokens,
      reasoning: attempts[1].reasoningTokens,
      finishReason: attempts[1].finishReason,
    },
    {
      step: 2,
      usage: { inputTokens: 500, outputTokens: 25, totalTokens: 525 },
      cached: 400,
      reasoning: 5,
      finishReason: "stop",
    },
  );
  assert.ok(telemetry.trace.events.some((event) => event.kind === "tool"));
  assert.ok(
    telemetry.trace.events.some(
      (event) =>
        event.kind === "cache" &&
        event.operation === "create" &&
        event.tokenCount === 64,
    ),
  );
  assert.ok(
    telemetry.trace.events.some(
      (event) => event.kind === "cache" && event.operation === "reuse",
    ),
  );
  assert.equal(
    telemetry.trace.events.some(
      (event) => event.kind === "validation" && event.status === "accepted",
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(telemetry.trace),
    /She knows the lighthouse secret|private-1|discovery-candidate/,
  );
});

test("the third request disables tool calls after two tool rounds", async () => {
  const searches = [];
  const attempts = [];
  const session = makeSession();
  const fake = transport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call === 1)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      if (call === 2)
        return jsonResponse(
          toolReply("get_item_details", { itemId: "umbrella" }),
        );
      return jsonResponse(
        textReply(
          JSON.stringify({ narrative: "The lamp glows.", effects: [] }),
        ),
      );
    },
  });
  const result = await withGlobalFetch(fake.fetch, () =>
    agent.runNarrator(
      makeInput({
        session,
        searchMemory: async (query) => {
          searches.push(query);
          return [];
        },
        onAttemptFinish: (event) => attempts.push(event),
        contextCache: {
          client: new cacheModule.GeminiContextCache({ mode: "off" }),
          databaseScope: {},
        },
      }),
    ),
  );
  assert.equal(fake.generated.length, 3);
  assert.equal(searches.length, 1);
  assert.deepEqual(
    attempts.map((event) => event.finishReason),
    ["tool-calls", "tool-calls", "stop"],
  );
  assert.ok(fake.generated[0].body.tools?.length);
  assert.deepEqual(fake.generated[1].body.toolConfig, {
    functionCallingConfig: { mode: "AUTO" },
  });
  const finalBody = fake.generated[2].body;
  assert.equal(finalBody.tools, undefined);
  assert.equal(finalBody.toolConfig, undefined);
  assert.equal(finalBody.generationConfig.maxOutputTokens, 8_192);
  const finalContents = JSON.stringify(finalBody.contents);
  assert.match(finalContents, /functionResponse/);
  assert.match(finalContents, /lighthouse/);
  assert.match(finalContents, /umbrella/);
  assert.equal(result.response.narrative, "The lamp glows.");
});

test("invalid tool-followup proposals repair once with the exact check and no partial state", async () => {
  const checks = [];
  let repairBody;
  const cache = createCacheTransport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call === 1)
        return jsonResponse(
          toolReply("run_check", {
            attributeId: "charm",
            difficulty: 5,
            mode: "NORMAL",
          }),
        );
      if (call === 2)
        return jsonResponse(
          textReply(
            JSON.stringify({
              narrative: "Aiko nods.",
              effects: [
                {
                  type: "ATTRIBUTE_CHANGE",
                  target: "missing-attribute",
                  operation: "ADD",
                  value: 1,
                },
              ],
            }),
          ),
        );
      repairBody = _body;
      return jsonResponse(
        textReply(JSON.stringify({ narrative: "Aiko waits.", effects: [] })),
      );
    },
  });
  const session = makeSession();
  const result = await withGlobalFetch(cache.fetch, () =>
    agent.runNarrator(
      makeInput({
        session,
        onAttemptFinish: (event) => checks.push(event),
        contextCache: { client: cache.client, databaseScope: {} },
      }),
    ),
  );
  assert.equal(cache.generated.length, 3);
  const repairText = repairBody.contents[0].parts[0].text;
  const repair = JSON.parse(repairText);
  assert.equal(repair.correction.exactCheckResult.attributeId, "charm");
  assert.equal(
    repair.correction.exactCheckResult.outcome,
    result.check?.outcome,
  );
  assert.match(repair.correction.reason, /missing-attribute|tidak/i);
  assert.equal(repairBody.tools, undefined);
  assert.equal(repairBody.cachedContent, undefined);
  assert.equal(result.response.narrative, "Aiko waits.");
  assert.deepEqual(result.application.applied, []);
  assert.equal(
    result.application.state.attributes.charm,
    session.state.attributes.charm,
  );
  assert.equal(result.response.effects.length, 0);
  assert.equal(checks.length, 3);
});

test("explicit cache bypasses the final no-tools step and repairs an exhausted tool turn", async () => {
  const attempts = [];
  let telemetry;
  const cache = createCacheTransport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000, 64)),
    generate: (_body, call) => {
      if (call <= 2)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      if (call === 3) return jsonResponse(textReply("not valid json"));
      return jsonResponse(
        textReply(
          JSON.stringify({ narrative: "The lamp glows.", effects: [] }),
        ),
      );
    },
  });
  const result = await withGlobalFetch(cache.fetch, () =>
    agent.runNarrator(
      makeInput({
        session: makeSession(),
        searchMemory: async () => [],
        onAttemptFinish: (event) => attempts.push(event),
        onContext: (value) => {
          telemetry = value;
        },
        contextCache: { client: cache.client, databaseScope: {} },
      }),
    ),
  );
  assert.equal(cache.created.length, 1, "only the tool cache is created");
  assert.equal(cache.generated.length, 4);
  const first = cache.generated[0].body;
  const second = cache.generated[1].body;
  const final = cache.generated[2].body;
  const repair = cache.generated[3].body;
  assert.equal(typeof first.cachedContent, "string");
  assert.equal(second.cachedContent, first.cachedContent);
  assert.equal(final.cachedContent, undefined);
  assert.equal(final.tools, undefined);
  assert.equal(final.toolConfig, undefined);
  assert.ok(final.systemInstruction);
  // The final no-tools request keeps the full tool conversation; the fourth
  // request is the existing fresh repair (original prompt + correction).
  assert.match(JSON.stringify(final.contents), /functionResponse/);
  assert.match(JSON.stringify(final.contents), /lighthouse/);
  assert.equal(repair.cachedContent, undefined);
  assert.equal(repair.tools, undefined);
  assert.equal(repair.toolConfig, undefined);
  assert.equal(repair.generationConfig.maxOutputTokens, 8_192);
  const repairPrompt = repair.contents[0].parts[0].text;
  assert.match(repairPrompt, /correction/);
  assert.match(repairPrompt, /not valid json/);
  assert.match(repair.systemInstruction.parts[0].text, /knownNpcIdentities/);
  assert.deepEqual(
    attempts.map((event) => event.finishReason),
    ["tool-calls", "tool-calls", "stop", "stop"],
  );
  assert.equal(result.response.narrative, "The lamp glows.");
  const cacheTraces = telemetry.trace.events.filter(
    (event) => event.kind === "cache",
  );
  assert.equal(
    cacheTraces.filter(
      (event) =>
        event.operation === "bypass" && event.reason === "final_answer",
    ).length,
    1,
  );
  assert.equal(
    cacheTraces.filter(
      (event) => event.operation === "bypass" && event.reason === "repair",
    ).length,
    1,
  );
  assert.equal(
    cacheTraces.filter((event) => event.operation === "create").length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(telemetry.trace),
    /She knows the lighthouse secret|private-1/,
  );
});

test("a rejected fourth-request repair cannot make a fifth call or commit", async () => {
  let telemetry;
  const session = makeSession();
  const before = structuredClone(session.state);
  const cache = createCacheTransport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call <= 2)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      return jsonResponse(textReply("not valid json"));
    },
  });
  await assert.rejects(
    withGlobalFetch(cache.fetch, () =>
      agent.runNarrator(
        makeInput({
          session,
          searchMemory: async () => [],
          onContext: (value) => {
            telemetry = value;
          },
          contextCache: { client: cache.client, databaseScope: {} },
        }),
      ),
    ),
    (error) => {
      assert.ok(error instanceof runtimeModule.NarratorResponseError);
      assert.equal(error.repairs, 1);
      assert.match(error.message, /setelah satu kali perbaikan/);
      assert.doesNotMatch(error.message, /batas permintaan run ini habis/);
      return true;
    },
  );
  assert.equal(cache.generated.length, 4);
  assert.equal(cache.created.length, 1);
  assert.equal(cache.generated[3].body.tools, undefined);
  assert.equal(cache.generated[3].body.generationConfig.maxOutputTokens, 8_192);
  assert.deepEqual(session.state, before);
  assert.equal(
    telemetry.trace.events.filter(
      (event) => event.kind === "model" && event.status === "started",
    ).length,
    4,
  );
  assert.equal(
    telemetry.trace.events.filter((event) => event.kind === "repair").length,
    1,
  );
});

test("a truncated final answer after two tool rounds is repaired by the fourth request", async () => {
  const session = makeSession();
  const fake = transport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call <= 2)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      if (call === 3) return jsonResponse(lengthReply('{"narrative":"'));
      return jsonResponse(
        textReply(
          JSON.stringify({ narrative: "The lamp glows.", effects: [] }),
        ),
      );
    },
  });
  const result = await withGlobalFetch(fake.fetch, () =>
    agent.runNarrator(
      makeInput({
        session,
        searchMemory: async () => [],
        contextCache: {
          client: new cacheModule.GeminiContextCache({ mode: "off" }),
          databaseScope: {},
        },
      }),
    ),
  );
  assert.equal(fake.generated.length, 4);
  const repair = fake.generated[3].body;
  assert.equal(repair.tools, undefined);
  assert.equal(repair.generationConfig.maxOutputTokens, 8_192);
  const repairPrompt = JSON.parse(repair.contents[0].parts[0].text);
  assert.match(repairPrompt.correction.reason, /output token/i);
  assert.equal(result.response.narrative, "The lamp glows.");
});

test("the final failure reason follows the last attempt", async () => {
  const runFailure = async (finalReply, repairReply) => {
    const session = makeSession();
    const before = structuredClone(session.state);
    const fake = transport({
      create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
      generate: (_body, call) => {
        if (call <= 2)
          return jsonResponse(
            toolReply("search_memory", { query: "lighthouse" }),
          );
        if (call === 3) return jsonResponse(finalReply);
        return jsonResponse(repairReply);
      },
    });
    let failure;
    await assert.rejects(
      withGlobalFetch(fake.fetch, () =>
        agent.runNarrator(
          makeInput({
            session,
            searchMemory: async () => [],
            contextCache: {
              client: new cacheModule.GeminiContextCache({ mode: "off" }),
              databaseScope: {},
            },
          }),
        ),
      ),
      (error) => {
        assert.ok(error instanceof runtimeModule.NarratorResponseError);
        failure = error;
        return true;
      },
    );
    assert.equal(fake.generated.length, 4);
    assert.deepEqual(session.state, before);
    return failure;
  };

  const repairedLength = await runFailure(
    textReply("not valid json"),
    lengthReply('{"narrative":"'),
  );
  assert.equal(repairedLength.reason, "output_limit");
  assert.match(repairedLength.message, /terpotong/);
  assert.equal(repairedLength.repairs, 1);

  const initialLength = await runFailure(
    lengthReply('{"narrative":"'),
    textReply("not valid json"),
  );
  assert.equal(initialLength.reason, "invalid");
  assert.match(initialLength.message, /setelah satu kali perbaikan/);
  assert.doesNotMatch(initialLength.message, /terpotong/);
  assert.equal(initialLength.repairs, 1);
});

test("a rejected repair retries once more within the four-request cap", async () => {
  const session = makeSession();
  const fake = transport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call === 1)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      return jsonResponse(textReply("not valid json"));
    },
  });
  await assert.rejects(
    withGlobalFetch(fake.fetch, () =>
      agent.runNarrator(
        makeInput({
          session,
          searchMemory: async () => [],
          contextCache: {
            client: new cacheModule.GeminiContextCache({ mode: "off" }),
            databaseScope: {},
          },
        }),
      ),
    ),
    (error) => {
      assert.ok(error instanceof runtimeModule.NarratorResponseError);
      assert.equal(error.repairs, 2);
      return true;
    },
  );
  assert.equal(fake.generated.length, 4);
});

test("a second repair within the request cap commits the turn", async () => {
  const session = makeSession();
  const badEffect = JSON.stringify({
    narrative: "Aiko tersenyum.",
    effects: [
      {
        type: "RELATIONSHIP_CHANGE",
        npcId: "aiko",
        target: "attraction",
        operation: "ADD",
        value: 1,
      },
    ],
  });
  const goodEffect = JSON.stringify({
    narrative: "Aiko tersenyum.",
    effects: [
      {
        type: "RELATIONSHIP_CHANGE",
        npcId: "aiko",
        target: "trust",
        operation: "ADD",
        value: 1,
      },
    ],
  });
  const fake = transport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: (_body, call) => {
      if (call === 1)
        return jsonResponse(
          toolReply("search_memory", { query: "lighthouse" }),
        );
      if (call <= 3) return jsonResponse(textReply(badEffect));
      return jsonResponse(textReply(goodEffect));
    },
  });
  const result = await withGlobalFetch(fake.fetch, () =>
    agent.runNarrator(
      makeInput({
        session,
        searchMemory: async () => [],
        contextCache: {
          client: new cacheModule.GeminiContextCache({ mode: "off" }),
          databaseScope: {},
        },
      }),
    ),
  );
  assert.equal(fake.generated.length, 4);
  const secondRepair = JSON.parse(
    fake.generated[3].body.contents[0].parts[0].text,
  );
  assert.match(secondRepair.correction.reason, /attraction|tidak dikenal/);
  assert.match(secondRepair.correction.reason, /Id tersedia: trust/);
  assert.equal(result.response.narrative, "Aiko tersenyum.");
  assert.equal(
    result.application.state.relationships.find(
      (entry) => entry.npcId === "aiko",
    ).values.trust,
    session.state.relationships.find((entry) => entry.npcId === "aiko").values
      .trust + 1,
  );
});

test("abort, rejected attempt ledgers, and observer failures cannot report success", async () => {
  const finishes = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const pending = runtimeModule.runAgent(
    {
      provider: "gemini",
      model: "gemini-test",
      prepare: () => ({
        request: { model: { modelId: "fake" }, system: "s", prompt: "p" },
        validate: () => ({ kind: "accepted", value: "accepted" }),
        repair: () => ({
          model: { modelId: "fake" },
          system: "s",
          prompt: "p",
        }),
      }),
      onAttemptStart: async () => {},
      onAttemptFinish: async (event) => {
        finishes.push(event);
      },
      signal: controller.signal,
    },
    {
      generateText: async (options) => {
        await options.onLanguageModelCallStart({ callId: "call-1" });
        await gate;
        await options.onLanguageModelCallEnd({
          callId: "call-1",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          performance: { responseTimeMs: 1 },
        });
        return { text: "ok", finishReason: "stop" };
      },
    },
  );
  controller.abort(new Error("cancelled by test"));
  release();
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(
    finishes.some((event) => event.status === "succeeded"),
    false,
  );

  let started = 0;
  await assert.rejects(
    runtimeModule.runAgent(
      {
        provider: "gemini",
        model: "gemini-test",
        prepare: () => ({
          request: { model: { modelId: "fake" }, system: "s", prompt: "p" },
          validate: () => ({ kind: "accepted", value: "accepted" }),
          repair: () => ({
            model: { modelId: "fake" },
            system: "s",
            prompt: "p",
          }),
        }),
        onAttemptStart: () => {
          started += 1;
          throw new Error("ledger unavailable");
        },
        onAttemptFinish: async () => {},
      },
      {
        generateText: async (options) => {
          await options.onLanguageModelCallStart({ callId: "call-1" });
          return { text: "ok", finishReason: "stop" };
        },
      },
    ),
    /ledger unavailable/,
  );
  assert.equal(started, 1);
});

test("traces are bounded and unknown usage stays null", async () => {
  const collector = new runtimeModule.AgentTraceCollector();
  for (let index = 0; index < 130; index += 1) {
    collector.push({
      kind: "validation",
      status: "rejected",
      reason: "Respons narrator tidak valid.",
      textChars: 4,
    });
  }
  const bounded = collector.snapshot();
  assert.equal(bounded.events.length, 128);
  assert.equal(bounded.dropped, 2);

  const attempts = [];
  let telemetry;
  const cache = createCacheTransport({
    create: () => jsonResponse(cacheCreateReply(Date.now() + 300_000)),
    generate: () =>
      jsonResponse(
        textReply(JSON.stringify({ narrative: "Quiet.", effects: [] }), {
          promptTokenCount: 120,
          candidatesTokenCount: 8,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: 0,
        }),
      ),
  });
  await agent.runNarrator(
    makeInput({
      onAttemptFinish: (event) => attempts.push(event),
      onContext: (value) => {
        telemetry = value;
      },
      contextCache: { client: cache.client, databaseScope: {} },
    }),
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].cachedInputTokens, 0);
  assert.equal(attempts[0].reasoningTokens, 0);
  assert.equal(attempts[0].finishReason, "stop");
  assert.ok(telemetry.trace.events.length > 0);
  assert.ok(telemetry.trace.events.length <= 128);
  assert.doesNotMatch(
    JSON.stringify(telemetry.trace),
    /server-only-test-key|She knows the lighthouse secret|umbrella/,
  );
});

test("disabled, unsupported provider, and unsupported model bypasses stay honest", () => {
  const traces = [];
  const context = makeContext();
  const onTrace = (event) => traces.push(event);
  const options = {
    provider: "gemini",
    databaseScope: {},
    sessionId: "session-1",
    audience: { kind: "player" },
    lorebookRefs: [],
    model: "gemini-2.5-flash",
    apiKey: "cache-test-key",
    context,
    signal: new AbortController().signal,
    onTrace,
  };
  const disabled = new cacheModule.GeminiContextCache({ mode: "off" });
  assert.equal(disabled.fetchFor(options), undefined);
  assert.equal(traces.at(-1).reason, "disabled");

  const explicit = new cacheModule.GeminiContextCache({ mode: "explicit" });
  traces.length = 0;
  assert.equal(
    explicit.fetchFor({ ...options, provider: "openrouter" }),
    undefined,
  );
  assert.equal(traces.at(-1).reason, "unsupported_provider");
  for (const model of ["gemini-4-pro", "models/../evil", "gemini-2.0-flash"]) {
    traces.length = 0;
    assert.equal(explicit.fetchFor({ ...options, model }), undefined);
    assert.equal(traces.at(-1).reason, "unsupported_model");
  }
});

test("server rejects unknown cache modes before serving requests", () => {
  const previous = process.env.FWORLD_GEMINI_CONTEXT_CACHE;
  try {
    process.env.FWORLD_GEMINI_CONTEXT_CACHE = "maybe";
    assert.throws(
      () =>
        serverApi.createHttpServer(
          { current: null, path: "unused-framework-cache.sqlite" },
          {},
        ),
      /FWORLD_GEMINI_CONTEXT_CACHE harus off atau explicit/,
    );
  } finally {
    if (previous === undefined) delete process.env.FWORLD_GEMINI_CONTEXT_CACHE;
    else process.env.FWORLD_GEMINI_CONTEXT_CACHE = previous;
  }
});
