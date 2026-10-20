import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { createServer } from "vite";

let server;
let db;
let narratorPrompt;

function sampleGame(id) {
  return {
    id,
    title: "Cafe Nami",
    scenario: {
      setting: "Kamakura",
      startingSituation: "First evening shift, heavy rain.",
    },
    attributes: [
      { id: "charm", name: "Charm", min: 0, max: 20, defaultValue: 5 },
      { id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 3 },
    ],
    resources: [
      { id: "yen", name: "Yen", min: 0, max: 100000, initialValue: 5000 },
      { id: "energy", name: "Energy", min: 0, initialValue: 100 },
    ],
    relationships: [
      { id: "trust", name: "Trust", min: -100, max: 100, defaultValue: 0 },
    ],
    items: [
      {
        id: "energy_drink",
        name: "Energy Drink",
        stackable: true,
        maxStack: 5,
        consumable: true,
        effects: [
          {
            type: "RESOURCE_CHANGE",
            target: "energy",
            operation: "ADD",
            value: 20,
          },
        ],
        tags: [],
      },
      {
        id: "old_camera",
        name: "Old Camera",
        stackable: false,
        consumable: false,
        effects: [],
        tags: ["quest"],
      },
    ],
    player: {
      name: "Ren",
      attributes: { charm: 7 },
      resources: { yen: 1200 },
    },
    npcs: [
      {
        id: "aiko",
        name: "Aiko",
        personality: ["quiet"],
        goals: ["find her missing brother"],
        privateKnowledge: ["knows about the lighthouse"],
        initialRelationships: { trust: 12 },
      },
    ],
    startingInventory: [
      { itemId: "old_camera", quantity: 1 },
      { itemId: "energy_drink", quantity: 3 },
    ],
    updatedAt: new Date().toISOString(),
  };
}

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  db = await server.ssrLoadModule("/src/db.ts");
  narratorPrompt = await server.ssrLoadModule("/shared/narrator-prompt.ts");
});

test.after(async () => {
  await server.close();
});

test("game round-trips through the games store", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const loaded = await db.getGame(game.id);
  assert.deepEqual(loaded, game);
  const all = await db.listGames();
  assert.ok(all.some((g) => g.id === game.id));
});

test("initial state derives defaults where config omits values", async () => {
  const game = sampleGame(crypto.randomUUID());
  const state = db.buildInitialState(game);
  assert.equal(state.attributes.charm, 7);
  assert.equal(state.attributes.wit, 3);
  assert.equal(state.resources.yen, 1200);
  assert.equal(state.resources.energy, 100);
  assert.deepEqual(state.inventory, [
    { itemId: "old_camera", quantity: 1 },
    { itemId: "energy_drink", quantity: 3 },
  ]);
  assert.deepEqual(state.relationships, [
    { npcId: "aiko", values: { trust: 12 } },
  ]);
  assert.equal(state.world.scene, game.scenario.startingSituation);
  assert.deepEqual(state.world.activeCharacters, ["player", "aiko"]);
});

test("legacy snapshot preserves stored IDs and snapshots in one readonly transaction", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });
  const message = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    turnId: "legacy-turn",
    sequence: 0,
    role: "NARRATOR",
    content: "The story continues.",
    createdAt: new Date().toISOString(),
  };
  session.nextSequence = 1;
  await db.saveTurn(session, [message]);
  const updatedGame = { ...game, title: "Updated after session start" };
  await db.saveGame(updatedGame);
  const sourceDb = await db.getDb();
  const versionBefore = sourceDb.version;
  const storesBefore = [...sourceDb.objectStoreNames].sort();

  const descriptor = Object.getOwnPropertyDescriptor(
    IDBDatabase.prototype,
    "transaction",
  );
  const transactions = [];
  Object.defineProperty(IDBDatabase.prototype, "transaction", {
    ...descriptor,
    value(stores, mode, ...options) {
      if (this.name === "fworld") {
        transactions.push({ stores: [...stores], mode });
      }
      return descriptor.value.call(this, stores, mode, ...options);
    },
  });
  let snapshot;
  try {
    snapshot = await db.readLegacySnapshot();
  } finally {
    Object.defineProperty(IDBDatabase.prototype, "transaction", descriptor);
  }

  assert.deepEqual(transactions, [
    { stores: ["games", "sessions", "messages"], mode: "readonly" },
  ]);
  assert.equal(sourceDb.version, versionBefore);
  assert.deepEqual([...sourceDb.objectStoreNames].sort(), storesBefore);
  assert.equal(snapshot.format, "fworld-legacy-migration");
  assert.equal(snapshot.version, 1);
  assert.deepEqual(
    snapshot.games.find((entry) => entry.id === game.id),
    updatedGame,
  );
  assert.deepEqual(
    snapshot.sessions.find((entry) => entry.id === session.id),
    session,
  );
  assert.deepEqual(
    snapshot.messages.find((entry) => entry.id === message.id),
    message,
  );
});

test("write lock reports unsupported when Web Locks are unavailable", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  try {
    assert.equal(await db.acquireWriteLock(), "unsupported");
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

test("write lock reports granted only while a Web Lock is held", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(_name, _options, callback) {
          return Promise.resolve(callback({}));
        },
      },
    },
  });
  try {
    assert.equal(await db.acquireWriteLock(), "granted");
  } finally {
    db.releaseWriteLock();
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

test("session snapshot stays stable when the template game changes later", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });
  assert.equal(session.gameId, game.id);
  assert.equal(session.nextSequence, 0);

  game.title = "Changed after start";
  game.scenario.startingSituation = "Rewritten.";
  await db.saveGame(game);

  const reloaded = await db.getSession(session.id);
  assert.equal(reloaded.definitionSnapshot.title, "Cafe Nami");
  assert.equal(
    reloaded.definitionSnapshot.scenario.startingSituation,
    "First evening shift, heavy rain.",
  );
});

test("saveTurn commits session and messages together and history reads in order", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });

  const messages = [
    {
      id: crypto.randomUUID(),
      sessionId: session.id,
      turnId: "turn-1",
      sequence: 0,
      role: "NARRATOR",
      content: "The rain begins.",
      createdAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      sessionId: session.id,
      turnId: "turn-1",
      sequence: 1,
      role: "PLAYER",
      content: "I greet Aiko.",
      createdAt: new Date().toISOString(),
    },
  ];
  session.nextSequence = 2;
  await db.saveTurn(session, messages);

  const history = await db.getHistory(session.id);
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((m) => m.sequence),
    [0, 1],
  );
  const reloaded = await db.getSession(session.id);
  assert.equal(reloaded.nextSequence, 2);
});

test("a failed message write rolls back the session write in the same transaction", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });
  const before = await db.getSession(session.id);

  session.nextSequence = 99;
  const bad = [
    {
      id: crypto.randomUUID(),
      sessionId: session.id,
      turnId: "turn-x",
      sequence: 0,
      role: "NPC",
      content: () => "not cloneable",
      createdAt: new Date().toISOString(),
    },
  ];
  await assert.rejects(db.saveTurn(session, bad));

  const after = await db.getSession(session.id);
  assert.equal(after.nextSequence, before.nextSequence);
  assert.equal((await db.getHistory(session.id)).length, 0);
});

test("validateDefinition catches references, duplicates, and range violations", async () => {
  const game = sampleGame(crypto.randomUUID());
  assert.deepEqual(db.validateDefinition(game), []);

  game.attributes.push({
    id: "charm",
    name: "Dup",
    min: 0,
    max: 1,
    defaultValue: 0,
  });
  game.player.attributes.missing = 1;
  game.startingInventory.push({ itemId: "ghost", quantity: 1 });
  game.items[0].effects.push({
    type: "RESOURCE_CHANGE",
    target: "ghost",
    operation: "ADD",
    value: 1,
  });
  game.attributes[1].defaultValue = 99;
  const errors = db.validateDefinition(game);
  assert.ok(errors.some((e) => /duplikat/.test(e)));
  assert.ok(errors.some((e) => /player\.attributes/.test(e)));
  assert.ok(errors.some((e) => /startingInventory\[2\]/.test(e)));
  assert.ok(errors.some((e) => /items "energy_drink"/.test(e)));
  assert.ok(errors.some((e) => /attributes "wit"/.test(e)));
});

test("export then import restores content under fresh ids", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "openrouter",
    model: "openai/gpt-5-mini",
  });
  const message = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    turnId: "turn-1",
    sequence: 0,
    role: "NARRATOR",
    content: "Opening scene.",
    createdAt: new Date().toISOString(),
  };
  session.nextSequence = 1;
  await db.saveTurn(session, [message]);

  const bundle = await db.exportBundle(session.id);
  const text = JSON.stringify(bundle);
  const { gameId, sessionId } = await db.importBundle(JSON.parse(text));

  assert.notEqual(gameId, game.id);
  assert.notEqual(sessionId, session.id);

  const importedGame = await db.getGame(gameId);
  assert.equal(importedGame.title, "Cafe Nami");
  assert.deepEqual(importedGame.items, game.items);

  const importedSession = await db.getSession(sessionId);
  assert.equal(importedSession.gameId, gameId);
  assert.equal(importedSession.definitionSnapshot.id, gameId);
  assert.equal(importedSession.state.attributes.charm, 7);
  assert.equal(importedSession.ai.provider, "openrouter");

  const importedHistory = await db.getHistory(sessionId);
  assert.equal(importedHistory.length, 1);
  assert.equal(importedHistory[0].content, "Opening scene.");
  assert.equal(importedHistory[0].sessionId, sessionId);
  assert.notEqual(importedHistory[0].id, message.id);
});

test("import rejects corrupt payloads without writing anything", async () => {
  const gamesBefore = (await db.listGames()).length;

  await assert.rejects(db.importBundle(null), db.ImportError);
  await assert.rejects(
    db.importBundle({ format: "other", version: 1 }),
    db.ImportError,
  );
  await assert.rejects(
    db.importBundle({ format: "fworld-save", version: 99 }),
    db.ImportError,
  );

  const validGame = sampleGame(crypto.randomUUID());
  await db.saveGame(validGame);
  const validSession = await db.createSession(validGame, {
    provider: "gemini",
    model: "m",
  });
  await db.saveTurn(validSession, [
    {
      id: crypto.randomUUID(),
      sessionId: validSession.id,
      turnId: "turn-1",
      sequence: 0,
      role: "NARRATOR",
      content: "Scene.",
      createdAt: new Date().toISOString(),
    },
  ]);
  const bundle = await db.exportBundle(validSession.id);

  const badRef = structuredClone(bundle);
  badRef.game.startingInventory.push({ itemId: "ghost", quantity: 1 });
  await assert.rejects(db.importBundle(badRef), db.ImportError);

  const badSession = structuredClone(bundle);
  badSession.messages[0] = { ...badSession.messages[0], sessionId: "foreign" };
  await assert.rejects(db.importBundle(badSession), db.ImportError);

  const after = await db.listGames();
  assert.equal(after.length, gamesBefore + 1);
});

test("import rejects dangerous keys, snapshot mismatch, and invalid runtime state", async () => {
  const gamesBefore = (await db.listGames()).length;
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });
  session.nextSequence = 1;
  await db.saveTurn(session, [
    {
      id: crypto.randomUUID(),
      sessionId: session.id,
      turnId: "turn-1",
      sequence: 0,
      role: "NARRATOR",
      content: "Scene.",
      createdAt: new Date().toISOString(),
    },
  ]);
  const bundle = await db.exportBundle(session.id);

  const reject = async (candidate, match) => {
    await assert.rejects(db.importBundle(candidate), (error) => {
      assert.ok(error instanceof db.ImportError);
      if (match) {
        assert.ok(
          error.problems.some((p) => match.test(p)),
          `expected ${match} in ${JSON.stringify(error.problems)}`,
        );
      }
      return true;
    });
  };

  const polluted = JSON.parse(
    JSON.stringify(bundle).replace(
      '{"format"',
      '{"__proto__": {"hacked": true}, "format"',
    ),
  );
  await reject(polluted, /berbahaya/);

  const snapshotMismatch = structuredClone(bundle);
  snapshotMismatch.session.definitionSnapshot.title = "berbeda";
  await reject(snapshotMismatch, /Snapshot/);

  const stateOutOfRange = structuredClone(bundle);
  stateOutOfRange.session.state.attributes.charm = 999;
  await reject(stateOutOfRange, /rentang/);

  const stateUnknownItem = structuredClone(bundle);
  stateUnknownItem.session.state.inventory.push({
    itemId: "ghost",
    quantity: 1,
  });
  await reject(stateUnknownItem, /tidak dikenal/);

  const factBadVisibility = structuredClone(bundle);
  factBadVisibility.session.state.facts.push({
    id: "f1",
    text: "rahasia",
    visibility: "secret",
    knownBy: [],
    createdAt: new Date().toISOString(),
    source: "story",
  });
  await reject(factBadVisibility, /visibility/);

  const factBadKnownBy = structuredClone(bundle);
  factBadKnownBy.session.state.facts.push({
    id: "f2",
    text: "rahasia",
    visibility: "private",
    knownBy: ["ghost"],
    createdAt: new Date().toISOString(),
    source: "story",
  });
  await reject(factBadKnownBy, /knownBy/);

  const badSequence = structuredClone(bundle);
  badSequence.session.nextSequence = 5;
  await reject(badSequence, /nextSequence/);

  const badCheck = structuredClone(bundle);
  badCheck.messages[0].check = {
    attributeId: "ghost",
    difficulty: 1,
    mode: "NORMAL",
    score: 3,
    outcome: "SUCCESS",
  };
  await reject(badCheck, /attributeId/);

  const after = await db.listGames();
  assert.equal(after.length, gamesBefore + 1);
});

test("import strips foreign fields from game and session state on restore", async () => {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  const session = await db.createSession(game, {
    provider: "gemini",
    model: "m",
  });
  session.nextSequence = 1;
  await db.saveTurn(session, [
    {
      id: crypto.randomUUID(),
      sessionId: session.id,
      turnId: "turn-1",
      sequence: 0,
      role: "NARRATOR",
      content: "Scene.",
      createdAt: new Date().toISOString(),
    },
  ]);
  const bundle = structuredClone(await db.exportBundle(session.id));
  bundle.game.apiKey = "secret";
  bundle.session.definitionSnapshot.apiKey = "secret";
  bundle.session.state.hacked = true;
  bundle.session.ai.extra = "leak";

  const { gameId, sessionId } = await db.importBundle(bundle);
  const importedGame = await db.getGame(gameId);
  assert.equal("apiKey" in importedGame, false);
  const importedSession = await db.getSession(sessionId);
  assert.equal("hacked" in importedSession.state, false);
  assert.deepEqual(importedSession.ai, {
    provider: "gemini",
    model: "m",
    systemPrompt: narratorPrompt.DEFAULT_NARRATOR_SYSTEM_PROMPT,
  });
});

test("legacy snapshot does not create a missing database", async () => {
  const sourceDb = await db.getDb();
  sourceDb.close();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("fworld");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });

  assert.deepEqual(await db.readLegacySnapshot(), {
    format: "fworld-legacy-migration",
    version: 1,
    games: [],
    sessions: [],
    messages: [],
  });
  assert.equal(
    (await indexedDB.databases()).some(
      (database) => database.name === "fworld",
    ),
    false,
  );
});
