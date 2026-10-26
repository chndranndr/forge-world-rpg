import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const providerKey = "lorebook-evolving-offline-key";
let vite;
let databaseApi;
let turnApi;
let loreApi;
let templateApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, turnApi, loreApi, templateApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
    vite.ssrLoadModule("/shared/lore.ts"),
    vite.ssrLoadModule("/shared/template.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

const storyPath = "examples/lorebook-evolving-story.json";
const gamePath = "examples/lorebook-evolving-game.json";

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
    return openRouterResponse(content, `lorebook-evolving-${requestNumber}`);
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

function candidate(prompt, expectedBody) {
  const entry = prompt.context.lore.find((entry) => entry.discoveryCandidate);
  assert.ok(entry, "expected an opaque discovery candidate");
  assert.match(entry.id, /^discovery-candidate:[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(entry).sort(), ["discoveryCandidate", "id"]);
  assert.equal(JSON.stringify(prompt).includes(expectedBody), false);
  return entry;
}

function discoveredBody(prompt, entry, expectedBody) {
  const found = prompt.context.lore.find(
    (candidate) => candidate.id === entry.id,
  );
  assert.ok(found, `expected ${entry.id} in prompt lore`);
  assert.equal(found.body, expectedBody);
  assert.equal(JSON.stringify(prompt).includes(expectedBody), true);
}

test("the evolving-story kit publishes, gates each stage, and reveals lore in order", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fworld-evolving-"));
  const db = new databaseApi.GameDatabase(join(directory, "runtime.sqlite"));
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  const pack = loreApi.parseLorebookPack(
    JSON.parse(readFileSync(storyPath, "utf8")),
  );
  const template = templateApi.parseTemplate(
    JSON.parse(readFileSync(gamePath, "utf8")),
  );
  assert.equal(pack.format, "fworld-lorebook");
  assert.equal(pack.version, 1);
  assert.equal(pack.pack.id, "fworld-evolving-story");
  assert.equal(pack.pack.version, 1);
  assert.equal(pack.entries.length, 12);
  assert.equal(pack.links.length, 5);
  const ids = new Set(pack.entries.map((entry) => entry.id));
  for (const link of pack.links) {
    assert.ok(ids.has(link.fromId), `missing ${link.fromId}`);
    assert.ok(ids.has(link.toId), `missing ${link.toId}`);
  }
  const discoveryEntries = pack.entries.filter(
    (entry) => entry.visibility === "discovery",
  );
  assert.deepEqual(
    discoveryEntries.map((entry) => entry.metadata.discoverAt),
    [
      ["loc:kampung"],
      ["loc:rumah-singgah"],
      ["loc:dermaga"],
      ["loc:balai-kota"],
    ],
  );
  assert.deepEqual(
    discoveryEntries.map((entry) => entry.metadata.discoveryKeywords[0]),
    ["catatan", "catatan", "catatan", "catatan"],
  );

  const draft = template.draft;
  assert.equal(draft.language, "Indonesian");
  assert.equal(draft.ageRating, "adult-18-plus");
  assert.deepEqual(draft.lorebookRefs, [
    { packId: "fworld-evolving-story", version: 1 },
  ]);
  assert.deepEqual(draft.startingInventory, [
    { itemId: "item:ponsel", quantity: 1 },
  ]);
  assert.deepEqual(draft.player.attributes, {});
  assert.deepEqual(draft.player.resources, {});
  assert.deepEqual(draft.npcs, []);
  const game = {
    ...draft,
    id: "evolving-story-game",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  db.importLorebook(pack);
  const started = db.startSessionForDefinition({
    definition: game,
    ai: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    sessionId: "evolving-story-session",
  });
  const session = started.session.value;
  assert.equal(session.state.world.locationId, "loc:kampung");
  const map = session.worldMap;
  assert.deepEqual(map.locations.map((location) => location.id).sort(), [
    "loc:balai-kota",
    "loc:dermaga",
    "loc:kampung",
    "loc:lapas",
    "loc:rumah-singgah",
  ]);
  assert.deepEqual(
    map.connections
      .map((edge) => [edge.fromId, edge.toId].sort().join("-"))
      .sort(),
    [
      "loc:balai-kota-loc:dermaga",
      "loc:dermaga-loc:rumah-singgah",
      "loc:kampung-loc:lapas",
      "loc:kampung-loc:rumah-singgah",
      "loc:lapas-loc:rumah-singgah",
    ],
  );
  assert.deepEqual(map.flags, {
    arc_mafia: false,
    arc_politisi: false,
    arc_residivis: false,
  });
  for (const entry of discoveryEntries) {
    for (const locationId of entry.metadata.discoverAt) {
      assert.ok(
        map.locations.some((location) => location.id === locationId),
        `${entry.id} points at ${locationId}`,
      );
    }
  }
  assert.deepEqual(
    session.definitionSnapshot.items.map((item) => item.id).sort(),
    [
      "item:catatan-residivis",
      "item:mandat-keluarga",
      "item:mandat-politik",
      "item:ponsel",
    ],
  );

  const preman = pack.entries.find((entry) => entry.id === "activity:preman");
  const residivis = pack.entries.find(
    (entry) => entry.id === "activity:residivis",
  );
  const mafia = pack.entries.find((entry) => entry.id === "activity:mafia");
  const politisi = pack.entries.find(
    (entry) => entry.id === "activity:politisi",
  );
  assert.ok(preman && residivis && mafia && politisi);

  stubProvider(
    t,
    [
      (prompt) => ({
        narrative: "Raka membaca buku iuran di gang.",
        effects: [
          { type: "DISCOVER_LORE", loreId: candidate(prompt, preman.body).id },
        ],
      }),
      (prompt) => {
        discoveredBody(prompt, preman, preman.body);
        return { narrative: "Raka mengingat angka iuran.", effects: [] };
      },
      { narrative: "Jalan ke Rumah Singgah masih ditutup.", effects: [] },
      {
        narrative: "Seorang kontak menyerahkan catatan residivis.",
        effects: [
          {
            type: "ADD_ITEM",
            target: "item:catatan-residivis",
            quantity: 1,
          },
        ],
      },
      { narrative: "Raka berjalan ke Rumah Singgah.", effects: [] },
      (prompt) => ({
        narrative: "Raka membuka berkas kepulangan.",
        effects: [
          {
            type: "DISCOVER_LORE",
            loreId: candidate(prompt, residivis.body).id,
          },
        ],
      }),
      (prompt) => {
        discoveredBody(prompt, residivis, residivis.body);
        return { narrative: "Raka mengingat berkas kepulangan.", effects: [] };
      },
      { narrative: "Dermaga masih tertutup untuk Raka.", effects: [] },
      {
        narrative: "Keluarga Hitam menyerahkan mandat keluarga.",
        effects: [
          { type: "ADD_ITEM", target: "item:mandat-keluarga", quantity: 1 },
        ],
      },
      { narrative: "Raka berjalan ke Dermaga Timur.", effects: [] },
      (prompt) => ({
        narrative: "Raka membaca manifest dermaga.",
        effects: [
          { type: "DISCOVER_LORE", loreId: candidate(prompt, mafia.body).id },
        ],
      }),
      (prompt) => {
        discoveredBody(prompt, mafia, mafia.body);
        return { narrative: "Raka mengingat manifest dermaga.", effects: [] };
      },
      { narrative: "Balai Kota belum bisa dimasuki.", effects: [] },
      {
        narrative: "Penghubung menyerahkan mandat politik.",
        effects: [
          { type: "ADD_ITEM", target: "item:mandat-politik", quantity: 1 },
        ],
      },
      { narrative: "Raka berjalan ke Balai Kota.", effects: [] },
      (prompt) => ({
        narrative: "Raka membuka arsip dewan.",
        effects: [
          {
            type: "DISCOVER_LORE",
            loreId: candidate(prompt, politisi.body).id,
          },
        ],
      }),
      (prompt) => {
        discoveredBody(prompt, politisi, politisi.body);
        return { narrative: "Raka mengingat arsip dewan.", effects: [] };
      },
    ],
    (prompt, _body, requestNumber) => {
      if (requestNumber === 0) {
        assert.equal(prompt.context.state.inventory[0].id, "item:ponsel");
      }
    },
  );

  const sessionId = "evolving-story-session";
  const first = await run(db, {
    sessionId,
    requestId: "evolving-discover-preman",
    work: { kind: "turn", input: "Raka memeriksa buku iuran." },
  });
  assert.equal(first.status, "committed", JSON.stringify(first.error));
  assert.deepEqual(db.getSession(sessionId).state.world.discoveredLoreIds, [
    "activity:preman",
  ]);
  const premanPrompt = await run(db, {
    sessionId,
    requestId: "evolving-preman-body",
    work: { kind: "turn", input: "Raka mengingat catatan itu." },
  });
  assert.equal(premanPrompt.status, "committed");

  const blockedHome = await run(db, {
    sessionId,
    requestId: "evolving-blocked-singgah",
    work: { kind: "turn", input: "Raka pergi ke Rumah Singgah." },
  });
  assert.equal(blockedHome.status, "committed");
  assert.equal(db.getSession(sessionId).state.world.locationId, "loc:kampung");

  const awardResidivis = await run(db, {
    sessionId,
    requestId: "evolving-award-residivis",
    work: { kind: "turn", input: "Raka menerima catatan residivis." },
  });
  assert.equal(awardResidivis.status, "committed");
  assert.deepEqual(db.getSession(sessionId).state.inventory, [
    { itemId: "item:ponsel", quantity: 1 },
    { itemId: "item:catatan-residivis", quantity: 1 },
  ]);
  const useResidivis = await run(db, {
    sessionId,
    requestId: "evolving-use-residivis",
    work: { kind: "item_use", itemId: "item:catatan-residivis" },
  });
  assert.equal(
    useResidivis.status,
    "committed",
    JSON.stringify(useResidivis.error),
  );
  const afterResidivis = db.getSession(sessionId);
  assert.equal(afterResidivis.state.world.flags.arc_residivis, true);
  assert.equal(
    afterResidivis.state.world.flags.arc_mafia,
    false,
    "only the residivis gate opens",
  );
  assert.deepEqual(afterResidivis.state.inventory, [
    { itemId: "item:ponsel", quantity: 1 },
  ]);
  assert.ok(
    afterResidivis.state.facts.some(
      (fact) =>
        fact.text === "Raka telah kembali setelah menjalani hukuman kedua.",
    ),
  );
  assert.ok(
    afterResidivis.definitionSnapshot.items.some(
      (item) => item.id === "item:catatan-residivis",
    ),
  );

  const allowedSinggah = await run(db, {
    sessionId,
    requestId: "evolving-allowed-singgah",
    work: { kind: "turn", input: "Raka pergi ke Rumah Singgah." },
  });
  assert.equal(allowedSinggah.status, "committed");
  assert.equal(
    db.getSession(sessionId).state.world.locationId,
    "loc:rumah-singgah",
  );

  const discoverResidivis = await run(db, {
    sessionId,
    requestId: "evolving-discover-residivis",
    work: { kind: "turn", input: "Raka memeriksa berkas kepulangan." },
  });
  assert.equal(discoverResidivis.status, "committed");
  assert.deepEqual(db.getSession(sessionId).state.world.discoveredLoreIds, [
    "activity:preman",
    "activity:residivis",
  ]);
  const residivisPrompt = await run(db, {
    sessionId,
    requestId: "evolving-residivis-body",
    work: { kind: "turn", input: "Raka mengingat berkas itu." },
  });
  assert.equal(residivisPrompt.status, "committed");

  const blockedDermaga = await run(db, {
    sessionId,
    requestId: "evolving-blocked-dermaga",
    work: { kind: "turn", input: "Raka pergi ke Dermaga Timur." },
  });
  assert.equal(blockedDermaga.status, "committed");
  assert.equal(
    db.getSession(sessionId).state.world.locationId,
    "loc:rumah-singgah",
  );

  const awardMafia = await run(db, {
    sessionId,
    requestId: "evolving-award-keluarga",
    work: { kind: "turn", input: "Raka menerima mandat keluarga." },
  });
  assert.equal(awardMafia.status, "committed");
  const useMafia = await run(db, {
    sessionId,
    requestId: "evolving-use-keluarga",
    work: { kind: "item_use", itemId: "item:mandat-keluarga" },
  });
  assert.equal(useMafia.status, "committed");
  const afterMafia = db.getSession(sessionId);
  assert.equal(afterMafia.state.world.flags.arc_mafia, true);
  assert.equal(afterMafia.state.world.flags.arc_politisi, false);
  assert.ok(
    afterMafia.state.facts.some(
      (fact) => fact.text === "Raka diterima sebagai anggota Keluarga Hitam.",
    ),
  );

  const allowedDermaga = await run(db, {
    sessionId,
    requestId: "evolving-allowed-dermaga",
    work: { kind: "turn", input: "Raka pergi ke Dermaga Timur." },
  });
  assert.equal(allowedDermaga.status, "committed");
  assert.equal(db.getSession(sessionId).state.world.locationId, "loc:dermaga");

  const discoverMafia = await run(db, {
    sessionId,
    requestId: "evolving-discover-mafia",
    work: { kind: "turn", input: "Raka memeriksa manifest dermaga." },
  });
  assert.equal(discoverMafia.status, "committed");
  const mafiaPrompt = await run(db, {
    sessionId,
    requestId: "evolving-mafia-body",
    work: { kind: "turn", input: "Raka mengingat manifest itu." },
  });
  assert.equal(mafiaPrompt.status, "committed");

  const blockedBalaiKota = await run(db, {
    sessionId,
    requestId: "evolving-blocked-balai-kota",
    work: { kind: "turn", input: "Raka pergi ke Balai Kota." },
  });
  assert.equal(blockedBalaiKota.status, "committed");
  assert.equal(db.getSession(sessionId).state.world.locationId, "loc:dermaga");

  const awardPolitik = await run(db, {
    sessionId,
    requestId: "evolving-award-politik",
    work: { kind: "turn", input: "Raka menerima mandat politik." },
  });
  assert.equal(awardPolitik.status, "committed");
  const usePolitik = await run(db, {
    sessionId,
    requestId: "evolving-use-politik",
    work: { kind: "item_use", itemId: "item:mandat-politik" },
  });
  assert.equal(usePolitik.status, "committed");
  const afterPolitik = db.getSession(sessionId);
  assert.equal(afterPolitik.state.world.flags.arc_politisi, true);
  assert.ok(
    afterPolitik.state.facts.some(
      (fact) =>
        fact.text ===
        "Raka telah masuk ke politik kota, bukan memenangkan pemilihan.",
    ),
  );

  const allowedBalaiKota = await run(db, {
    sessionId,
    requestId: "evolving-allowed-balai-kota",
    work: { kind: "turn", input: "Raka pergi ke Balai Kota." },
  });
  assert.equal(allowedBalaiKota.status, "committed");
  assert.equal(
    db.getSession(sessionId).state.world.locationId,
    "loc:balai-kota",
  );

  const discoverPolitik = await run(db, {
    sessionId,
    requestId: "evolving-discover-politik",
    work: { kind: "turn", input: "Raka memeriksa arsip dewan." },
  });
  assert.equal(discoverPolitik.status, "committed");
  const politikPrompt = await run(db, {
    sessionId,
    requestId: "evolving-politik-body",
    work: { kind: "turn", input: "Raka mengingat arsip itu." },
  });
  assert.equal(politikPrompt.status, "committed");

  const final = db.getSession(sessionId);
  assert.deepEqual(final.state.world.discoveredLoreIds, [
    "activity:preman",
    "activity:residivis",
    "activity:mafia",
    "activity:politisi",
  ]);
  assert.deepEqual(final.state.world.flags, {
    arc_residivis: true,
    arc_mafia: true,
    arc_politisi: true,
  });
  assert.deepEqual(final.state.inventory, [
    { itemId: "item:ponsel", quantity: 1 },
  ]);
  assert.equal(final.definitionSnapshot.items.length, 4);
  assert.deepEqual(final.lorebookRefs, [
    { packId: "fworld-evolving-story", version: 1 },
  ]);
});
