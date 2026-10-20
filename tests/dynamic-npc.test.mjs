import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const providerKey = "dynamic-npc-offline-key";
let vite;
let databaseApi;
let turnApi;
let worldApi;
let engineApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, turnApi, worldApi, engineApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
    vite.ssrLoadModule("/shared/world.ts"),
    vite.ssrLoadModule("/shared/engine.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

function definition(id) {
  return {
    id,
    title: "The Meeting Place",
    scenario: {
      setting: "A plaza connects to a small market.",
      startingSituation: "Ren arrives at the plaza.",
      worldRules: "Travel follows the mapped road.",
    },
    attributes: [{ id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 4 }],
    resources: [
      { id: "coin", name: "Coin", min: 0, max: 100, initialValue: 10 },
    ],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 2 },
    ],
    items: [],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
    worldMap: {
      locations: [
        { id: "loc:plaza", name: "Plaza", aliases: [], npcIds: [] },
        { id: "loc:market", name: "Market", aliases: [], npcIds: [] },
      ],
      connections: [{ fromId: "loc:plaza", toId: "loc:market" }],
      flags: {},
    },
    startingLocationId: "loc:plaza",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
}

function withDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "fworld-dynamic-npc-"));
  const databasePath = join(directory, "runtime.sqlite");
  let db = new databaseApi.GameDatabase(databasePath);
  const instances = [db];
  t.after(() => {
    for (const instance of instances) instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = new databaseApi.GameDatabase(databasePath);
      instances.push(db);
      return db;
    },
  };
}

function startSession(db, game, sessionId) {
  const existing = db.getGame(game.id);
  return db.startSessionForDefinition({
    definition: game,
    ...(existing ? { expectedGameRevision: existing.revision } : {}),
    ai: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    sessionId,
  });
}

function openRouterResponse(content, id) {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(content) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function promptFromRequest(body) {
  for (const message of body.messages ?? []) {
    const parts = Array.isArray(message.content)
      ? message.content.map((part) => part.text)
      : [message.content];
    for (const part of parts) {
      if (typeof part !== "string") continue;
      try {
        const value = JSON.parse(part);
        if (value && typeof value === "object" && "playerAction" in value) {
          return value;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function stubProvider(t, responses, beforeRequest = () => {}) {
  const originalFetch = globalThis.fetch;
  let requestNumber = 0;
  globalThis.fetch = async (input, init) => {
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const body = JSON.parse(text);
    const prompt = promptFromRequest(body);
    beforeRequest(prompt, body, requestNumber);
    const planned = responses[requestNumber];
    const content =
      typeof planned === "function"
        ? planned(prompt, body, requestNumber)
        : planned;
    if (!content) {
      throw new Error(`Unexpected provider request ${requestNumber + 1}.`);
    }
    requestNumber += 1;
    return openRouterResponse(content, `dynamic-npc-${requestNumber}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

async function waitForRun(db, sessionId, requestId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = db.getRun(sessionId, requestId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Run ${requestId} did not finish after 100 event-loop turns.`);
}

async function run(db, input) {
  const session = db.getSession(input.sessionId);
  turnApi.startSessionRun(db, {
    ...input,
    expectedRevision: session.revision,
    providerKey,
  });
  return waitForRun(db, input.sessionId, input.requestId);
}

function registrationProposal(id = "stranger-1", name = "Lina") {
  return {
    narrative: `${name} greets Ren at the plaza.`,
    effects: [
      {
        type: "REGISTER_NPC",
        id,
        name,
        description: "A careful courier.",
        personality: ["watchful"],
        role: "courier",
        goals: ["deliver a sealed note"],
      },
      {
        type: "RELATIONSHIP_CHANGE",
        target: "trust",
        npcId: id,
        operation: "ADD",
        value: 1,
      },
      {
        type: "ADD_FACT",
        text: "PLAYER_ONLY_SECRET: Ren keeps a private letter.",
        visibility: "private",
        knownBy: ["player"],
      },
    ],
  };
}
test("narrator registration clones inputs and applies following effects sequentially", () => {
  const game = definition("dynamic-npc-engine-game");
  const state = engineApi.buildInitialState(game);
  const originalGame = structuredClone(game);
  const originalState = structuredClone(state);
  const proposal = engineApi.parseTurnResponse(registrationProposal());
  const result = engineApi.applyNarratorEffects(game, state, proposal.effects, {
    worldMap: game.worldMap,
  });

  assert.deepEqual(game, originalGame);
  assert.deepEqual(state, originalState);
  assert.equal(result.definition.npcs[0].id, "stranger-1");
  assert.equal(
    result.state.relationships.find((entry) => entry.npcId === "stranger-1")
      .values.trust,
    3,
  );
  assert.deepEqual(result.state.world.activeCharacters, [
    "player",
    "stranger-1",
  ]);
});

test("a zero-NPC session registers, reuses, scopes, persists, exports, and preserves an encounter NPC", async (t) => {
  const fixture = withDb(t);
  let db = fixture.db;
  const game = definition("dynamic-npc-game");
  const sessionId = "dynamic-npc-session";
  const started = startSession(db, game, sessionId);
  assert.deepEqual(started.session.value.definitionSnapshot.npcs, []);

  const responses = [
    registrationProposal(),
    {
      narrative: "Lina explains the route.",
      effects: [
        {
          type: "RELATIONSHIP_CHANGE",
          target: "trust",
          npcId: "stranger-1",
          operation: "ADD",
          value: 1,
        },
      ],
    },
    { narrative: "Ren reaches the market.", effects: [] },
    { narrative: "Ren returns to the plaza.", effects: [] },
    {
      narrative: "Lina answers Ren's question.",
      effects: [
        {
          type: "RELATIONSHIP_CHANGE",
          target: "trust",
          npcId: "stranger-1",
          operation: "ADD",
          value: 1,
        },
      ],
    },
  ];
  stubProvider(t, responses, (prompt, _body, requestNumber) => {
    assert.ok(prompt);
    if (requestNumber === 1 || requestNumber === 4) {
      assert.deepEqual(prompt.context.actorScope, {
        kind: "npc",
        npcId: "stranger-1",
      });
      assert.equal(prompt.context.activeNpcs[0].id, "stranger-1");
      assert.equal(prompt.context.activeNpcs[0].name, "Lina");
      assert.equal(
        prompt.context.state.relationships[0].value,
        requestNumber === 1 ? 3 : 4,
      );
      assert.equal(
        JSON.stringify(prompt).includes("PLAYER_ONLY_SECRET"),
        false,
      );
      assert.deepEqual(prompt.context.npcKnowledge.privateFactsKnown, []);
    }
  });

  const first = await run(db, {
    sessionId,
    requestId: "dynamic-npc-register",
    work: { kind: "turn", input: "I greet the new courier." },
  });
  assert.equal(first.status, "committed", JSON.stringify(first.error));
  const registered = db.getSession(sessionId);
  assert.equal(registered.definitionSnapshot.npcs.length, 1);
  assert.equal(registered.definitionSnapshot.npcs[0].id, "stranger-1");
  assert.equal(registered.definitionSnapshot.npcs[0].name, "Lina");
  assert.deepEqual(registered.definitionSnapshot.npcs[0].privateKnowledge, []);
  assert.equal(
    Object.hasOwn(registered.definitionSnapshot.npcs[0], "attributes"),
    false,
  );
  assert.deepEqual(
    game.npcs,
    [],
    "registration must not mutate the parent template",
  );
  assert.deepEqual(db.getGame(game.id).npcs, []);
  assert.equal(
    registered.state.relationships.find((entry) => entry.npcId === "stranger-1")
      .values.trust,
    3,
  );
  assert.deepEqual(registered.state.world.npcPresence["stranger-1"], {
    locationId: "loc:plaza",
  });
  assert.deepEqual(registered.state.world.activeCharacters, [
    "player",
    "stranger-1",
  ]);
  assert.deepEqual(
    worldApi.sceneParticipants(
      registered.worldMap,
      "loc:plaza",
      registered.state.world.npcPresence,
      registered.definitionSnapshot.npcs.map((npc) => npc.id),
    ),
    ["player", "stranger-1"],
  );
  assert.ok(
    first.result.messages.every((message) =>
      message.knownBy.includes("stranger-1"),
    ),
  );
  const registrationEvent = first.result.messages.find(
    (message) => message.role === "SYSTEM_EVENT",
  );
  assert.ok(registrationEvent);
  assert.equal(registrationEvent.content.includes("PLAYER_ONLY_SECRET"), false);
  assert.deepEqual(db.getNpcDetails(sessionId, "stranger-1").relationship, {
    trust: 3,
  });

  const second = await run(db, {
    sessionId,
    requestId: "dynamic-npc-reuse",
    work: { kind: "turn", input: "I ask Lina about the road." },
  });
  assert.equal(second.status, "committed", JSON.stringify(second.error));
  assert.equal(db.getSession(sessionId).definitionSnapshot.npcs.length, 1);
  assert.equal(db.getNpcDetails(sessionId, "stranger-1").relationship.trust, 4);

  const away = await run(db, {
    sessionId,
    requestId: "dynamic-npc-travel-away",
    work: { kind: "turn", input: "Travel to Market." },
  });
  assert.equal(away.status, "committed", JSON.stringify(away.error));
  const market = db.getSession(sessionId);
  assert.equal(market.state.world.locationId, "loc:market");
  assert.deepEqual(market.state.world.activeCharacters, ["player"]);
  assert.deepEqual(
    worldApi.sceneParticipants(
      market.worldMap,
      "loc:market",
      market.state.world.npcPresence,
      market.definitionSnapshot.npcs.map((npc) => npc.id),
    ),
    ["player"],
  );

  const back = await run(db, {
    sessionId,
    requestId: "dynamic-npc-travel-back",
    work: { kind: "turn", input: "Travel to Plaza." },
  });
  assert.equal(back.status, "committed", JSON.stringify(back.error));
  assert.ok(
    back.result.messages.every(
      (message) => !message.knownBy.includes("stranger-1"),
    ),
  );
  const plaza = db.getSession(sessionId);
  assert.equal(plaza.state.world.locationId, "loc:plaza");
  assert.deepEqual(plaza.state.world.activeCharacters, [
    "player",
    "stranger-1",
  ]);

  const later = await run(db, {
    sessionId,
    requestId: "dynamic-npc-after-return",
    work: { kind: "turn", input: "I ask Lina about the note." },
  });
  assert.equal(later.status, "committed", JSON.stringify(later.error));
  assert.ok(
    later.result.messages.every((message) =>
      message.knownBy.includes("stranger-1"),
    ),
  );
  assert.equal(db.getNpcDetails(sessionId, "stranger-1").relationship.trust, 5);

  const parent = db.getGame(game.id);
  const edit = structuredClone(parent);
  edit.title = "An Updated Meeting Place";
  edit.npcs.push({
    id: "template-guard",
    name: "Gate Guard",
    personality: ["formal"],
    goals: ["keep the plaza calm"],
    privateKnowledge: [],
    initialRelationships: {},
  });
  const updatedParent = db.updateGame(game.id, edit, parent.revision);
  assert.deepEqual(
    updatedParent.npcs.map((npc) => npc.id),
    ["template-guard"],
  );
  assert.deepEqual(
    new Set(
      db.getSession(sessionId).definitionSnapshot.npcs.map((npc) => npc.id),
    ),
    new Set(["template-guard", "stranger-1"]),
  );
  assert.deepEqual(
    db.getGame(game.id).npcs.map((npc) => npc.id),
    ["template-guard"],
  );

  const beforeCollision = db.getSession(sessionId);
  const collision = structuredClone(updatedParent);
  collision.npcs.push({
    id: "stranger-1",
    name: "Conflicting Template NPC",
    personality: [],
    goals: [],
    privateKnowledge: [],
    initialRelationships: {},
  });
  assert.throws(
    () => db.updateGame(game.id, collision, updatedParent.revision),
    databaseApi.ValidationError,
  );
  assert.equal(db.getGame(game.id).revision, updatedParent.revision);
  assert.deepEqual(db.getSession(sessionId), beforeCollision);

  db = fixture.reopen();
  const reloaded = db.getSession(sessionId);
  assert.equal(
    reloaded.definitionSnapshot.npcs.find((npc) => npc.id === "stranger-1")
      .name,
    "Lina",
  );
  assert.equal(db.getNpcDetails(sessionId, "stranger-1").relationship.trust, 5);
  const bundle = db.exportSave(sessionId);
  assert.ok(bundle.game.npcs.some((npc) => npc.id === "stranger-1"));
  const imported = db.importSave(bundle);
  const importedSession = db.getSession(imported.sessionId);
  assert.ok(
    importedSession.definitionSnapshot.npcs.some(
      (npc) => npc.id === "stranger-1",
    ),
  );
  assert.equal(
    importedSession.state.world.npcPresence["stranger-1"].locationId,
    "loc:plaza",
  );
  assert.equal(
    importedSession.state.relationships.find(
      (entry) => entry.npcId === "stranger-1",
    ).values.trust,
    5,
  );
});

test("invalid registration and invalid later effects never partially commit", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-npc-invalid-game");
  const sessionId = "dynamic-npc-invalid-session";
  startSession(db, game, sessionId);

  const proposals = [
    {
      narrative: "A player identity is not a new NPC.",
      effects: [
        {
          type: "REGISTER_NPC",
          id: "player",
          name: "Stranger",
          personality: [],
          goals: [],
        },
      ],
    },
    {
      narrative: "The player is not a duplicate NPC.",
      effects: [
        {
          type: "REGISTER_NPC",
          id: "ren-duplicate",
          name: " rEn ",
          personality: [],
          goals: [],
        },
      ],
    },
    {
      narrative: "Private data cannot be registered in a narrator payload.",
      effects: [
        {
          type: "REGISTER_NPC",
          id: "private-injection",
          name: "Stranger",
          personality: [],
          goals: [],
          privateKnowledge: ["SECRET"],
        },
      ],
    },
    {
      narrative: "A later invalid effect cancels registration too.",
      effects: [
        {
          type: "REGISTER_NPC",
          id: "partial-person",
          name: "Partial Person",
          personality: [],
          goals: [],
        },
        {
          type: "RELATIONSHIP_CHANGE",
          target: "missing-relationship",
          npcId: "partial-person",
          operation: "ADD",
          value: 1,
        },
      ],
    },
  ];
  stubProvider(
    t,
    proposals.flatMap((proposal) => [proposal, proposal]),
  );

  for (const index of proposals.keys()) {
    const before = db.getSession(sessionId);
    const history = db.getHistory(sessionId);
    const result = await run(db, {
      sessionId,
      requestId: `dynamic-npc-invalid-${index}`,
      work: { kind: "turn", input: "I speak to a new person." },
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(db.getSession(sessionId), before);
    assert.deepEqual(db.getHistory(sessionId), history);
  }
});

test("opening ignores registration effects and choices rejects them without mutation", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-npc-readonly-game");
  const sessionId = "dynamic-npc-readonly-session";
  startSession(db, game, sessionId);
  const proposal = {
    narrative: "A passing stranger is mentioned but not registered.",
    effects: [
      {
        type: "REGISTER_NPC",
        id: "readonly-person",
        name: "Rin",
        personality: [],
        goals: [],
      },
    ],
  };
  stubProvider(t, [proposal, proposal, proposal]);

  const beforeOpening = db.getSession(sessionId);
  const opening = await run(db, {
    sessionId,
    requestId: "dynamic-npc-opening",
    work: { kind: "opening" },
  });
  assert.equal(opening.status, "committed", JSON.stringify(opening.error));
  const afterOpening = db.getSession(sessionId);
  assert.deepEqual(afterOpening.state, beforeOpening.state);
  assert.deepEqual(afterOpening.definitionSnapshot.npcs, []);

  const beforeChoices = db.getSession(sessionId);
  const historyBeforeChoices = db.getHistory(sessionId);
  const choices = await run(db, {
    sessionId,
    requestId: "dynamic-npc-choices",
    work: { kind: "choices" },
  });
  assert.equal(choices.status, "failed");
  assert.deepEqual(db.getSession(sessionId), beforeChoices);
  assert.deepEqual(db.getHistory(sessionId), historyBeforeChoices);
  assert.deepEqual(db.getSession(sessionId).definitionSnapshot.npcs, []);
});
test("scoped encounter NPCs remain visible under the six-NPC scene cap", () => {
  const npcIds = [
    "authored-1",
    "authored-2",
    "authored-3",
    "authored-4",
    "authored-5",
    "authored-6",
    "runtime-stranger",
  ];
  const map = {
    locations: [
      { id: "plaza", name: "Plaza", aliases: [], npcIds: npcIds.slice(0, 6) },
      { id: "market", name: "Market", aliases: [], npcIds: npcIds.slice(0, 6) },
    ],
    connections: [],
  };
  const presence = { "runtime-stranger": { locationId: "plaza" } };

  assert.deepEqual(worldApi.sceneParticipants(map, "plaza", presence, npcIds), [
    "player",
    "runtime-stranger",
    ...npcIds.slice(0, 5),
  ]);
  assert.deepEqual(
    worldApi.sceneParticipants(map, "market", presence, npcIds),
    ["player", ...npcIds.slice(0, 6)],
  );
});
