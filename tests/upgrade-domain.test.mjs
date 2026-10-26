import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let engine;
let lore;
let world;
let validation;
let template;

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  engine = await server.ssrLoadModule("/shared/engine.ts");
  lore = await server.ssrLoadModule("/shared/lore.ts");
  world = await server.ssrLoadModule("/shared/world.ts");
  validation = await server.ssrLoadModule("/shared/validation.ts");
  template = await server.ssrLoadModule("/shared/template.ts");
});

test.after(async () => {
  await server.close();
});

function map() {
  return {
    locations: [
      {
        id: "loc:prontera",
        name: "Prontera",
        aliases: ["P-town"],
        npcIds: ["npc-a"],
      },
      {
        id: "loc:market",
        name: "Morroc Market",
        aliases: ["Market"],
        parentId: "loc:prontera",
        npcIds: ["npc-b"],
        requiredFlag: "bridge-open",
      },
      {
        id: "loc:morroc",
        name: "Morroc",
        aliases: ["Desert City"],
        npcIds: [],
      },
      { id: "loc:twin-one", name: "Twin", aliases: [], npcIds: [] },
      { id: "loc:twin-two", name: "Twin", aliases: [], npcIds: [] },
    ],
    connections: [
      {
        fromId: "loc:prontera",
        toId: "loc:market",
        blockedByFlag: "road-blocked",
      },
    ],
    flags: { "bridge-open": false, "road-blocked": false, "mural-seen": false },
  };
}

function game(overrides = {}) {
  const definition = {
    id: "domain-game",
    title: "Domain Test",
    scenario: {
      setting: "A small test world",
      startingSituation: "At the gate.",
    },
    attributes: [],
    resources: [],
    relationships: [],
    items: [],
    player: { name: "Player", attributes: {}, resources: {} },
    npcs: [
      {
        id: "npc-a",
        name: "A",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-b",
        name: "B",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-c",
        name: "C",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-d",
        name: "D",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-e",
        name: "E",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-f",
        name: "F",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
      {
        id: "npc-g",
        name: "G",
        personality: [],
        goals: [],
        privateKnowledge: [],
        initialRelationships: {},
      },
    ],
    startingInventory: [],
    worldMap: map(),
    startingLocationId: "loc:prontera",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
  return definition;
}

function lorePack() {
  return {
    format: "fworld-lorebook",
    version: 1,
    pack: { id: "ragnarok-original", version: 1, name: "Original Lore" },
    entries: [
      {
        id: "history:origin",
        kind: "history",
        name: "Old Record",
        aliases: [],
        summary: "An original summary.",
        body: "A curated source text.",
        tags: ["history"],
        visibility: "public",
        metadata: {},
        provenance: {
          sourceId: "fworld-original",
          license: "CC0-1.0",
          canon: "original",
        },
      },
      {
        id: "history:secret",
        kind: "history",
        name: "Mural Secret",
        aliases: ["Hidden mural"],
        parentId: "history:origin",
        summary: "A secret summary.",
        body: "A hidden, authored discovery.",
        tags: ["secret"],
        visibility: "discovery",
        metadata: {
          discoverAt: ["loc:prontera"],
          discoveryKeywords: ["mural"],
          requiredFlag: "mural-seen",
        },
        provenance: {
          sourceId: "fworld-original",
          license: "CC0-1.0",
          canon: "original",
        },
      },
    ],
    links: [
      {
        fromId: "history:origin",
        toId: "history:secret",
        relation: "PARENT_OF",
      },
    ],
  };
}

test("world aliases select the longest name and report genuine ambiguity", () => {
  const worldMap = map();
  assert.deepEqual(world.resolveLocation(worldMap, "Morroc Market"), {
    kind: "found",
    location: worldMap.locations[1],
  });
  assert.deepEqual(world.resolveLocation(worldMap, "Twin"), {
    kind: "ambiguous",
    ids: ["loc:twin-one", "loc:twin-two"],
  });
  assert.deepEqual(world.validateWorldMap(worldMap, ["npc-a", "npc-b"]), []);
});

test("movement negation spans a long clause without suppressing later travel", () => {
  const worldMap = map();
  const worldState = {
    location: "Prontera",
    locationId: "loc:prontera",
    flags: { "bridge-open": true, "road-blocked": false, "mural-seen": false },
  };
  assert.deepEqual(
    world.resolveMovement(
      worldMap,
      worldState,
      "I do not want, after considering the detour for several minutes, to travel to Morroc Market.",
    ),
    { kind: "none" },
  );
  assert.deepEqual(
    world.resolveMovement(
      worldMap,
      worldState,
      "I do not want, after considering the detour for several minutes, to travel to Morroc Market, but I will go to Morroc Market.",
    ),
    { kind: "allowed", fromId: "loc:prontera", toId: "loc:market" },
  );
});
test("mapped movement commits only an allowed candidate", () => {
  const knownNpcIds = [
    "npc-a",
    "npc-b",
    "npc-c",
    "npc-d",
    "npc-e",
    "npc-f",
    "npc-g",
  ];
  const worldMap = map();
  const prior = {
    location: "Prontera",
    locationId: "loc:prontera",
    time: "morning",
    scene: "At the gate.",
    activeCharacters: ["player", "npc-a"],
    flags: { "bridge-open": false, "road-blocked": false, "mural-seen": false },
    npcPresence: {},
  };
  const none = world.resolveMovement(
    worldMap,
    prior,
    "Discuss Morroc's old history.",
  );
  const blocked = world.resolveMovement(
    worldMap,
    prior,
    "Go to Morroc Market.",
  );
  const ambiguous = world.resolveMovement(worldMap, prior, "Travel to Twin.");
  const unknown = world.resolveMovement(
    worldMap,
    prior,
    "Travel to Moon Archive.",
  );
  assert.equal(none.kind, "none");
  assert.equal(blocked.kind, "blocked");
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(unknown.kind, "unknown");
  for (const candidate of [none, blocked, ambiguous, unknown]) {
    const result = world.applyWorldProposal(
      worldMap,
      prior,
      candidate,
      { location: "Morroc Market", time: "evening" },
      knownNpcIds,
    );
    assert.equal(result.locationId, "loc:prontera");
    assert.equal(result.location, "Prontera");
    assert.deepEqual(result.activeCharacters, ["player", "npc-a"]);
    assert.equal(result.time, "evening");
  }

  assert.equal(
    world.resolveMovement(undefined, prior, "Discuss Morroc's old history.")
      .kind,
    "legacy",
  );
  const legacyResult = world.applyWorldProposal(
    undefined,
    prior,
    { kind: "legacy" },
    { location: "Freeform place", time: "evening", scene: "A new scene." },
    knownNpcIds,
  );
  assert.equal(legacyResult.location, "Freeform place");
  assert.equal(legacyResult.time, "evening");

  const open = {
    ...prior,
    flags: { ...prior.flags, "bridge-open": true },
  };
  assert.deepEqual(
    world.resolveMovement(
      worldMap,
      open,
      "I don't want to go to Morroc Market.",
    ),
    { kind: "none" },
  );
  assert.deepEqual(
    world.resolveMovement(
      worldMap,
      open,
      "Aku tidak ingin pergi ke Morroc Market.",
    ),
    { kind: "none" },
  );
  const candidate = world.resolveMovement(
    worldMap,
    open,
    "Walk from Prontera to Morroc Market.",
  );
  assert.deepEqual(candidate, {
    kind: "allowed",
    fromId: "loc:prontera",
    toId: "loc:market",
  });
  const noEcho = world.applyWorldProposal(
    worldMap,
    open,
    candidate,
    {},
    knownNpcIds,
  );
  assert.equal(noEcho.locationId, "loc:market");
  assert.equal(noEcho.location, "Morroc Market");
  assert.deepEqual(noEcho.activeCharacters, ["player", "npc-b"]);

  const postEffect = {
    ...open,
    flags: { ...open.flags, "road-blocked": true },
    npcPresence: { "npc-b": "present" },
  };
  const committed = world.applyWorldProposal(
    worldMap,
    postEffect,
    candidate,
    {
      location: "Prontera",
      scene: "Market gate.",
      time: "noon",
    },
    knownNpcIds,
  );
  assert.equal(committed.locationId, "loc:market");
  assert.equal(committed.location, "Morroc Market");
  assert.deepEqual(committed.activeCharacters, ["player", "npc-b"]);
  assert.equal(committed.time, "noon");
  assert.equal(committed.scene, "Market gate.");

  const crowdedMap = map();
  crowdedMap.locations[1].npcIds = [];
  const manyPresent = {
    ...open,
    npcPresence: Object.fromEntries(
      knownNpcIds.map((npcId) => [npcId, "present"]),
    ),
  };
  const orderedParticipants = world.applyWorldProposal(
    crowdedMap,
    manyPresent,
    candidate,
    {},
    [...knownNpcIds].reverse(),
  );
  assert.deepEqual(orderedParticipants.activeCharacters, [
    "player",
    "npc-g",
    "npc-f",
    "npc-e",
    "npc-d",
    "npc-c",
    "npc-b",
  ]);

  assert.throws(
    () =>
      world.applyWorldProposal(
        worldMap,
        { ...open, locationId: "loc:morroc" },
        candidate,
        {},
        knownNpcIds,
      ),
    world.WorldError,
  );
  assert.throws(
    () =>
      world.applyWorldProposal(
        worldMap,
        { ...open, locationId: "loc:missing" },
        { kind: "allowed", fromId: "loc:missing", toId: "loc:market" },
        {},
        knownNpcIds,
      ),
    world.WorldError,
  );
  assert.throws(
    () =>
      world.applyWorldProposal(
        worldMap,
        open,
        { kind: "allowed", fromId: "loc:prontera", toId: "loc:missing" },
        {},
        knownNpcIds,
      ),
    world.WorldError,
  );
});

test("scene presence overrides map defaults and caps NPC participants at six", () => {
  const worldMap = map();
  worldMap.locations[0].npcIds = [
    "npc-a",
    "npc-b",
    "npc-c",
    "npc-d",
    "npc-e",
    "npc-f",
    "npc-g",
  ];
  const participants = world.sceneParticipants(
    worldMap,
    "loc:prontera",
    { "npc-a": "absent", "npc-g": "present" },
    ["npc-a", "npc-b", "npc-c", "npc-d", "npc-e", "npc-f", "npc-g"],
  );
  assert.equal(participants[0], "player");
  assert.equal(participants.length, 7);
  assert.ok(!participants.includes("npc-a"));
  assert.ok(participants.includes("npc-g"));
  const definition = game();
  definition.worldMap = worldMap;
  const state = engine.buildInitialState(definition);
  const updated = engine.applyEffects(
    definition,
    state,
    [
      { type: "NPC_PRESENCE", npcId: "npc-a", present: false },
      { type: "NPC_PRESENCE", npcId: "npc-g", present: true },
    ],
    { worldMap: definition.worldMap },
  );
  assert.ok(!updated.state.world.activeCharacters.includes("npc-a"));
  assert.ok(updated.state.world.activeCharacters.includes("npc-g"));
  assert.equal(updated.state.world.activeCharacters.length, 7);
});

test("present NPC_PRESENCE rebinds a scoped NPC to the current scene", () => {
  const definition = game();
  const worldMap = definition.worldMap;
  const state = engine.buildInitialState(definition);
  state.world.locationId = "loc:morroc";
  state.world.location = "Morroc";
  state.world.npcPresence = { "npc-a": { locationId: "loc:prontera" } };
  state.world.activeCharacters = world.sceneParticipants(
    worldMap,
    state.world.locationId,
    state.world.npcPresence,
    ["npc-a"],
  );
  assert.deepEqual(state.world.activeCharacters, ["player"]);

  const present = engine.applyEffects(
    definition,
    state,
    [{ type: "NPC_PRESENCE", npcId: "npc-a", present: true }],
    { worldMap },
  );
  assert.deepEqual(present.state.world.npcPresence["npc-a"], {
    locationId: "loc:morroc",
    present: true,
  });
  assert.deepEqual(present.state.world.activeCharacters, ["player", "npc-a"]);
  assert.deepEqual(state.world.npcPresence["npc-a"], {
    locationId: "loc:prontera",
  });

  const absent = engine.applyEffects(
    definition,
    state,
    [{ type: "NPC_PRESENCE", npcId: "npc-a", present: false }],
    { worldMap },
  );
  assert.deepEqual(absent.state.world.npcPresence["npc-a"], {
    locationId: "loc:prontera",
    present: false,
  });
  assert.deepEqual(
    world.sceneParticipants(
      worldMap,
      "loc:prontera",
      absent.state.world.npcPresence,
      ["npc-a"],
    ),
    ["player"],
    "an explicit absence is not auto-revived by visiting the old location",
  );

  const returned = {
    ...absent.state,
    world: {
      ...absent.state.world,
      locationId: "loc:prontera",
      location: "Prontera",
    },
  };
  const reappeared = engine.applyEffects(
    definition,
    returned,
    [{ type: "NPC_PRESENCE", npcId: "npc-a", present: true }],
    { worldMap },
  );
  assert.deepEqual(reappeared.state.world.npcPresence["npc-a"], {
    locationId: "loc:prontera",
    present: true,
  });
  assert.deepEqual(reappeared.state.world.activeCharacters, [
    "player",
    "npc-a",
  ]);
});

test("lore effects require pinned discovery context, gates and player-authored action", () => {
  const definition = game({
    lorebookRefs: [{ packId: "ragnarok-original", version: 1 }],
  });
  const state = engine.buildInitialState(definition);
  const entry = lorePack().entries[1];
  const context = {
    worldMap: definition.worldMap,
    loreEntries: [entry],
    playerAction: "Search the mural by the gate.",
  };
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          playerAction: "Ask about the hidden room.",
        },
      ),
    engine.EngineError,
  );
  const flagOpenState = structuredClone(state);
  flagOpenState.world.flags["mural-seen"] = true;
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        flagOpenState,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          playerAction: "Ask about the hidden room.",
        },
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        flagOpenState,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          playerAction: "Don't search the mural.",
        },
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        {
          ...flagOpenState,
          world: { ...flagOpenState.world, locationId: "loc:market" },
        },
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        context,
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        flagOpenState,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          loreEntries: [{ ...entry, visibility: "narrator" }],
        },
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        flagOpenState,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          loreEntries: [
            {
              ...entry,
              metadata: { ...entry.metadata, blockedByFlag: "missing-flag" },
            },
          ],
        },
      ),
    engine.EngineError,
  );
  const keywordDiscovery = engine.applyEffects(
    definition,
    flagOpenState,
    [
      {
        type: "DISCOVER_LORE",
        loreId: entry.id,
      },
    ],
    { ...context, playerAction: "Mural" },
  );
  assert.deepEqual(keywordDiscovery.state.world.discoveredLoreIds, [entry.id]);
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "DISCOVER_LORE", loreId: "history:missing" }],
        context,
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "DISCOVER_LORE", loreId: entry.id }],
        {
          ...context,
          worldMap: undefined,
        },
      ),
    engine.EngineError,
  );

  const atomic = {
    worldMap: definition.worldMap,
    loreEntries: [entry],
    playerAction: "Search the mural.",
  };
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [
          { type: "SET_FLAG", target: "mural-seen", value: true },
          { type: "DISCOVER_LORE", loreId: entry.id },
        ],
        { ...atomic, playerAction: "Ask about the hidden room." },
      ),
    engine.EngineError,
  );
  assert.equal(state.world.flags["mural-seen"], false);
  const result = engine.applyEffects(
    definition,
    state,
    [
      { type: "SET_FLAG", target: "mural-seen", value: true },
      { type: "DISCOVER_LORE", loreId: entry.id },
    ],
    atomic,
  );
  assert.equal(result.state.world.flags["mural-seen"], true);
  assert.deepEqual(result.state.world.discoveredLoreIds, [entry.id]);
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "SET_FLAG", target: "not-declared", value: true }],
        atomic,
      ),
    engine.EngineError,
  );
});

test("private facts reveal only to an authored present recipient after explicit sharing", () => {
  const definition = game();
  const state = engine.buildInitialState(definition);
  state.facts.push({
    id: "fact-1",
    text: "A private route.",
    visibility: "private",
    knownBy: [],
    revealableTo: ["npc-a"],
    createdAt: "2026-10-12T00:00:00.000Z",
    source: "story",
  });
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-a" }],
        {
          playerAction: "Ask about the route.",
        },
      ),
    engine.EngineError,
  );
  const result = engine.applyEffects(
    definition,
    state,
    [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-a" }],
    {
      playerAction: "Tell A the route.",
    },
  );
  assert.deepEqual(result.state.facts[0].knownBy, ["npc-a"]);
  assert.deepEqual(state.facts[0].knownBy, []);
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-b" }],
        {
          playerAction: "Tell B the route.",
        },
      ),
    engine.EngineError,
  );
  const absentRecipient = structuredClone(state);
  absentRecipient.facts[0].revealableTo = ["npc-b"];
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        absentRecipient,
        [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-b" }],
        {
          playerAction: "Tell B the route.",
        },
      ),
    engine.EngineError,
  );
  absentRecipient.facts[0].revealableTo = ["player"];
  const playerReveal = engine.applyEffects(
    definition,
    absentRecipient,
    [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "player" }],
    {
      playerAction: "Tell myself the route.",
    },
  );
  assert.deepEqual(playerReveal.state.facts[0].knownBy, ["player"]);
  const publicFact = structuredClone(state);
  publicFact.facts[0].visibility = "public";
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        publicFact,
        [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-a" }],
        {
          playerAction: "Tell A the route.",
        },
      ),
    engine.EngineError,
  );
  assert.throws(
    () =>
      engine.applyEffects(
        definition,
        state,
        [{ type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-missing" }],
        {
          playerAction: "Tell someone the route.",
        },
      ),
    engine.EngineError,
  );
});

test("definition rejects undeclared new effect references", () => {
  const definition = game({
    lorebookRefs: [{ packId: "ragnarok-original", version: 1 }],
    items: [
      {
        id: "relic",
        name: "Relic",
        stackable: false,
        consumable: false,
        effects: [
          { type: "SET_FLAG", target: "missing", value: true },
          { type: "NPC_PRESENCE", npcId: "npc-missing", present: true },
          { type: "DISCOVER_LORE", loreId: "unsafe" },
          { type: "REVEAL_FACT", factId: "fact-1", npcId: "npc-missing" },
        ],
        tags: [],
      },
    ],
  });
  assert.ok(
    validation
      .validateDefinition(definition)
      .some((problem) => /flag/i.test(problem)),
  );
  assert.ok(
    validation
      .validateDefinition(definition)
      .some((problem) => /NPC_PRESENCE/i.test(problem)),
  );
  assert.ok(
    validation
      .validateDefinition(definition)
      .some((problem) => /namespaced/i.test(problem)),
  );
  assert.ok(
    validation
      .validateDefinition(definition)
      .some((problem) => /REVEAL_FACT/i.test(problem)),
  );
});

test("lorebook parser preserves curated summaries and rejects unsafe prose and broken graphs", () => {
  const pack = lorePack();
  assert.deepEqual(lore.validateLorebookPack(pack), []);
  assert.deepEqual(lore.parseLorebookPack(pack), pack);
  const unsafe = structuredClone(pack);
  unsafe.entries[0].body = "<script>alert(1)</script>";
  assert.ok(
    lore
      .validateLorebookPack(unsafe)
      .some((problem) => /executable/i.test(problem)),
  );
  const dangerousKey = structuredClone(pack);
  Object.defineProperty(dangerousKey.entries[0].metadata, "constructor", {
    value: "blocked",
    enumerable: true,
  });
  assert.ok(
    lore
      .validateLorebookPack(dangerousKey)
      .some((problem) => /dangerous/i.test(problem)),
  );
  const unsafeUrl = structuredClone(pack);
  unsafeUrl.entries[0].provenance.sourceUrl = "javascript:alert(1)";
  assert.ok(
    lore
      .validateLorebookPack(unsafeUrl)
      .some((problem) => /HTTP|executable/i.test(problem)),
  );
  const tooLong = structuredClone(pack);
  tooLong.entries[0].body = "x".repeat(lore.MAX_LORE_BODY_CHARS + 1);
  assert.ok(
    lore
      .validateLorebookPack(tooLong)
      .some((problem) => /characters/i.test(problem)),
  );
  const brokenLink = structuredClone(pack);
  brokenLink.links[0].toId = "history:missing";
  assert.ok(
    lore
      .validateLorebookPack(brokenLink)
      .some((problem) => /unknown/i.test(problem)),
  );
  const cycle = structuredClone(pack);
  cycle.entries[0].parentId = "history:secret";
  assert.ok(
    lore.validateLorebookPack(cycle).some((problem) => /cycle/i.test(problem)),
  );
  const unsupportedMetadata = structuredClone(pack);
  unsupportedMetadata.entries[0].metadata.secret = "drop me";
  assert.ok(
    lore
      .validateLorebookPack(unsupportedMetadata)
      .some((problem) => /unsupported field/i.test(problem)),
  );
});

test("template and save serializers preserve map, pins, private visibility and v1/v2 manifests", () => {
  const noLoreGame = game();
  noLoreGame.items = [
    {
      id: "coastal-map",
      name: "Peta pantai",
      stackable: false,
      consumable: false,
      effects: [],
      tags: [],
    },
  ];
  noLoreGame.startingInventory = [
    {
      itemId: "coastal-map",
      quantity: 1,
      owner: "Player",
      place: "satchel",
    },
  ];
  const draft = template.parseTemplate(
    template.exportTemplate(noLoreGame),
  ).draft;
  assert.deepEqual(draft.worldMap, noLoreGame.worldMap);
  assert.equal(draft.startingLocationId, "loc:prontera");
  assert.deepEqual(draft.startingInventory, noLoreGame.startingInventory);
  const refs = [{ packId: "ragnarok-original", version: 1 }];
  assert.deepEqual(
    template.parseTemplate(
      template.exportTemplate(game({ lorebookRefs: refs })),
    ).draft.lorebookRefs,
    refs,
  );

  const initialState = engine.buildInitialState(noLoreGame);
  const baseSession = {
    id: "session-1",
    gameId: noLoreGame.id,
    definitionSnapshot: noLoreGame,
    state: initialState,
    ai: { provider: "gemini", model: "test-model" },
    nextSequence: 1,
    updatedAt: "2026-10-12T00:00:00.000Z",
    worldMap: noLoreGame.worldMap,
  };
  const messages = [
    {
      id: "message-1",
      sessionId: "session-1",
      turnId: "turn-1",
      sequence: 0,
      role: "PLAYER",
      content: "A private thought.",
      visibility: "private",
      knownBy: ["player"],
      createdAt: "2026-10-12T00:00:00.000Z",
    },
  ];
  const v1 = validation.createExportBundle(
    baseSession,
    messages,
    "2026-10-12T00:00:00.000Z",
  );
  assert.equal(v1.version, 1);
  const restoredV1 = validation.validateExportBundle(v1);
  assert.deepEqual(restoredV1.session.state.world, initialState.world);
  assert.deepEqual(restoredV1.session.worldMap, noLoreGame.worldMap);
  assert.deepEqual(restoredV1.session.state.inventory, initialState.inventory);
  assert.equal(restoredV1.messages[0].visibility, "private");
  assert.deepEqual(restoredV1.messages[0].knownBy, ["player"]);

  const loreGame = game({ lorebookRefs: refs });
  const loreSession = {
    ...baseSession,
    gameId: loreGame.id,
    definitionSnapshot: loreGame,
    state: engine.buildInitialState(loreGame),
    lorebookRefs: refs,
  };
  const v2 = validation.createExportBundle(
    loreSession,
    messages,
    "2026-10-12T00:00:00.000Z",
    [{ ...refs[0], digest: "a".repeat(64) }],
  );
  assert.equal(v2.version, 2);
  assert.deepEqual(
    validation.validateExportBundle(v2).loreDependencies,
    v2.loreDependencies,
  );
  assert.deepEqual(
    validation.validateExportBundle(v2).session.lorebookRefs,
    refs,
  );
  assert.throws(
    () =>
      validation.validateExportBundle({ ...v2, loreDependencies: undefined }),
    validation.ImportError,
  );
  const v1Bound = { ...v2, version: 1 };
  delete v1Bound.loreDependencies;
  assert.throws(
    () => validation.validateExportBundle(v1Bound),
    validation.ImportError,
  );
  assert.throws(
    () =>
      validation.validateExportBundle({
        ...v2,
        loreDependencies: [{ ...refs[0], digest: "not-a-digest" }],
      }),
    validation.ImportError,
  );
  assert.throws(
    () =>
      validation.validateExportBundle({
        ...v1,
        version: 2,
        loreDependencies: [],
      }),
    validation.ImportError,
  );
  assert.throws(
    () => validation.validateExportBundle({ ...v2, version: 1 }),
    validation.ImportError,
  );
  assert.throws(
    () => validation.validateExportBundle({ ...v1, loreDependencies: [] }),
    validation.ImportError,
  );
  assert.throws(
    () => validation.createExportBundle(loreSession, [], "now"),
    validation.ImportError,
  );
});

test("narrative choices allow zero or three and reject malformed or excessive lists", () => {
  const parse = (choices) =>
    engine.parseTurnResponse({ narrative: "The turn completes.", choices });
  assert.deepEqual(
    engine.parseTurnResponse({ narrative: "The turn completes." }).choices,
    [],
  );
  assert.deepEqual(parse([]).choices, []);
  assert.equal(
    parse([
      { id: "a", label: "First" },
      { id: "b", label: "Second" },
      { id: "c", label: "Third" },
    ]).choices.length,
    3,
  );
  assert.throws(() => parse([{}, {}, {}, {}]), engine.EngineError);
  assert.throws(
    () =>
      parse([
        { id: "same", label: "One" },
        { id: "same", label: "Two" },
      ]),
    engine.EngineError,
  );
  assert.throws(() => parse([null]), engine.EngineError);
  assert.throws(
    () => parse([{ label: "Missing identifier" }]),
    engine.EngineError,
  );
  assert.throws(
    () => parse([{ id: "a", label: "One", extra: true }]),
    engine.EngineError,
  );
});
