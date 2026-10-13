import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { createServer } from "vite";

let server;
let turn;
let db;

function sampleGame(id) {
  return {
    id,
    title: "Kedai Senja",
    scenario: {
      setting: "Kedai kopi saat senja.",
      startingSituation: "Hujan turun saat shift pertama.",
    },
    attributes: [
      { id: "semangat", name: "Semangat", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [{ id: "yen", name: "Yen", min: 0, initialValue: 5000 }],
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
            target: "yen",
            operation: "ADD",
            value: 20,
          },
        ],
        tags: [],
      },
    ],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [
      {
        id: "aiko",
        name: "Aiko",
        personality: ["tenang"],
        goals: [],
        privateKnowledge: ["rahasia mercusuar"],
        initialRelationships: { trust: 12 },
      },
    ],
    startingInventory: [],
    updatedAt: new Date().toISOString(),
  };
}

function scriptedFetch(scripts) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const script = scripts.shift();
    if (script === undefined)
      throw new Error("fetch dipanggil lebih dari skenario");
    if (typeof script === "function") return script();
    const body = {
      candidates: [{ content: { parts: [{ text: JSON.stringify(script) }] } }],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

async function makeSession() {
  const game = sampleGame(crypto.randomUUID());
  await db.saveGame(game);
  return db.createSession(game, {
    provider: "gemini",
    model: "gemini-2.5-flash",
  });
}

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  db = await server.ssrLoadModule("/src/db.ts");
  turn = await server.ssrLoadModule("/src/turn.ts");
});

test.after(async () => {
  await server.close();
});

test("narrative-only turn commits player and narrator messages and applies effects", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      narrative: "Aiko tersenyum.",
      effects: [
        { type: "RESOURCE_CHANGE", target: "yen", operation: "ADD", value: 20 },
      ],
      world: { location: "Kedai", time: "19:00" },
    },
  ]);
  const outcome = await turn.submitTurn(
    session.id,
    "Aku menyapa Aiko.",
    "key",
    {
      fetchImpl,
    },
  );
  assert.equal(outcome.ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const history = await db.getHistory(session.id);
  assert.deepEqual(
    history.map((m) => m.role),
    ["PLAYER", "NARRATOR", "SYSTEM_EVENT"],
  );
  assert.deepEqual(
    history.map((m) => m.sequence),
    [0, 1, 2],
  );
  assert.equal(history[1].content, "Aiko tersenyum.");

  const reloaded = await db.getSession(session.id);
  assert.equal(reloaded.nextSequence, 3);
  assert.equal(reloaded.state.resources.yen, 5020);
  assert.equal(reloaded.state.world.location, "Kedai");
});

test("check flow computes engine result then narrates with the recorded outcome", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      requiresCheck: true,
      attribute: "semangat",
      difficulty: 5,
      mode: "NORMAL",
    },
    { narrative: "Kamu berhasil meyakinkan Aiko.", effects: [] },
  ]);
  const outcome = await turn.submitTurn(session.id, "Aku berbohong.", "key", {
    fetchImpl,
    random: () => 0.99,
  });
  assert.equal(outcome.ok, true);
  assert.equal(fetchImpl.calls.length, 2);

  const history = await db.getHistory(session.id);
  const narrator = history.find((m) => m.role === "NARRATOR");
  assert.deepEqual(narrator.check, {
    attributeId: "semangat",
    difficulty: 5,
    mode: "NORMAL",
    score: 8,
    outcome: "SUCCESS",
  });
});

test("invalid effects trigger one repair and the repaired proposal commits", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      narrative: "Aiko curiga.",
      effects: [
        {
          type: "RESOURCE_CHANGE",
          target: "ghost",
          operation: "ADD",
          value: 1,
        },
      ],
    },
    { narrative: "Aiko mengangguk.", effects: [] },
  ]);
  const outcome = await turn.submitTurn(
    session.id,
    "Aku meminjam payung.",
    "key",
    {
      fetchImpl,
    },
  );
  assert.equal(outcome.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
  const history = await db.getHistory(session.id);
  const narrator = history.find((m) => m.role === "NARRATOR");
  assert.equal(narrator.content, "Aiko mengangguk.");
});

test("invalid JSON twice exhausts repair and commits nothing", async () => {
  const session = await makeSession();
  const providerResponse = (text, prompt, completion, total) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: {
          promptTokenCount: prompt,
          candidatesTokenCount: completion,
          totalTokenCount: total,
        },
      }),
      { status: 200 },
    );
  const fetchImpl = scriptedFetch([
    () => providerResponse("bukan json", 3, 2, 5),
    () => providerResponse("masih bukan json", 4, 3, 7),
  ]);
  const originalInfo = console.info;
  const logs = [];
  console.info = (...values) => logs.push(values.join(" "));
  let outcome;
  try {
    outcome = await turn.submitTurn(session.id, "Halo.", "super-secret-key", {
      fetchImpl,
    });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /perbaikan/);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /attempts=2/);
  assert.match(logs[0], /repair=1/);
  assert.match(logs[0], /promptTokens=7/);
  assert.match(logs[0], /completionTokens=5/);
  assert.match(logs[0], /token=12/);
  assert.doesNotMatch(logs[0], /Halo\.|super-secret-key/);
  assert.equal((await db.getHistory(session.id)).length, 0);
  assert.equal((await db.getSession(session.id)).nextSequence, 0);
});

test("provider failure surfaces without committing", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    () =>
      new Response(JSON.stringify({ error: { message: "quota habis" } }), {
        status: 429,
      }),
  ]);
  const originalInfo = console.info;
  const logs = [];
  console.info = (...values) => logs.push(values.join(" "));
  let outcome;
  try {
    outcome = await turn.submitTurn(session.id, "Halo.", "key", { fetchImpl });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /quota habis/);
  assert.match(logs[0], /attempts=1/);
  assert.doesNotMatch(logs[0], /\btoken=0\b/);
  assert.equal((await db.getHistory(session.id)).length, 0);
});

test("second concurrent turn for the same session is rejected", async () => {
  const session = await makeSession();
  const release = Promise.withResolvers();
  const fetchImpl = async () => {
    await release.promise;
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { text: JSON.stringify({ narrative: "Ok.", effects: [] }) },
            ],
          },
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const first = turn.submitTurn(session.id, "Aksi pertama.", "key", {
    fetchImpl,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await turn.submitTurn(session.id, "Aksi kedua.", "key", {
    fetchImpl,
  });
  assert.deepEqual(second, { ok: false, error: "Turn lain sedang berjalan." });
  release.resolve();
  const firstOutcome = await first;
  assert.equal(firstOutcome.ok, true);
  assert.equal((await db.getHistory(session.id)).length, 2);
});

test("opening scene commits one narrator message and refuses to repeat", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    { narrative: "Hujan mengguyur kaca kedai.", effects: [] },
  ]);
  const outcome = await turn.beginOpeningScene(session.id, "key", {
    fetchImpl,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.messages[0].role, "NARRATOR");
  assert.equal(outcome.messages[0].sequence, 0);

  const reloaded = await db.getSession(session.id);
  assert.equal(reloaded.nextSequence, 1);

  const again = await turn.beginOpeningScene(session.id, "key", { fetchImpl });
  assert.deepEqual(again, { ok: false, error: "Scene awal sudah ada." });
});

test("opening scene rejects proposals that touch state", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    { narrative: "Hujan.", effects: [{ type: "ADD_FACT", text: "x" }] },
  ]);
  const outcome = await turn.beginOpeningScene(session.id, "key", {
    fetchImpl,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /tidak boleh mengubah state/);
  assert.equal((await db.getHistory(session.id)).length, 0);
});

test("buildContext separates narrator-only facts and caps recent messages", async () => {
  const session = await makeSession();
  const state = session.state;
  state.facts.push(
    {
      id: "f1",
      text: "Ren bekerja di kedai.",
      visibility: "public",
      knownBy: [],
      createdAt: new Date().toISOString(),
      source: "story",
    },
    {
      id: "f2",
      text: "Ren masuk mercusuar semalam.",
      visibility: "private",
      knownBy: [],
      createdAt: new Date().toISOString(),
      source: "story",
    },
  );
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({
      id: `m${i}`,
      sessionId: session.id,
      turnId: "t",
      sequence: i,
      role: "PLAYER",
      content: `pesan-${i}`,
      createdAt: new Date().toISOString(),
    });
  }

  const context = turn.buildContext(session, history);

  const narratorBlock = context.split("Hanya untuk narrator:")[1] ?? "";
  assert.match(narratorBlock, /Ren masuk mercusuar semalam/);
  const factsBlock =
    context.split("FACTS:")[1]?.split("Hanya untuk narrator:")[0] ?? "";
  assert.match(factsBlock, /Ren bekerja di kedai/);
  assert.doesNotMatch(factsBlock, /mercusuar/);
  for (let i = 0; i < 6; i += 1) {
    assert.ok(
      !context.includes(`PLAYER: pesan-${i}\n`),
      `pesan-${i} harus di luar jendela`,
    );
  }
  assert.match(context, /PLAYER: pesan-6/);
  assert.match(context, /PLAYER: pesan-29/);

  const npcKnowledge = (context.split("Pengetahuan NPC ini:")[1] ?? "").split(
    "\n\n",
  )[0];
  assert.match(npcKnowledge, /rahasia mercusuar/);
  assert.match(npcKnowledge, /Ren bekerja di kedai/);
  assert.doesNotMatch(npcKnowledge, /Ren masuk mercusuar semalam/);
});

test("requestChoices returns choices bound to current sequence without state change", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      narrative: "Pilihan tersedia.",
      effects: [],
      choices: [
        { id: "a", label: "Sapa Aiko" },
        { id: "b", label: "Diam saja" },
      ],
    },
  ]);
  const outcome = await turn.requestChoices(session.id, "key", { fetchImpl });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.choices.length, 2);
  assert.equal(outcome.boundSequence, session.nextSequence);
  assert.equal((await db.getHistory(session.id)).length, 0);
  assert.equal(
    (await db.getSession(session.id)).nextSequence,
    session.nextSequence,
  );
});

test("requestChoices rejects proposals that change state", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      narrative: "Pilihan.",
      effects: [{ type: "ADD_FACT", text: "x" }],
      choices: [{ id: "a", label: "Sapa" }],
    },
  ]);
  const outcome = await turn.requestChoices(session.id, "key", { fetchImpl });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /tidak boleh mengubah state/);
});

test("requestChoices accepts empty suggestions without changing the session", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    { narrative: "Kosong.", effects: [], choices: [] },
  ]);
  const outcome = await turn.requestChoices(session.id, "key", { fetchImpl });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.choices, []);
  assert.equal(outcome.boundSequence, session.nextSequence);
  assert.deepEqual(await db.getSession(session.id), session);
  assert.deepEqual(await db.getHistory(session.id), []);
});

test("narrative turn surfaces model choices in the outcome", async () => {
  const session = await makeSession();
  const fetchImpl = scriptedFetch([
    {
      narrative: "Aiko menunggu.",
      effects: [],
      choices: [
        { id: "a", label: "Tawarkan payung" },
        { id: "b", label: "Tanya kabarnya" },
      ],
    },
  ]);
  const outcome = await turn.submitTurn(session.id, "Aku masuk kedai.", "key", {
    fetchImpl,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.choices.length, 2);
  assert.equal(outcome.choices[0].label, "Tawarkan payung");
});

test("useSessionItem commits a consumable and logs a system event", async () => {
  const session = await makeSession();
  const seeded = await db.getSession(session.id);
  seeded.state.inventory = [{ itemId: "energy_drink", quantity: 1 }];
  await db.saveTurn(seeded, []);

  const outcome = await turn.useSessionItem(session.id, "energy_drink");
  assert.equal(outcome.ok, true);
  const reloaded = await db.getSession(session.id);
  assert.equal(reloaded.state.resources.yen, 5020);
  assert.deepEqual(reloaded.state.inventory, []);
  const history = await db.getHistory(session.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "SYSTEM_EVENT");
  assert.match(history[0].content, /Energy Drink digunakan/);
});

test("useSessionItem rejects missing item without committing", async () => {
  const session = await makeSession();
  const outcome = await turn.useSessionItem(session.id, "ghost_item");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /tidak dikenal/);
  assert.equal((await db.getHistory(session.id)).length, 0);
});
