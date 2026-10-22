import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { createServer } from "vite";

let server;
let db;

function baseGame(id) {
  return {
    id,
    title: "Kedai Kopi Senja",
    description: "Mengelola kedai kopi kecil di pinggir kota.",
    scenario: {
      setting: "Kota kecil",
      startingSituation: "Hari pertama kedai dibuka.",
    },
    attributes: [
      { id: "semangat", name: "Semangat", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [{ id: "uang", name: "Uang", min: 0, initialValue: 1000 }],
    relationships: [
      { id: "akrab", name: "Keakraban", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [
      {
        id: "kopi",
        name: "Kopi",
        stackable: true,
        maxStack: 10,
        consumable: true,
        effects: [],
        tags: [],
      },
    ],
    player: { name: "Dian", attributes: {}, resources: {} },
    npcs: [
      {
        id: "bima",
        name: "Bima",
        personality: ["ramah"],
        goals: ["membuat kedai ramai"],
        privateKnowledge: [],
        initialRelationships: { akrab: 3 },
      },
    ],
    startingInventory: [{ itemId: "kopi", quantity: 2 }],
    updatedAt: new Date().toISOString(),
  };
}

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  db = await server.ssrLoadModule("/src/db.ts");
});

test.after(async () => {
  await server.close();
});

test("text edits and adding entities are allowed", () => {
  const original = baseGame(crypto.randomUUID());
  const next = structuredClone(original);
  next.description = "Deskripsi yang diperbarui.";
  next.attributes.push({
    id: "fokus",
    name: "Fokus",
    min: 0,
    max: 5,
    defaultValue: 1,
  });
  next.npcs[0].personality.push("sabar");
  assert.deepEqual(db.validateDefinitionUpdate(original, next), []);
});

test("deleting an existing attribute, item, or npc is blocked", () => {
  const original = baseGame(crypto.randomUUID());

  const noAttribute = structuredClone(original);
  noAttribute.attributes = [];
  const noItem = structuredClone(original);
  noItem.items = [];
  noItem.startingInventory = [];
  const noNpc = structuredClone(original);
  noNpc.npcs = [];

  const cases = [
    [noAttribute, "semangat"],
    [noItem, "kopi"],
    [noNpc, "bima"],
  ];
  for (const [candidate, label] of cases) {
    const errors = db.validateDefinitionUpdate(original, candidate);
    assert.ok(
      errors.some((message) => message.includes(label)),
      `penghapusan ${label} harus diblokir`,
    );
  }
});

test("changing numeric bounds of existing entities is blocked", () => {
  const original = baseGame(crypto.randomUUID());
  const next = structuredClone(original);
  next.attributes[0].min = 1;
  next.attributes[0].max = 20;
  next.attributes[0].defaultValue = 7;
  next.resources[0].min = 5;
  next.resources[0].max = 999999;
  next.resources[0].initialValue = 50;
  next.relationships[0].defaultValue = 2;
  next.items[0].maxStack = 3;

  const errors = db.validateDefinitionUpdate(original, next);
  for (const label of ["semangat", "uang", "akrab", "kopi"]) {
    assert.ok(
      errors.some((message) => message.includes(label)),
      `perubahan numerik ${label} harus diblokir`,
    );
  }
});
