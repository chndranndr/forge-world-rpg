import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

let vite;
let api;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  api = await vite.ssrLoadModule("/server/db.ts");
});

test.after(async () => {
  await vite?.close();
});

function withDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "fworld-sqlite-"));
  const databasePath = join(directory, "fworld.sqlite");
  const db = new api.GameDatabase(databasePath);
  const instances = [db];
  t.after(() => {
    for (const instance of instances) instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    directory,
    databasePath,
    track: (instance) => instances.push(instance),
  };
}

function definition(id = "game-1") {
  return {
    id,
    title: "Lantern Cafe",
    scenario: { setting: "Kamakura", startingSituation: "Rain at the harbor." },
    attributes: [{ id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 4 }],
    resources: [
      { id: "yen", name: "Yen", min: 0, max: 1000, initialValue: 100 },
    ],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [
      {
        id: "lantern",
        name: "Lantern",
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
        personality: ["quiet"],
        goals: ["find the lighthouse keeper"],
        privateKnowledge: ["The lighthouse door is hidden."],
        initialRelationships: { trust: 2 },
      },
    ],
    startingInventory: [{ itemId: "lantern", quantity: 1 }],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const ai = { provider: "gemini", model: "gemini-test" };

function message(
  sessionId,
  sequence,
  content,
  id = `message-${sessionId}-${sequence}`,
) {
  return {
    id,
    sessionId,
    turnId: "request-1",
    sequence,
    role: "NARRATOR",
    content,
    createdAt: "2026-10-01T00:00:01.000Z",
  };
}

function start(db, game = definition(), sessionId = "session-1") {
  const existing = db.getGame(game.id);
  return db.startSessionForDefinition({
    definition: game,
    ...(existing ? { expectedGameRevision: existing.revision } : {}),
    ai,
    sessionId,
  });
}

function commit(
  db,
  session,
  requestId,
  messages,
  result = { text: "done" },
  state = session.state,
) {
  db.startRun({
    sessionId: session.id,
    requestId,
    inputHash: `hash-${requestId}`,
    expectedRevision: db.getSession(session.id).revision,
  });
  return db.commitRun(session.id, requestId, { state, messages, result });
}

test("startSessionForDefinition creates a draft or revises an existing game atomically", (t) => {
  const { db } = withDb(t);
  const initial = start(db);
  assert.deepEqual(initial.game, { value: initial.game.value, revision: 1 });
  assert.equal(initial.game.value.id, "game-1");
  assert.equal(initial.session.value.definitionSnapshot.id, "game-1");
  assert.equal(db.listGames().length, 1);

  const firstState = initial.session.value.state;
  const changedState = {
    ...firstState,
    world: { ...firstState.world, scene: "Saved before template edit." },
  };
  commit(
    db,
    initial.session.value,
    "before-template-edit",
    [message("session-1", 0, "Original session history.")],
    {},
    changedState,
  );
  const firstSessionBeforeDraftUpdate = db.getSession("session-1");
  const firstHistoryBeforeDraftUpdate = db.getHistory("session-1");

  const edited = definition();

  edited.title = "Lantern Cafe at Dawn";
  const second = db.startSessionForDefinition({
    definition: edited,
    expectedGameRevision: initial.game.revision,
    ai,
    sessionId: "session-2",
  });
  assert.equal(second.game.value.id, "game-1");
  assert.equal(second.game.value.title, edited.title);
  assert.equal(second.game.revision, 2);
  assert.equal(second.session.value.definitionSnapshot.title, edited.title);
  assert.deepEqual(db.getSession("session-1"), firstSessionBeforeDraftUpdate);
  assert.deepEqual(db.getHistory("session-1"), firstHistoryBeforeDraftUpdate);

  assert.throws(
    () =>
      db.startSessionForDefinition({
        definition: edited,
        ai,
        sessionId: "session-3",
      }),
    api.ConflictError,
  );
  assert.throws(
    () =>
      db.startSessionForDefinition({
        definition: edited,
        expectedGameRevision: 1,
        ai,
        sessionId: "session-3",
      }),
    api.ConflictError,
  );
  assert.equal(db.listSessions("game-1").length, 2);

  const failedAtomicUpdate = { ...edited, title: "Must roll back" };
  assert.throws(() =>
    db.startSessionForDefinition({
      definition: failedAtomicUpdate,
      expectedGameRevision: 2,
      ai,
      sessionId: "session-1",
    }),
  );
  assert.equal(db.getGame("game-1").revision, 2);
  assert.equal(db.getGame("game-1").title, edited.title);
  assert.equal(db.listSessions("game-1").length, 2);
  assert.deepEqual(db.getSession("session-1"), firstSessionBeforeDraftUpdate);
  assert.deepEqual(db.getHistory("session-1"), firstHistoryBeforeDraftUpdate);
});

test("game and session updates enforce expected revisions", (t) => {
  const { db } = withDb(t);
  const created = start(db);
  const next = definition();
  const sessionBeforeGameUpdate = db.getSession(created.session.value.id);

  next.title = "Updated title";
  const updated = db.updateGame("game-1", next, 1);
  assert.equal(updated.revision, 2);
  assert.throws(() => db.updateGame("game-1", next, 1), api.ConflictError);

  const session = db.getSession(created.session.value.id);
  assert.deepEqual(session, sessionBeforeGameUpdate);

  const changed = db.updateSession(
    session.id,
    { ai: { provider: "openrouter", model: "m" } },
    session.revision,
  );
  assert.equal(changed.revision, session.revision + 1);
  assert.equal(changed.ai.provider, "openrouter");
  assert.throws(
    () => db.updateSession(session.id, { ai }, 1),
    api.ConflictError,
  );
});

test("game update leaves sessions unchanged and refuses active runs", (t) => {
  const { db } = withDb(t);
  const session = start(db).session.value;

  db.startRun({
    sessionId: session.id,
    requestId: "active",
    inputHash: "active-input",
    expectedRevision: 1,
  });
  assert.throws(
    () => db.updateSession(session.id, { ai: session.ai }, 1),
    (error) => error.code === "RUN_IN_PROGRESS",
  );
  const edited = definition();
  edited.title = "A new title";
  assert.throws(() => db.updateGame("game-1", edited, 1), api.ConflictError);
  assert.equal(db.getGame("game-1").revision, 1);
  assert.equal(db.getSession(session.id).revision, 1);

  db.failRun(session.id, "active", { code: "CANCELLED" });
  const changedState = {
    ...session.state,
    world: { ...session.state.world, scene: "Saved dynamic scene." },
  };
  commit(
    db,
    session,
    "state-change",
    [message(session.id, 0, "A saved history line.")],
    {},
    changedState,
  );
  const before = db.getSession(session.id);
  const beforeHistory = db.getHistory(session.id);
  const updated = db.updateGame("game-1", edited, 1);
  const after = db.getSession(session.id);
  assert.equal(updated.revision, 2);
  assert.deepEqual(after, before);
  assert.deepEqual(db.getHistory(session.id), beforeHistory);

  const future = db.startSavedSession({
    gameId: "game-1",
    expectedGameRevision: updated.revision,
    ai,
    sessionId: "future-session",
  });
  assert.equal(future.definitionSnapshot.title, edited.title);
  assert.deepEqual(db.getSession(session.id), before);
  assert.deepEqual(db.getHistory(session.id), beforeHistory);
});

test("game deletion removes saved sessions and their history, but blocks active runs", (t) => {
  const { db } = withDb(t);
  const first = start(db);
  commit(db, first.session.value, "history", [
    message(first.session.value.id, 0, "This saved scene will be deleted."),
  ]);
  const second = start(db, definition(), "session-2");
  db.startRun({
    sessionId: second.session.value.id,
    requestId: "active",
    inputHash: "active-input",
    expectedRevision: second.session.revision,
  });

  assert.throws(
    () => db.deleteGame("game-1", second.game.revision),
    (error) => error.code === "RUN_IN_PROGRESS",
  );
  assert.ok(db.getGame("game-1"));
  assert.equal(db.listSessions("game-1").length, 2);

  db.failRun(second.session.value.id, "active", { code: "CANCELLED" });
  db.deleteGame("game-1", second.game.revision);
  assert.equal(db.getGame("game-1"), undefined);
  assert.deepEqual(db.listSessions("game-1"), []);
  assert.equal(db.getSession(first.session.value.id), undefined);
  assert.equal(db.getSession(second.session.value.id), undefined);
});

test("run start is idempotent, rejects conflicts, and commits session/history once", (t) => {
  const { db } = withDb(t);
  const session = start(db).session.value;
  const input = {
    sessionId: session.id,
    requestId: "run-1",
    inputHash: "same-input",
    expectedRevision: 1,
  };
  assert.equal(db.startRun(input).status, "running");
  assert.equal(db.startRun(input).requestId, "run-1");
  assert.throws(
    () => db.startRun({ ...input, inputHash: "different" }),
    api.ConflictError,
  );
  assert.throws(
    () => db.startRun({ ...input, requestId: "run-2" }),
    api.ConflictError,
  );

  const first = db.commitRun(session.id, "run-1", {
    state: session.state,
    messages: [
      message(session.id, 0, "A lantern glows beside the harbor lighthouse."),
    ],
    result: { narrative: "The lantern lights the harbor." },
  });
  assert.equal(first.session.revision, 2);
  assert.equal(first.session.nextSequence, 1);
  assert.equal(first.run.status, "committed");
  const replay = db.commitRun(session.id, "run-1", {
    state: session.state,
    messages: [
      message(session.id, 0, "A lantern glows beside the harbor lighthouse."),
    ],
    result: { narrative: "The lantern lights the harbor." },
  });
  assert.equal(replay.session.revision, 2);
  assert.equal(db.getHistory(session.id).length, 1);
  assert.throws(
    () =>
      db.commitRun(session.id, "run-1", {
        state: session.state,
        messages: [],
        result: { narrative: "different" },
      }),
    api.ConflictError,
  );
  assert.throws(
    () =>
      db.startRun({ ...input, requestId: "stale-run", expectedRevision: 1 }),
    api.ConflictError,
  );
});

test("read-only runs commit results against their snapshot without changing session", (t) => {
  const { db } = withDb(t);
  const session = start(db).session.value;
  const input = {
    sessionId: session.id,
    requestId: "choices-1",
    inputHash: "choices-input",
    expectedRevision: 1,
    kind: "choices",
  };
  db.startRun(input);
  const result = { choices: ["Ask Aiko", "Leave"] };
  assert.equal(
    db.completeReadOnlyRun(session.id, input.requestId, result).status,
    "committed",
  );
  assert.equal(
    db.completeReadOnlyRun(session.id, input.requestId, result).status,
    "committed",
  );
  assert.equal(db.getSession(session.id).revision, 1);
  assert.equal(db.getSession(session.id).nextSequence, 0);
  assert.deepEqual(db.getHistory(session.id), []);
  assert.throws(
    () =>
      db.completeReadOnlyRun(session.id, input.requestId, {
        choices: ["different"],
      }),
    api.ConflictError,
  );
});

test("message uniqueness and failed writes roll back the whole run commit", (t) => {
  const { db, databasePath } = withDb(t);
  const first = start(db, definition(), "session-a").session.value;
  const second = start(db, definition(), "session-b").session.value;
  commit(db, first, "run-a", [
    message(first.id, 0, "Already stored.", "shared-message-id"),
  ]);
  db.startRun({
    sessionId: second.id,
    requestId: "run-b",
    inputHash: "hash-b",
    expectedRevision: 1,
  });

  assert.throws(() =>
    db.commitRun(second.id, "run-b", {
      state: {
        ...second.state,
        world: { ...second.state.world, scene: "Changed" },
      },
      messages: [
        message(second.id, 0, "Duplicate primary key.", "shared-message-id"),
      ],
      result: { ok: true },
    }),
  );
  assert.equal(db.getSession(second.id).revision, 1);
  assert.equal(
    db.getSession(second.id).state.world.scene,
    "Rain at the harbor.",
  );
  assert.equal(db.getHistory(second.id).length, 0);
  assert.equal(db.getRun(second.id, "run-b").status, "running");

  const raw = new DatabaseSync(databasePath);
  raw.exec("PRAGMA foreign_keys = ON");
  assert.throws(() =>
    raw
      .prepare(
        `INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at)
         VALUES ('orphan','missing-session','x',0,'NPC','x','now')`,
      )
      .run(),
  );
  assert.throws(() =>
    raw
      .prepare(
        `INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at)
         VALUES ('duplicate-seq','session-a','x',0,'NPC','x','now')`,
      )
      .run(),
  );
  raw.close();
});

test("failed and interrupted runs are retained without automatic replay", (t) => {
  const { db, databasePath, track } = withDb(t);
  const session = start(db).session.value;
  db.startRun({
    sessionId: session.id,
    requestId: "failed",
    inputHash: "h1",
    expectedRevision: 1,
  });
  assert.equal(
    db.failRun(session.id, "failed", { code: "MODEL_ERROR" }).status,
    "failed",
  );
  db.startRun({
    sessionId: session.id,
    requestId: "running",
    inputHash: "h2",
    expectedRevision: 1,
  });
  db.close();

  const recovered = new api.GameDatabase(databasePath);
  track(recovered);
  assert.equal(recovered.getRun(session.id, "running").status, "interrupted");
  assert.equal(recovered.getRun(session.id, "failed").status, "failed");
  assert.equal(recovered.getSession(session.id).revision, 1);
});

test("message paging, FTS, and scoped NPC/item detail work", (t) => {
  const { db } = withDb(t);
  const one = start(db, definition(), "session-one").session.value;
  const two = start(db, definition(), "session-two").session.value;
  commit(db, one, "run-one", [
    message(one.id, 0, "Aiko hides a brass key near the lighthouse."),
    {
      ...message(one.id, 1, "The harbor bell rings."),
      role: "NPC",
      speakerId: "aiko",
    },
  ]);
  commit(db, two, "run-two", [
    message(two.id, 0, "A quiet road crosses the valley."),
  ]);

  const page = db.listMessages(one.id, { limit: 1 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextAfterSequence, 0);
  const before = db.listMessagesBefore(one.id, 2, 1);
  assert.deepEqual(
    before.messages.map((item) => item.sequence),
    [1],
  );
  assert.equal(before.nextBeforeSequence, 1);
  assert.equal(before.hasMore, true);
  assert.deepEqual(
    db
      .listMessagesBefore(one.id, before.nextBeforeSequence, 1)
      .messages.map((item) => item.sequence),
    [0],
  );
  assert.equal(
    db.listMessages(one.id, { afterSequence: 0, limit: 1 }).messages[0]
      .sequence,
    1,
  );
  assert.equal(
    db
      .searchMemory(one.id, "lighthouse")
      .some((item) => item.kind === "message"),
    true,
  );
  assert.deepEqual(db.searchMemory(two.id, "lighthouse"), []);
  const current = db.getSession(one.id);
  const state = structuredClone(current.state);
  state.facts.push(
    {
      id: "known-secret",
      text: "Aiko knows the secret passage.",
      visibility: "private",
      knownBy: ["aiko"],
      createdAt: "2026-10-01T00:00:02.000Z",
      source: "story",
    },
    {
      id: "player-secret",
      text: "Ren knows the secret route.",
      visibility: "private",
      knownBy: ["player"],
      createdAt: "2026-10-01T00:00:02.500Z",
      source: "story",
    },
    {
      id: "unknown-secret",
      text: "A hidden secret from the valley.",
      visibility: "private",
      knownBy: [],
      createdAt: "2026-10-01T00:00:03.000Z",
      source: "story",
    },
  );
  db.updateSession(one.id, { state }, current.revision);
  const aikoFacts = db
    .searchMemory(one.id, "secret", "aiko")
    .filter((hit) => hit.kind === "fact");
  assert.deepEqual(
    aikoFacts.map((hit) => hit.id),
    ["known-secret"],
  );
  assert.equal(aikoFacts[0].source, "story");
  assert.equal(aikoFacts[0].visibility, "private");
  assert.deepEqual(aikoFacts[0].knownBy, ["aiko"]);
  assert.equal(
    aikoFacts.some((fact) => fact.id === "player-secret"),
    false,
  );
  assert.deepEqual(
    db
      .searchMemory(one.id, "secret")
      .filter((hit) => hit.kind === "fact")
      .map((hit) => hit.id),
    ["player-secret"],
  );
  assert.equal(
    db
      .searchMemory(one.id, "harbor")
      .find((hit) => hit.kind === "message" && hit.sequence === 1)?.speakerId,
    "aiko",
  );
  assert.equal(db.getNpcDetails(one.id, "aiko").relationship.trust, 2);
  assert.equal(db.getItemDetails(one.id, "lantern").quantity, 1);
  assert.throws(() => db.getNpcDetails(two.id, "missing"), api.NotFoundError);
});

test("AI ledger records per-attempt usage only and keeps unknown totals distinct", (t) => {
  const { db, databasePath } = withDb(t);
  const session = start(db).session.value;
  db.startRun({
    sessionId: session.id,
    requestId: "run-usage",
    inputHash: "usage-input",
    expectedRevision: 1,
  });
  const input = {
    id: "ai-1",
    sessionId: session.id,
    requestId: "run-usage",
    kind: "turn",
    attempt: 1,
    provider: "gemini",
    model: "gemini-test",
  };
  db.startAiRequest(input);
  assert.throws(() => db.startAiRequest({ ...input, id: "ai-duplicate" }));
  db.finishAiRequest("ai-1", {
    status: "succeeded",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    latencyMs: 123,
    finishReason: "stop",
  });
  const summary = db.getUsageSummary(session.id, "run-usage");
  assert.equal(summary.requests, 1);
  assert.equal(summary.totalTokens, 25);
  assert.equal(summary.latencyMs, 123);

  db.startAiRequest({ ...input, id: "ai-2", attempt: 2 });
  db.finishAiRequest("ai-2", { status: "unknown" });
  const all = db.getUsageSummary(session.id);
  assert.equal(all.totalTokens, 25);
  assert.equal(all.unknownUsageRequests, 1);

  const inspect = new DatabaseSync(databasePath);
  const columns = inspect
    .prepare("PRAGMA table_info(ai_requests)")
    .all()
    .map((row) => row.name);
  assert.equal(
    columns.some((name) => /prompt|key/i.test(name)),
    false,
  );
  inspect.close();
});

test("save v1 import creates fresh IDs and backup restore uses SQLite backup", async (t) => {
  const { db, directory, track } = withDb(t);
  const session = start(db).session.value;
  commit(db, session, "run-save", [
    message(session.id, 0, "The lighthouse is quiet."),
  ]);
  const bundle = db.exportSave(session.id);
  const imported = db.importSave(bundle);
  assert.notEqual(imported.gameId, bundle.game.id);
  assert.notEqual(imported.sessionId, bundle.session.id);
  assert.equal(
    db.getHistory(imported.sessionId)[0].sessionId,
    imported.sessionId,
  );
  assert.equal(
    db.getHistory(imported.sessionId)[0].id === bundle.messages[0].id,
    false,
  );

  const backupPath = join(directory, "verified-backup.sqlite");
  const restorePath = join(directory, "restored.sqlite");
  await db.backupTo(backupPath);
  const restored = await api.GameDatabase.restoreFrom(backupPath, restorePath);
  track(restored);
  assert.equal(
    restored.getSession(session.id).state.world.scene,
    session.state.world.scene,
  );
  assert.equal(
    restored.getHistory(session.id)[0].content,
    bundle.messages[0].content,
  );
  assert.equal(restored.getGame("game-1").revision, 1);
});

test("legacy transfer validates raw arrays, preserves IDs, verifies readback, and is idempotent", (t) => {
  const { db } = withDb(t);
  const game = definition();
  const session = {
    id: "session-1",
    gameId: game.id,
    definitionSnapshot: game,
    state: {
      attributes: { wit: 4 },
      resources: { yen: 100 },
      inventory: [{ itemId: "lantern", quantity: 1 }],
      relationships: [{ npcId: "aiko", values: { trust: 2 } }],
      facts: [],
      world: {
        location: "",
        time: "",
        scene: "Rain at the harbor.",
        activeCharacters: ["player", "aiko"],
      },
    },
    ai,
    nextSequence: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const legacy = {
    games: [game],
    sessions: [session],
    messages: [
      message(
        session.id,
        0,
        "Aiko remembers the lighthouse.",
        "legacy-message",
      ),
    ],
  };
  const receipt = db.transferLegacyStores(legacy);
  assert.equal(receipt.verified, true);
  assert.deepEqual(receipt.counts, { games: 1, sessions: 1, messages: 1 });
  assert.equal(db.getGame("game-1").id, "game-1");
  assert.equal(db.getSession(session.id).id, session.id);
  assert.equal(db.getHistory(session.id)[0].id, "legacy-message");
  assert.deepEqual(db.transferLegacyStores(legacy), receipt);
  assert.deepEqual(db.getMigrationReceipt(receipt.fingerprint), receipt);

  const malformed = structuredClone(legacy);
  malformed.games[0].attributes.push(null);
  assert.throws(() => db.transferLegacyStores(malformed), api.ValidationError);
});

test("legacy transfer rolls back all rows on ID conflict", (t) => {
  const { db } = withDb(t);
  db.createGame(definition("game-a"));
  const incomingGame = definition("game-a");
  incomingGame.title = "Conflicting definition";
  const otherGame = definition("game-b");
  const otherSession = {
    id: "legacy-session",
    gameId: otherGame.id,
    definitionSnapshot: otherGame,
    state: {
      attributes: { wit: 4 },
      resources: { yen: 100 },
      inventory: [{ itemId: "lantern", quantity: 1 }],
      relationships: [{ npcId: "aiko", values: { trust: 2 } }],
      facts: [],
      world: {
        location: "",
        time: "",
        scene: "Rain at the harbor.",
        activeCharacters: ["player", "aiko"],
      },
    },
    ai,
    nextSequence: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const payload = {
    games: [incomingGame, otherGame],
    sessions: [otherSession],
    messages: [message(otherSession.id, 0, "A migration must remain atomic.")],
  };
  assert.throws(() => db.transferLegacyStores(payload), api.ConflictError);
  assert.equal(db.getGame("game-b"), undefined);
  assert.equal(db.getSession("legacy-session"), undefined);
  assert.equal(db.listGames().length, 1);
});

test("AI profile snapshots stay stable across edits and rebinds keep identity", (t) => {
  const { db } = withDb(t);
  assert.throws(
    () =>
      db.createAiProfile({
        name: "x",
        provider: "custom",
        model: "m",
        systemPrompt: "p",
      }),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () =>
      db.createAiProfile({
        name: "x",
        provider: "gemini",
        model: "m",
        systemPrompt: "p",
        baseURL: "https://api.example.com/v1",
      }),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.equal(db.getSessionAiBinding("missing-session"), undefined);

  const profile = db.createAiProfile({
    name: "Router A",
    provider: "openrouter",
    model: "model-1",
    systemPrompt: "Prompt one.",
  });
  assert.equal(profile.revision, 1);
  const started = db.startSessionForDefinition({
    definition: definition("profile-game"),
    profileId: profile.id,
    sessionId: "profile-session",
  });
  assert.equal(started.session.value.ai.model, "model-1");
  assert.equal(started.session.value.ai.systemPrompt, "Prompt one.");
  const binding = db.getSessionAiBinding("profile-session");
  assert.equal(binding.profileId, profile.id);
  assert.equal(binding.credentialId, profile.credentialId);
  assert.equal(binding.provider, "openrouter");

  const edited = db.updateAiProfile(
    profile.id,
    {
      name: "Router A",
      provider: "openrouter",
      model: "model-2",
      systemPrompt: "Prompt two.",
    },
    profile.revision,
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.credentialId, profile.credentialId);
  assert.equal(db.getSession("profile-session").ai.model, "model-1");
  const second = db.startSessionForDefinition({
    definition: definition("profile-game-2"),
    profileId: profile.id,
    sessionId: "profile-session-2",
  });
  assert.equal(second.session.value.ai.model, "model-2");

  const beforeCommit = db.getSession("profile-session");
  commit(db, beforeCommit, "profile-run", [
    message("profile-session", 0, "Committed history."),
  ]);
  const afterCommit = db.getSession("profile-session");
  const applied = db.applySessionAiProfile(
    "profile-session",
    profile.id,
    afterCommit.revision,
  );
  assert.equal(applied.ai.model, "model-2");
  assert.equal(applied.ai.systemPrompt, "Prompt two.");
  assert.equal(applied.nextSequence, afterCommit.nextSequence);
  assert.deepEqual(applied.state, afterCommit.state);
  assert.equal(
    db.getHistory("profile-session")[0].content,
    "Committed history.",
  );

  assert.throws(
    () =>
      db.applySessionAiProfile(
        "profile-session",
        profile.id,
        afterCommit.revision,
      ),
    (error) => error.code === "CONFLICT",
  );
  assert.equal(db.getSession("profile-session").ai.model, "model-2");

  const activeRevision = db.getSession("profile-session").revision;
  db.startRun({
    sessionId: "profile-session",
    requestId: "active-profile-run",
    inputHash: "hash-active-profile",
    expectedRevision: activeRevision,
  });
  assert.throws(
    () =>
      db.applySessionAiProfile("profile-session", profile.id, activeRevision),
    (error) => error.code === "RUN_IN_PROGRESS",
  );
  assert.equal(db.getSession("profile-session").revision, activeRevision);
  assert.equal(
    db.getSessionAiBinding("profile-session").credentialId,
    profile.credentialId,
  );

  db.failRun("profile-session", "active-profile-run", {
    code: "TEST_FAILURE",
    message: "Test releases the running slot.",
  });
  const manual = db.updateSession(
    "profile-session",
    {
      ai: {
        provider: "openrouter",
        model: "model-3",
        systemPrompt: "Prompt three.",
      },
    },
    activeRevision,
  );
  assert.equal(manual.ai.model, "model-3");
  assert.equal(
    db.getSessionAiBinding("profile-session").credentialId,
    profile.credentialId,
  );

  db.updateSession(
    "profile-session",
    {
      ai: {
        provider: "gemini",
        model: "gemini-x",
        systemPrompt: "Prompt four.",
      },
    },
    manual.revision,
  );
  assert.equal(db.getSessionAiBinding("profile-session"), undefined);

  const custom = db.createAiProfile({
    name: "Custom A",
    provider: "custom",
    model: "custom-1",
    systemPrompt: "Prompt five.",
    baseURL: "https://api.example.com/v1",
  });
  const bound = db.startSessionForDefinition({
    definition: definition("custom-game"),
    profileId: custom.id,
    sessionId: "custom-session",
  });
  assert.equal(bound.session.value.ai.provider, "custom");
  const oldBinding = db.getSessionAiBinding("custom-session");
  const moved = db.updateAiProfile(
    custom.id,
    {
      name: "Custom A",
      provider: "custom",
      model: "custom-1",
      systemPrompt: "Prompt five.",
      baseURL: "https://api.example.com/v2",
    },
    custom.revision,
  );
  assert.notEqual(moved.credentialId, custom.credentialId);
  const keptBinding = db.getSessionAiBinding("custom-session");
  assert.equal(keptBinding.credentialId, oldBinding.credentialId);
  assert.equal(keptBinding.baseURL, "https://api.example.com/v1");
  db.startSessionForDefinition({
    definition: definition("custom-game-2"),
    profileId: custom.id,
    sessionId: "custom-session-2",
  });
  assert.equal(
    db.getSessionAiBinding("custom-session-2").baseURL,
    "https://api.example.com/v2",
  );
});
test("saved-world starts preserve stored definitions and metadata commits during a run", (t) => {
  const { db } = withDb(t);
  const created = db.createGame(definition("saved-start-game"));
  const first = db.startSavedSession({
    gameId: created.id,
    expectedGameRevision: created.revision,
    name: "  First story  ",
    ai,
    sessionId: "saved-first",
  });
  assert.equal(first.name, "First story");
  assert.equal(first.pinned, false);
  const olderBefore = db.getSession(first.id);

  const edited = definition("saved-start-game");
  edited.title = "Saved title";
  const saved = db.updateGame(created.id, edited, created.revision);
  assert.deepEqual(db.getSession(first.id), olderBefore);
  const second = db.startSavedSession({
    gameId: created.id,
    expectedGameRevision: saved.revision,
    name: "Second story",
    ai,
    sessionId: "saved-second",
  });
  assert.equal(db.getGame(created.id).title, "Saved title");
  assert.deepEqual(db.getSession(first.id), olderBefore);
  assert.equal(second.definitionSnapshot.title, "Saved title");

  const sessionCount = db.listSessions(created.id).length;
  assert.throws(
    () =>
      db.startSavedSession({
        gameId: created.id,
        expectedGameRevision: 1,
        ai,
      }),
    api.ConflictError,
  );
  assert.throws(
    () =>
      db.startSavedSession({
        gameId: created.id,
        expectedGameRevision: saved.revision,
        ai: { provider: "custom", model: "custom-model" },
      }),
    api.ValidationError,
  );
  assert.throws(
    () =>
      db.startSavedSession({
        gameId: created.id,
        expectedGameRevision: saved.revision,
        profileId: "missing-profile",
      }),
    api.NotFoundError,
  );
  const unplayable = definition("unplayable-saved-game");
  unplayable.player.name = "";
  const draft = db.createGame(unplayable);
  assert.throws(
    () =>
      db.startSavedSession({
        gameId: draft.id,
        expectedGameRevision: draft.revision,
        ai,
      }),
    api.ValidationError,
  );
  assert.equal(db.listSessions(created.id).length, sessionCount);
  assert.equal(db.listSessions(draft.id).length, 0);
  assert.equal(db.getGame(created.id).revision, saved.revision);

  const before = db.getSession(second.id);
  db.startRun({
    sessionId: second.id,
    requestId: "metadata-during-run",
    inputHash: "metadata",
    expectedRevision: before.revision,
  });
  const metadata = db.updateSessionMetadata(second.id, {
    name: "  Renamed during run  ",
    pinned: true,
  });
  assert.equal(metadata.name, "Renamed during run");
  assert.equal(metadata.pinned, true);
  const pinOnly = db.updateSessionMetadata(second.id, { pinned: true });
  assert.equal(pinOnly.name, "Renamed during run");
  assert.equal(pinOnly.revision, before.revision);
  assert.equal(pinOnly.updatedAt, before.updatedAt);
  assert.throws(
    () => db.updateSessionMetadata(second.id, { name: 42 }),
    api.ValidationError,
  );
  assert.throws(
    () => db.updateSessionMetadata(second.id, { name: " ".repeat(300) }),
    api.ValidationError,
  );
  assert.throws(
    () => db.updateSessionMetadata(second.id, { name: "x".repeat(257) }),
    api.ValidationError,
  );
  assert.equal(metadata.revision, before.revision);
  assert.equal(metadata.updatedAt, before.updatedAt);
  const committed = db.commitRun(second.id, "metadata-during-run", {
    state: before.state,
    messages: [message(second.id, 0, "The scene continues.")],
    result: { ok: true },
  });
  assert.equal(committed.session.name, "Renamed during run");
  assert.equal(committed.session.pinned, true);
  assert.equal(committed.session.revision, before.revision + 1);
  const exported = db.exportSave(second.id);
  assert.equal(exported.session.name, "Renamed during run");
  assert.equal(exported.session.pinned, true);
  const copiedIds = db.importSave(exported);
  const copied = db.getSession(copiedIds.sessionId);
  assert.notEqual(copied.id, second.id);
  assert.equal(copied.name, "Renamed during run");
  assert.equal(copied.pinned, true);
  assert.throws(
    () => db.updateSessionMetadata(second.id, {}),
    api.ValidationError,
  );
  assert.throws(
    () => db.updateSessionMetadata(second.id, { pinned: "yes" }),
    api.ValidationError,
  );
  const cleared = db.updateSessionMetadata(second.id, { name: null });
  assert.equal(cleared.name, undefined);
  assert.equal(cleared.pinned, true);
});

test("session deletion checks revision and running state, then cascades all session data", (t) => {
  const { db, databasePath } = withDb(t);
  const game = db.createGame(definition("delete-session-game"));
  const profile = db.createAiProfile({
    name: "Delete test profile",
    provider: "gemini",
    model: "gemini-test",
    systemPrompt: "A test prompt.",
  });
  const session = db.startSavedSession({
    gameId: game.id,
    expectedGameRevision: game.revision,
    profileId: profile.id,
    sessionId: "delete-session",
  });
  db.startRun({
    sessionId: session.id,
    requestId: "history-run",
    inputHash: "history",
    expectedRevision: session.revision,
  });
  db.commitRun(session.id, "history-run", {
    state: session.state,
    messages: [message(session.id, 0, "Delete cascade needle.")],
    result: { ok: true },
  });
  db.saveContextTelemetry(session.id, "history-run", {
    contextChars: 10,
    approximateTokens: 3,
    tokenEstimateMethod: "test",
    sections: {},
    selectedLoreIds: [],
    omissions: [],
    toolCalls: 0,
    repairs: 0,
  });
  const revision = db.getSession(session.id).revision;
  db.startRun({
    sessionId: session.id,
    requestId: "active-run",
    inputHash: "active",
    expectedRevision: revision,
  });
  assert.throws(
    () => db.deleteSession(session.id, revision - 1),
    api.ConflictError,
  );
  assert.throws(
    () => db.deleteSession(session.id, revision),
    (error) => error.code === "RUN_IN_PROGRESS",
  );
  assert.ok(db.getSession(session.id));
  assert.ok(db.getSessionAiBinding(session.id));
  db.failRun(session.id, "active-run", { code: "CANCELLED" });

  db.deleteSession(session.id, revision);
  assert.equal(db.getSession(session.id), undefined);
  assert.equal(db.getSessionAiBinding(session.id), undefined);
  assert.equal(db.getContextTelemetry(session.id, "history-run"), undefined);
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    raw
      .prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id = ?")
      .get(session.id).count,
    0,
  );
  assert.equal(
    raw
      .prepare(
        "SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'needle'",
      )
      .get().count,
    0,
  );
  raw.close();
});
