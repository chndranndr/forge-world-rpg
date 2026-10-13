import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const providerKey = "upgrade-runtime-offline-key";
let vite;
let databaseApi;
let turnApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [databaseApi, turnApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

function definition(id) {
  return {
    id,
    title: "The Gate Letter",
    description: "A small route-finding story.",
    scenario: {
      setting: "Prontera and Morroc are connected by a direct road.",
      startingSituation: "A traveler waits at the Prontera gate.",
      worldRules: "Travel follows the validated road map.",
    },
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
        personality: ["watchful"],
        goals: ["keep the gate safe"],
        privateKnowledge: ["Aiko's private gate note."],
        initialRelationships: { trust: 1 },
      },
      {
        id: "bima",
        name: "Bima",
        personality: ["curious"],
        goals: ["learn the road"],
        privateKnowledge: ["Bima's private market note."],
        initialRelationships: { trust: 0 },
      },
    ],
    startingInventory: [],
    worldMap: {
      locations: [
        { id: "loc:prontera", name: "Prontera", aliases: [], npcIds: ["aiko"] },
        { id: "loc:morroc", name: "Morroc", aliases: [], npcIds: ["bima"] },
      ],
      connections: [{ fromId: "loc:prontera", toId: "loc:morroc" }],
      flags: {},
    },
    startingLocationId: "loc:prontera",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
}

function startSession(db, game, sessionId) {
  const existing = db.getGame(game.id);
  return db.startSessionForDefinition({
    definition: game,
    ...(existing ? { expectedGameRevision: existing.revision } : {}),
    ai: { provider: "openrouter", model: "openai/gpt-4o-mini" },
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
  let requestNumber = 0;
  globalThis.fetch = async (input, init) => {
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const body = JSON.parse(text);
    const prompt = promptFromRequest(body);
    beforeRequest(prompt, body, requestNumber);
    const content = responses[requestNumber];
    if (!content)
      throw new Error(`Unexpected provider request ${requestNumber + 1}.`);
    requestNumber += 1;
    return openRouterResponse(content, `runtime-${requestNumber}`);
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
  const started = turnApi.startSessionRun(db, {
    ...input,
    expectedRevision: session.revision,
    providerKey,
  });
  return {
    started,
    run: await waitForRun(db, input.sessionId, input.requestId),
  };
}

function withDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "fworld-upgrade-runtime-"));
  const db = new databaseApi.GameDatabase(join(directory, "runtime.sqlite"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test("runtime commits only validated travel and ignores narrator destinations", async (t) => {
  const db = withDb(t);
  const sessionId = "runtime-map-session";
  startSession(db, definition("runtime-map-game"), sessionId);
  const responses = [
    {
      narrative: "The gate opens for the traveler.",
      effects: [{ type: "ADD_FACT", text: "Ignored opening proposal." }],
      world: { location: "Model destination" },
    },
    {
      narrative: "No suggestion is needed yet.",
      effects: [],
      world: { location: "Model destination" },
      choices: [],
    },
    {
      narrative: "Aiko shares her private gate note as Ren heads to Morroc.",
      effects: [],
      world: { location: "Prontera", scene: "Market gate." },
    },
    {
      narrative: "No route reaches the Moon Archive.",
      effects: [],
      world: { location: "Prontera" },
    },
  ];
  let phase = "opening";
  stubProvider(t, responses, (prompt) => {
    assert.ok(prompt);
    const expectedLocation =
      phase === "unknown-move" ? "loc:morroc" : "loc:prontera";
    assert.equal(
      db.getSession(sessionId).state.world.locationId,
      expectedLocation,
    );
    if (phase === "travel") {
      assert.deepEqual(prompt.context.npcKnowledge.privateKnowledge, [
        "Aiko's private gate note.",
      ]);
      assert.deepEqual(prompt.context.state.world.activeCharacters, [
        "player",
        "aiko",
      ]);
      assert.deepEqual(prompt.context.state.world.movement, {
        kind: "allowed",
        fromId: "loc:prontera",
        toId: "loc:morroc",
      });
    }
  });

  const original = db.getSession(sessionId);
  const opening = await run(db, {
    sessionId,
    requestId: "runtime-opening",
    work: { kind: "opening" },
  });
  assert.equal(
    opening.run.status,
    "committed",
    JSON.stringify(opening.run.error),
  );
  assert.deepEqual(db.getSession(sessionId).state, original.state);
  assert.equal(db.getSession(sessionId).state.world.locationId, "loc:prontera");
  assert.deepEqual(db.getSession(sessionId).state.facts, []);

  phase = "choices";
  const beforeChoices = db.getSession(sessionId);
  const historyBeforeChoices = db.getHistory(sessionId);
  const choices = await run(db, {
    sessionId,
    requestId: "runtime-empty-choices",
    work: { kind: "choices" },
  });
  assert.equal(
    choices.run.status,
    "committed",
    JSON.stringify(choices.run.error),
  );
  assert.deepEqual(choices.run.result, {
    choices: [],
    boundRevision: beforeChoices.revision,
  });
  assert.deepEqual(db.getSession(sessionId), beforeChoices);
  assert.deepEqual(db.getHistory(sessionId), historyBeforeChoices);

  phase = "travel";
  const beforeTravel = db.getSession(sessionId);
  const travel = await run(db, {
    sessionId,
    requestId: "runtime-travel",
    work: {
      kind: "turn",
      input: "Ask Aiko about the gate, then travel to Morroc.",
    },
  });
  assert.equal(
    travel.run.status,
    "committed",
    JSON.stringify(travel.run.error),
  );
  const afterTravel = db.getSession(sessionId);
  assert.equal(afterTravel.state.world.locationId, "loc:morroc");
  assert.deepEqual(afterTravel.state.world.activeCharacters, [
    "player",
    "bima",
  ]);
  assert.equal(
    afterTravel.state.resources.coin,
    beforeTravel.state.resources.coin,
  );
  const travelMessages = travel.run.result.messages;
  assert.equal(travelMessages.length, 2);
  assert.deepEqual(
    travelMessages.map((message) => message.knownBy),
    [
      ["player", "aiko"],
      ["player", "aiko"],
    ],
  );
  assert.equal(
    db
      .searchMemory(sessionId, "private gate note", "aiko")
      .some((hit) => hit.kind === "message"),
    true,
  );
  assert.equal(
    db
      .searchMemory(sessionId, "private gate note", "bima")
      .some((hit) => hit.kind === "message"),
    false,
  );
  const telemetry = db.getContextTelemetry(sessionId, "runtime-travel");
  assert.ok(telemetry.contextChars <= 24_000);
  assert.ok(telemetry.sections.world.count > 0);
  assert.equal(Object.hasOwn(telemetry, "prompt"), false);
  assert.equal(Object.hasOwn(telemetry, "playerAction"), false);

  phase = "unknown-move";
  const beforeUnknownMove = db.getSession(sessionId);
  const unknownMove = await run(db, {
    sessionId,
    requestId: "runtime-unknown-move",
    work: { kind: "turn", input: "Travel to Moon Archive." },
  });
  assert.equal(unknownMove.run.status, "committed");
  const afterUnknownMove = db.getSession(sessionId);
  assert.equal(afterUnknownMove.state.world.locationId, "loc:morroc");
  assert.deepEqual(afterUnknownMove.state.world.activeCharacters, [
    "player",
    "bima",
  ]);
  assert.equal(
    afterUnknownMove.state.resources.coin,
    beforeUnknownMove.state.resources.coin,
  );
  assert.equal(unknownMove.run.result.messages.length, 2);
  assert.deepEqual(
    unknownMove.run.result.messages.map((message) => message.knownBy),
    [
      ["player", "bima"],
      ["player", "bima"],
    ],
  );
});

test("runtime loads exact pinned discovery entries and rejects unauthorized or remote discovery atomically", async (t) => {
  const db = withDb(t);
  const pack = {
    format: "fworld-lorebook",
    version: 1,
    pack: {
      id: "runtime-discoveries",
      version: 1,
      name: "Runtime discoveries",
    },
    entries: [
      {
        id: "secret:mural",
        kind: "other",
        name: "Gate mural",
        aliases: [],
        summary: "An old gate mural.",
        body: "A hidden route is painted beneath the mural.",
        tags: ["mural"],
        visibility: "discovery",
        metadata: {
          discoverAt: ["loc:prontera"],
          discoveryKeywords: ["mural"],
        },
        provenance: { sourceId: "runtime-test" },
      },
      {
        id: "secret:aiko-mural",
        kind: "other",
        name: "Aiko's private mural",
        aliases: [],
        summary: "A mural known only by Aiko.",
        body: "Aiko privately knows a route beneath the mural.",
        tags: ["mural"],
        visibility: "discovery",
        metadata: {
          actorId: "aiko",
          discoverAt: ["loc:prontera"],
          discoveryKeywords: ["mural"],
        },
        provenance: { sourceId: "runtime-test" },
      },
    ],
    links: [],
  };
  const published = db.importLorebook(pack);
  const ref = { packId: pack.pack.id, version: pack.pack.version };
  assert.equal(
    db
      .retrieveLore([ref], {
        locationId: "loc:prontera",
        query: "I inspect the mural at the gate.",
        narrator: true,
      })
      .some((entry) => entry.id === "secret:mural"),
    false,
  );
  const localCandidates = db.retrieveLoreForTurn([ref], {
    locationId: "loc:prontera",
    query: "mural",
    discoveredLoreIds: [],
    limit: 18,
  });
  const remoteCandidates = db.retrieveLoreForTurn([ref], {
    locationId: "loc:morroc",
    query: "mural",
    discoveredLoreIds: [],
    limit: 18,
  });
  assert.equal(
    localCandidates.some((entry) => entry.id === "secret:mural"),
    true,
  );
  assert.equal(
    remoteCandidates.some((entry) => entry.id === "secret:mural"),
    false,
  );
  const baseGame = definition("runtime-discovery-game");
  baseGame.lorebookRefs = [ref];
  baseGame.startingLocationId = "loc:prontera";
  const allowedSessionId = "runtime-discovery-allowed";
  startSession(db, baseGame, allowedSessionId);
  const deniedGame = {
    ...structuredClone(baseGame),
    id: "runtime-discovery-denied",
  };
  deniedGame.startingLocationId = "loc:morroc";
  const deniedLocationId = "runtime-discovery-wrong-location";
  startSession(db, deniedGame, deniedLocationId);

  const discoveryEffect = { type: "DISCOVER_LORE", loreId: "secret:mural" };
  const actorDiscoveryEffect = {
    type: "DISCOVER_LORE",
    loreId: "secret:aiko-mural",
  };
  const resourceEffect = {
    type: "RESOURCE_CHANGE",
    target: "coin",
    operation: "ADD",
    value: 5,
  };
  const invalidProposal = {
    narrative: "The narrator claims the hidden mural was found.",
    effects: [resourceEffect, discoveryEffect],
  };
  let actorCandidateVisible = false;
  stubProvider(
    t,
    [
      {
        narrative: "The player examines Aiko's private mural.",
        effects: [resourceEffect, actorDiscoveryEffect],
      },
      {
        narrative: "The player examines the mural and finds the hidden route.",
        effects: [resourceEffect, discoveryEffect],
      },
      invalidProposal,
      invalidProposal,
    ],
    (prompt, _body, requestNumber) => {
      if (requestNumber === 0) {
        actorCandidateVisible = prompt.context.lore.some(
          (entry) => entry.id === "secret:aiko-mural",
        );
        const candidate = prompt.context.lore.find(
          (entry) => entry.id === "secret:mural",
        );
        assert.equal(candidate?.discoveryCandidate, true);
      }
    },
  );

  const allowed = await run(db, {
    sessionId: allowedSessionId,
    requestId: "runtime-discovery-commit",
    work: { kind: "turn", input: "I inspect the mural at the gate." },
  });
  assert.equal(
    allowed.run.status,
    "committed",
    JSON.stringify(allowed.run.error),
  );
  assert.equal(
    actorCandidateVisible,
    false,
    "actor-scoped discovery candidate leaked into the prompt",
  );
  const discovered = db.getSession(allowedSessionId);
  assert.equal(discovered.state.resources.coin, 35);
  assert.deepEqual(discovered.state.world.discoveredLoreIds, ["secret:mural"]);
  assert.equal(
    db.getLoreEntry([ref], "secret:mural").provenance.sourceId,
    "runtime-test",
  );
  assert.equal(published.entries, 2);

  const beforeDenied = db.getSession(deniedLocationId);
  const denied = await run(db, {
    sessionId: deniedLocationId,
    requestId: "runtime-discovery-denied",
    work: { kind: "turn", input: "I inspect the mural at the gate." },
  });
  assert.equal(denied.run.status, "failed");
  assert.deepEqual(db.getSession(deniedLocationId), beforeDenied);
  assert.deepEqual(db.getHistory(deniedLocationId), []);
});
test("arrival effects validate against destination participants", async (t) => {
  const db = withDb(t);
  const sessionId = "runtime-arrival-effect-session";
  const game = definition("runtime-arrival-effect-game");
  startSession(db, game, sessionId);
  const initial = db.getSession(sessionId);
  const state = structuredClone(initial.state);
  state.facts.push({
    id: "arrival-secret",
    text: "Ren knows the sealed route.",
    visibility: "private",
    knownBy: ["player"],
    revealableTo: ["bima"],
    createdAt: "2026-10-12T00:00:00.000Z",
    source: "story",
  });
  db.updateSession(sessionId, { state }, initial.revision);
  const response = {
    narrative: "Ren tells Bima about the route after arriving in Morroc.",
    effects: [{ type: "REVEAL_FACT", factId: "arrival-secret", npcId: "bima" }],
  };
  stubProvider(t, [response, response]);

  const result = await run(db, {
    sessionId,
    requestId: "runtime-arrival-effect",
    work: {
      kind: "turn",
      input: "Travel to Morroc and tell Bima about the route.",
    },
  });
  assert.equal(
    result.run.status,
    "committed",
    JSON.stringify(result.run.error),
  );
  const committed = db.getSession(sessionId);
  assert.equal(committed.state.world.locationId, "loc:morroc");
  assert.deepEqual(
    committed.state.facts.find((fact) => fact.id === "arrival-secret").knownBy,
    ["player", "bima"],
  );
});
test("runtime repairs unknown lore IDs before committing discovery effects", async (t) => {
  const db = withDb(t);
  const pack = {
    format: "fworld-lorebook",
    version: 1,
    pack: { id: "runtime-invalid-discovery", version: 1, name: "Clues" },
    entries: [
      {
        id: "secret:mural",
        kind: "other",
        name: "Gate mural",
        aliases: [],
        summary: "A marked mural.",
        body: "The mural shows a hidden route.",
        tags: ["mural"],
        visibility: "discovery",
        metadata: {
          discoverAt: ["loc:prontera"],
          discoveryKeywords: ["mural"],
        },
        provenance: { sourceId: "runtime-test" },
      },
    ],
    links: [],
  };
  db.importLorebook(pack);
  const game = definition("runtime-invalid-discovery-game");
  game.lorebookRefs = [{ packId: pack.pack.id, version: pack.pack.version }];
  const sessionId = "runtime-invalid-discovery-session";
  startSession(db, game, sessionId);
  const responses = [
    {
      narrative: "The player claims to find an invented clue.",
      effects: [{ type: "DISCOVER_LORE", loreId: "secret:invented" }],
    },
    {
      narrative: "The player keeps searching for the clue.",
      effects: [],
    },
  ];
  let repairReason;
  stubProvider(t, responses, (prompt, _body, requestNumber) => {
    if (requestNumber === 1) repairReason = prompt.correction.reason;
  });

  const result = await run(db, {
    sessionId,
    requestId: "runtime-invalid-discovery",
    work: {
      kind: "turn",
      input: "I inspect the mural at the gate.",
    },
  });
  assert.equal(
    result.run.status,
    "committed",
    JSON.stringify(result.run.error),
  );
  assert.match(repairReason, /DISCOVER_LORE|discovery/i);
  assert.equal(
    db
      .getHistory(sessionId)
      .some(
        (message) =>
          message.role === "NARRATOR" &&
          message.content === "The player keeps searching for the clue.",
      ),
    true,
  );
  assert.deepEqual(db.getSession(sessionId).state.world.discoveredLoreIds, []);
});
