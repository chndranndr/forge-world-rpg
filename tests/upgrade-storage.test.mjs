import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

let vite;
let api;
let engine;
let world;
let narratorPrompt;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  api = await vite.ssrLoadModule("/server/db.ts");
  engine = await vite.ssrLoadModule("/shared/engine.ts");
  world = await vite.ssrLoadModule("/shared/world.ts");
  narratorPrompt = await vite.ssrLoadModule("/shared/narrator-prompt.ts");
});

test.after(async () => {
  await vite?.close();
});

function withDb(t, prefix = "fworld-upgrade-storage-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(directory, "fworld.sqlite");
  const instances = [];
  const db = new api.GameDatabase(databasePath);
  instances.push(db);
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

function definition(id = "upgrade-game") {
  return {
    id,
    title: "Lantern Cafe",
    scenario: { setting: "Morroc", startingSituation: "Rain at the market." },
    attributes: [{ id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 4 }],
    resources: [
      { id: "coin", name: "Coin", min: 0, max: 100, initialValue: 30 },
    ],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [
      {
        id: "aiko",
        name: "Aiko",
        personality: ["quiet"],
        goals: ["protect the archive"],
        privateKnowledge: [],
        initialRelationships: { trust: 1 },
      },
      {
        id: "bryn",
        name: "Bryn",
        personality: ["curious"],
        goals: ["find a route"],
        privateKnowledge: [],
        initialRelationships: { trust: 0 },
      },
    ],
    startingInventory: [],
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
}

const ai = { provider: "gemini", model: "gemini-upgrade-test" };

function entry(id, kind, name, extra = {}) {
  return {
    id,
    kind,
    name,
    aliases: [],
    summary: `${name} overview`,
    body: `${name} details for storage tests.`,
    tags: [],
    visibility: "public",
    metadata: {},
    provenance: { sourceId: "upgrade-storage-tests" },
    ...extra,
  };
}

function pack(id, version, entries, links = []) {
  return {
    format: "fworld-lorebook",
    version: 1,
    pack: { id, version, name: `Pack ${id}` },
    entries,
    links,
  };
}

function start(db, game = definition(), sessionId = "upgrade-session") {
  const existing = db.getGame(game.id);
  return db.startSessionForDefinition({
    definition: game,
    ...(existing ? { expectedGameRevision: existing.revision } : {}),
    ai,
    sessionId,
  });
}

function message(
  sessionId,
  sequence,
  content,
  scope = {},
  turnId = "upgrade-turn",
) {
  return {
    id: `message-${sessionId}-${sequence}`,
    sessionId,
    turnId,
    sequence,
    role: "NARRATOR",
    content,
    createdAt: `2026-10-12T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    ...scope,
  };
}

function commitBatch(db, sessionId, requestId, messages) {
  const session = db.getSession(sessionId);
  db.startRun({
    sessionId,
    requestId,
    inputHash: `hash-${requestId}`,
    expectedRevision: session.revision,
  });
  return db.commitRun(sessionId, requestId, {
    state: session.state,
    messages,
    result: { committed: messages.length },
  });
}

function createV1Database(path) {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE games (
      id TEXT PRIMARY KEY NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
      definition_snapshot_json TEXT NOT NULL CHECK (json_valid(definition_snapshot_json)),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      ai_json TEXT NOT NULL CHECK (json_valid(ai_json)),
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX sessions_by_game ON sessions(game_id, updated_at DESC);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      role TEXT NOT NULL CHECK (role IN ('PLAYER','NPC','NARRATOR','SYSTEM_EVENT')),
      speaker_id TEXT,
      content TEXT NOT NULL,
      check_json TEXT CHECK (check_json IS NULL OR json_valid(check_json)),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, sequence)
    ) STRICT;
    CREATE INDEX messages_page ON messages(session_id, sequence);
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, content='messages', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','item_use')),
      status TEXT NOT NULL CHECK (status IN ('running','committed','failed','interrupted')),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    ) STRICT;
    CREATE UNIQUE INDEX one_running_turn_per_session ON turns(session_id)
      WHERE status = 'running';
    CREATE TABLE ai_requests (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','connection_test')),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter')),
      model TEXT NOT NULL,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
      cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
      reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
      latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
      finish_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX ai_usage_by_session ON ai_requests(session_id, created_at);
    CREATE INDEX ai_usage_by_run ON ai_requests(session_id, request_id, attempt);
    CREATE UNIQUE INDEX ai_attempt_once ON ai_requests(session_id, request_id, kind, attempt)
      WHERE request_id IS NOT NULL;
    CREATE TABLE migrations (
      fingerprint TEXT PRIMARY KEY NOT NULL,
      counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
      ids_json TEXT NOT NULL CHECK (json_valid(ids_json)),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  const game = definition("legacy-v1-game");
  const session = {
    id: "legacy-v1-session",
    gameId: game.id,
    definitionSnapshot: game,
    state: engine.buildInitialState(game),
    ai,
    nextSequence: 1,
    updatedAt: "2026-10-12T00:00:01.000Z",
  };
  raw
    .prepare(
      "INSERT INTO games(id, definition_json, revision, updated_at) VALUES (?, ?, 1, ?)",
    )
    .run(game.id, JSON.stringify(game), game.updatedAt);
  raw
    .prepare(
      `INSERT INTO sessions(
       id, game_id, definition_snapshot_json, state_json, ai_json,
       next_sequence, revision, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      session.id,
      session.gameId,
      JSON.stringify(session.definitionSnapshot),
      JSON.stringify(session.state),
      JSON.stringify(session.ai),
      session.nextSequence,
      session.updatedAt,
    );
  raw
    .prepare(
      `INSERT INTO messages(
       id, session_id, turn_id, sequence, role, speaker_id, content,
       check_json, created_at
     ) VALUES (?, ?, ?, 0, 'NARRATOR', NULL, ?, NULL, ?)`,
    )
    .run(
      "legacy-v1-message",
      session.id,
      "legacy-v1-turn",
      "Legacy story survives the schema upgrade.",
      "2026-10-12T00:00:01.000Z",
    );
  raw.close();
}

test("v1 databases migrate and reopen, and restore upgrades before replacing the target", async (t) => {
  const { db, directory, track } = withDb(t);
  db.close();
  const migrationPath = join(directory, "legacy-v1-migration.sqlite");
  createV1Database(migrationPath);
  const migrated = new api.GameDatabase(migrationPath);
  track(migrated);
  assert.equal(migrated.getSession("legacy-v1-session").nextSequence, 1);
  assert.equal(
    migrated.getHistory("legacy-v1-session")[0].content,
    "Legacy story survives the schema upgrade.",
  );
  migrated.close();
  const reopened = new api.GameDatabase(migrationPath);
  track(reopened);
  assert.equal(reopened.getSession("legacy-v1-session").nextSequence, 1);
  assert.equal(reopened.getHistory("legacy-v1-session").length, 1);
  reopened.close();

  const v1Original = join(directory, "legacy-v1-original.sqlite");
  createV1Database(v1Original);
  const v1Backup = join(directory, "legacy-v1-backup.sqlite");
  copyFileSync(v1Original, v1Backup);
  const targetPath = join(directory, "restored.sqlite");
  const existing = new api.GameDatabase(targetPath);
  existing.createGame(definition("pre-restore-sentinel"));
  existing.close();
  const restored = await api.GameDatabase.restoreFrom(v1Backup, targetPath);
  track(restored);
  assert.deepEqual(
    restored.listGames().map((game) => game.id),
    ["legacy-v1-game"],
  );
  assert.equal(restored.getHistory("legacy-v1-session").length, 1);
  const v2Backup = join(directory, "upgraded-v2-backup.sqlite");
  await restored.backupTo(v2Backup);
  const roundTrip = await api.GameDatabase.restoreFrom(
    v2Backup,
    join(directory, "restored-round-trip.sqlite"),
  );
  track(roundTrip);
  assert.deepEqual(
    roundTrip.listGames().map((game) => game.id),
    ["legacy-v1-game"],
  );

  const invalidBackup = join(directory, "unsupported.sqlite");
  const invalid = new DatabaseSync(invalidBackup);
  invalid.exec("PRAGMA user_version = 99");
  invalid.close();
  await assert.rejects(
    api.GameDatabase.restoreFrom(invalidBackup, targetPath),
    (error) => error.code === "SCHEMA_VERSION",
  );
  assert.deepEqual(
    restored.listGames().map((game) => game.id),
    ["legacy-v1-game"],
  );
});

test("startup repairs missing tables and indexes without losing surviving story data", (t) => {
  const { db, databasePath, track } = withDb(t);
  const started = start(db, definition("repair-game"), "repair-session");
  commitBatch(db, "repair-session", "before-repair", [
    message("repair-session", 0, "Original story phrase survives repair."),
  ]);
  db.close();

  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO story_summary_cursors(session_id, next_sequence)
    VALUES ('repair-session', 1);
    DROP TABLE story_summary_cursors;
    DROP TABLE messages_fts;
  `);
  raw.close();

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let repaired;
  try {
    repaired = new api.GameDatabase(databasePath);
  } finally {
    console.warn = originalWarn;
  }
  track(repaired);

  assert.deepEqual(
    repaired.listGames().map((game) => game.id),
    [started.game.value.id],
  );
  assert.equal(repaired.getSession("repair-session").nextSequence, 1);
  assert.deepEqual(
    repaired.getHistory("repair-session").map((item) => item.content),
    ["Original story phrase survives repair."],
  );
  assert.deepEqual(
    repaired
      .searchMemory("repair-session", "survives repair")
      .map((item) => item.sequence),
    [0],
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0][1].tables, ["story_summary_cursors"]);
  assert.match(warnings[0][0], /Restore a backup/);

  const current = repaired.getSession("repair-session");
  commitBatch(repaired, "repair-session", "after-repair", [
    message(
      "repair-session",
      current.nextSequence,
      "Fresh message is indexed after repair.",
    ),
  ]);
  assert.equal(
    repaired
      .searchMemory("repair-session", "indexed after repair")
      .some((item) => item.kind === "message" && item.sequence === 1),
    true,
  );
});

test("v1 repair reports missing table rows as backup-only recovery", (t) => {
  const { db, directory, track } = withDb(t);
  db.close();
  const databasePath = join(directory, "legacy-v1-missing-table.sqlite");
  createV1Database(databasePath);
  const raw = new DatabaseSync(databasePath);
  raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE messages;");
  raw.close();

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let repaired;
  try {
    repaired = new api.GameDatabase(databasePath);
  } finally {
    console.warn = originalWarn;
  }
  track(repaired);

  assert.deepEqual(
    repaired.listGames().map((game) => game.id),
    ["legacy-v1-game"],
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0][1].tables, ["messages"]);
  assert.match(warnings[0][0], /Restore a backup/);
});

test("lore publication is immutable, transactional, escaped, scoped, and location-aware", (t) => {
  const { db, databasePath } = withDb(t);
  const ref = { packId: "morroc", version: 1 };
  const morrocPack = pack(
    ref.packId,
    ref.version,
    [
      entry("world:midgard", "world", "Midgard"),
      entry("region:sograt-road", "region", "Sograt Road", {
        parentId: "world:midgard",
      }),
      entry("loc:morroc", "location", "Morroc", {
        parentId: "region:sograt-road",
        aliases: ["Sograt"],
      }),
      entry("loc:prontera", "location", "Prontera", {
        parentId: "region:sograt-road",
      }),
      entry("npc:prontera-guide", "npc", "Prontera Guide", {
        parentId: "loc:prontera",
      }),
      entry("place:morroc_market", "place", "Morroc Market", {
        parentId: "loc:morroc",
        aliases: ["Market"],
      }),
      entry("npc:aiko", "npc", "Aiko", {
        parentId: "place:morroc_market",
        metadata: { actorId: "aiko" },
      }),
      entry("activity:trading", "activity", "Market trading", {
        parentId: "place:morroc_market",
      }),
      entry("history:morroc_foundation", "history", "Founding of Morroc", {
        aliases: ["Morroc foundation"],
        body: "The history of Morroc began before the desert road was built.",
      }),
      entry("secret:archive", "other", "Sealed archive", {
        visibility: "narrator",
        body: "The sealed archive contains private prose.",
      }),
    ],
    [
      {
        fromId: "loc:morroc",
        toId: "place:morroc_market",
        relation: "PARENT_OF",
      },
      {
        fromId: "npc:aiko",
        toId: "place:morroc_market",
        relation: "PRESENT_AT",
      },
      {
        fromId: "place:morroc_market",
        toId: "secret:archive",
        relation: "RELATED_TO",
      },
    ],
  );
  const dryRun = db.importLorebook(morrocPack, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(db.listLorebooks().total, 0);
  const published = db.importLorebook(morrocPack);
  assert.equal(db.importLorebook(morrocPack).existing, true);
  assert.equal(db.importLorebook(morrocPack).digest, published.digest);
  const changed = structuredClone(morrocPack);
  changed.entries[0].body = "Different immutable content.";
  assert.throws(
    () => db.importLorebook(changed),
    (error) => error.code === "LOREBOOK_VERSION_CONFLICT",
  );

  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    CREATE TRIGGER reject_bad_lore BEFORE INSERT ON lore_entries
    WHEN new.entry_id = 'bad:second'
    BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END;
  `);
  raw.close();
  const rollbackPack = pack("rollback", 1, [
    entry("good:first", "other", "First entry"),
    entry("bad:second", "other", "Second entry"),
  ]);
  assert.throws(() => db.importLorebook(rollbackPack));
  assert.equal(
    db.listLorebooks().packs.some((item) => item.id === "rollback"),
    false,
  );
  const check = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    Number(
      check
        .prepare(
          "SELECT COUNT(*) AS n FROM lore_entries WHERE pack_id='rollback'",
        )
        .get().n,
    ),
    0,
  );
  check.close();

  const otherPack = pack("other-pack", 1, [
    entry("other:morroc", "other", "Morroc other-version", {
      body: "Morroc appears in a separate exact pack scope.",
    }),
  ]);
  db.importLorebook(otherPack);
  const creatorExport = db.exportLorebook(ref);
  assert.equal(creatorExport.entries.length, 10);
  assert.equal(
    creatorExport.entries.some((item) => item.id === "secret:archive"),
    true,
  );
  const publicPage = db.listLoreEntries(ref, { limit: 100 });
  assert.equal(
    publicPage.entries.some((item) => item.id === "secret:archive"),
    false,
  );
  assert.equal(publicPage.total, 9);
  const morrocSearch = db.listLoreEntries(ref, { query: "Morroc", limit: 100 });
  assert.equal(
    morrocSearch.entries.some((item) => item.id === "other:morroc"),
    false,
  );
  assert.doesNotThrow(() => db.listLoreEntries(ref, { query: '" OR : MATCH' }));
  const page = db.listLoreEntries(ref, { limit: 1, offset: 1 });
  assert.equal(page.total, publicPage.total);
  assert.equal(page.entries.length, 1);
  const links = db.listLoreLinks(ref, "loc:morroc", { limit: 10 });
  assert.equal(links.total, 1);
  assert.equal(links.links[0].toId, "place:morroc_market");

  const game = definition("morroc-game");
  game.lorebookRefs = [ref];
  game.startingLocationId = "loc:morroc";
  const started = start(db, game, "morroc-session");
  const pinnedMap = db.getWorldMap(started.session.value);
  assert.equal(
    pinnedMap.locations
      .find((item) => item.id === "loc:morroc")
      .npcIds.includes("aiko"),
    true,
  );
  assert.equal(started.session.value.state.world.locationId, "loc:morroc");
  assert.equal(
    pinnedMap.locations.find((item) => item.id === "loc:morroc").parentId,
    undefined,
  );
  assert.equal(
    db.getLoreEntry([ref], "loc:morroc")?.parentId,
    "region:sograt-road",
  );
  const locationLore = db.retrieveLore([ref], { locationId: "loc:morroc" });
  assert.equal(
    locationLore.find((item) => item.id === "loc:morroc")?.parentId,
    "region:sograt-road",
  );
  const preview = db.previewLore(game, { locationId: "Market" });
  assert.equal(preview.locationId, "place:morroc_market");
  assert.deepEqual(preview.activeNpcIds, ["aiko"]);
  assert.equal(
    preview.entries.some((item) => item.id === "secret:archive"),
    false,
  );
  const morrocPreview = db.previewLore(game, {
    locationId: "loc:morroc",
    query: "market receipts",
  });
  assert.equal(
    morrocPreview.entries.some((item) => item.id === "region:sograt-road"),
    true,
  );
  assert.equal(
    morrocPreview.entries.some((item) => item.id === "world:midgard"),
    true,
  );
  assert.equal(
    morrocPreview.entries.some((item) => item.id === "npc:prontera-guide"),
    false,
  );

  const localOnly = db.retrieveLore([ref], {
    locationId: "place:morroc_market",
    query: "Morroc",
  });
  assert.equal(
    localOnly.some((item) => item.kind === "history"),
    false,
  );
  const localConversation = db.retrieveLore([ref], {
    locationId: "place:morroc_market",
    query: "I buy a receipt at Morroc Market",
  });
  assert.equal(
    localConversation.some((item) => item.kind === "history"),
    false,
  );
  const explicitHistory = db.retrieveLore([ref], {
    locationId: "place:morroc_market",
    query: "Morroc history",
  });
  assert.equal(
    explicitHistory.some((item) => item.id === "history:morroc_foundation"),
    true,
  );
  const naturalHistory = db.retrieveLore([ref], {
    locationId: "place:morroc_market",
    query:
      "Ask Sava about the history behind Morroc's shared road ledger and parcel handoffs.",
  });
  assert.equal(
    naturalHistory
      .slice(0, 5)
      .some((item) => item.id === "history:morroc_foundation"),
    true,
  );

  const duplicateAliasGame = definition("duplicate-alias-game");
  duplicateAliasGame.worldMap = {
    locations: [
      { id: "loc:one", name: "One", aliases: ["Harbor"], npcIds: [] },
      { id: "loc:two", name: "Two", aliases: ["Harbor"], npcIds: [] },
    ],
    connections: [],
  };
  duplicateAliasGame.startingLocationId = "loc:one";
  assert.equal(
    world.resolveLocation(duplicateAliasGame.worldMap, "Harbor").kind,
    "ambiguous",
  );
  assert.throws(() =>
    db.previewLore(duplicateAliasGame, { locationId: "Harbor" }),
  );

  const duplicateIdOne = pack("duplicate-one", 1, [
    entry("same:identity", "other", "Same identity"),
  ]);
  const duplicateIdTwo = pack("duplicate-two", 1, [
    entry("same:identity", "other", "Same identity again"),
  ]);
  db.importLorebook(duplicateIdOne);
  db.importLorebook(duplicateIdTwo);
  assert.throws(
    () =>
      db.validateLoreBindings(
        [
          { packId: "duplicate-one", version: 1 },
          { packId: "duplicate-two", version: 1 },
        ],
        definition(),
      ),
    (error) => error.code === "INVALID_LORE_BINDING",
  );
  const badMapping = pack("bad-mapping", 1, [
    entry("npc:unknown", "npc", "Unknown actor", {
      metadata: { actorId: "missing-npc" },
    }),
  ]);
  db.importLorebook(badMapping);
  assert.throws(
    () =>
      db.validateLoreBindings(
        [{ packId: "bad-mapping", version: 1 }],
        definition(),
      ),
    (error) => error.code === "INVALID_LORE_BINDING",
  );
  assert.throws(
    () =>
      db.validateLoreBindings([{ packId: "absent", version: 1 }], definition()),
    (error) => error.code === "LORE_DEPENDENCY_MISSING",
  );
});

test("session map pins survive game edits and save dependencies are checked before writes", (t) => {
  const { db } = withDb(t);
  const oldPack = pack("world", 1, [entry("loc:morroc", "location", "Morroc")]);
  const newPack = pack("world", 2, [
    entry("loc:prontera", "location", "Prontera"),
  ]);
  db.importLorebook(oldPack);
  db.importLorebook(newPack);
  const missingGame = definition("missing-lore-game");
  missingGame.lorebookRefs = [{ packId: "world", version: 100 }];
  assert.throws(
    () => db.createGame(missingGame),
    (error) => error.code === "LORE_DEPENDENCY_MISSING",
  );
  assert.equal(db.getGame(missingGame.id), undefined);
  const original = definition("pinned-world-game");
  original.lorebookRefs = [{ packId: "world", version: 1 }];
  original.startingLocationId = "loc:morroc";
  const first = start(db, original, "pinned-old-session");
  const missingUpdate = structuredClone(original);
  missingUpdate.title = "Must not persist";
  missingUpdate.lorebookRefs = [{ packId: "world", version: 100 }];
  assert.throws(
    () => db.updateGame(original.id, missingUpdate, first.game.revision),
    (error) => error.code === "LORE_DEPENDENCY_MISSING",
  );
  assert.equal(db.getGame(original.id).title, original.title);
  assert.equal(db.getGame(original.id).revision, first.game.revision);
  assert.deepEqual(db.getSession(first.session.value.id).lorebookRefs, [
    { packId: "world", version: 1 },
  ]);
  const oldPin = db.getSession(first.session.value.id);
  const oldMap = db.getWorldMap(oldPin);

  const updatedDefinition = structuredClone(original);
  updatedDefinition.title = "New default world";
  updatedDefinition.lorebookRefs = [{ packId: "world", version: 2 }];
  updatedDefinition.startingLocationId = "loc:prontera";
  updatedDefinition.updatedAt = "2026-10-12T01:00:00.000Z";
  const updatedGame = db.updateGame(
    original.id,
    updatedDefinition,
    first.game.revision,
  );
  const preserved = db.getSession(first.session.value.id);
  assert.deepEqual(preserved.lorebookRefs, [{ packId: "world", version: 1 }]);
  assert.deepEqual(preserved.definitionSnapshot.lorebookRefs, [
    { packId: "world", version: 1 },
  ]);
  assert.deepEqual(db.getWorldMap(preserved), oldMap);
  assert.equal(preserved.state.world.locationId, "loc:morroc");

  const future = db.startSessionForDefinition({
    definition: updatedDefinition,
    expectedGameRevision: updatedGame.revision,
    ai,
    sessionId: "pinned-new-session",
  });
  assert.deepEqual(future.session.value.lorebookRefs, [
    { packId: "world", version: 2 },
  ]);
  assert.equal(future.session.value.state.world.locationId, "loc:prontera");
  assert.deepEqual(
    db.getWorldMap(db.getSession(first.session.value.id)),
    oldMap,
  );

  const source = withDb(t, "fworld-save-source-");
  const savePack = pack("save-world", 1, [
    entry("loc:save", "location", "Save location"),
  ]);
  source.db.importLorebook(savePack);
  const saveDefinition = definition("v2-save-game");
  saveDefinition.lorebookRefs = [{ packId: "save-world", version: 1 }];
  saveDefinition.startingLocationId = "loc:save";
  const saveSession = start(source.db, saveDefinition, "v2-save-session");
  const bundle = source.db.exportSave(saveSession.session.value.id);
  assert.equal(bundle.version, 2);
  assert.equal(
    bundle.loreDependencies[0].digest,
    source.db.listLorebooks().packs[0].digest,
  );

  const target = withDb(t, "fworld-save-target-");
  const missingManifest = structuredClone(bundle);
  delete missingManifest.loreDependencies;
  assert.throws(() => target.db.importSave(missingManifest));
  assert.throws(
    () => target.db.importSave(bundle),
    (error) => error.code === "LORE_DEPENDENCY_MISSING",
  );
  assert.equal(target.db.listGames().length, 0);
  assert.equal(target.db.listSessions(saveDefinition.id).length, 0);

  target.db.importLorebook(savePack);
  const wrongDigest = structuredClone(bundle);
  wrongDigest.loreDependencies[0].digest = "0".repeat(64);
  assert.throws(
    () => target.db.importSave(wrongDigest),
    (error) => error.code === "LORE_DEPENDENCY_MISMATCH",
  );
  assert.equal(target.db.listGames().length, 0);
  const imported = target.db.importSave(bundle);
  const restoredSession = target.db.getSession(imported.sessionId);
  assert.deepEqual(restoredSession.lorebookRefs, [
    { packId: "save-world", version: 1 },
  ]);
  assert.equal(restoredSession.state.world.locationId, "loc:save");

  const legacySource = definition("legacy-v1-save-game");
  const legacySession = start(
    source.db,
    legacySource,
    "legacy-v1-save-session",
  );
  const legacyBundle = source.db.exportSave(legacySession.session.value.id);
  assert.equal(legacyBundle.version, 1);
  const legacyImport = target.db.importSave(legacyBundle);
  assert.equal(
    target.db.getSession(legacyImport.sessionId).lorebookRefs,
    undefined,
  );
});

test("scoped history, extractive summaries, and telemetry remain idempotent and noncanonical", (t) => {
  const { db, databasePath } = withDb(t);
  const started = start(db, definition("memory-game"), "memory-session");
  const sessionId = started.session.value.id;
  const messages = [];
  messages.push(
    message(sessionId, 0, "needle The silver bridge collapsed before dawn.", {
      visibility: "public",
    }),
  );
  messages.push(
    message(sessionId, 1, "needle Aiko discovered the emerald seal.", {
      visibility: "private",
      knownBy: ["player", "aiko"],
    }),
  );
  messages.push(
    message(sessionId, 2, "needle Bryn knows the cobalt key.", {
      visibility: "private",
      knownBy: ["bryn"],
    }),
  );
  messages.push(message(sessionId, 3, "needle A legacy private note."));
  for (let sequence = 4; sequence < 120; sequence += 1) {
    messages.push(
      message(
        sessionId,
        sequence,
        `needle Bryn private receipt ${sequence}. ${"x".repeat(300)}`,
        { visibility: "private", knownBy: ["bryn"] },
      ),
    );
  }
  commitBatch(db, sessionId, "long-history", messages);
  assert.equal(db.getHistory(sessionId).length, 120);
  assert.deepEqual(
    db.getRecentHistory(sessionId, 1, "aiko").map((item) => item.sequence),
    [1],
  );
  assert.deepEqual(
    db.getRecentHistory(sessionId, 1, "bryn").map((item) => item.sequence),
    [119],
  );
  const aikoMemory = db.searchMemory(sessionId, "needle", "aiko");
  assert.equal(
    aikoMemory.some((item) => item.kind === "message" && item.sequence === 1),
    true,
  );
  assert.equal(
    aikoMemory.some((item) => item.kind === "message" && item.sequence > 1),
    false,
  );
  const playerMemory = db.searchMemory(sessionId, "needle");
  assert.deepEqual(
    playerMemory
      .filter((item) => item.kind === "message")
      .map((item) => item.sequence)
      .sort((left, right) => left - right),
    [0, 1, 3],
  );
  assert.equal(
    db
      .searchMemory(sessionId, "cobalt key", "bryn")
      .some((item) => item.kind === "message" && item.sequence === 2),
    true,
  );
  assert.equal(db.searchMemory(sessionId, "cobalt key").length, 0);
  assert.equal(
    db.searchMemory(sessionId, "legacy private note", "aiko").length,
    0,
  );
  assert.throws(
    () => db.searchMemory(sessionId, "needle", ""),
    (error) => error.code === "NOT_FOUND",
  );
  assert.deepEqual(
    db.getRecentHistory(sessionId, 3).map((item) => item.sequence),
    [0, 1, 3],
  );
  assert.deepEqual(
    db.getRecentHistory(sessionId, 1).map((item) => item.sequence),
    [3],
  );
  const firstPage = db.listMessagesBefore(
    sessionId,
    Number.MAX_SAFE_INTEGER,
    1,
  );
  assert.deepEqual(
    firstPage.messages.map((item) => item.sequence),
    [3],
  );
  assert.equal(firstPage.nextBeforeSequence, 3);
  assert.equal(firstPage.hasMore, true);
  const secondPage = db.listMessagesBefore(
    sessionId,
    firstPage.nextBeforeSequence,
    1,
  );
  assert.deepEqual(
    secondPage.messages.map((item) => item.sequence),
    [1],
  );
  assert.equal(secondPage.hasMore, true);
  const finalPage = db.listMessagesBefore(
    sessionId,
    secondPage.nextBeforeSequence,
    1,
  );
  assert.deepEqual(
    finalPage.messages.map((item) => item.sequence),
    [0],
  );
  assert.equal(finalPage.hasMore, false);
  assert.equal(
    db.getHistory(sessionId).some((item) => item.sequence === 3),
    true,
  );

  const committed = db.getSession(sessionId);
  const stateBefore = structuredClone(committed.state);
  const revisionBefore = committed.revision;
  let inserted = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    inserted += db.compactStory(sessionId, 20);
  }
  assert.ok(inserted > 0);
  assert.equal(db.compactStory(sessionId, 20), 0);
  const afterCompact = db.getSession(sessionId);
  assert.deepEqual(afterCompact.state, stateBefore);
  assert.equal(afterCompact.revision, revisionBefore);
  const playerBridge = db.getStorySummaries(sessionId, {
    query: "silver bridge",
  });
  assert.ok(
    db
      .getStorySummaries(sessionId, { limit: 50 })
      .every((summary) => Buffer.byteLength(summary.summary, "utf8") <= 4_000),
  );
  assert.equal(
    playerBridge.some((summary) => summary.summary.includes("silver bridge")),
    true,
  );
  const naturallyPhrasedBridge = db.getStorySummaries(sessionId, {
    query:
      "Could you remind me what happened to the silver bridge before dawn?",
  });
  assert.ok(
    naturallyPhrasedBridge.some((summary) =>
      summary.summary.includes("silver bridge collapsed before dawn"),
    ),
    "Natural-language queries must retrieve a relevant early event summary.",
  );
  const aikoEmerald = db.getStorySummaries(sessionId, {
    query: "emerald seal",
    npcId: "aiko",
  });
  assert.equal(
    aikoEmerald.some((summary) => summary.summary.includes("emerald seal")),
    true,
  );
  assert.equal(
    db.getStorySummaries(sessionId, { query: "emerald seal", npcId: "bryn" })
      .length,
    0,
  );
  assert.equal(
    db
      .getStorySummaries(sessionId, { query: "cobalt key", npcId: "bryn" })
      .some((summary) => summary.summary.includes("cobalt key")),
    true,
  );
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  const beforeRepeated = Number(
    raw
      .prepare("SELECT COUNT(*) AS n FROM story_summaries WHERE session_id = ?")
      .get(sessionId).n,
  );
  assert.equal(db.compactStory(sessionId, 20), 0);
  const afterRepeated = Number(
    raw
      .prepare("SELECT COUNT(*) AS n FROM story_summaries WHERE session_id = ?")
      .get(sessionId).n,
  );
  raw.close();
  assert.equal(afterRepeated, beforeRepeated);

  const telemetryRun = "telemetry-run";
  const latest = db.getSession(sessionId);
  db.startRun({
    sessionId,
    requestId: telemetryRun,
    inputHash: "hash-telemetry-run",
    expectedRevision: latest.revision,
  });
  const aiAttempt = db.startAiRequest({
    sessionId,
    requestId: telemetryRun,
    kind: "turn",
    attempt: 1,
    provider: "gemini",
    model: "gemini-upgrade-test",
  });
  const telemetry = {
    contextChars: 40,
    approximateTokens: 12,
    tokenEstimateMethod: "chars-per-4",
    sections: { state: { chars: 20, count: 1, omitted: 0 } },
    selectedLoreIds: [],
    omissions: ["history:limit"],
    toolCalls: 1,
    repairs: 0,
  };
  db.saveContextTelemetry(sessionId, telemetryRun, telemetry);
  db.saveContextTelemetry(sessionId, telemetryRun, telemetry);
  assert.deepEqual(db.getContextTelemetry(sessionId, telemetryRun), telemetry);
  assert.throws(
    () =>
      db.saveContextTelemetry(sessionId, telemetryRun, {
        ...telemetry,
        omissions: ["sk-or-v1-012345678901234567890123456789"],
      }),
    api.ValidationError,
  );
  db.finishAiRequest(aiAttempt.id, {
    status: "succeeded",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  assert.deepEqual(db.estimateTokens(100, "gemini", "gemini-upgrade-test"), {
    approximateTokens: 50,
    method: "observed-ratio",
  });
  assert.deepEqual(
    db.estimateTokens(100, "openrouter", "model-without-observations"),
    { approximateTokens: 25, method: "chars-per-4" },
  );
});

test("legacy session rows and saves inherit the narrator default; custom prompts round-trip", (t) => {
  const { db, databasePath } = withDb(t, "fworld-narrator-prompt-");
  const started = start(
    db,
    definition("narrator-prompt-game"),
    "narrator-prompt-session",
  );
  const raw = new DatabaseSync(databasePath);
  raw
    .prepare("UPDATE sessions SET ai_json = ? WHERE id = ?")
    .run(
      JSON.stringify({ provider: ai.provider, model: ai.model }),
      started.session.value.id,
    );
  raw.close();

  const legacySession = db.getSession(started.session.value.id);
  assert.equal(
    legacySession.ai.systemPrompt,
    narratorPrompt.DEFAULT_NARRATOR_SYSTEM_PROMPT,
  );
  const customSystemPrompt = "Custom narrator prompt for save restore.";
  db.updateSession(
    legacySession.id,
    {
      ai: { ...ai, systemPrompt: customSystemPrompt },
    },
    legacySession.revision,
  );

  const bundle = db.exportSave(legacySession.id);
  assert.equal(bundle.session.ai.systemPrompt, customSystemPrompt);
  const oldBundle = structuredClone(bundle);
  delete oldBundle.session.ai.systemPrompt;
  const oldImport = db.importSave(oldBundle);
  assert.equal(
    db.getSession(oldImport.sessionId).ai.systemPrompt,
    narratorPrompt.DEFAULT_NARRATOR_SYSTEM_PROMPT,
  );
  const customImport = db.importSave(bundle);
  assert.equal(
    db.getSession(customImport.sessionId).ai.systemPrompt,
    customSystemPrompt,
  );

  const blankBundle = structuredClone(bundle);
  blankBundle.session.ai.systemPrompt = " \n ";
  assert.throws(() => db.importSave(blankBundle), api.ImportError);
  const oversizedBundle = structuredClone(bundle);
  oversizedBundle.session.ai.systemPrompt = "x".repeat(
    narratorPrompt.MAX_NARRATOR_SYSTEM_PROMPT_CHARS + 1,
  );
  assert.throws(() => db.importSave(oversizedBundle), api.ImportError);
});

function createV2Database(path) {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE games (
      id TEXT PRIMARY KEY NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
      definition_snapshot_json TEXT NOT NULL CHECK (json_valid(definition_snapshot_json)),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      ai_json TEXT NOT NULL CHECK (json_valid(ai_json)),
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL,
      world_map_json TEXT CHECK (world_map_json IS NULL OR json_valid(world_map_json)),
      lore_refs_json TEXT CHECK (lore_refs_json IS NULL OR json_valid(lore_refs_json))
    ) STRICT;
    CREATE INDEX sessions_by_game ON sessions(game_id, updated_at DESC);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      role TEXT NOT NULL CHECK (role IN ('PLAYER','NPC','NARRATOR','SYSTEM_EVENT')),
      speaker_id TEXT,
      content TEXT NOT NULL,
      check_json TEXT CHECK (check_json IS NULL OR json_valid(check_json)),
      created_at TEXT NOT NULL,
      visibility TEXT CHECK (visibility IS NULL OR visibility IN ('public','private')),
      known_by_json TEXT CHECK (known_by_json IS NULL OR json_valid(known_by_json)),
      UNIQUE (session_id, sequence)
    ) STRICT;
    CREATE INDEX messages_page ON messages(session_id, sequence);
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, content='messages', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','item_use')),
      status TEXT NOT NULL CHECK (status IN ('running','committed','failed','interrupted')),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    ) STRICT;
    CREATE UNIQUE INDEX one_running_turn_per_session ON turns(session_id)
      WHERE status = 'running';
    CREATE TABLE ai_requests (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','connection_test')),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter')),
      model TEXT NOT NULL,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
      cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
      reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
      latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
      finish_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX ai_usage_by_session ON ai_requests(session_id, created_at);
    CREATE INDEX ai_usage_by_run ON ai_requests(session_id, request_id, attempt);
    CREATE UNIQUE INDEX ai_attempt_once ON ai_requests(session_id, request_id, kind, attempt)
      WHERE request_id IS NOT NULL;
    CREATE TABLE migrations (
      fingerprint TEXT PRIMARY KEY NOT NULL,
      counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
      ids_json TEXT NOT NULL CHECK (json_valid(ids_json)),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE lore_packs (
      pack_id TEXT NOT NULL,
      pack_version INTEGER NOT NULL CHECK (pack_version > 0),
      name TEXT NOT NULL,
      description TEXT,
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
      link_count INTEGER NOT NULL CHECK (link_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pack_id, pack_version)
    ) STRICT;
    CREATE TABLE lore_entries (
      pack_id TEXT NOT NULL,
      pack_version INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
      parent_id TEXT,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
      visibility TEXT NOT NULL CHECK (visibility IN ('public','narrator','discovery')),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      PRIMARY KEY (pack_id, pack_version, entry_id)
    ) STRICT;
    CREATE TABLE lore_links (
      pack_id TEXT NOT NULL,
      pack_version INTEGER NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (pack_id, pack_version, from_id, to_id, relation)
    ) STRICT;
    CREATE TABLE context_telemetry (
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      context_chars INTEGER NOT NULL CHECK (context_chars >= 0),
      approximate_tokens INTEGER NOT NULL CHECK (approximate_tokens >= 0),
      token_estimate_method TEXT NOT NULL,
      sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
      selected_lore_ids_json TEXT NOT NULL CHECK (json_valid(selected_lore_ids_json)),
      omissions_json TEXT NOT NULL CHECK (json_valid(omissions_json)),
      tool_calls INTEGER NOT NULL CHECK (tool_calls >= 0),
      repairs INTEGER NOT NULL CHECK (repairs >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id),
      FOREIGN KEY (session_id, request_id)
        REFERENCES turns(session_id, request_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE story_summaries (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
      to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
      summary TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
      known_by_json TEXT NOT NULL CHECK (json_valid(known_by_json)),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, from_sequence, to_sequence, visibility, known_by_json, source_digest)
    ) STRICT;
    CREATE INDEX story_summaries_by_session
      ON story_summaries(session_id, to_sequence DESC);
    CREATE INDEX story_summaries_by_scope
      ON story_summaries(session_id, visibility, to_sequence DESC);
    CREATE TABLE story_summary_cursors (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0)
    ) STRICT;
    PRAGMA user_version = 2;
  `);

  const game = definition("legacy-v2-game");
  const session = {
    id: "legacy-v2-session",
    gameId: game.id,
    definitionSnapshot: game,
    state: engine.buildInitialState(game),
    ai: { provider: "gemini", model: "gemini-legacy-v2" },
    nextSequence: 1,
    updatedAt: "2026-10-18T00:00:01.000Z",
  };
  raw
    .prepare(
      "INSERT INTO games(id, definition_json, revision, updated_at) VALUES (?, ?, 1, ?)",
    )
    .run(game.id, JSON.stringify(game), game.updatedAt);
  raw
    .prepare(
      `INSERT INTO sessions(
         id, game_id, definition_snapshot_json, state_json, ai_json,
         next_sequence, revision, updated_at, world_map_json, lore_refs_json
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)`,
    )
    .run(
      session.id,
      session.gameId,
      JSON.stringify(session.definitionSnapshot),
      JSON.stringify(session.state),
      JSON.stringify(session.ai),
      session.nextSequence,
      session.updatedAt,
    );
  raw
    .prepare(
      `INSERT INTO messages(
         id, session_id, turn_id, sequence, role, speaker_id, content,
         check_json, created_at, visibility, known_by_json
       ) VALUES (?, ?, ?, 0, 'NARRATOR', NULL, ?, NULL, ?, 'public', NULL)`,
    )
    .run(
      "legacy-v2-message",
      session.id,
      "legacy-v2-turn",
      "V2 sentinel history survives the schema 3 upgrade.",
      "2026-10-18T00:00:01.000Z",
    );
  raw
    .prepare(
      `INSERT INTO lore_packs(
         pack_id, pack_version, name, entry_count, link_count, digest, created_at
       ) VALUES ('legacy-v2-pack', 1, 'Legacy Pack', 1, 0, 'digest-v2', ?)`,
    )
    .run("2026-10-18T00:00:00.000Z");
  raw
    .prepare(
      `INSERT INTO lore_entries(
         pack_id, pack_version, entry_id, kind, name, aliases_json, parent_id,
         summary, body, tags_json, visibility, metadata_json, provenance_json
       ) VALUES ('legacy-v2-pack', 1, 'legacy:entry-v2', 'world', 'Legacy Entry',
         '[]', NULL, 'Legacy summary', 'Legacy body', '[]', 'public', '{}',
         '{"sourceId":"legacy-v2-tests"}')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO turns(
         session_id, request_id, input_hash, expected_revision, kind, status,
         result_json, error_json, created_at, updated_at
       ) VALUES (?, 'legacy-v2-request', 'hash-v2', 1, 'turn', 'committed',
         '{"ok":true}', NULL, ?, ?)`,
    )
    .run(session.id, "2026-10-18T00:00:01.000Z", "2026-10-18T00:00:02.000Z");
  raw
    .prepare(
      `INSERT INTO ai_requests(
         id, session_id, request_id, kind, attempt, provider, model,
         input_tokens, output_tokens, total_tokens, cached_input_tokens,
         reasoning_tokens, status, latency_ms, finish_reason, created_at, updated_at
       ) VALUES ('legacy-v2-ledger', ?, 'legacy-v2-request', 'turn', 1,
         'openrouter', 'legacy/router', 10, 5, 15, NULL, NULL, 'succeeded',
         1200, 'stop', ?, ?)`,
    )
    .run(session.id, "2026-10-18T00:00:01.000Z", "2026-10-18T00:00:02.000Z");
  raw.close();
}

test("populated schema-2 data migrates to schema 3 and accepts custom ledger and bindings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fworld-v2-upgrade-"));
  const databasePath = join(directory, "legacy-v2.sqlite");
  createV2Database(databasePath);
  const db = new api.GameDatabase(databasePath);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const raw = new DatabaseSync(databasePath);
  const version = raw.prepare("PRAGMA user_version").get().user_version;
  const tableNames = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  raw.close();
  assert.equal(version, 3);
  assert.ok(tableNames.includes("ai_credentials"));
  assert.ok(tableNames.includes("ai_profiles"));
  assert.ok(tableNames.includes("session_ai_bindings"));

  assert.equal(
    db.getHistory("legacy-v2-session")[0].content,
    "V2 sentinel history survives the schema 3 upgrade.",
  );
  assert.equal(db.getGame("legacy-v2-game").title, "Lantern Cafe");
  assert.equal(
    db.getLoreEntry(
      [{ packId: "legacy-v2-pack", version: 1 }],
      "legacy:entry-v2",
    ).name,
    "Legacy Entry",
  );
  const usage = db.getUsageSummary("legacy-v2-session", "legacy-v2-request");
  assert.equal(usage.totalTokens, 15);

  const custom = db.createAiProfile({
    name: "Fixture custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Fixture prompt.",
    baseURL: "https://api.example.com/v1",
  });
  const started = db.startSessionForDefinition({
    definition: definition("v2-upgrade-custom-game"),
    profileId: custom.id,
    sessionId: "v2-upgrade-custom-session",
  });
  assert.equal(started.session.value.ai.provider, "custom");
  const ledger = db.startAiRequest({
    kind: "connection_test",
    attempt: 1,
    provider: "custom",
    model: "fixture-model",
  });
  db.finishAiRequest(ledger.id, {
    status: "succeeded",
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  });
  db.close();

  const reopened = new api.GameDatabase(databasePath);
  assert.equal(
    reopened.getSessionAiBinding("v2-upgrade-custom-session").credentialId,
    custom.credentialId,
  );
  assert.equal(
    reopened.getSession("v2-upgrade-custom-session").ai.model,
    "fixture-model",
  );
  assert.equal(
    reopened.getHistory("legacy-v2-session")[0].content,
    "V2 sentinel history survives the schema 3 upgrade.",
  );

  const rawAfter = new DatabaseSync(databasePath);
  const ledgerCount = rawAfter
    .prepare(
      "SELECT COUNT(*) AS count FROM ai_requests WHERE provider = 'custom'",
    )
    .get().count;
  const attemptIndex = rawAfter
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ai_attempt_once'",
    )
    .get();
  rawAfter.close();
  assert.equal(ledgerCount, 1);
  assert.ok(attemptIndex);
  reopened.close();
});

test("v2 backups migrate through staging and invalid bindings are rejected before swap", async (t) => {
  const { db, directory, databasePath, track } = withDb(
    t,
    "fworld-v2-restore-",
  );
  db.close();
  const v2Path = join(directory, "restore-source-v2.sqlite");
  createV2Database(v2Path);
  const restored = await api.GameDatabase.restoreFrom(v2Path, databasePath);
  track(restored);
  assert.equal(restored.getSession("legacy-v2-session").nextSequence, 1);
  assert.equal(
    restored.getHistory("legacy-v2-session")[0].content,
    "V2 sentinel history survives the schema 3 upgrade.",
  );

  const geminiProfile = restored.createAiProfile({
    name: "Mismatch gemini",
    provider: "gemini",
    model: "gemini-test",
    systemPrompt: "Fixture prompt.",
  });
  const started = restored.startSessionForDefinition({
    definition: definition("binding-mismatch-game"),
    profileId: geminiProfile.id,
    sessionId: "binding-mismatch-session",
  });
  const custom = restored.createAiProfile({
    name: "Mismatch custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Fixture prompt.",
    baseURL: "https://api.example.com/v1",
  });
  const raw = new DatabaseSync(databasePath);
  raw
    .prepare(
      `UPDATE session_ai_bindings SET credential_id = ? WHERE session_id = ?`,
    )
    .run(custom.credentialId, started.session.value.id);
  raw.close();
  const badBackup = join(directory, "binding-mismatch-backup.sqlite");
  await restored.backupTo(badBackup);
  await assert.rejects(
    api.GameDatabase.restoreFrom(
      badBackup,
      join(directory, "binding-mismatch-target.sqlite"),
    ),
    (error) => error.code === "CORRUPT_DATABASE",
  );
});

test("SQLite backups carry profile metadata but never credential tokens", async (t) => {
  const { db, directory } = withDb(t, "fworld-profile-backup-");
  const profile = db.createAiProfile({
    name: "Backup custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Fixture prompt.",
    baseURL: "https://api.example.com/v1",
  });
  db.startSessionForDefinition({
    definition: definition("backup-binding-game"),
    profileId: profile.id,
    sessionId: "backup-binding-session",
  });
  const dummyToken = "dummy-token-fworld-backup-never";
  const backupPath = join(directory, "profile-backup.sqlite");
  await db.backupTo(backupPath);
  const bytes = readFileSync(backupPath);
  assert.ok(!bytes.includes(dummyToken));

  const raw = new DatabaseSync(backupPath, { readOnly: true });
  const profileNames = raw
    .prepare("SELECT name FROM ai_profiles")
    .all()
    .map((row) => row.name);
  const bindingCount = raw
    .prepare("SELECT COUNT(*) AS count FROM session_ai_bindings")
    .get().count;
  raw.close();
  assert.deepEqual(profileNames, ["Backup custom"]);
  assert.equal(bindingCount, 1);
});
