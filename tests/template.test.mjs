import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

let server;
let db;
let template;

function fullGame(id) {
  return {
    id,
    title: "Kedai Senja di Tepi Laut",
    genre: "slice of life",
    tone: "hangat",
    language: "id",
    scenario: {
      setting: "Kamakura",
      startingSituation: "Hari pertama kedai dibuka.",
    },
    attributes: [
      { id: "semangat", name: "Semangat", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [
      { id: "energi", name: "Energi", min: 0, max: 100, initialValue: 80 },
    ],
    relationships: [
      { id: "akrab", name: "Keakraban", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [
      {
        id: "kopi_hangat",
        name: "Kopi Hangat",
        stackable: true,
        maxStack: 5,
        consumable: true,
        effects: [
          {
            type: "RESOURCE_CHANGE",
            target: "energi",
            operation: "ADD",
            value: 15,
          },
          {
            type: "RELATIONSHIP_CHANGE",
            target: "akrab",
            npcId: "bima",
            operation: "ADD",
            value: 2,
          },
        ],
        tags: ["minuman"],
      },
      {
        id: "kamera_tua",
        name: "Kamera Tua",
        stackable: false,
        consumable: false,
        effects: [{ type: "ADD_FACT", text: "Foto mercusuar lama." }],
        tags: [],
      },
    ],
    player: {
      name: "Dian",
      attributes: { semangat: 7 },
      resources: {},
    },
    npcs: [
      {
        id: "bima",
        name: "Bima",
        personality: ["pendiam"],
        goals: ["menjaga mercusuar"],
        privateKnowledge: ["surat wasiat"],
        initialRelationships: { akrab: 3 },
      },
    ],
    startingInventory: [
      { itemId: "kopi_hangat", quantity: 2 },
      { itemId: "kamera_tua", quantity: 1 },
    ],
    updatedAt: "2026-09-29T00:00:00.000Z",
  };
}

function skeletonDraft() {
  return {
    title: "",
    scenario: { setting: "", startingSituation: "" },
    attributes: [],
    resources: [],
    relationships: [],
    items: [],
    player: { name: "", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
  };
}

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  db = await server.ssrLoadModule("/src/db.ts");
  template = await server.ssrLoadModule("/src/template.ts");
});

test.after(async () => {
  await server.close();
});

test("bundled example parses as a playable draft with ai", async () => {
  const file = await readFile(
    new URL("../examples/game-template.json", import.meta.url),
    "utf8",
  );
  const { draft, ai } = template.parseTemplate(JSON.parse(file));
  assert.equal(draft.title, "Kedai Senja di Tepi Laut");
  assert.equal(draft.player.name, "Dian");
  assert.deepEqual(draft.startingInventory, [
    { itemId: "kopi_hangat", quantity: 2 },
    { itemId: "paket_biji_kopi", quantity: 1 },
    { itemId: "kamera_tua", quantity: 1 },
    { itemId: "kunci_mercusuar", quantity: 1 },
  ]);
  assert.deepEqual(ai, { provider: "gemini", model: "gemini-2.5-flash" });
  const effectTypes = new Set(
    draft.items.flatMap((item) => item.effects.map((effect) => effect.type)),
  );
  assert.deepEqual([...effectTypes].sort(), [
    "ADD_FACT",
    "ADD_ITEM",
    "ATTRIBUTE_CHANGE",
    "RELATIONSHIP_CHANGE",
    "REMOVE_FACT",
    "REMOVE_ITEM",
    "RESOURCE_CHANGE",
  ]);
  assert.deepEqual(
    db.validatePlayability({ ...draft, id: "x", updatedAt: "t" }),
    [],
  );
  assert.deepEqual(
    db.validateDefinition({ ...draft, id: "x", updatedAt: "t" }),
    [],
  );
});

test("template round-trip preserves content and drops ids, timestamps, foreign fields", () => {
  const game = fullGame(crypto.randomUUID());
  game.apiKey = "secret";
  game.state = { attributes: {} };
  const bundle = template.exportTemplate(game, {
    provider: "gemini",
    model: "m",
  });
  assert.equal(bundle.format, "fworld-template");
  assert.equal(bundle.version, 1);
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes(game.id));

  const { draft, ai } = template.parseTemplate(JSON.parse(text));
  assert.deepEqual(draft.attributes, game.attributes);
  assert.deepEqual(draft.resources, game.resources);
  assert.deepEqual(draft.relationships, game.relationships);
  assert.deepEqual(draft.items, game.items);
  assert.deepEqual(draft.player, game.player);
  assert.deepEqual(draft.npcs, game.npcs);
  assert.deepEqual(draft.startingInventory, game.startingInventory);
  assert.equal(draft.genre, "slice of life");
  assert.equal(draft.language, "id");
  assert.equal("id" in draft, false);
  assert.equal("updatedAt" in draft, false);
  assert.equal("apiKey" in draft, false);
  assert.equal("state" in draft, false);
  assert.deepEqual(ai, { provider: "gemini", model: "m" });
});

test("skeleton template without title, player, or scenario parses as draft", () => {
  const bundle = {
    format: "fworld-template",
    version: 1,
    exportedAt: "2026-09-30T00:00:00.000Z",
    game: skeletonDraft(),
  };
  const { draft, ai } = template.parseTemplate(
    JSON.parse(JSON.stringify(bundle)),
  );
  assert.deepEqual(draft, skeletonDraft());
  assert.equal(ai, undefined);
  assert.ok(
    db.validatePlayability({ ...draft, id: "x", updatedAt: "t" }).length > 0,
  );
});

test("wrong format and version rejected naming accepted formats", () => {
  for (const format of [
    "fworld-mockup-template",
    "fworld-mockup",
    "fworld-save",
  ]) {
    assert.throws(
      () =>
        template.parseTemplate({ format, version: 1, game: skeletonDraft() }),
      (error) => {
        assert.ok(error instanceof db.ImportError);
        assert.ok(error.problems.some((p) => p.includes("fworld-template")));
        return true;
      },
    );
  }
  assert.throws(
    () =>
      template.parseTemplate({
        format: "fworld-template",
        version: 2,
        game: skeletonDraft(),
      }),
    db.ImportError,
  );
});

test("structurally broken templates rejected with specific problems", () => {
  const reject = (game, match) => {
    assert.throws(
      () =>
        template.parseTemplate({ format: "fworld-template", version: 1, game }),
      (error) => {
        assert.ok(
          error.problems.some((p) => match.test(p)),
          `expected ${match} in ${JSON.stringify(error.problems)}`,
        );
        return true;
      },
    );
  };

  const base = () => JSON.parse(JSON.stringify(skeletonDraft()));

  const noScenario = base();
  delete noScenario.scenario;
  reject(noScenario, /scenario/);

  const badRange = base();
  badRange.attributes.push({
    id: "a",
    name: "A",
    min: 10,
    max: 0,
    defaultValue: 5,
  });
  reject(badRange, /min melebihi max/);

  const nonFinite = base();
  nonFinite.attributes.push({
    id: "a",
    name: "A",
    min: 0,
    max: Number.NaN,
    defaultValue: 5,
  });
  reject(nonFinite, /finite/);

  const badOperation = base();
  badOperation.attributes.push({
    id: "a",
    name: "A",
    min: 0,
    max: 10,
    defaultValue: 5,
  });
  badOperation.items.push({
    id: "i",
    name: "I",
    stackable: false,
    consumable: false,
    effects: [
      {
        type: "ATTRIBUTE_CHANGE",
        target: "a",
        operation: "MULTIPLY",
        value: 1,
      },
    ],
    tags: [],
  });
  reject(badOperation, /operation/);

  const unknownEffect = base();
  unknownEffect.items.push({
    id: "i",
    name: "I",
    stackable: false,
    consumable: false,
    effects: [{ type: "TELEPORT", target: "x" }],
    tags: [],
  });
  reject(unknownEffect, /type effect/);

  const relationshipWithoutNpc = base();
  relationshipWithoutNpc.relationships.push({
    id: "r",
    name: "R",
    min: 0,
    max: 5,
    defaultValue: 0,
  });
  relationshipWithoutNpc.items.push({
    id: "i",
    name: "I",
    stackable: false,
    consumable: false,
    effects: [
      { type: "RELATIONSHIP_CHANGE", target: "r", operation: "ADD", value: 1 },
    ],
    tags: [],
  });
  reject(relationshipWithoutNpc, /npcId/);

  const emptyFact = base();
  emptyFact.items.push({
    id: "i",
    name: "I",
    stackable: false,
    consumable: false,
    effects: [{ type: "ADD_FACT", text: "   " }],
    tags: [],
  });
  reject(emptyFact, /fakta/);

  const ghostRef = base();
  ghostRef.player.attributes = { hantu: 3 };
  reject(ghostRef, /player\.attributes/);

  const badOverride = base();
  badOverride.attributes.push({
    id: "a",
    name: "A",
    min: 0,
    max: 10,
    defaultValue: 5,
  });
  badOverride.player.attributes = { a: 99 };
  reject(badOverride, /rentang/);

  const unstackableQuantity = base();
  unstackableQuantity.items.push({
    id: "i",
    name: "I",
    stackable: false,
    consumable: false,
    effects: [],
    tags: [],
  });
  unstackableQuantity.startingInventory.push({ itemId: "i", quantity: 3 });
  reject(unstackableQuantity, /ditumpuk/);

  assert.throws(
    () =>
      template.parseTemplate({
        format: "fworld-template",
        version: 1,
        game: base(),
        ai: { provider: "claude", model: "x" },
      }),
    db.ImportError,
  );

  const polluted = JSON.parse(
    JSON.stringify({
      format: "fworld-template",
      version: 1,
      game: base(),
    }).replace('"game"', '"__proto__": {}, "game"'),
  );
  assert.throws(() => template.parseTemplate(polluted), db.ImportError);
});

test("parse never writes the database", async () => {
  const before = await db.listGames();
  template.parseTemplate({
    format: "fworld-template",
    version: 1,
    game: skeletonDraft(),
  });
  assert.throws(
    () => template.parseTemplate({ format: "wrong" }),
    db.ImportError,
  );
  const after = await db.listGames();
  assert.deepEqual(after, before);
});
