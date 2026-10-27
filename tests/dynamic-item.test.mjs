import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const providerKey = "dynamic-item-offline-key";
let vite;
let databaseApi;
let turnApi;
let engineApi;
let serverApi;
let agentApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, turnApi, engineApi, serverApi, agentApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
    vite.ssrLoadModule("/shared/engine.ts"),
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/server/agent.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

function definition(id, overrides = {}) {
  return {
    id,
    title: "Harbor Errands",
    scenario: {
      setting: "A harbor town with a small market.",
      startingSituation: "Ren waits at the harbor.",
      worldRules: "Items can be bought or handed over.",
    },
    attributes: [{ id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 4 }],
    resources: [
      { id: "energy", name: "Energy", min: 0, max: 10, initialValue: 2 },
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
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

function withDb(t, prefix = "fworld-dynamic-item-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(directory, "runtime.sqlite");
  let db = new databaseApi.GameDatabase(databasePath);
  const instances = [db];
  const extraDirectories = new Set([directory]);
  t.after(() => {
    for (const instance of instances) {
      try {
        instance.close();
      } catch {
        // already closed
      }
    }
    for (const extra of extraDirectories) {
      rmSync(extra, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  return {
    directory,
    databasePath,
    get db() {
      return db;
    },
    track(instance) {
      instances.push(instance);
      return instance;
    },
    trackDirectory(path) {
      extraDirectories.add(path);
    },
    reopen() {
      db.close();
      db = new databaseApi.GameDatabase(databasePath);
      instances.push(db);
      return db;
    },
  };
}

function startSession(db, game, sessionId, ai) {
  const existing = db.getGame(game.id);
  return db.startSessionForDefinition({
    definition: game,
    ...(existing ? { expectedGameRevision: existing.revision } : {}),
    ai: ai ?? { provider: "openrouter", model: "openai/gpt-4o-mini" },
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
  const calls = [];
  let requestNumber = 0;
  globalThis.fetch = async (input, init) => {
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const body = JSON.parse(text);
    const prompt = promptFromRequest(body);
    calls.push({ prompt, body, requestNumber });
    beforeRequest(prompt, body, requestNumber);
    const planned = responses[requestNumber];
    const content =
      typeof planned === "function"
        ? await planned(prompt, body, requestNumber)
        : planned;
    if (!content) {
      throw new Error(`Unexpected provider request ${requestNumber + 1}.`);
    }
    requestNumber += 1;
    return openRouterResponse(content, `dynamic-item-${requestNumber}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: {
          host: "127.0.0.1:5173",
          origin: "http://127.0.0.1:5173",
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, body: data });
        });
      },
    );
    request.on("error", reject);
    request.end();
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

function teaProposal(quantity = 1) {
  return {
    narrative: "A vendor hands Ren a warm tea.",
    effects: [
      {
        type: "REGISTER_ITEM",
        id: "item-teh-hangat",
        name: "Teh hangat",
        description: "Teh manis dalam gelas kertas.",
        stackable: true,
        maxStack: 5,
        consumable: true,
        effects: [
          {
            type: "RESOURCE_CHANGE",
            target: "energy",
            operation: "ADD",
            value: 3,
          },
        ],
        tags: ["minuman"],
        quantity,
      },
    ],
  };
}

test("narrator item registration grants, persists, and survives lifecycle boundaries", async (t) => {
  const fixture = withDb(t);
  let db = fixture.db;
  const game = definition("dynamic-item-lifecycle-game");
  const sessionId = "dynamic-item-lifecycle-session";
  const customPrompt = "Custom narrator prompt for dynamic items.";
  const started = startSession(db, game, sessionId, {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    systemPrompt: customPrompt,
  });
  assert.equal(started.session.value.definitionSnapshot.items.length, 0);
  const revisionBefore = started.session.revision;

  const calls = stubProvider(
    t,
    [
      teaProposal(),
      { narrative: "Ren checks the warm cup.", effects: [] },
      {
        narrative: "Someone hands Ren another tea.",
        effects: [
          {
            type: "ADD_ITEM",
            target: "item-teh-hangat",
            quantity: 1,
          },
        ],
      },
    ],
    (prompt, body, requestNumber) => {
      assert.ok(prompt, `missing prompt for request ${requestNumber}`);
      assert.match(
        JSON.stringify(body),
        /Dynamic items: REGISTER_ITEM/,
        "turn requests must carry the runtime item instructions",
      );
      if (requestNumber === 0) {
        assert.deepEqual(prompt.context.state.inventory, []);
      }
      if (requestNumber === 1) {
        const tea = prompt.context.state.inventory.find(
          (entry) => entry.id === "item-teh-hangat",
        );
        assert.deepEqual(tea, {
          id: "item-teh-hangat",
          name: "Teh hangat",
          description: "Teh manis dalam gelas kertas.",
          tags: ["minuman"],
          quantity: 1,
          stackable: true,
          consumable: true,
        });
      }
    },
  );

  const granted = await run(db, {
    sessionId,
    requestId: "dynamic-item-register",
    work: { kind: "turn", input: "I accept the warm tea." },
  });
  assert.equal(granted.status, "committed", JSON.stringify(granted.error));
  const registered = db.getSession(sessionId);
  assert.equal(registered.revision, revisionBefore + 1);
  assert.equal(registered.definitionSnapshot.items.length, 1);
  const stored = registered.definitionSnapshot.items[0];
  assert.equal(stored.id, "item-teh-hangat");
  assert.equal(stored.name, "Teh hangat");
  assert.equal(stored.stackable, true);
  assert.equal(stored.maxStack, 5);
  assert.equal(stored.consumable, true);
  assert.deepEqual(stored.tags, ["minuman"]);
  assert.deepEqual(stored.effects, [
    { type: "RESOURCE_CHANGE", target: "energy", operation: "ADD", value: 3 },
  ]);
  assert.deepEqual(registered.state.inventory, [
    { itemId: "item-teh-hangat", quantity: 1 },
  ]);
  assert.equal(registered.state.resources.energy, 2);
  assert.equal(registered.ai.systemPrompt, customPrompt);
  assert.deepEqual(db.getGame(game.id).items, []);
  const registrationEvent = granted.result.messages.find(
    (message) => message.role === "SYSTEM_EVENT",
  );
  assert.match(
    registrationEvent.content,
    /Item "Teh hangat" terdaftar dan diperoleh sebanyak 1/,
  );

  const inspected = await run(db, {
    sessionId,
    requestId: "dynamic-item-inventory",
    work: { kind: "turn", input: "I look at the cup." },
  });
  assert.equal(inspected.status, "committed", JSON.stringify(inspected.error));

  const used = await run(db, {
    sessionId,
    requestId: "dynamic-item-use",
    work: { kind: "item_use", itemId: "item-teh-hangat" },
  });
  assert.equal(used.status, "committed", JSON.stringify(used.error));
  const afterUse = db.getSession(sessionId);
  assert.equal(afterUse.state.resources.energy, 5);
  assert.deepEqual(afterUse.state.inventory, []);
  assert.equal(afterUse.definitionSnapshot.items.length, 1);
  assert.equal(afterUse.definitionSnapshot.items[0].id, "item-teh-hangat");

  const reacquired = await run(db, {
    sessionId,
    requestId: "dynamic-item-reacquire",
    work: { kind: "turn", input: "The vendor offers another cup." },
  });
  assert.equal(
    reacquired.status,
    "committed",
    JSON.stringify(reacquired.error),
  );
  const afterReacquire = db.getSession(sessionId);
  assert.deepEqual(afterReacquire.state.inventory, [
    { itemId: "item-teh-hangat", quantity: 1 },
  ]);
  assert.equal(afterReacquire.definitionSnapshot.items.length, 1);
  assert.equal(afterReacquire.revision, afterUse.revision + 1);

  const providerCallsBeforeReplay = calls.length;
  const replaySession = db.getSession(sessionId);
  const replay = turnApi.startSessionRun(db, {
    sessionId,
    requestId: "dynamic-item-reacquire",
    expectedRevision: afterUse.revision,
    work: { kind: "turn", input: "The vendor offers another cup." },
    providerKey,
  });
  assert.equal(replay.status, "committed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, providerCallsBeforeReplay);
  assert.deepEqual(db.getSession(sessionId), replaySession);

  db = fixture.reopen();
  const reloaded = db.getSession(sessionId);
  assert.equal(reloaded.definitionSnapshot.items.length, 1);
  assert.equal(reloaded.definitionSnapshot.items[0].name, "Teh hangat");
  assert.deepEqual(reloaded.state.inventory, [
    { itemId: "item-teh-hangat", quantity: 1 },
  ]);
  assert.equal(reloaded.state.resources.energy, 5);

  const bundle = db.exportSave(sessionId);
  assert.equal(bundle.game.items.length, 1);
  assert.equal(bundle.game.items[0].id, "item-teh-hangat");
  assert.deepEqual(db.getGame(game.id).items, []);
  const otherDirectory = mkdtempSync(
    join(tmpdir(), "fworld-dynamic-item-import-"),
  );
  fixture.trackDirectory(otherDirectory);
  const imported = fixture.track(
    new databaseApi.GameDatabase(join(otherDirectory, "imported.sqlite")),
  );
  const importedIds = imported.importSave(bundle);
  const importedSession = imported.getSession(importedIds.sessionId);
  assert.deepEqual(
    importedSession.definitionSnapshot.items,
    reloaded.definitionSnapshot.items,
  );
  assert.deepEqual(importedSession.state.inventory, [
    { itemId: "item-teh-hangat", quantity: 1 },
  ]);
  assert.equal(importedSession.state.resources.energy, 5);

  const backupPath = join(fixture.directory, "exported.sqlite");
  await db.backupTo(backupPath);
  const restoredPath = join(fixture.directory, "restored.sqlite");
  const restored = fixture.track(
    await databaseApi.GameDatabase.restoreFrom(backupPath, restoredPath),
  );
  const restoredSession = restored.getSession(sessionId);
  assert.equal(
    restoredSession.definitionSnapshot.items[0].id,
    "item-teh-hangat",
  );
  assert.deepEqual(restoredSession.state.inventory, [
    { itemId: "item-teh-hangat", quantity: 1 },
  ]);
  assert.equal(restoredSession.state.resources.energy, 5);
  assert.deepEqual(restoredSession.lorebookRefs, undefined);
});

function emptyState(game) {
  return engineApi.buildInitialState(game);
}

function applyProposal(game, state, effects) {
  const proposal = engineApi.parseTurnResponse({
    narrative: "The story moves.",
    effects,
  });
  return engineApi.applyNarratorEffects(game, state, proposal.effects, {
    worldMap: game.worldMap,
  });
}

function registerPayload(overrides = {}) {
  return {
    type: "REGISTER_ITEM",
    id: "item-teh-hangat",
    name: "Teh hangat",
    description: "Teh manis dalam gelas kertas.",
    stackable: true,
    maxStack: 5,
    consumable: true,
    effects: [
      { type: "RESOURCE_CHANGE", target: "energy", operation: "ADD", value: 3 },
    ],
    tags: ["minuman"],
    quantity: 1,
    ...overrides,
  };
}

test("item registration rejects invalid definitions without partially applying", () => {
  const game = definition("dynamic-item-engine-game");
  const state = emptyState(game);
  const originalGame = structuredClone(game);
  const originalState = structuredClone(state);

  const fails = (effects, pattern) => {
    assert.throws(
      () => applyProposal(game, state, effects),
      pattern,
      `expected rejection for ${pattern}`,
    );
    assert.deepEqual(game, originalGame);
    assert.deepEqual(state, originalState);
  };

  fails([registerPayload({ id: "player" })], /sudah digunakan/);
  fails([registerPayload({ id: "bad id" })], /tidak valid/);
  fails([registerPayload({ quantity: 0 })], /minimal 1/);
  fails([registerPayload({ stackable: "true" })], /stackable harus boolean/);
  fails([registerPayload({ tags: "minuman" })], /tags harus array/);
  fails([registerPayload({ tags: ["x".repeat(101)] })], /batas 100/);
  fails([registerPayload({ unknown: true })], /unsupported field/);
  fails(
    [
      registerPayload({
        effects: [
          {
            type: "RESOURCE_CHANGE",
            target: "missing",
            operation: "ADD",
            value: 1,
          },
        ],
      }),
    ],
    /tidak valid/,
  );
  fails(
    [
      registerPayload({
        effects: [
          { type: "REGISTER_ITEM", ...registerPayload({ id: "item-anak" }) },
        ],
      }),
    ],
    /tidak boleh mendaftarkan/,
  );
  fails(
    [
      registerPayload({
        effects: [
          {
            type: "RELATIONSHIP_CHANGE",
            target: "trust",
            npcId: "npc-later",
            operation: "ADD",
            value: 1,
          },
        ],
      }),
      {
        type: "REGISTER_NPC",
        id: "npc-later",
        name: "Lina",
        personality: [],
        goals: [],
      },
    ],
    /tidak valid/,
  );

  const stacked = applyProposal(game, state, [
    registerPayload({ id: "item-teh-hangat", name: "Teh hangat" }),
  ]);
  assert.equal(stacked.state.inventory[0].quantity, 1);
  assert.throws(
    () =>
      applyProposal(stacked.definition, stacked.state, [
        registerPayload({ id: "item-kedua", name: " teh   HANGAT " }),
      ]),
    /sudah terdaftar sebagai "item-teh-hangat"; gunakan ADD_ITEM/,
  );
  assert.throws(
    () =>
      applyProposal(stacked.definition, stacked.state, [
        registerPayload({
          id: "item-gelas",
          name: "Gelas",
          stackable: false,
          quantity: 2,
        }),
      ]),
    /tidak bisa ditumpuk/,
  );
  assert.throws(
    () =>
      applyProposal(stacked.definition, stacked.state, [
        registerPayload({ id: "item-cangkir", name: "Cangkir", quantity: 1 }),
        { type: "ADD_ITEM", target: "item-cangkir", quantity: 5 },
      ]),
    /melebihi tumpukan maksimal 5/,
  );

  const mixed = applyProposal(game, state, [
    {
      type: "REGISTER_NPC",
      id: "npc-lina",
      name: "Lina",
      personality: [],
      goals: [],
    },
    registerPayload({
      id: "item-surat",
      name: "Surat",
      stackable: false,
      effects: [
        {
          type: "ADD_FACT",
          text: "Lina menyerahkan surat itu.",
          knownBy: ["npc-lina"],
        },
      ],
      tags: [],
    }),
  ]);
  assert.deepEqual(
    mixed.definition.npcs.map((npc) => npc.id),
    ["npc-lina"],
  );
  assert.deepEqual(
    mixed.definition.items.map((item) => item.id),
    ["item-surat"],
  );
  const used = engineApi.useItem(mixed.definition, mixed.state, "item-surat", {
    worldMap: game.worldMap,
  });
  assert.equal(used.state.facts.length, 1);
  assert.deepEqual(used.state.facts[0].knownBy, ["npc-lina"]);
  assert.deepEqual(used.state.inventory, []);
});

test("an invalid effect after registration leaves the session untouched", async (t) => {
  const fixture = withDb(t);
  const db = fixture.db;
  const game = definition("dynamic-item-invalid-game");
  const sessionId = "dynamic-item-invalid-session";
  startSession(db, game, sessionId);

  const proposal = {
    narrative: "A cup appears and the story rewrites trust.",
    effects: [
      registerPayload(),
      {
        type: "RELATIONSHIP_CHANGE",
        target: "missing-relationship",
        npcId: "missing-npc",
        operation: "ADD",
        value: 1,
      },
    ],
  };
  stubProvider(t, [proposal, proposal]);
  const before = db.getSession(sessionId);
  const history = db.getHistory(sessionId);
  const failed = await run(db, {
    sessionId,
    requestId: "dynamic-item-invalid-turn",
    work: { kind: "turn", input: "I accept the tea." },
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(db.getSession(sessionId), before);
  assert.deepEqual(db.getHistory(sessionId), history);
  assert.equal(db.getSession(sessionId).definitionSnapshot.items.length, 0);
});

test("item detail tools expose only public effects", async () => {
  const game = definition("dynamic-item-tool-game");
  game.items = [
    {
      id: "item-catatan",
      name: "Catatan ujian",
      description: "Salinan catatan ujian.",
      stackable: false,
      consumable: true,
      effects: [
        { type: "DISCOVER_LORE", loreId: "activity:catatan-ujian" },
        { type: "ADD_FACT", text: "SECRET_FACT_TEXT", visibility: "private" },
        {
          type: "RESOURCE_CHANGE",
          target: "energy",
          operation: "ADD",
          value: 1,
        },
      ],
      tags: ["catatan"],
    },
  ];
  const session = {
    id: "dynamic-item-tool-session",
    gameId: game.id,
    definitionSnapshot: game,
    state: {
      ...emptyState(game),
      inventory: [{ itemId: "item-catatan", quantity: 1 }],
    },
    ai: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    nextSequence: 0,
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  const result = await agentApi.runNarrator(
    {
      session,
      history: [],
      kind: "turn",
      playerAction: "I inspect the note.",
      providerKey: "dynamic-item-tool-key",
      searchMemory: async () => [],
      onAttemptStart: () => {},
      onAttemptFinish: () => {},
    },
    {
      generateText: async (options) => {
        const details = await options.tools.get_item_details.execute({
          itemId: "item-catatan",
        });
        assert.equal(details.quantity, 1);
        assert.deepEqual(details.effects, [
          {
            type: "RESOURCE_CHANGE",
            target: "energy",
            operation: "ADD",
            value: 1,
          },
        ]);
        assert.equal(
          JSON.stringify(details).includes("SECRET_FACT_TEXT"),
          false,
        );
        assert.equal(
          JSON.stringify(details).includes("activity:catatan-ujian"),
          false,
        );
        return {
          text: JSON.stringify({ narrative: "Ren reads it.", effects: [] }),
          finishReason: "stop",
        };
      },
    },
  );
  assert.equal(result.response.narrative, "Ren reads it.");
});

const discoveryPack = {
  format: "fworld-lorebook",
  version: 1,
  pack: { id: "dynamic-item-clues", version: 1, name: "Clues" },
  entries: [
    {
      id: "activity:catatan-ujian",
      kind: "activity",
      name: "Catatan ujian",
      aliases: ["catatan ujian"],
      summary: "Catatan ujian di balai desa.",
      body: "Halaman terakhir mencatat nama penyetor dan tanggal ujian ulang.",
      tags: ["catatan"],
      visibility: "discovery",
      metadata: {
        discoverAt: ["loc:plaza"],
        discoveryKeywords: ["catatan"],
        requiredFlag: "arc_ujian",
      },
      provenance: { sourceId: "dynamic-item-test" },
    },
  ],
  links: [],
};

function loreGame(id) {
  const game = definition(id, { items: [] });
  game.lorebookRefs = [{ packId: discoveryPack.pack.id, version: 1 }];
  game.worldMap = {
    ...game.worldMap,
    flags: { arc_ujian: false },
  };
  return game;
}

function discoveryItemProposal(loreId) {
  return {
    narrative: "Raka menerima catatan ujian yang sudah dibacanya.",
    effects: [
      {
        type: "REGISTER_ITEM",
        id: "item-catatan-ujian",
        name: "Catatan ujian",
        description: "Salinan catatan ujian dari balai desa.",
        stackable: false,
        consumable: true,
        effects: [{ type: "DISCOVER_LORE", loreId }],
        tags: ["dokumen"],
        quantity: 1,
      },
    ],
  };
}

test("deferred discovery stays hidden until a gated item use, then persists", async (t) => {
  const fixture = withDb(t, "fworld-dynamic-item-lore-");
  const db = fixture.db;
  db.importLorebook(discoveryPack);
  const game = loreGame("dynamic-item-lore-game");
  const sessionId = "dynamic-item-lore-session";
  startSession(db, game, sessionId);

  stubProvider(t, [
    (prompt) => {
      const candidate = prompt.context.lore.find(
        (entry) => entry.discoveryCandidate,
      );
      assert.ok(candidate, "expected an opaque discovery candidate");
      assert.match(candidate.id, /^discovery-candidate:[0-9a-f-]{36}$/);
      assert.deepEqual(Object.keys(candidate).sort(), [
        "discoveryCandidate",
        "id",
      ]);
      assert.equal(
        JSON.stringify(prompt).includes("activity:catatan-ujian"),
        false,
      );
      return discoveryItemProposal(candidate.id);
    },
    { narrative: "Raka memeriksa barang bawaannya.", effects: [] },
    (prompt) => {
      const candidate = prompt.context.lore.find(
        (entry) => entry.discoveryCandidate,
      );
      assert.ok(candidate);
      return discoveryItemProposal("activity:invented");
    },
    (_prompt, body) => {
      const last = body.messages.at(-1)?.content;
      const text =
        typeof last === "string"
          ? last
          : Array.isArray(last)
            ? last.map((part) => part.text).join("")
            : "";
      const correction = JSON.parse(text).correction;
      assert.equal(correction.previousResponse, "");
      assert.equal(JSON.stringify(body).includes("activity:invented"), false);
      return { narrative: "Raka mengurungkan niatnya.", effects: [] };
    },
    discoveryItemProposal("activity:invented"),
    discoveryItemProposal("activity:invented"),
    discoveryItemProposal("activity:invented"),
    { narrative: "Raka berjalan ke pasar.", effects: [] },
    { narrative: "Raka kembali ke plaza.", effects: [] },
    (prompt) => {
      const entry = prompt.context.lore.find(
        (candidate) => candidate.id === "activity:catatan-ujian",
      );
      assert.ok(entry, "discovered lore must reach the prompt");
      assert.equal(entry.body, discoveryPack.entries[0].body);
      assert.equal(
        JSON.stringify(prompt).includes(discoveryPack.entries[0].body),
        true,
      );
      return { narrative: "Raka membaca catatan itu lagi.", effects: [] };
    },
  ]);

  const registered = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-register",
    work: { kind: "turn", input: "Raka memeriksa catatan di plaza." },
  });
  assert.equal(
    registered.status,
    "committed",
    JSON.stringify(registered.error),
  );
  const afterRegister = db.getSession(sessionId);
  const storedItem = afterRegister.definitionSnapshot.items[0];
  assert.equal(storedItem.id, "item-catatan-ujian");
  assert.deepEqual(storedItem.effects, [
    { type: "DISCOVER_LORE", loreId: "activity:catatan-ujian" },
  ]);
  assert.deepEqual(afterRegister.state.world.discoveredLoreIds ?? [], []);
  assert.deepEqual(afterRegister.state.inventory, [
    { itemId: "item-catatan-ujian", quantity: 1 },
  ]);
  const serializedAfterRegister = JSON.stringify(storedItem);
  assert.equal(serializedAfterRegister.includes("discovery-candidate:"), false);

  const server = serverApi.createHttpServer(
    { current: db, path: fixture.databasePath },
    {
      development: true,
      backupDirectory: join(fixture.directory, "backups"),
      envFilePath: join(fixture.directory, ".env"),
      contextCacheMode: "off",
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const sessionResponse = await httpGet(port, `/api/sessions/${sessionId}`);
  assert.equal(sessionResponse.status, 200);
  const publicSession = JSON.parse(sessionResponse.body).value;
  assert.deepEqual(
    publicSession.definitionSnapshot.items[0].effects,
    [],
    "player JSON must hide hidden item effects",
  );
  assert.equal(sessionResponse.body.includes('"type":"DISCOVER_LORE"'), false);
  assert.equal(sessionResponse.body.includes("activity:catatan-ujian"), false);
  const runResponse = await httpGet(
    port,
    `/api/sessions/${sessionId}/runs/dynamic-item-lore-register`,
  );
  assert.equal(runResponse.status, 200);
  assert.equal(runResponse.body.includes('"type":"DISCOVER_LORE"'), false);
  assert.equal(runResponse.body.includes("activity:catatan-ujian"), false);
  assert.deepEqual(
    JSON.parse(runResponse.body).result.session.value.definitionSnapshot
      .items[0].effects,
    [],
  );

  const detailsTurn = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-details",
    work: { kind: "turn", input: "Raka melihat catatan itu." },
  });
  assert.equal(
    detailsTurn.status,
    "committed",
    JSON.stringify(detailsTurn.error),
  );

  const repaired = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-guessed",
    work: { kind: "turn", input: "Raka memeriksa catatan ujian." },
  });
  assert.equal(repaired.status, "committed", JSON.stringify(repaired.error));
  assert.equal(db.getSession(sessionId).definitionSnapshot.items.length, 1);
  assert.deepEqual(
    db.getSession(sessionId).state.world.discoveredLoreIds ?? [],
    [],
  );

  const beforeInvalid = db.getSession(sessionId);
  const invalid = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-invalid",
    work: { kind: "turn", input: "Raka memeriksa catatan ujian." },
  });
  assert.equal(invalid.status, "failed");
  assert.deepEqual(db.getSession(sessionId), beforeInvalid);

  const away = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-away",
    work: { kind: "turn", input: "Raka pergi ke Market." },
  });
  assert.equal(away.status, "committed", JSON.stringify(away.error));
  assert.equal(db.getSession(sessionId).state.world.locationId, "loc:market");
  const wrongPlace = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-wrong-place",
    work: { kind: "item_use", itemId: "item-catatan-ujian" },
  });
  assert.equal(wrongPlace.status, "failed");
  assert.match(wrongPlace.error.message, /tidak dapat ditemukan di lokasi ini/);
  assert.deepEqual(db.getSession(sessionId).state.inventory, [
    { itemId: "item-catatan-ujian", quantity: 1 },
  ]);

  const back = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-back",
    work: { kind: "turn", input: "Raka berangkat ke Plaza." },
  });
  assert.equal(back.status, "committed", JSON.stringify(back.error));
  const blocked = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-flag-off",
    work: { kind: "item_use", itemId: "item-catatan-ujian" },
  });
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error.message, /membutuhkan flag "arc_ujian"/);
  assert.deepEqual(db.getSession(sessionId).state.inventory, [
    { itemId: "item-catatan-ujian", quantity: 1 },
  ]);

  const beforeFlag = db.getSession(sessionId);
  db.updateSession(
    sessionId,
    {
      state: {
        ...beforeFlag.state,
        world: {
          ...beforeFlag.state.world,
          flags: { ...(beforeFlag.state.world.flags ?? {}), arc_ujian: true },
        },
      },
    },
    beforeFlag.revision,
  );
  const used = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-use",
    work: { kind: "item_use", itemId: "item-catatan-ujian" },
  });
  assert.equal(used.status, "committed", JSON.stringify(used.error));
  const afterDiscovery = db.getSession(sessionId);
  assert.deepEqual(afterDiscovery.state.world.discoveredLoreIds, [
    "activity:catatan-ujian",
  ]);
  assert.deepEqual(afterDiscovery.state.inventory, []);
  assert.equal(afterDiscovery.definitionSnapshot.items.length, 1);

  const revealed = await run(db, {
    sessionId,
    requestId: "dynamic-item-lore-reveal",
    work: { kind: "turn", input: "Raka membaca catatan ujian." },
  });
  assert.equal(revealed.status, "committed", JSON.stringify(revealed.error));

  const bundle = db.exportSave(sessionId);
  assert.equal(bundle.version, 2);
  assert.equal(bundle.loreDependencies[0].packId, discoveryPack.pack.id);
  assert.equal(bundle.loreDependencies[0].digest.length, 64);
  assert.deepEqual(bundle.session.definitionSnapshot.items[0].effects, [
    { type: "DISCOVER_LORE", loreId: "activity:catatan-ujian" },
  ]);
  assert.equal(JSON.stringify(bundle).includes("discovery-candidate:"), false);

  const otherDirectory = mkdtempSync(
    join(tmpdir(), "fworld-dynamic-item-lore-import-"),
  );
  fixture.trackDirectory(otherDirectory);
  const missingPack = fixture.track(
    new databaseApi.GameDatabase(join(otherDirectory, "missing.sqlite")),
  );
  assert.throws(() => missingPack.importSave(bundle), /belum dipasang/);

  const target = fixture.track(
    new databaseApi.GameDatabase(join(otherDirectory, "imported.sqlite")),
  );
  target.importLorebook(discoveryPack);
  const imported = target.importSave(bundle);
  const importedSession = target.getSession(imported.sessionId);
  assert.deepEqual(importedSession.definitionSnapshot.items[0].effects, [
    { type: "DISCOVER_LORE", loreId: "activity:catatan-ujian" },
  ]);
  assert.deepEqual(importedSession.state.world.discoveredLoreIds, [
    "activity:catatan-ujian",
  ]);
  assert.deepEqual(importedSession.state.inventory, []);

  const tampered = structuredClone(bundle);
  tampered.loreDependencies[0].digest = "0".repeat(64);
  const tamperTarget = fixture.track(
    new databaseApi.GameDatabase(join(otherDirectory, "tampered.sqlite")),
  );
  tamperTarget.importLorebook(discoveryPack);
  assert.throws(() => tamperTarget.importSave(tampered), /digest|LORE/i);

  const noManifest = structuredClone(bundle);
  delete noManifest.loreDependencies;
  const noManifestTarget = fixture.track(
    new databaseApi.GameDatabase(join(otherDirectory, "no-manifest.sqlite")),
  );
  noManifestTarget.importLorebook(discoveryPack);
  assert.throws(
    () => noManifestTarget.importSave(noManifest),
    /loreDependencies/,
  );

  const backupPath = join(fixture.directory, "lore-backup.sqlite");
  await db.backupTo(backupPath);
  const restored = fixture.track(
    await databaseApi.GameDatabase.restoreFrom(
      backupPath,
      join(fixture.directory, "lore-restored.sqlite"),
    ),
  );
  const restoredSession = restored.getSession(sessionId);
  assert.deepEqual(restoredSession.state.world.discoveredLoreIds, [
    "activity:catatan-ujian",
  ]);
  assert.deepEqual(restoredSession.definitionSnapshot.items[0].effects, [
    { type: "DISCOVER_LORE", loreId: "activity:catatan-ujian" },
  ]);
});

test("a pinned lore flag is materialized for validation without hot-updating the session", async (t) => {
  const fixture = withDb(t, "fworld-dynamic-item-pin-");
  const db = fixture.db;
  const pack = {
    format: "fworld-lorebook",
    version: 1,
    pack: { id: "dynamic-item-harbor", version: 1, name: "Harbor lore" },
    entries: [
      {
        id: "loc:pelabuhan",
        kind: "location",
        name: "Pelabuhan Lama",
        aliases: [],
        summary: "Dermaga tua di ujung kota.",
        body: "Dermaga kayu yang dipakai kapal kecil.",
        tags: ["dermaga"],
        visibility: "public",
        metadata: { requiredFlag: "arc_pelabuhan" },
        provenance: { sourceId: "dynamic-item-test" },
      },
    ],
    links: [],
  };
  db.importLorebook(pack);
  const game = definition("dynamic-item-pin-game");
  game.lorebookRefs = [{ packId: pack.pack.id, version: 1 }];
  game.worldMap = {
    locations: [{ id: "loc:kota", name: "Kota", aliases: [], npcIds: [] }],
    connections: [],
    flags: {},
  };
  game.startingLocationId = "loc:kota";
  const sessionId = "dynamic-item-pin-session";
  startSession(db, game, sessionId);
  const initial = db.getSession(sessionId);
  assert.equal(initial.worldMap.flags.arc_pelabuhan, false);
  assert.deepEqual(initial.definitionSnapshot.worldMap.flags, {});
  const initialMap = structuredClone(initial.worldMap);
  const initialRefs = structuredClone(initial.lorebookRefs);

  stubProvider(t, [
    {
      narrative: "Petugas menyerahkan tiket dermaga.",
      effects: [
        {
          type: "REGISTER_ITEM",
          id: "item-tiket-dermaga",
          name: "Tiket dermaga",
          stackable: false,
          consumable: true,
          effects: [{ type: "SET_FLAG", target: "arc_pelabuhan", value: true }],
          tags: ["dokumen"],
          quantity: 1,
        },
      ],
    },
  ]);
  const granted = await run(db, {
    sessionId,
    requestId: "dynamic-item-pin-register",
    work: { kind: "turn", input: "Raka menerima tiket." },
  });
  assert.equal(granted.status, "committed", JSON.stringify(granted.error));
  const afterRegister = db.getSession(sessionId);
  assert.deepEqual(afterRegister.worldMap, initialMap);
  assert.deepEqual(afterRegister.lorebookRefs, initialRefs);
  assert.deepEqual(afterRegister.definitionSnapshot.worldMap.flags, {
    arc_pelabuhan: false,
  });
  assert.equal(afterRegister.state.world.flags?.arc_pelabuhan, false);
  assert.deepEqual(db.getGame(game.id).worldMap.flags, {});

  const used = await run(db, {
    sessionId,
    requestId: "dynamic-item-pin-use",
    work: { kind: "item_use", itemId: "item-tiket-dermaga" },
  });
  assert.equal(used.status, "committed", JSON.stringify(used.error));
  const afterUse = db.getSession(sessionId);
  assert.equal(afterUse.state.world.flags.arc_pelabuhan, true);
  assert.deepEqual(afterUse.worldMap, initialMap);
  assert.deepEqual(afterUse.lorebookRefs, initialRefs);
  assert.deepEqual(db.getGame(game.id).worldMap.flags, {});

  const bundle = db.exportSave(sessionId);
  const target = fixture.track(
    new databaseApi.GameDatabase(
      join(fixture.directory, "pin-imported.sqlite"),
    ),
  );
  target.importLorebook(pack);
  const imported = target.importSave(bundle);
  const importedSession = target.getSession(imported.sessionId);
  assert.equal(importedSession.state.world.flags.arc_pelabuhan, true);
  assert.deepEqual(importedSession.lorebookRefs, initialRefs);
});
