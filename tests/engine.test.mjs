import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let engine;
let sharedEngine;

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  engine = await server.ssrLoadModule("/src/engine.ts");
  sharedEngine = await server.ssrLoadModule("/shared/engine.ts");
});

test.after(async () => {
  await server.close();
});

function makeGame() {
  return {
    id: "game-1",
    title: "Uji",
    scenario: { setting: "s", startingSituation: "s" },
    attributes: [
      { id: "str", name: "Kekuatan", min: 0, max: 10, defaultValue: 5 },
    ],
    resources: [
      { id: "hp", name: "Nyawa", min: 0, max: 20, initialValue: 10 },
      { id: "gold", name: "Emas", min: 0, initialValue: 0 },
    ],
    relationships: [
      { id: "trust", name: "Kepercayaan", min: -5, max: 5, defaultValue: 0 },
    ],
    items: [
      {
        id: "potion",
        name: "Ramuan",
        stackable: true,
        maxStack: 3,
        consumable: true,
        effects: [
          { type: "RESOURCE_CHANGE", target: "hp", operation: "ADD", value: 5 },
        ],
        tags: [],
      },
      {
        id: "sword",
        name: "Pedang",
        stackable: false,
        consumable: false,
        effects: [
          {
            type: "ATTRIBUTE_CHANGE",
            target: "str",
            operation: "ADD",
            value: 1,
          },
        ],
        tags: [],
      },
      {
        id: "empty",
        name: "Kosong",
        stackable: true,
        consumable: false,
        effects: [],
        tags: [],
      },
    ],
    player: {
      name: "Pemain",
      attributes: { str: 5 },
      resources: { hp: 10, gold: 0 },
    },
    npcs: [
      {
        id: "npc-1",
        name: "Budi",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: { trust: 0 },
        attributes: { str: 7 },
      },
    ],
    startingInventory: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeState() {
  return {
    attributes: { str: 5 },
    resources: { hp: 10, gold: 5 },
    inventory: [
      { itemId: "potion", quantity: 2 },
      { itemId: "sword", quantity: 1 },
    ],
    relationships: [{ npcId: "npc-1", values: { trust: 0 } }],
    facts: [],
    world: { location: "l", time: "t", scene: "s", activeCharacters: [] },
  };
}

test("shared engine initializes RPG state without the database module", () => {
  const state = sharedEngine.buildInitialState(makeGame());
  assert.deepEqual(state.attributes, { str: 5 });
  assert.deepEqual(state.world, {
    location: "",
    time: "",
    scene: "s",
    activeCharacters: ["player", "npc-1"],
  });
});

test("valid batch applies all effects and returns summaries", () => {
  const game = makeGame();
  const state = makeState();
  const snapshot = structuredClone(state);
  const result = engine.applyEffects(game, state, [
    { type: "ATTRIBUTE_CHANGE", target: "str", operation: "ADD", value: 2 },
    {
      type: "RESOURCE_CHANGE",
      target: "hp",
      operation: "SUBTRACT",
      value: 3,
    },
    {
      type: "RELATIONSHIP_CHANGE",
      target: "trust",
      npcId: "npc-1",
      operation: "ADD",
      value: 1,
    },
    { type: "ADD_ITEM", target: "potion", quantity: 1 },
    { type: "ADD_FACT", text: "rahasia besar" },
  ]);
  assert.deepEqual(state, snapshot);
  assert.equal(result.applied.length, 5);
  for (const summary of result.applied) {
    assert.equal(typeof summary, "string");
    assert.ok(summary.length > 0);
  }
  assert.equal(result.state.attributes.str, 7);
  assert.equal(result.state.resources.hp, 7);
  assert.equal(result.state.relationships[0].values.trust, 1);
  assert.equal(result.state.inventory[0].quantity, 3);
  assert.equal(result.state.facts.length, 1);
  assert.equal(result.state.facts[0].text, "rahasia besar");
  assert.equal(result.state.facts[0].source, "story");
  assert.equal(result.state.facts[0].visibility, "public");
  assert.ok(result.state.facts[0].id);
});

test("resource below minimum rejects whole batch and leaves state untouched", () => {
  const game = makeGame();
  const state = makeState();
  const snapshot = structuredClone(state);
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "ATTRIBUTE_CHANGE",
          target: "str",
          operation: "ADD",
          value: 1,
        },
        {
          type: "RESOURCE_CHANGE",
          target: "hp",
          operation: "SUBTRACT",
          value: 999,
        },
      ]),
    engine.EngineError,
  );
  assert.deepEqual(state, snapshot);
});

test("unknown attribute, resource, item, relationship, and NPC ids rejected", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "ATTRIBUTE_CHANGE",
          target: "nope",
          operation: "ADD",
          value: 1,
        },
      ]),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "RESOURCE_CHANGE",
          target: "nope",
          operation: "ADD",
          value: 1,
        },
      ]),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        { type: "ADD_ITEM", target: "nope", quantity: 1 },
      ]),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "RELATIONSHIP_CHANGE",
          target: "nope",
          npcId: "npc-1",
          operation: "ADD",
          value: 1,
        },
      ]),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "RELATIONSHIP_CHANGE",
          target: "trust",
          npcId: "nope",
          operation: "ADD",
          value: 1,
        },
      ]),
    engine.EngineError,
  );
});

test("attribute result out of range rejected naming attribute and bounds", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "ATTRIBUTE_CHANGE",
          target: "str",
          operation: "SET",
          value: 99,
        },
      ]),
    (error) => {
      assert.ok(error instanceof engine.EngineError);
      assert.match(error.message, /Kekuatan/);
      assert.match(error.message, /0/);
      assert.match(error.message, /10/);
      return true;
    },
  );
});

test("stackable ADD respects maxStack", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        { type: "ADD_ITEM", target: "potion", quantity: 2 },
      ]),
    (error) => {
      assert.ok(error instanceof engine.EngineError);
      assert.match(error.message, /3/);
      return true;
    },
  );
  const ok = engine.applyEffects(game, state, [
    { type: "ADD_ITEM", target: "potion", quantity: 1 },
  ]);
  assert.equal(ok.state.inventory[0].quantity, 3);
});

test("non-stackable ADD rejects quantity above 1", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        { type: "ADD_ITEM", target: "sword", quantity: 2 },
      ]),
    engine.EngineError,
  );
});

test("REMOVE_ITEM beyond owned quantity rejected", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        { type: "REMOVE_ITEM", target: "potion", quantity: 5 },
      ]),
    engine.EngineError,
  );
});

test("REMOVE_ITEM drops entry at zero quantity", () => {
  const game = makeGame();
  const state = makeState();
  const result = engine.applyEffects(game, state, [
    { type: "REMOVE_ITEM", target: "potion", quantity: 2 },
  ]);
  assert.equal(
    result.state.inventory.some((entry) => entry.itemId === "potion"),
    false,
  );
});

test("ADD_FACT then REMOVE_FACT round-trips", () => {
  const game = makeGame();
  const state = makeState();
  const added = engine.applyEffects(game, state, [
    { type: "ADD_FACT", text: "rahasia" },
  ]);
  const factId = added.state.facts[0].id;
  const removed = engine.applyEffects(game, added.state, [
    { type: "REMOVE_FACT", target: factId },
  ]);
  assert.equal(removed.state.facts.length, 0);
  assert.throws(
    () =>
      engine.applyEffects(game, removed.state, [
        { type: "REMOVE_FACT", target: factId },
      ]),
    engine.EngineError,
  );
});

test("RELATIONSHIP_CHANGE without npcId rejected; with npcId applies", () => {
  const game = makeGame();
  const state = makeState();
  assert.throws(
    () =>
      engine.applyEffects(game, state, [
        {
          type: "RELATIONSHIP_CHANGE",
          target: "trust",
          operation: "ADD",
          value: 1,
        },
      ]),
    engine.EngineError,
  );
  const ok = engine.applyEffects(game, state, [
    {
      type: "RELATIONSHIP_CHANGE",
      target: "trust",
      npcId: "npc-1",
      operation: "ADD",
      value: 2,
    },
  ]);
  assert.equal(ok.state.relationships[0].values.trust, 2);
});

test("useItem consumable decrements and applies effects", () => {
  const game = makeGame();
  const state = makeState();
  const result = engine.useItem(game, state, "potion");
  assert.equal(result.state.resources.hp, 15);
  assert.equal(
    result.state.inventory.find((entry) => entry.itemId === "potion").quantity,
    1,
  );
});

test("useItem non-consumable keeps quantity", () => {
  const game = makeGame();
  const state = makeState();
  const result = engine.useItem(game, state, "sword");
  assert.equal(result.state.attributes.str, 6);
  assert.equal(
    result.state.inventory.find((entry) => entry.itemId === "sword").quantity,
    1,
  );
});

test("useItem on missing item throws", () => {
  const game = makeGame();
  const state = makeState();
  state.inventory = [];
  assert.throws(
    () => engine.useItem(game, state, "potion"),
    engine.EngineError,
  );
});

test("useItem consumable decrements to zero and drops the entry", () => {
  const game = makeGame();
  const state = makeState();
  state.inventory = [{ itemId: "potion", quantity: 1 }];
  const result = engine.useItem(game, state, "potion");
  assert.equal(
    result.state.inventory.some((entry) => entry.itemId === "potion"),
    false,
  );
});

test("runCheck boundaries with injected random", () => {
  const game = makeGame();
  const state = makeState();
  const params = { attributeId: "str", difficulty: 5, mode: "NORMAL" };
  // base 5 + modifier -3 = 2 ... modifier +3 = 8
  const at = (modifier) => {
    // MODIFIER = floor(r * span+1) + min; NORMAL min -3 span 7
    const r = (modifier + 3.5) / 7;
    return engine.runCheck(game, state, params, () => r);
  };
  assert.equal(at(0).score, 5);
  assert.equal(at(0).outcome, "SUCCESS");
  assert.equal(at(-1).score, 4);
  assert.equal(at(-1).outcome, "PARTIAL_SUCCESS");
  assert.equal(at(-2).score, 3);
  assert.equal(at(-2).outcome, "PARTIAL_SUCCESS");
  assert.equal(at(-3).score, 2);
  assert.equal(at(-3).outcome, "FAILURE");
});
test("runCheck OFF mode modifier always zero", () => {
  const game = makeGame();
  const state = makeState();
  const params = { attributeId: "str", difficulty: 5, mode: "OFF" };
  assert.equal(engine.runCheck(game, state, params, () => 0).score, 5);
  assert.equal(engine.runCheck(game, state, params, () => 0.99).score, 5);
});

test("runCheck reads NPC attribute when npcId given", () => {
  const game = makeGame();
  const state = makeState();
  const record = engine.runCheck(
    game,
    state,
    {
      attributeId: "str",
      difficulty: 7,
      mode: "OFF",
      npcId: "npc-1",
    },
    () => 0,
  );
  assert.equal(record.score, 7);
  assert.equal(record.outcome, "SUCCESS");
});

test("validateCheckRequest catches unknown attribute and negative difficulty", () => {
  const game = makeGame();
  const state = makeState();
  const problems = engine.validateCheckRequest(game, state, {
    attributeId: "nope",
    difficulty: -1,
    mode: "NORMAL",
  });
  assert.equal(problems.length, 2);
  assert.equal(
    engine.validateCheckRequest(game, state, {
      attributeId: "str",
      difficulty: 0,
      mode: "NORMAL",
    }).length,
    0,
  );
});

test("validateCheckRequest checks NPC existence and attribute", () => {
  const game = makeGame();
  const state = makeState();
  assert.equal(
    engine.validateCheckRequest(game, state, {
      attributeId: "str",
      difficulty: 1,
      mode: "NORMAL",
      npcId: "npc-1",
    }).length,
    0,
  );
  assert.equal(
    engine.validateCheckRequest(game, state, {
      attributeId: "str",
      difficulty: 1,
      mode: "NORMAL",
      npcId: "nope",
    }).length,
    1,
  );
});

test("parseTurnResponse parses a check request", () => {
  const result = engine.parseTurnResponse({
    requiresCheck: true,
    attribute: "str",
    difficulty: 7,
    mode: "HIGH",
    npcId: "npc-1",
  });
  assert.equal(result.type, "check_request");
  assert.deepEqual(result.params, {
    attributeId: "str",
    difficulty: 7,
    mode: "HIGH",
    npcId: "npc-1",
  });
});

test("parseTurnResponse defaults check mode to NORMAL and drops blank npcId", () => {
  const result = engine.parseTurnResponse({
    requiresCheck: true,
    attribute: "str",
    difficulty: 3,
    npcId: "  ",
  });
  assert.equal(result.type, "check_request");
  assert.equal(result.params.mode, "NORMAL");
  assert.equal(result.params.npcId, undefined);
});

test("parseTurnResponse rejects a check request with bad difficulty", () => {
  assert.throws(
    () =>
      engine.parseTurnResponse({
        requiresCheck: true,
        attribute: "str",
        difficulty: "high",
      }),
    engine.EngineError,
  );
});

test("parseTurnResponse parses a narrative proposal with effects", () => {
  const result = engine.parseTurnResponse({
    narrative: "Aiko mengangkat alis.",
    effects: [
      { type: "RESOURCE_CHANGE", target: "gold", operation: "ADD", value: 5 },
      {
        type: "RELATIONSHIP_CHANGE",
        target: "trust",
        npcId: "npc-1",
        operation: "ADD",
        value: 1,
      },
    ],
    world: {
      location: "Kafe",
      locationId: "loc:cafe",
      time: "19:50",
    },
  });
  assert.equal(result.type, "narrative");
  assert.equal(result.narrative, "Aiko mengangkat alis.");
  assert.equal(result.effects.length, 2);
  assert.equal(result.effects[1].npcId, "npc-1");
  assert.deepEqual(result.world, {
    location: "Kafe",
    locationId: "loc:cafe",
    time: "19:50",
  });
});

test("parseTurnResponse rejects narrative without text", () => {
  assert.throws(
    () => engine.parseTurnResponse({ effects: [] }),
    engine.EngineError,
  );
});

test("parseTurnResponse rejects unknown effect type", () => {
  assert.throws(
    () =>
      engine.parseTurnResponse({
        narrative: "x",
        effects: [{ type: "EXPLODE" }],
      }),
    engine.EngineError,
  );
});

test("parseTurnResponse rejects non-object input", () => {
  assert.throws(() => engine.parseTurnResponse("halo"), engine.EngineError);
  assert.throws(() => engine.parseTurnResponse(null), engine.EngineError);
});
