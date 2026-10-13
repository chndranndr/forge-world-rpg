import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let agent;

test.before(async () => {
  server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  agent = await server.ssrLoadModule("/server/agent.ts");
});

test.after(async () => {
  await server?.close();
});

function makeSession(provider = "gemini") {
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
      {
        id: "unheld",
        name: "Sealed note",
        description: "Not in the inventory.",
        stackable: false,
        consumable: false,
        effects: [],
        tags: [],
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
    ai: {
      provider,
      model: provider === "gemini" ? "gemini-test" : "vendor/model-test",
    },
    nextSequence: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function makeInput(overrides = {}) {
  const session = makeSession();
  return {
    session,
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

function fakeStep(
  options,
  usage = { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
) {
  return (async () => {
    await options.onLanguageModelCallStart({ callId: "request-1" });
    await options.onLanguageModelCallEnd({
      callId: "request-1",
      usage,
      performance: { responseTimeMs: 37.6 },
    });
  })();
}

test("uses the session model, fixed request limits, compact context, and counts a JSON repair", async () => {
  const session = makeSession();
  const history = Array.from({ length: 30 }, (_, sequence) => ({
    id: `m-${sequence}`,
    sessionId: session.id,
    turnId: "turn-1",
    sequence,
    role: "PLAYER",
    content: `message-${sequence}`,
    visibility: "public",
    knownBy: ["player", "aiko"],
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const finished = [];
  let telemetry;
  let estimatedChars = 0;
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({
      session,
      history,
      playerAction: "I ask Aiko whether she would like my umbrella.",
      onAttemptFinish: (event) => finished.push(event),
      onContext: (value) => {
        telemetry = value;
      },
      estimateTokens: (chars) => {
        estimatedChars = chars;
        return {
          approximateTokens: Math.ceil(chars / 4),
          method: "test-ratio",
        };
      },
    }),
    {
      generateText: async (options) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(options.model.modelId, "gemini-test");
          assert.equal(options.maxRetries, 0);
          assert.equal(options.maxOutputTokens, 2400);
          assert.equal(options.stopWhen({ steps: [{}, {}] }), false);
          assert.equal(options.stopWhen({ steps: [{}, {}, {}] }), true);
          assert.equal(options.abortSignal.aborted, false);
          assert.deepEqual(Object.keys(options.tools).sort(), [
            "get_item_details",
            "get_npc_details",
            "run_check",
            "search_memory",
          ]);
          assert.doesNotMatch(options.prompt, /server-only-test-key/);
          const prompt = JSON.parse(options.prompt);
          assert.equal(
            prompt.context.activeNpcs[0].privateKnowledge,
            undefined,
          );
          assert.deepEqual(prompt.context.state.relationships, [
            { npcId: "aiko", id: "trust", name: "Trust", value: 3 },
          ]);
          assert.deepEqual(prompt.context.npcKnowledge.privateKnowledge, [
            "She knows the lighthouse secret.",
          ]);
          assert.doesNotMatch(options.prompt, /entered the lighthouse/);
          assert.equal(prompt.recentMessages.length, 24);
          assert.equal(prompt.recentMessages[0].content, "message-6");
          assert.equal(prompt.recentMessages.at(-1).content, "message-29");
        } else {
          assert.equal(options.tools, undefined);
          assert.match(JSON.parse(options.prompt).correction.reason, /JSON/);
        }
        await fakeStep(options);
        return {
          text:
            calls === 1
              ? "not json"
              : JSON.stringify({ narrative: "The rain eases.", effects: [] }),
        };
      },
    },
  );
  assert.equal(result.response.narrative, "The rain eases.");
  assert.equal(calls, 2);
  assert.equal(finished.length, 2);
  assert.equal(estimatedChars, telemetry.contextChars);
  assert.equal(telemetry.tokenEstimateMethod, "test-ratio");
  assert.ok(telemetry.contextChars <= 24_000);
  assert.ok(telemetry.sections.history.count > 0);
  assert.doesNotMatch(
    JSON.stringify(telemetry),
    /Aiko|umbrella|lighthouse|message-/,
  );
  assert.deepEqual(
    { ...finished[0], latencyMs: null },
    {
      step: 1,
      provider: "gemini",
      model: "gemini-test",
      status: "succeeded",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      latencyMs: null,
    },
  );
  assert.equal(finished[0].latencyMs, 38);
  assert.equal(finished[1].step, 2);
  assert.equal(finished[1].usage.totalTokens, 16);
});

test("gives choice generation a compact output budget and repairs token-limited responses", async () => {
  const session = makeSession("openrouter");
  const finished = [];
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({
      session,
      kind: "choices",
      playerAction: "",
      onAttemptFinish: (event) => finished.push(event),
    }),
    {
      generateText: async (options) => {
        calls += 1;
        assert.equal(options.maxOutputTokens, calls === 1 ? 2400 : 1800);
        if (calls === 1) {
          assert.match(options.system, /0–3 distinct/);
          assert.doesNotMatch(options.system, /exactly three|exactly 3/i);
          await fakeStep(options);
          return { text: '{"narrative":"', finishReason: "length" };
        }
        assert.equal(options.tools, undefined);
        assert.match(
          JSON.parse(options.prompt).correction.reason,
          /output token/i,
        );
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "Pilihan tersedia.",
            effects: [],
            choices: [
              { id: "a", label: "Tawarkan bantuan" },
              { id: "b", label: "Tanya kabar" },
              { id: "c", label: "Biarkan dia memilih" },
            ],
          }),
          finishReason: "stop",
        };
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(finished.length, 2);
  assert.equal(result.response.choices.length, 3);
});

test("accepts zero or fewer than three choices and rejects more than three", async () => {
  const session = makeSession("openrouter");
  let emptyCalls = 0;
  const empty = await agent.runNarrator(
    makeInput({ session, kind: "choices", playerAction: "" }),
    {
      generateText: async (options) => {
        emptyCalls += 1;
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "Aiko waits.",
            effects: [],
            choices: [],
          }),
        };
      },
    },
  );
  assert.equal(emptyCalls, 1);
  assert.deepEqual(empty.response.choices, []);
  let shortCalls = 0;
  const short = await agent.runNarrator(
    makeInput({ session, kind: "choices", playerAction: "" }),
    {
      generateText: async (options) => {
        shortCalls += 1;
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "Aiko waits.",
            effects: [],
            choices: [
              { id: "a", label: "Ask" },
              { id: "b", label: "Wait" },
            ],
          }),
        };
      },
    },
  );
  assert.equal(shortCalls, 1);
  assert.equal(short.response.choices.length, 2);

  let invalidCalls = 0;
  await assert.rejects(
    agent.runNarrator(
      makeInput({ session, kind: "choices", playerAction: "" }),
      {
        generateText: async (options) => {
          invalidCalls += 1;
          await fakeStep(options);
          return {
            text: JSON.stringify({
              narrative: "Aiko waits.",
              effects: [],
              choices: [
                { id: "a", label: "Ask" },
                { id: "b", label: "Wait" },
                { id: "c", label: "Leave" },
                { id: "d", label: "Return" },
              ],
            }),
          };
        },
      },
    ),
    (error) => error instanceof agent.NarratorResponseError,
  );
  assert.equal(invalidCalls, 2);
});

test("reports when choice generation remains truncated after repair", async () => {
  const session = makeSession("openrouter");
  await assert.rejects(
    agent.runNarrator(
      makeInput({ session, kind: "choices", playerAction: "" }),
      {
        generateText: async (options) => {
          await fakeStep(options);
          return { text: '{"narrative":"', finishReason: "length" };
        },
      },
    ),
    (error) => {
      assert.equal(error.name, "NarratorResponseError");
      assert.match(error.message, /terpotong/i);
      assert.match(error.message, /coba lagi/i);
      assert.doesNotMatch(error.message, /narrative|choices|token server/i);
      return true;
    },
  );
});

test("keeps one computed check through one repair within three provider requests", async () => {
  const finished = [];
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({ onAttemptFinish: (event) => finished.push(event) }),
    {
      generateText: async (options) => {
        calls += 1;
        if (calls === 1) {
          await options.onLanguageModelCallStart({ callId: "check-tool" });
          const check = await options.tools.run_check.execute({
            attributeId: "charm",
            difficulty: 5,
            mode: "OFF",
          });
          await options.onLanguageModelCallEnd({
            callId: "check-tool",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            performance: { responseTimeMs: 37 },
          });
          await options.onLanguageModelCallStart({ callId: "proposal" });
          await options.onLanguageModelCallEnd({
            callId: "proposal",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            performance: { responseTimeMs: 37 },
          });
          return {
            text: JSON.stringify({
              narrative: "Aiko agrees.",
              effects: [{ type: "ADD_ITEM", target: "missing", quantity: 1 }],
            }),
          };
        } else {
          assert.equal(options.tools, undefined);
          const prompt = JSON.parse(options.prompt);
          assert.equal(prompt.correction.exactCheckResult.score, 5);
          assert.equal(prompt.correction.exactCheckResult.outcome, "SUCCESS");
          await fakeStep(options);
          return {
            text: JSON.stringify({ narrative: "Aiko agrees.", effects: [] }),
          };
        }
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(finished.length, 3);
  assert.equal(result.check.score, 5);
  assert.equal(result.response.narrative, "Aiko agrees.");
});

test("tools validate snapshot IDs, cap scoped memory, and memoize only one distinct check", async () => {
  const memoryOptions = [];
  let checks;
  const result = await agent.runNarrator(
    makeInput({
      playerAction: "I ask Aiko about the old promise.",
      searchMemory: async (_query, options) => {
        memoryOptions.push(options);
        return Array.from({ length: 8 }, (_, index) => ({
          id: `memory-${index}`,
          text: "x".repeat(1_000),
          kind: "message",
          visibility: "private",
          knownBy: ["aiko"],
          turnId: "memory-turn",
          sequence: index,
          role: "NPC",
          speakerId: "aiko",
          createdAt: "2026-10-01T00:00:00.000Z",
        }));
      },
    }),
    {
      generateText: async (options) => {
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.get_npc_details.execute({ npcId: "missing" }),
          ),
          /interlocutor terpilih/,
        );
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.get_item_details.execute({ itemId: "missing" }),
          ),
          /Item ID tidak ada/,
        );
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.get_item_details.execute({ itemId: "unheld" }),
          ),
          /tidak ada di inventory/,
        );
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.search_memory.execute({
              query: "old",
              sessionId: "other",
            }),
          ),
        );
        assert.deepEqual(
          await options.tools.search_memory.execute({
            query: "other actor",
            npcId: "bima",
          }),
          [],
        );
        const hits = await options.tools.search_memory.execute({
          query: "old promise",
          npcId: "aiko",
        });
        assert.ok(hits.length <= 5);
        assert.ok(
          hits.reduce((sum, hit) => sum + hit.id.length + hit.text.length, 0) <=
            4000,
        );
        assert.ok(JSON.stringify(hits).length <= 4000);
        assert.equal(memoryOptions[0].npcId, "aiko");
        assert.equal(memoryOptions[0].limit, 5);
        assert.ok(memoryOptions[0].maxChars <= 4000);
        assert.ok(memoryOptions[0].maxChars > 0);
        assert.equal(memoryOptions[0].signal, options.abortSignal);
        assert.equal(hits[0].kind, "message");
        assert.equal(hits[0].sequence, 0);
        assert.equal(hits[0].speakerId, "aiko");
        assert.equal(Object.hasOwn(hits[0], "knownBy"), false);
        assert.equal(memoryOptions.length, 1);
        assert.deepEqual(
          await options.tools.search_memory.execute({ query: "second query" }),
          [],
        );
        const npc = await options.tools.get_npc_details.execute({
          npcId: "aiko",
        });
        assert.deepEqual(npc.knowledge.privateKnowledge, [
          "She knows the lighthouse secret.",
        ]);
        assert.equal(npc.relationship.trust, 3);
        const item = await options.tools.get_item_details.execute({
          itemId: "umbrella",
        });
        assert.equal(item.description, "A blue umbrella.");
        assert.equal(item.quantity, 1);

        const params = {
          attributeId: "charm",
          difficulty: 5,
          mode: "OFF",
        };
        const check = await options.tools.run_check.execute(params);
        assert.deepEqual(await options.tools.run_check.execute(params), check);
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.run_check.execute({ ...params, difficulty: 6 }),
          ),
          /Only one distinct check/,
        );
        checks = check;
        await fakeStep(options);
        return {
          text: JSON.stringify({ narrative: "Aiko accepts.", effects: [] }),
        };
      },
    },
  );
  assert.equal(result.check, checks);
  assert.equal(result.check.outcome, "SUCCESS");
  assert.equal(result.response.type, "narrative");
});

test("player memory search returns player-known facts without NPC-private facts", async () => {
  let searchOptions;
  let results;
  await agent.runNarrator(
    makeInput({
      playerAction: "I search the notes for the courier's letter.",
      searchMemory: async (_query, options) => {
        searchOptions = options;
        return [
          {
            id: "player-history",
            kind: "message",
            text: "The courier hid the letter by the west fountain.",
            sequence: 4,
            role: "NPC",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "public-route",
            kind: "fact",
            text: "The western road leads to the fountain.",
            visibility: "public",
            knownBy: [],
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "private-npc-note",
            kind: "fact",
            text: "Aiko keeps the lighthouse key.",
            visibility: "private",
            knownBy: ["aiko"],
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "player-secret-note",
            kind: "fact",
            text: "Ren knows where the courier hid the letter.",
            visibility: "private",
            knownBy: ["player"],
            createdAt: "2026-10-01T00:00:01.000Z",
          },
        ];
      },
    }),
    {
      generateText: async (options) => {
        results = await options.tools.search_memory.execute({
          query: "courier letter",
        });
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "The note is still readable.",
            effects: [],
          }),
        };
      },
    },
  );
  assert.equal(searchOptions.npcId, undefined);
  assert.deepEqual(
    results.map((hit) => [hit.kind, hit.id]),
    [
      ["message", "player-history"],
      ["fact", "public-route"],
      ["fact", "player-secret-note"],
    ],
  );
});

test("opening preserves narrative choices while leaving state effects to the caller", async () => {
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({ kind: "opening", playerAction: "" }),
    {
      generateText: async (options) => {
        calls += 1;
        assert.equal(options.tools, undefined);
        return {
          text: JSON.stringify({
            narrative: "The cafe opens.",
            effects: [
              { type: "ADD_FACT", text: "An ignored opening proposal." },
            ],
            world: {
              location: "Model-proposed location",
              scene: "Model-proposed scene",
            },
            choices: [
              { id: "choice-1", label: "Ask Bima" },
              { id: "choice-2", label: "Watch the door" },
            ],
          }),
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.response.effects.length, 1);
  assert.equal(result.response.choices.length, 2);
  assert.equal(result.response.narrative, "The cafe opens.");
});

test("uses OpenRouter only when selected in the session snapshot", async () => {
  const session = makeSession("openrouter");
  const result = await agent.runNarrator(makeInput({ session }), {
    generateText: async (options) => {
      assert.equal(options.model.modelId, "vendor/model-test");
      assert.match(options.model.provider, /openrouter/i);
      await fakeStep(options, undefined);
      return { text: JSON.stringify({ narrative: "Ready.", effects: [] }) };
    },
  });
  assert.equal(result.response.narrative, "Ready.");
});

test("fails the active attempt without fabricating usage after a provider error", async () => {
  const started = [];
  const finished = [];
  await assert.rejects(
    agent.runNarrator(
      makeInput({
        onAttemptStart: (event) => started.push(event),
        onAttemptFinish: (event) => finished.push(event),
      }),
      {
        generateText: async (options) => {
          await options.onLanguageModelCallStart({ callId: "failed-request" });
          throw new Error("provider unavailable");
        },
      },
    ),
    /provider unavailable/,
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].status, "started");
  assert.equal(started[0].usage, null);
  assert.equal(started[0].latencyMs, null);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "failed");
  assert.equal(finished[0].usage, null);
  assert.equal(typeof finished[0].latencyMs, "number");
});

test("keeps principal context scoped and unaffected by unrelated actors or items", async () => {
  const session = makeSession();
  const relationships = Array.from({ length: 180 }, (_, index) => ({
    id: `rel-${String(index).padStart(3, "0")}`,
    name: `Relationship ${String(index).padStart(3, "0")}`,
    min: -10,
    max: 10,
    defaultValue: 0,
  }));
  const npcs = ["aiko", "bima", "citra"].map((id) => ({
    id,
    name: id,
    description: `${id} waits nearby.`,
    personality: ["patient"],
    goals: ["keep the peace"],
    privateKnowledge: [`${id.toUpperCase()} private knowledge.`],
    initialRelationships: Object.fromEntries(
      relationships.map(({ id }) => [id, 0]),
    ),
  }));
  const valuesFor = (value) =>
    Object.fromEntries(relationships.map(({ id }) => [id, value]));
  session.definitionSnapshot.relationships = relationships;
  session.definitionSnapshot.npcs = npcs;
  session.state.relationships = npcs.map((npc, index) => ({
    npcId: npc.id,
    values: valuesFor([7, 3, -4][index]),
  }));
  session.state.world.activeCharacters = ["player", "aiko", "bima"];
  session.state.facts = [
    {
      id: "public-archive",
      text: "The archive opens at dusk.",
      visibility: "public",
      knownBy: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      source: "story",
    },
    {
      id: "aiko-fact",
      text: "Aiko knows the archive's hidden stair.",
      visibility: "private",
      knownBy: ["aiko"],
      createdAt: "2026-10-01T00:00:00.000Z",
      source: "story",
    },
    {
      id: "bima-fact",
      text: "Bima's private archive secret.",
      visibility: "private",
      knownBy: ["bima"],
      createdAt: "2026-10-01T00:00:00.000Z",
      source: "story",
    },
  ];
  const history = [
    {
      id: "public-message",
      sessionId: session.id,
      turnId: "turn-1",
      sequence: 0,
      role: "NARRATOR",
      content: "The public archive bell rings.",
      visibility: "public",
      knownBy: ["player"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "aiko-message",
      sessionId: session.id,
      turnId: "turn-2",
      sequence: 1,
      role: "NPC",
      speakerId: "aiko",
      content: "Aiko's archive clue.",
      visibility: "private",
      knownBy: ["player", "aiko"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "bima-message",
      sessionId: session.id,
      turnId: "turn-3",
      sequence: 2,
      role: "NPC",
      speakerId: "bima",
      content: "Bima's private archive conversation.",
      visibility: "private",
      knownBy: ["player", "bima"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "legacy-message",
      sessionId: session.id,
      turnId: "turn-4",
      sequence: 3,
      role: "NPC",
      speakerId: "bima",
      content: "Unknown legacy conversation.",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const storySummaries = [
    {
      sessionId: session.id,
      fromSequence: 0,
      toSequence: 3,
      summary: "The public archive clue.",
      sourceDigest: "public-digest",
      visibility: "public",
      knownBy: [],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      sessionId: session.id,
      fromSequence: 4,
      toSequence: 7,
      summary: "Aiko's earlier hidden-stair clue.",
      sourceDigest: "aiko-digest",
      visibility: "private",
      knownBy: ["aiko"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      sessionId: session.id,
      fromSequence: 8,
      toSequence: 11,
      summary: "Bima's unrelated private archive secret.",
      sourceDigest: "bima-digest",
      visibility: "private",
      knownBy: ["bima"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const lore = [
    {
      id: "aiko-lore",
      kind: "character",
      name: "Aiko archive notes",
      aliases: [],
      summary: "Aiko local notes.",
      body: "Aiko archive information.",
      tags: [],
      visibility: "narrator",
      metadata: { actorId: "aiko" },
      provenance: { sourceId: "test" },
    },
    {
      id: "bima-lore",
      kind: "character",
      name: "Bima private notes",
      aliases: [],
      summary: "Bima private notes.",
      body: "Bima's private lore secret.",
      tags: [],
      visibility: "narrator",
      metadata: { actorId: "bima" },
      provenance: { sourceId: "test" },
    },
  ];

  const runAndCapture = async (candidate) => {
    let captured;
    const result = await agent.runNarrator(
      makeInput({
        session: candidate,
        playerAction: "I ask Aiko about the archive.",
        history,
        storySummaries,
        lore,
      }),
      {
        generateText: async (options) => {
          const promptText = `${options.system}\n${options.prompt}`;
          const prompt = JSON.parse(options.prompt);
          const context = prompt.context;
          captured = promptText;
          assert.deepEqual(
            context.activeNpcs.map((npc) => npc.id),
            ["aiko", "bima"],
          );
          assert.ok(
            context.activeNpcs.every((npc) => !("privateKnowledge" in npc)),
          );
          assert.ok(context.state.relationships.length > 0);
          assert.ok(
            context.state.relationships.every(({ npcId }) => npcId === "aiko"),
          );
          assert.equal(
            context.state.relationships.find(({ id }) => id === "rel-000")
              .value,
            7,
          );
          assert.deepEqual(context.npcKnowledge.privateKnowledge, [
            "AIKO private knowledge.",
          ]);
          const serialized = JSON.stringify(prompt);
          assert.match(serialized, /Aiko knows the archive's hidden stair/);
          assert.match(serialized, /Aiko's earlier hidden-stair clue/);
          assert.match(serialized, /Aiko's archive clue/);
          assert.doesNotMatch(
            serialized,
            /Bima's private|Bima private|Unknown legacy/,
          );
          assert.ok(options.system.length + options.prompt.length <= 24_000);
          await assert.rejects(
            Promise.resolve().then(() =>
              options.tools.get_npc_details.execute({ npcId: "bima" }),
            ),
            /interlocutor terpilih/,
          );
          const details = await options.tools.get_npc_details.execute({
            npcId: "aiko",
          });
          assert.equal(details.relationship["rel-000"], 7);
          assert.deepEqual(details.knowledge.privateKnowledge, [
            "AIKO private knowledge.",
          ]);
          await fakeStep(options);
          return {
            text: JSON.stringify({
              narrative: "The scene continues.",
              effects: [],
            }),
          };
        },
      },
    );
    assert.equal(result.response.narrative, "The scene continues.");
    return captured;
  };

  const ordinaryPrompt = await runAndCapture(session);
  const expanded = structuredClone(session);
  expanded.definitionSnapshot.npcs.push(
    ...Array.from({ length: 1_000 }, (_, index) => ({
      id: `remote-${index}`,
      name: `Remote ${index}`,
      description: `Unrelated profile ${index}.`,
      personality: [],
      goals: [],
      privateKnowledge: [`Remote secret ${index}.`],
    })),
  );
  expanded.definitionSnapshot.items.push(
    ...Array.from({ length: 1_000 }, (_, index) => ({
      id: `unheld-${index}`,
      name: `Unheld ${index}`,
      description: `Unrelated item ${index}.`,
      stackable: false,
      consumable: false,
      effects: [],
      tags: [],
    })),
  );
  assert.equal(await runAndCapture(expanded), ordinaryPrompt);
});

test("fails before the provider when required context exceeds its limit", async () => {
  const session = makeSession();
  session.definitionSnapshot.player.description = "x".repeat(25_000);
  let providerCalled = false;
  await assert.rejects(
    agent.runNarrator(makeInput({ session }), {
      generateText: async () => {
        providerCalled = true;
        return { text: "{}" };
      },
    }),
    (error) => {
      assert.ok(error instanceof agent.NarratorContextError);
      assert.ok(error.actualChars > error.maxChars);
      assert.equal(error.maxChars, 24_000);
      assert.match(error.message, new RegExp(String(error.actualChars)));
      assert.match(error.message, /24,?000|24000/);
      assert.match(error.message, /ringkas konfigurasi game atau aksi pemain/i);
      return true;
    },
  );
  assert.equal(providerCalled, false);
});
test("only explicit NPC address grants private context or NPC-scoped tools", async () => {
  const session = makeSession();
  const npc = session.definitionSnapshot.npcs[0];
  npc.id = "sava";
  npc.name = "Sava";
  npc.privateKnowledge = ["Sava's private lighthouse clue."];
  session.state.relationships = [{ npcId: "sava", values: { trust: 3 } }];
  session.state.world.activeCharacters = ["player", "sava"];
  session.state.facts = [
    {
      id: "sava-secret",
      text: "Sava alone knows the lighthouse entrance.",
      visibility: "private",
      knownBy: ["sava"],
      createdAt: "2026-10-01T00:00:00.000Z",
      source: "story",
    },
  ];
  const history = [
    {
      id: "sava-private-message",
      sessionId: session.id,
      turnId: "sava-private-turn",
      sequence: 0,
      role: "NPC",
      speakerId: "sava",
      content: "Sava whispers about the hidden lighthouse stair.",
      visibility: "private",
      knownBy: ["sava"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const storySummaries = [
    {
      sessionId: session.id,
      fromSequence: 0,
      toSequence: 0,
      summary: "Sava secretly found a hidden lighthouse stair.",
      sourceDigest: "sava-digest",
      visibility: "private",
      knownBy: ["sava"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const lore = [
    {
      id: "sava-lore",
      kind: "character",
      name: "Sava's lighthouse clue",
      aliases: [],
      summary: "Sava knows the lighthouse stair.",
      body: "Sava alone knows the hidden lighthouse stair.",
      tags: [],
      visibility: "narrator",
      metadata: { actorId: "sava" },
      provenance: { sourceId: "test" },
    },
  ];

  assert.equal(
    agent.selectPrincipalNpc(
      session,
      "Privately ask Sava to show the lighthouse clue.",
    ),
    "sava",
  );
  assert.equal(
    agent.selectPrincipalNpc(session, "Sava, tell me about the lighthouse."),
    "sava",
  );
  assert.equal(
    agent.selectPrincipalNpc(
      session,
      "I remember a story about Sava and the lighthouse.",
    ),
    undefined,
  );
  assert.equal(
    agent.selectPrincipalNpc(
      session,
      "I remember asking Sava about the lighthouse.",
    ),
    undefined,
  );
  assert.equal(
    agent.selectPrincipalNpc(
      session,
      "I ask Sava's friend about the lighthouse.",
    ),
    undefined,
  );

  const capture = async (playerAction, addressed) => {
    let memorySearches = 0;
    const result = await agent.runNarrator(
      makeInput({
        session,
        history,
        playerAction,
        storySummaries,
        lore,
        searchMemory: async () => {
          memorySearches += 1;
          return [];
        },
      }),
      {
        generateText: async (options) => {
          const prompt = JSON.parse(options.prompt);
          const context = prompt.context;
          const serialized = JSON.stringify(prompt);
          if (addressed) {
            assert.deepEqual(context.actorScope, {
              kind: "npc",
              npcId: "sava",
            });
            assert.deepEqual(context.npcKnowledge.privateKnowledge, [
              "Sava's private lighthouse clue.",
            ]);
            assert.match(
              serialized,
              /Sava alone knows the lighthouse entrance/,
            );
            assert.match(
              serialized,
              /Sava whispers about the hidden lighthouse stair/,
            );
            assert.match(
              serialized,
              /Sava secretly found a hidden lighthouse stair/,
            );
            assert.match(
              serialized,
              /Sava alone knows the hidden lighthouse stair/,
            );
            assert.deepEqual(
              await options.tools.search_memory.execute({
                query: "lighthouse",
                npcId: "another-npc",
              }),
              [],
            );
            await assert.rejects(
              Promise.resolve().then(() =>
                options.tools.get_npc_details.execute({ npcId: "another-npc" }),
              ),
              /interlocutor terpilih/,
            );
          } else {
            assert.deepEqual(context.actorScope, { kind: "player-narrator" });
            assert.equal(context.npcKnowledge, null);
            assert.deepEqual(context.state.relationships, []);
            assert.doesNotMatch(
              serialized,
              /Sava's private lighthouse clue|Sava alone knows|Sava whispers|Sava secretly found/,
            );
            await assert.rejects(
              Promise.resolve().then(() =>
                options.tools.get_npc_details.execute({ npcId: "sava" }),
              ),
              /interlocutor terpilih/,
            );
            assert.deepEqual(
              await options.tools.search_memory.execute({
                query: "lighthouse",
                npcId: "sava",
              }),
              [],
            );
          }
          await fakeStep(options);
          return {
            text: JSON.stringify({
              narrative: "The scene continues.",
              effects: [],
            }),
          };
        },
      },
    );
    assert.equal(result.response.type, "narrative");
    assert.equal(memorySearches, 0);
  };

  await capture("I ask Sava about the lighthouse.", true);
  await capture("Sava, tell me about the lighthouse.", true);
  await capture("I remember a story about Sava and the lighthouse.", false);
});

test("hides actor-bound lore from a different principal", async () => {
  const session = makeSession();
  session.state.world.location = "Cafe Nami";
  session.state.world.locationId = "loc:cafe";
  session.state.world.discoveredLoreIds = [];
  const worldMap = {
    locations: [
      { id: "loc:cafe", name: "Cafe Nami", aliases: [], npcIds: ["aiko"] },
    ],
    connections: [],
    flags: {},
  };
  const secret = {
    id: "secret:bima-mural",
    kind: "other",
    name: "Bima's sealed mural note",
    aliases: [],
    summary: "Only Bima knows the writing behind the frame.",
    body: "Bima alone can read the hidden inscription.",
    tags: [],
    visibility: "discovery",
    metadata: {
      actorId: "bima",
      discoverAt: ["loc:cafe"],
      discoveryKeywords: ["mural"],
    },
    provenance: { sourceId: "test" },
  };
  const playerAction = "Aiko, I inspect the mural.";
  const prompts = [];
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({
      session,
      playerAction,
      worldMap,
      lore: [secret],
      effectContext: { worldMap, loreEntries: [secret], playerAction },
    }),
    {
      generateText: async (options) => {
        calls += 1;
        prompts.push({
          text: `${options.system}\n${options.prompt}`,
          value: JSON.parse(options.prompt),
        });
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "The mural remains unread.",
            effects:
              calls === 1
                ? [{ type: "DISCOVER_LORE", loreId: secret.id }]
                : [],
          }),
        };
      },
    },
  );

  const initialPrompt = prompts[0];
  for (const value of [secret.id, secret.name, secret.summary, secret.body]) {
    assert.equal(initialPrompt.text.includes(value), false, value);
  }
  assert.deepEqual(initialPrompt.value.context.lore, []);
  assert.equal(calls, 2);
  assert.deepEqual(result.response.effects, []);
  assert.deepEqual(result.application.state.world.discoveredLoreIds, []);
});

test("uses opaque discovery handles across a gated lore repair", async () => {
  const session = makeSession();
  session.state.world.location = "Vault";
  session.state.world.locationId = "loc:vault";
  session.state.world.flags = { vaultOpen: false };
  session.state.world.discoveredLoreIds = [];
  const worldMap = {
    locations: [
      { id: "loc:vault", name: "Vault", aliases: [], npcIds: [] },
    ],
    connections: [],
    flags: { vaultOpen: false },
  };
  const secret = {
    id: "secret:vault-mural",
    kind: "other",
    name: "The sealed vault mural",
    aliases: [],
    summary: "A hidden route is painted beneath the old mural.",
    body: "The passage opens behind a stone panel.",
    tags: ["vault-private-tag"],
    visibility: "discovery",
    metadata: {
      discoverAt: ["loc:vault"],
      requiredFlag: "vaultOpen",
      discoveryKeywords: ["vault-private-keyword"],
    },
    provenance: { sourceId: "test" },
  };
  const playerAction = "I inspect the mural.";
  const prompts = [];
  let opaqueHandle;
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({
      session,
      playerAction,
      worldMap,
      lore: [secret],
      effectContext: { worldMap, loreEntries: [secret], playerAction },
    }),
    {
      generateText: async (options) => {
        calls += 1;
        const prompt = JSON.parse(options.prompt);
        prompts.push({
          text: `${options.system}\n${options.prompt}`,
          value: prompt,
        });
        if (calls === 1) opaqueHandle = prompt.context.lore[0]?.id;
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "The mural gives way.",
            effects:
              calls === 1
                ? [{ type: "DISCOVER_LORE", loreId: opaqueHandle }]
                : [
                    {
                      type: "SET_FLAG",
                      target: "vaultOpen",
                      value: true,
                    },
                    { type: "DISCOVER_LORE", loreId: opaqueHandle },
                  ],
          }),
        };
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(typeof opaqueHandle, "string");
  assert.ok(opaqueHandle.length > 0);
  assert.notEqual(opaqueHandle, secret.id);
  assert.deepEqual(
    result.response.effects.map(({ type }) => type),
    ["SET_FLAG", "DISCOVER_LORE"],
  );
  assert.equal(result.application.state.world.flags.vaultOpen, true);
  assert.deepEqual(result.application.state.world.discoveredLoreIds, [
    secret.id,
  ]);

  const hiddenValues = [
    secret.id,
    secret.name,
    secret.summary,
    secret.body,
    ...secret.tags,
    ...secret.metadata.discoveryKeywords,
  ];
  for (const { text, value } of prompts) {
    for (const hidden of hiddenValues) {
      assert.equal(text.includes(hidden), false, hidden);
      assert.equal(opaqueHandle.includes(hidden), false, hidden);
    }
    for (const key of Object.keys(secret.metadata)) {
      assert.equal(text.includes(`"${key}"`), false, key);
    }
    assert.deepEqual(value.context.lore, [
      { id: opaqueHandle, discoveryCandidate: true },
    ]);
  }
});
