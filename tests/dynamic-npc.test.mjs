import assert from "node:assert/strict";
import { get } from "node:http";
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
let mainApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, turnApi, worldApi, engineApi, mainApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
    vite.ssrLoadModule("/shared/world.ts"),
    vite.ssrLoadModule("/shared/engine.ts"),
    vite.ssrLoadModule("/server/main.ts"),
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
    directory,
    databasePath,
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

async function openWorldServer(t, fixture) {
  const server = mainApi.createHttpServer(
    { current: fixture.db, path: fixture.databasePath },
    {
      development: true,
      allowedHosts: ["*"],
      backupDirectory: join(fixture.directory, "backups"),
      envFilePath: join(fixture.directory, ".env"),
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { Origin: "http://127.0.0.1:5173" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, value: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
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
  const sessionBeforeParentEdit = db.getSession(sessionId);
  const historyBeforeParentEdit = db.getHistory(sessionId);
  const detailsBeforeParentEdit = db.getNpcDetails(sessionId, "stranger-1");

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
  assert.deepEqual(db.getSession(sessionId), sessionBeforeParentEdit);
  assert.deepEqual(db.getHistory(sessionId), historyBeforeParentEdit);
  assert.deepEqual(
    db.getNpcDetails(sessionId, "stranger-1"),
    detailsBeforeParentEdit,
  );

  assert.deepEqual(
    db.getGame(game.id).npcs.map((npc) => npc.id),
    ["template-guard"],
  );

  const collision = structuredClone(updatedParent);
  collision.npcs.push({
    id: "stranger-1",
    name: "Conflicting Template NPC",
    personality: [],
    goals: [],
    privateKnowledge: [],
    initialRelationships: {},
  });
  const collisionUpdate = db.updateGame(
    game.id,
    collision,
    updatedParent.revision,
  );
  assert.equal(collisionUpdate.revision, updatedParent.revision + 1);
  assert.deepEqual(
    db.getGame(game.id).npcs.map((npc) => npc.id),
    ["template-guard", "stranger-1"],
  );
  assert.deepEqual(db.getSession(sessionId), sessionBeforeParentEdit);
  assert.deepEqual(db.getHistory(sessionId), historyBeforeParentEdit);
  assert.deepEqual(
    db.getNpcDetails(sessionId, "stranger-1"),
    detailsBeforeParentEdit,
  );

  db = fixture.reopen();
  const reloaded = db.getSession(sessionId);
  assert.equal(
    reloaded.definitionSnapshot.npcs.find((npc) => npc.id === "stranger-1")
      .name,
    "Lina",
  );
  assert.deepEqual(
    reloaded.definitionSnapshot.npcs.map((npc) => npc.id),
    ["stranger-1"],
  );

  assert.equal(db.getNpcDetails(sessionId, "stranger-1").relationship.trust, 5);
  const bundle = db.exportSave(sessionId);
  assert.ok(bundle.game.npcs.some((npc) => npc.id === "stranger-1"));
  assert.equal(
    bundle.game.npcs.find((npc) => npc.id === "stranger-1").name,
    "Lina",
  );
  assert.equal(
    bundle.game.npcs.some((npc) => npc.name === "Conflicting Template NPC"),
    false,
  );

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

test("an addressed arrival turn commits with the encounter NPC in the world view", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-npc-arrival-game");
  game.npcs.push({
    id: "plaza-guard",
    name: "Garda",
    personality: ["formal"],
    goals: ["keep the plaza calm"],
    privateKnowledge: [],
    initialRelationships: {},
  });
  game.worldMap.locations[0].npcIds = ["plaza-guard"];
  const sessionId = "dynamic-npc-arrival-session";
  startSession(db, game, sessionId);

  const responses = [
    registrationProposal(),
    { narrative: "Ren reaches the market.", effects: [] },
    {
      narrative: "Ren returns to the plaza; Lina points toward the road.",
      effects: [],
    },
    { narrative: "Lina repeats the directions from the gate.", effects: [] },
  ];
  stubProvider(t, responses, (prompt, _body, requestNumber) => {
    if (requestNumber === 2) {
      assert.deepEqual(prompt.context.actorScope, {
        kind: "npc",
        npcId: "stranger-1",
      });
      assert.ok(
        prompt.context.activeNpcs.some(({ id }) => id === "stranger-1"),
        "destination NPC must be a scene participant",
      );
      assert.deepEqual(prompt.context.state.world.movement, {
        kind: "allowed",
        fromId: "loc:market",
        toId: "loc:plaza",
      });
    }
    if (requestNumber === 3) {
      assert.deepEqual(prompt.context.actorScope, {
        kind: "npc",
        npcId: "stranger-1",
      });
      assert.ok(
        prompt.recentMessages.some(
          (message) =>
            message.content ===
            "Ren returns to the plaza; Lina points toward the road.",
        ),
        "principal history must include the arrival exchange",
      );
    }
  });

  const registered = await run(db, {
    sessionId,
    requestId: "dynamic-npc-arrival-register",
    work: { kind: "turn", input: "I greet the new courier." },
  });
  assert.equal(
    registered.status,
    "committed",
    JSON.stringify(registered.error),
  );

  const away = await run(db, {
    sessionId,
    requestId: "dynamic-npc-arrival-away",
    work: { kind: "turn", input: "Travel to Market." },
  });
  assert.equal(away.status, "committed", JSON.stringify(away.error));
  assert.deepEqual(db.getSession(sessionId).state.world.activeCharacters, [
    "player",
  ]);

  const arrival = await run(db, {
    sessionId,
    requestId: "dynamic-npc-arrival-addressed",
    work: {
      kind: "turn",
      input: "I ask Lina about the road as we travel back to the Plaza.",
    },
  });
  assert.equal(arrival.status, "committed", JSON.stringify(arrival.error));

  const committed = db.getSession(sessionId);
  assert.equal(committed.state.world.locationId, "loc:plaza");
  assert.ok(committed.state.world.activeCharacters.includes("stranger-1"));
  assert.deepEqual(committed.state.world.npcPresence["stranger-1"], {
    locationId: "loc:plaza",
  });

  assert.deepEqual(
    arrival.result.messages.map(({ knownBy }) => knownBy),
    [
      ["player", "stranger-1"],
      ["player", "stranger-1"],
    ],
  );
  assert.ok(
    arrival.result.messages.every(
      (message) => !message.knownBy.includes("plaza-guard"),
    ),
    "destination bystanders must not receive the exchange",
  );
  assert.ok(
    db
      .getRecentHistory(sessionId, 24, "stranger-1")
      .some(
        (message) =>
          message.content ===
          "Ren returns to the plaza; Lina points toward the road.",
      ),
    "arrival exchange must be in the principal's history",
  );
  assert.ok(
    db
      .searchMemory(sessionId, "Lina points", "stranger-1")
      .some(
        (hit) =>
          hit.kind === "message" &&
          hit.excerpt.includes("Lina points toward the road"),
      ),
    "arrival exchange must be searchable by the principal",
  );
  assert.ok(
    db
      .searchMemory(sessionId, "Lina points", "plaza-guard")
      .every((hit) => !hit.excerpt.includes("Lina points toward the road")),
    "bystanders must not search the exchange",
  );

  const followUp = await run(db, {
    sessionId,
    requestId: "dynamic-npc-arrival-follow-up",
    work: { kind: "turn", input: "I ask Lina about the road we discussed." },
  });
  assert.equal(followUp.status, "committed", JSON.stringify(followUp.error));

  const base = await openWorldServer(t, fixture);
  const world = await getJson(`${base}/api/sessions/${sessionId}/world`);
  assert.equal(world.status, 200);
  assert.equal(world.value.location.id, "loc:plaza");
  assert.ok(world.value.people.some(({ id }) => id === "stranger-1"));
  assert.ok(
    world.value.people.every(
      (person) => !Object.hasOwn(person, "privateKnowledge"),
    ),
  );
});

test("an off-scene registered NPC can be reencountered at a different location", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-npc-offscene-game");
  game.npcs.push({
    id: "plaza-guard",
    name: "Garda",
    personality: ["formal"],
    goals: ["keep the plaza calm"],
    privateKnowledge: [],
    initialRelationships: {},
  });
  game.worldMap.locations[0].npcIds = ["plaza-guard"];
  const sessionId = "dynamic-npc-offscene-session";
  startSession(db, game, sessionId);

  const responses = [
    registrationProposal(),
    { narrative: "Ren reaches the market.", effects: [] },
    {
      narrative: "Lina steps out of the market crowd.",
      effects: [{ type: "NPC_PRESENCE", npcId: "stranger-1", present: true }],
    },
    { narrative: "Lina answers quietly.", effects: [] },
  ];
  stubProvider(t, responses, (prompt, _body, requestNumber) => {
    if (requestNumber === 0) {
      assert.equal(
        "knownNpcIdentities" in prompt.context,
        false,
        "identity roster must be omitted when empty",
      );
      return;
    }
    if (requestNumber === 1 || requestNumber === 2) {
      assert.deepEqual(prompt.context.knownNpcIdentities, [
        { id: "stranger-1", name: "Lina" },
      ]);
      assert.deepEqual(prompt.context.actorScope, {
        kind: "player-narrator",
      });
      assert.equal(
        prompt.context.activeNpcs.some(({ id }) => id === "stranger-1"),
        false,
      );
      assert.equal(prompt.context.npcKnowledge, null);
      const serialized = JSON.stringify(prompt);
      assert.equal(serialized.includes("LINA_SECRET"), false);
      assert.equal(serialized.includes("privateKnowledge"), false);
    }
    if (requestNumber === 3) {
      assert.equal("knownNpcIdentities" in prompt.context, false);
      assert.deepEqual(prompt.context.actorScope, {
        kind: "npc",
        npcId: "stranger-1",
      });
      assert.ok(prompt.context.npcKnowledge);
      assert.ok(
        prompt.context.npcKnowledge.privateFactsKnown.some(({ text }) =>
          text.includes("LINA_SECRET"),
        ),
        "next turn must expose the reencountered NPC's known facts",
      );
      assert.equal(
        JSON.stringify(prompt).includes("PLAYER_ONLY_SECRET"),
        false,
      );
      assert.ok(
        prompt.recentMessages.some(
          (message) =>
            message.content ===
            "Lina, step out of the market crowd and talk to me.",
        ),
        "next turn must recall the reencounter action",
      );
      assert.ok(
        prompt.recentMessages.some(
          (message) =>
            message.content === "Lina steps out of the market crowd.",
        ),
        "next turn must recall the reencounter narration",
      );
    }
  });

  const registered = await run(db, {
    sessionId,
    requestId: "dynamic-npc-offscene-register",
    work: { kind: "turn", input: "I greet the new courier." },
  });
  assert.equal(
    registered.status,
    "committed",
    JSON.stringify(registered.error),
  );

  const seededSession = db.getSession(sessionId);
  const seededState = structuredClone(seededSession.state);
  seededState.facts.push({
    id: "lina-secret",
    text: "LINA_SECRET: only Lina knows the market password.",
    visibility: "private",
    knownBy: ["stranger-1"],
    createdAt: "2026-10-13T00:00:00.000Z",
    source: "story",
  });
  db.updateSession(sessionId, { state: seededState }, seededSession.revision);

  const away = await run(db, {
    sessionId,
    requestId: "dynamic-npc-offscene-away",
    work: { kind: "turn", input: "Travel to Market." },
  });
  assert.equal(away.status, "committed", JSON.stringify(away.error));
  const market = db.getSession(sessionId);
  assert.deepEqual(market.state.world.activeCharacters, ["player"]);
  assert.deepEqual(market.state.world.npcPresence["stranger-1"], {
    locationId: "loc:plaza",
  });

  const reencounter = await run(db, {
    sessionId,
    requestId: "dynamic-npc-offscene-reencounter",
    work: {
      kind: "turn",
      input: "Lina, step out of the market crowd and talk to me.",
    },
  });
  assert.equal(
    reencounter.status,
    "committed",
    JSON.stringify(reencounter.error),
  );
  const committed = db.getSession(sessionId);
  assert.equal(committed.state.world.locationId, "loc:market");
  assert.deepEqual(committed.state.world.npcPresence["stranger-1"], {
    locationId: "loc:market",
    present: true,
  });
  assert.ok(committed.state.world.activeCharacters.includes("stranger-1"));
  assert.deepEqual(
    worldApi.sceneParticipants(
      committed.worldMap,
      "loc:market",
      committed.state.world.npcPresence,
      committed.definitionSnapshot.npcs.map((npc) => npc.id),
    ),
    ["player", "stranger-1"],
  );
  const reencounterMessages = reencounter.result.messages.filter(
    (message) => message.role === "PLAYER" || message.role === "NARRATOR",
  );
  assert.deepEqual(
    reencounterMessages.map((message) => message.knownBy),
    [
      ["player", "stranger-1"],
      ["player", "stranger-1"],
    ],
  );
  assert.ok(
    reencounter.result.messages.every((message) =>
      message.knownBy.includes("stranger-1"),
    ),
    "reencounter, including its system event, must reach the new participant",
  );
  assert.ok(
    reencounter.result.messages.every(
      (message) => !message.knownBy.includes("plaza-guard"),
    ),
    "mapped bystander must not receive the reencounter",
  );
  assert.ok(
    db
      .getRecentHistory(sessionId, 24, "stranger-1")
      .some(
        (message) => message.content === "Lina steps out of the market crowd.",
      ),
    "reencounter narration must be in the principal's history",
  );

  const followUp = await run(db, {
    sessionId,
    requestId: "dynamic-npc-offscene-follow-up",
    work: { kind: "turn", input: "I ask Lina about the market password." },
  });
  assert.equal(followUp.status, "committed", JSON.stringify(followUp.error));
  assert.ok(
    db
      .searchMemory(sessionId, "market password", "stranger-1")
      .some(
        (hit) => hit.kind === "fact" && hit.excerpt.includes("LINA_SECRET"),
      ),
  );
});

test("origin-fallback travel keeps destination presence targets out of the audience", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-npc-scene-gate-game");
  game.npcs.push(
    {
      id: "lina",
      name: "Lina",
      personality: ["watchful"],
      goals: ["keep the gate safe"],
      privateKnowledge: ["Lina's private gate note."],
      initialRelationships: {},
    },
    {
      id: "market-guard",
      name: "Garda",
      personality: ["formal"],
      goals: ["keep the market calm"],
      privateKnowledge: [],
      initialRelationships: {},
    },
  );
  game.worldMap.locations[0].npcIds = ["lina"];
  game.worldMap.locations[1].npcIds = ["market-guard"];
  const sessionId = "dynamic-npc-scene-gate-session";
  startSession(db, game, sessionId);
  const initial = db.getSession(sessionId);
  const state = structuredClone(initial.state);
  state.world.npcPresence = {
    "market-guard": { locationId: "loc:market" },
  };
  state.world.activeCharacters = worldApi.sceneParticipants(
    game.worldMap,
    state.world.locationId,
    state.world.npcPresence,
    game.npcs.map((npc) => npc.id),
  );
  db.updateSession(sessionId, { state }, initial.revision);

  stubProvider(
    t,
    [
      {
        narrative:
          "Lina shares her private gate note as Ren heads to the market.",
        effects: [
          { type: "NPC_PRESENCE", npcId: "market-guard", present: true },
        ],
      },
    ],
    (prompt) => {
      assert.deepEqual(prompt.context.actorScope, {
        kind: "npc",
        npcId: "lina",
      });
      assert.ok(prompt.context.activeNpcs.some(({ id }) => id === "lina"));
      assert.equal(
        prompt.context.activeNpcs.some(({ id }) => id === "market-guard"),
        false,
      );
      assert.deepEqual(prompt.context.knownNpcIdentities, [
        { id: "market-guard", name: "Garda" },
      ]);
      assert.match(JSON.stringify(prompt), /Lina's private gate note/);
    },
  );

  const travel = await run(db, {
    sessionId,
    requestId: "dynamic-npc-scene-gate-travel",
    work: {
      kind: "turn",
      input: "I ask Lina about the gate as we travel to the Market.",
    },
  });
  assert.equal(travel.status, "committed", JSON.stringify(travel.error));

  const committed = db.getSession(sessionId);
  assert.equal(committed.state.world.locationId, "loc:market");
  assert.deepEqual(committed.state.world.npcPresence["market-guard"], {
    locationId: "loc:market",
    present: true,
  });
  assert.ok(committed.state.world.activeCharacters.includes("market-guard"));
  assert.ok(!committed.state.world.activeCharacters.includes("lina"));
  assert.deepEqual(
    travel.result.messages.map((message) => message.knownBy),
    [
      ["player", "lina"],
      ["player", "lina"],
      ["player", "lina"],
    ],
  );
  assert.ok(
    travel.result.messages.every(
      (message) => !message.knownBy.includes("market-guard"),
    ),
  );
  assert.ok(
    !db
      .getRecentHistory(sessionId, 24, "market-guard")
      .some((message) => message.content.includes("private gate note")),
  );
  assert.ok(
    !db
      .searchMemory(sessionId, "private gate note", "market-guard")
      .some((hit) => hit.excerpt.includes("private gate note")),
  );
  assert.ok(
    db
      .searchMemory(sessionId, "private gate note", "lina")
      .some(
        (hit) =>
          hit.kind === "message" && hit.excerpt.includes("private gate note"),
      ),
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
