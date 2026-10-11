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
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const finished = [];
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({
      session,
      history,
      onAttemptFinish: (event) => finished.push(event),
    }),
    {
      generateText: async (options) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(options.model.modelId, "gemini-test");
          assert.equal(options.maxRetries, 0);
          assert.equal(options.maxOutputTokens, 1200);
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
          assert.equal(prompt.context.activeNpcs[0].relationship.trust, 3);
          assert.deepEqual(prompt.context.npcKnowledge[0].privateKnowledge, [
            "She knows the lighthouse secret.",
          ]);
          assert.match(
            JSON.stringify(prompt.context.state.facts.narratorOnly),
            /entered the lighthouse/,
          );
          assert.doesNotMatch(
            JSON.stringify(prompt.context.state.facts.public),
            /lighthouse/,
          );
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
        assert.equal(options.maxOutputTokens, calls === 1 ? 1200 : 1800);
        if (calls === 1) {
          assert.match(options.system, /one short sentence/);
          assert.match(options.system, /"id":"choice-1"/);
          assert.match(options.system, /"id":"choice-2"/);
          assert.match(options.system, /"id":"choice-3"/);
          assert.doesNotMatch(options.system, /"choices":\[\]/);
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

test("repairs generated choices unless there are exactly three", async () => {
  const session = makeSession("openrouter");
  let calls = 0;
  const result = await agent.runNarrator(
    makeInput({ session, kind: "choices", playerAction: "" }),
    {
      generateText: async (options) => {
        calls += 1;
        if (calls === 2) {
          assert.match(
            JSON.parse(options.prompt).correction.reason,
            /tepat 3/i,
          );
        }
        await fakeStep(options);
        return {
          text: JSON.stringify({
            narrative: "Aiko waits.",
            effects: [],
            choices:
              calls === 1
                ? [
                    { id: "a", label: "Ask" },
                    { id: "b", label: "Wait" },
                  ]
                : [
                    { id: "a", label: "Ask" },
                    { id: "b", label: "Wait" },
                    { id: "c", label: "Leave" },
                  ],
          }),
          finishReason: "stop",
        };
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.response.choices.length, 3);
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
      searchMemory: async (_query, options) => {
        memoryOptions.push(options);
        return Array.from({ length: 8 }, (_, index) => ({
          id: `memory-${index}`,
          text: "x".repeat(1_000),
          kind: "message",
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
          /NPC ID tidak ada/,
        );
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.get_item_details.execute({ itemId: "missing" }),
          ),
          /Item ID tidak ada/,
        );
        await assert.rejects(
          Promise.resolve().then(() =>
            options.tools.search_memory.execute({
              query: "old",
              sessionId: "other",
            }),
          ),
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
        assert.deepEqual(memoryOptions[0], {
          npcId: "aiko",
          limit: 5,
          maxChars: 4000,
          signal: options.abortSignal,
        });
        assert.equal(hits[0].kind, "message");
        assert.equal(hits[0].sequence, 0);
        assert.equal(hits[0].speakerId, "aiko");
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

test("opening can include choices and repairs forbidden state changes", async () => {
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
            effects:
              calls === 1 ? [{ type: "ADD_FACT", text: "A new lead." }] : [],
            choices: [
              { id: "choice-1", label: "Ask Bima" },
              { id: "choice-2", label: "Watch the door" },
              { id: "choice-3", label: "Wait quietly" },
            ],
          }),
        };
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.response.choices.length, 3);
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

test("fits large relationship context without losing current values", async () => {
  const session = makeSession();
  const relationships = Array.from({ length: 180 }, (_, index) => ({
    id: `rel-${String(index).padStart(3, "0")}`,
    name: `Relationship ${String(index).padStart(3, "0")}`,
    min: -10,
    max: 10,
    defaultValue: 0,
  }));
  const initialRelationships = Object.fromEntries(
    relationships.map(({ id }) => [id, 0]),
  );
  const npcs = ["aiko", "bima", "citra"].map((id) => ({
    id,
    name: id,
    description: `${id} waits nearby.`,
    personality: ["patient"],
    goals: ["keep the peace"],
    privateKnowledge: ["A secret."],
    initialRelationships,
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
  const lastRelationshipId = relationships.at(-1).id;

  const result = await agent.runNarrator(makeInput({ session }), {
    generateText: async (options) => {
      const prompt = JSON.parse(options.prompt);
      const context = prompt.context;
      const aiko = context.activeNpcs.find((npc) => npc.id === "aiko");
      assert.equal(aiko.relationship[lastRelationshipId], 7);
      assert.equal(Object.hasOwn(aiko, "initialRelationships"), false);
      assert.equal(Object.hasOwn(context.state, "relationships"), false);

      const inactiveDetails = await options.tools.get_npc_details.execute({
        npcId: "citra",
      });
      assert.equal(inactiveDetails.relationship[lastRelationshipId], -4);

      const legacyPrompt = structuredClone(prompt);
      legacyPrompt.context.activeNpcs = legacyPrompt.context.activeNpcs.map(
        (npc) => ({
          ...npc,
          initialRelationships,
        }),
      );
      legacyPrompt.context.state.relationships = session.state.relationships;
      assert.ok(options.system.length + options.prompt.length <= 24_000);
      assert.ok(
        options.system.length + JSON.stringify(legacyPrompt).length > 24_000,
      );

      return {
        text: JSON.stringify({
          narrative: "The scene continues.",
          effects: [],
        }),
      };
    },
  });

  assert.equal(result.response.narrative, "The scene continues.");
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
