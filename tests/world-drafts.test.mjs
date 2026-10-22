import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

let server;
let drafts;
let validation;
let exampleTemplate;

const emptyTemplate = {
  format: "fworld-template",
  version: 1,
  game: {
    title: "Legacy draft",
    scenario: { setting: "", startingSituation: "" },
    attributes: [],
    resources: [],
    relationships: [],
    items: [],
    player: { name: "", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
  },
};

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  drafts = await server.ssrLoadModule("/src/world-drafts.ts");
  validation = await server.ssrLoadModule("/shared/validation.ts");
  exampleTemplate = JSON.parse(
    await readFile(
      new URL("../examples/game-template.json", import.meta.url),
      "utf8",
    ),
  );
});

test.after(async () => {
  await server.close();
});

test("blank draft has valid empty shape and new-draft enum defaults", () => {
  const draft = drafts.buildBlankDraft({ id: "blank-id", updatedAt: "now" });
  assert.deepEqual(validation.validateDefinition(draft), []);
  assert.equal(draft.title, "");
  assert.equal(draft.description, "");
  assert.deepEqual(draft.scenario, {
    setting: "",
    startingSituation: "",
    narratorStyle: "cinematic-second-person",
    tempo: "medium",
    turnLength: "medium",
    pointOfView: "second-person",
  });
  assert.equal(draft.ageRating, "teen-13-plus");
  assert.equal(draft.player.pronoun, "neutral");
  assert.deepEqual(draft.attributes, []);
  assert.deepEqual(draft.resources, []);
  assert.deepEqual(draft.relationshipParties, []);
  assert.deepEqual(draft.relationships, []);
  assert.deepEqual(draft.items, []);
  assert.deepEqual(draft.player, {
    name: "",
    pronoun: "neutral",
    attributes: {},
    resources: {},
  });
  assert.deepEqual(draft.npcs, []);
  assert.deepEqual(draft.startingInventory, []);
});

test("built-in draft gets a fresh identity, defaults, and independent content", () => {
  const first = drafts.buildBuiltinDraft(exampleTemplate, {
    id: "first-id",
    updatedAt: "first-time",
  });
  const second = drafts.buildBuiltinDraft(exampleTemplate, {
    id: "second-id",
    updatedAt: "second-time",
  });

  assert.equal(first.title, "Kedai Senja di Tepi Laut");
  assert.equal(first.npcs.length, 3);
  assert.equal(first.worldMap, undefined);
  assert.equal(first.id, "first-id");
  assert.equal(first.updatedAt, "first-time");
  assert.equal(second.id, "second-id");
  assert.equal(second.updatedAt, "second-time");
  assert.equal(first.ageRating, "teen-13-plus");
  assert.equal(first.scenario.narratorStyle, "cinematic-second-person");
  assert.equal(first.scenario.tempo, "medium");
  assert.equal(first.scenario.turnLength, "medium");
  assert.equal(first.scenario.pointOfView, "second-person");
  assert.equal(first.player.pronoun, "neutral");

  first.attributes[0].name = "Changed only in first draft";
  assert.equal(second.attributes[0].name, "Semangat");
  assert.equal(exampleTemplate.game.attributes[0].name, "Semangat");
  assert.notStrictEqual(first.attributes, second.attributes);
  assert.notStrictEqual(first.npcs[0], second.npcs[0]);
});

test("saved legacy template gets fresh identity without added enum defaults", () => {
  const first = drafts.buildSavedTemplateDraft(emptyTemplate, () => ({
    id: "saved-first",
    updatedAt: "time-one",
  }));
  const second = drafts.buildSavedTemplateDraft(emptyTemplate, () => ({
    id: "saved-second",
    updatedAt: "time-two",
  }));

  assert.equal(first.id, "saved-first");
  assert.equal(first.updatedAt, "time-one");
  assert.equal(second.id, "saved-second");
  assert.equal(second.updatedAt, "time-two");
  assert.equal(Object.hasOwn(first, "ageRating"), false);
  assert.equal(Object.hasOwn(first.scenario, "narratorStyle"), false);
  assert.equal(Object.hasOwn(first.scenario, "tempo"), false);
  assert.equal(Object.hasOwn(first.scenario, "turnLength"), false);
  assert.equal(Object.hasOwn(first.scenario, "pointOfView"), false);
  assert.equal(Object.hasOwn(first.player, "pronoun"), false);
});
