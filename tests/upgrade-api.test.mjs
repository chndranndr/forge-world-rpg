import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "vite";

const lorebook = JSON.parse(
  readFileSync(
    new URL("../examples/lorebook-prontera.json", import.meta.url),
    "utf8",
  ),
);
const loreTemplate = JSON.parse(
  readFileSync(
    new URL("../examples/lorebook-game.json", import.meta.url),
    "utf8",
  ),
);

let vite;
let serverApi;
let databaseApi;
let engineApi;

test.before(async () => {
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [serverApi, databaseApi, engineApi] = await Promise.all([
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/shared/engine.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

async function openApi(t) {
  const directory = mkdtempSync(join(tmpdir(), "fworld-upgrade-api-"));
  const databasePath = join(directory, "data.sqlite");
  const database = new databaseApi.GameDatabase(databasePath);
  const ref = { current: database, path: databasePath };
  const server = serverApi.createHttpServer(ref, {
    development: true,
    allowedHosts: ["*"],
    backupDirectory: join(directory, "backups"),
    envFilePath: join(directory, ".env"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    ref.current.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api`;
  const json = (method, body) => ({
    method,
    headers: {
      Origin: "http://127.0.0.1:5173",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { base, database: ref.current, ref, json };
}

function loreGame(id) {
  const definition = structuredClone(loreTemplate.game);
  definition.id = id;
  definition.updatedAt = "2026-10-12T00:00:00.000Z";
  definition.items[0].effects = [
    {
      type: "ADD_FACT",
      text: "creator-only effect prose",
      visibility: "private",
      knownBy: [],
    },
    {
      type: "ATTRIBUTE_CHANGE",
      target: definition.attributes[0].id,
      operation: "ADD",
      value: 1,
    },
  ];
  return definition;
}

function plainGame(id) {
  return {
    id,
    title: "No-lore test",
    scenario: {
      setting: "A quiet town.",
      startingSituation: "A morning begins.",
    },
    attributes: [],
    resources: [],
    relationships: [],
    items: [],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
}

test("HTTP lore routes validate, paginate, preview, pin exact versions, and isolate player views", async (t) => {
  const { base, database, ref, json } = await openApi(t);
  const dryRunResponse = await fetch(
    `${base}/lorebooks/import`,
    json("POST", { lorebook, dryRun: true }),
  );
  assert.equal(dryRunResponse.status, 200);
  const dryRun = await dryRunResponse.json();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.entries, lorebook.entries.length);
  assert.deepEqual(database.listLorebooks(), { packs: [], total: 0 });

  const publishedResponse = await fetch(
    `${base}/lorebooks/import`,
    json("POST", { lorebook, dryRun: false }),
  );
  assert.equal(publishedResponse.status, 200);
  const published = await publishedResponse.json();
  assert.equal(published.pack.id, lorebook.pack.id);
  assert.equal(published.pack.version, lorebook.pack.version);
  assert.equal(published.dryRun, false);
  const nextVersion = structuredClone(lorebook);
  nextVersion.pack.version = lorebook.pack.version + 1;
  nextVersion.pack.name = `${lorebook.pack.name} v${nextVersion.pack.version}`;
  const nextVersionResponse = await fetch(
    `${base}/lorebooks/import`,
    json("POST", { lorebook: nextVersion }),
  );
  assert.equal(nextVersionResponse.status, 200);

  const packPageResponse = await fetch(`${base}/lorebooks?limit=1&offset=0`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(packPageResponse.status, 200);
  const packPage = await packPageResponse.json();
  assert.equal(packPage.total, 2);
  assert.equal(packPage.packs.length, 1);
  assert.equal(packPage.packs[0].id, lorebook.pack.id);
  const secondPackPage = await fetch(`${base}/lorebooks?limit=1&offset=1`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  const secondPage = await secondPackPage.json();
  assert.equal(secondPage.total, 2);
  assert.equal(secondPage.packs.length, 1);
  assert.notEqual(secondPage.packs[0].version, packPage.packs[0].version);

  const exact = `${base}/lorebooks/${encodeURIComponent(lorebook.pack.id)}/versions/${lorebook.pack.version}`;
  const entriesResponse = await fetch(
    `${exact}/entries?query=Prontera&limit=10&offset=0`,
    {
      headers: { Origin: "http://127.0.0.1:5173" },
    },
  );
  assert.equal(entriesResponse.status, 200);
  const entriesPage = await entriesResponse.json();
  assert.ok(entriesPage.entries.some((entry) => entry.id === "loc:prontera"));
  assert.ok(
    entriesPage.entries.every((entry) => entry.visibility === "public"),
  );
  assert.ok(
    entriesPage.entries.every((entry) => !Object.hasOwn(entry, "metadata")),
  );
  assert.ok(
    entriesPage.entries.every((entry) => typeof entry.body === "string"),
  );
  assert.ok(
    !entriesPage.entries.some(
      (entry) => entry.id === "secret:narrator-ledger-cue",
    ),
  );

  const publicLink = lorebook.links.find((link) => {
    const from = lorebook.entries.find((entry) => entry.id === link.fromId);
    const to = lorebook.entries.find((entry) => entry.id === link.toId);
    return from?.visibility === "public" && to?.visibility === "public";
  });
  assert.ok(publicLink);
  const linksResponse = await fetch(
    `${exact}/links?entryId=${encodeURIComponent(publicLink.fromId)}&limit=20&offset=0`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.equal(linksResponse.status, 200);
  const linksPage = await linksResponse.json();
  assert.ok(linksPage.links.length > 0);
  assert.ok(
    linksPage.links.every(
      (link) =>
        lorebook.entries.find((entry) => entry.id === link.fromId)
          ?.visibility === "public" &&
        lorebook.entries.find((entry) => entry.id === link.toId)?.visibility ===
          "public",
    ),
  );

  const exportedResponse = await fetch(`${exact}/export`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(exportedResponse.status, 200);
  const exportedPack = await exportedResponse.json();
  assert.equal(exportedPack.entries.length, lorebook.entries.length);
  assert.ok(
    exportedPack.entries.some(
      (entry) => entry.id === "secret:narrator-ledger-cue",
    ),
  );

  const malformedQuery = await fetch(`${base}/lorebooks?limit=1&limit=2`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(malformedQuery.status, 400);
  const unsupportedQuery = await fetch(`${base}/lorebooks?search=all`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(unsupportedQuery.status, 400);
  const invalidBody = await fetch(
    `${base}/lorebooks/import`,
    json("POST", { lorebook, unexpected: true }),
  );
  assert.equal(invalidBody.status, 400);

  const definition = loreGame("api-lore-game");
  definition.worldMap = {
    locations: [
      { id: "loc:prontera", name: "Prontera", aliases: [], npcIds: [] },
      {
        id: "test:gated-yard",
        name: "Gated yard",
        aliases: [],
        summary: "A destination behind a locked gate.",
        npcIds: [],
        requiredFlag: "yard-open",
      },
    ],
    connections: [{ fromId: "loc:prontera", toId: "test:gated-yard" }],
    flags: { "yard-open": false },
  };
  const previewResponse = await fetch(
    `${base}/lorebooks/preview`,
    json("POST", {
      definition,
      locationId: definition.startingLocationId,
      query: "ledger",
    }),
  );
  assert.equal(
    previewResponse.status,
    200,
    `preview failed: ${JSON.stringify(await previewResponse.clone().json())}`,
  );
  const preview = await previewResponse.json();
  assert.ok(preview.entries.length > 0);
  assert.ok(Array.isArray(preview.activeNpcIds));
  assert.ok(Array.isArray(preview.omitted));
  assert.ok(
    preview.entries.every((entry) => !Object.hasOwn(entry, "metadata")),
  );
  assert.ok(preview.entries.every((entry) => !Object.hasOwn(entry, "body")));

  const missingPreview = await fetch(
    `${base}/lorebooks/preview`,
    json("POST", {
      definition: {
        ...definition,
        lorebookRefs: [{ packId: "missing-pack", version: 17 }],
      },
    }),
  );
  assert.equal(missingPreview.status, 409);
  const missingBody = await missingPreview.json();
  assert.equal(missingBody.code, "LORE_DEPENDENCY_MISSING");
  assert.match(missingBody.message, /missing-pack|17/i);

  const oversizedBody = JSON.stringify({
    lorebook: "x".repeat(8 * 1024 * 1024 + 1),
    dryRun: false,
  });
  const oversized = await fetch(`${base}/lorebooks/import`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:5173",
      "Content-Type": "application/json",
    },
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "PAYLOAD_TOO_LARGE");
  const partySecret = "A brass marker appears at low tide.";
  definition.ageRating = "teen-13-plus";
  definition.relationshipParties = [
    {
      id: "harbor-circle",
      name: "Harbor Circle",
      type: "community",
      initialStance: "wary",
      secret: partySecret,
    },
  ];

  const startedResponse = await fetch(
    `${base}/sessions/start`,
    json("POST", {
      definition,
      ai: { provider: "gemini", model: "gemini-test" },
    }),
  );
  assert.equal(
    startedResponse.status,
    201,
    `session start failed: ${JSON.stringify(await startedResponse.clone().json())}`,
  );
  const started = await startedResponse.json();
  const sessionId = started.session.value.id;
  assert.deepEqual(started.session.value.lorebookRefs, definition.lorebookRefs);
  assert.equal(
    started.session.value.definitionSnapshot.ageRating,
    "teen-13-plus",
  );
  assert.deepEqual(
    started.session.value.definitionSnapshot.relationshipParties,
    [
      {
        id: "harbor-circle",
        name: "Harbor Circle",
        type: "community",
        initialStance: "wary",
      },
    ],
  );
  assert.equal(
    database.getSession(sessionId).definitionSnapshot.relationshipParties[0]
      .secret,
    partySecret,
  );
  assert.equal(Object.hasOwn(started.session.value, "worldMap"), false);
  assert.equal(
    Object.hasOwn(started.session.value.definitionSnapshot, "worldMap"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      started.session.value.definitionSnapshot,
      "startingLocationId",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(started.session.value.definitionSnapshot, "scenario"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      started.session.value.definitionSnapshot.npcs[0],
      "privateKnowledge",
    ),
    false,
  );
  assert.deepEqual(
    started.session.value.definitionSnapshot.items[0].effects.map(
      (effect) => effect.type,
    ),
    ["ATTRIBUTE_CHANGE"],
  );

  let rawSession = database.getSession(sessionId);
  const createdAt = "2026-10-12T00:00:00.000Z";
  const updatedState = {
    ...rawSession.state,
    facts: [
      {
        id: "fact-public",
        text: "Public fact",
        visibility: "public",
        knownBy: [],
        source: "story",
        createdAt,
      },
      {
        id: "fact-player",
        text: "Player-known fact",
        visibility: "private",
        knownBy: ["player"],
        revealableTo: [definition.npcs[0].id],
        source: "story",
        createdAt,
      },
      {
        id: "fact-npc",
        text: "NPC-only fact",
        visibility: "private",
        knownBy: [definition.npcs[0].id],
        source: "story",
        createdAt,
      },
      {
        id: "fact-hidden",
        text: "Unknown private fact",
        visibility: "private",
        knownBy: [],
        source: "story",
        createdAt,
      },
    ],
    world: {
      ...rawSession.state.world,
      discoveredLoreIds: ["secret:morroc-rest-mark"],
    },
  };
  database.updateSession(
    sessionId,
    { state: updatedState },
    rawSession.revision,
  );
  rawSession = database.getSession(sessionId);

  const sessionResponse = await fetch(`${base}/sessions/${sessionId}`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(sessionResponse.status, 200);
  const playerSession = await sessionResponse.json();
  assert.deepEqual(playerSession.value.lorebookRefs, definition.lorebookRefs);
  assert.equal(Object.hasOwn(playerSession.value, "worldMap"), false);
  assert.equal(
    Object.hasOwn(playerSession.value.definitionSnapshot, "worldMap"),
    false,
  );
  assert.equal(
    Object.hasOwn(playerSession.value.definitionSnapshot, "startingLocationId"),
    false,
  );
  assert.equal(
    Object.hasOwn(playerSession.value.definitionSnapshot, "scenario"),
    false,
  );
  assert.equal(
    Object.hasOwn(playerSession.value.state, "relationships"),
    false,
  );
  assert.equal(Object.hasOwn(playerSession.value.state.world, "flags"), false);
  assert.equal(
    Object.hasOwn(playerSession.value.state.world, "discoveredLoreIds"),
    false,
  );
  assert.equal(
    Object.hasOwn(playerSession.value.state.world, "npcPresence"),
    false,
  );
  assert.equal(
    Object.hasOwn(playerSession.value.state.world, "activeCharacters"),
    false,
  );
  assert.deepEqual(
    playerSession.value.state.facts.map((fact) => fact.id).sort(),
    ["fact-player", "fact-public"],
  );
  assert.ok(
    playerSession.value.state.facts.every(
      (fact) => !Object.hasOwn(fact, "knownBy"),
    ),
  );
  assert.ok(
    playerSession.value.definitionSnapshot.npcs.every(
      (npc) => !Object.hasOwn(npc, "privateKnowledge"),
    ),
  );

  const worldResponse = await fetch(`${base}/sessions/${sessionId}/world`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(worldResponse.status, 200);
  const world = await worldResponse.json();
  assert.equal(world.location.id, "loc:prontera");
  assert.equal(world.location.name, "Prontera");
  assert.ok(world.people.some((person) => person.id === "npc:prontera_guard"));
  assert.ok(
    world.people.every((person) => !Object.hasOwn(person, "privateKnowledge")),
  );
  assert.deepEqual(world.facts.map((fact) => fact.id).sort(), [
    "fact-player",
    "fact-public",
  ]);
  assert.ok(
    world.discoveries.some((entry) => entry.id === "secret:morroc-rest-mark"),
  );
  assert.ok(
    !world.discoveries.some(
      (entry) => entry.id === "secret:narrator-ledger-cue",
    ),
  );
  assert.ok(
    world.discoveries.every((entry) => !Object.hasOwn(entry, "metadata")),
  );
  assert.ok(world.discoveries.every((entry) => !Object.hasOwn(entry, "body")));
  assert.ok(
    !world.locations.some((location) => location.id === "test:gated-yard"),
  );
  assert.equal(Object.hasOwn(world, "flags"), false);
  assert.ok(!JSON.stringify(world).includes("yard-open"));
  assert.equal(JSON.stringify(world).includes(partySecret), false);

  const gateResult = engineApi.applyEffects(
    rawSession.definitionSnapshot,
    rawSession.state,
    [{ type: "SET_FLAG", target: "yard-open", value: true }],
    { worldMap: database.getWorldMap(rawSession) },
  );
  const gateRunId = "api-open-yard";
  database.startRun({
    sessionId,
    requestId: gateRunId,
    inputHash: "open-yard",
    expectedRevision: rawSession.revision,
  });
  database.commitRun(sessionId, gateRunId, {
    state: gateResult.state,
    messages: [
      {
        id: "yard-gate-opened",
        sessionId,
        turnId: gateRunId,
        sequence: rawSession.nextSequence,
        role: "NARRATOR",
        content: "The yard gate opens.",
        createdAt,
      },
    ],
    result: { effects: gateResult.applied },
  });
  rawSession = database.getSession(sessionId);
  const openedWorldResponse = await fetch(
    `${base}/sessions/${sessionId}/world`,
    {
      headers: { Origin: "http://127.0.0.1:5173" },
    },
  );
  assert.equal(openedWorldResponse.status, 200);
  const openedWorld = await openedWorldResponse.json();
  assert.ok(
    openedWorld.locations.some((location) => location.id === "test:gated-yard"),
  );
  assert.equal(Object.hasOwn(openedWorld, "flags"), false);
  assert.ok(!JSON.stringify(openedWorld).includes("yard-open"));
  const runId = "api-choice-privacy";
  database.startRun({
    sessionId,
    requestId: runId,
    inputHash: "choices-input",
    expectedRevision: rawSession.revision,
    kind: "choices",
  });
  database.completeReadOnlyRun(sessionId, runId, {
    session: { value: rawSession, revision: rawSession.revision },
    messages: [
      {
        id: "hidden-message",
        sessionId,
        turnId: "turn-private",
        sequence: 1,
        role: "NPC",
        content: "unshared",
        visibility: "private",
        knownBy: [],
        createdAt,
      },
      {
        id: "known-message",
        sessionId,
        turnId: "turn-private",
        sequence: 2,
        role: "NPC",
        content: "shared with player",
        visibility: "private",
        knownBy: ["player"],
        createdAt,
      },
    ],
    choices: [],
    boundRevision: rawSession.revision,
  });
  const runResponse = await fetch(
    `${base}/sessions/${sessionId}/runs/${runId}`,
    {
      headers: { Origin: "http://127.0.0.1:5173" },
    },
  );
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.result.choices, []);
  assert.equal(run.result.boundRevision, rawSession.revision);
  assert.deepEqual(
    run.result.messages.map((message) => message.id),
    ["known-message"],
  );
  assert.ok(
    run.result.messages.every((message) => !Object.hasOwn(message, "knownBy")),
  );
  assert.equal(Object.hasOwn(run.result.session.value, "worldMap"), false);

  const saveResponse = await fetch(`${base}/sessions/${sessionId}/save`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(saveResponse.status, 200);
  const v2Bundle = await saveResponse.json();
  assert.equal(v2Bundle.version, 2);
  assert.deepEqual(v2Bundle.game.lorebookRefs, definition.lorebookRefs);
  assert.ok(
    v2Bundle.session.worldMap.locations.some(
      (location) => location.id === "loc:prontera",
    ),
  );
  assert.equal(v2Bundle.loreDependencies.length, 1);

  const plainStartedResponse = await fetch(
    `${base}/sessions/start`,
    json("POST", {
      definition: plainGame("api-no-lore"),
      ai: { provider: "gemini", model: "gemini-test" },
    }),
  );
  assert.equal(plainStartedResponse.status, 201);
  const plainStarted = await plainStartedResponse.json();
  const v1Response = await fetch(
    `${base}/sessions/${plainStarted.session.value.id}/save`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.equal(v1Response.status, 200);
  const v1Bundle = await v1Response.json();
  assert.equal(v1Bundle.version, 1);
  assert.equal(Object.hasOwn(v1Bundle, "loreDependencies"), false);
  const importedV1Response = await fetch(
    `${base}/saves`,
    json("POST", v1Bundle),
  );
  assert.equal(
    importedV1Response.status,
    201,
    `v1 save import failed: ${JSON.stringify(await importedV1Response.clone().json())}`,
  );

  const backupResponse = await fetch(`${base}/backups`, json("POST", {}));
  assert.equal(backupResponse.status, 201);
  const backup = await backupResponse.json();
  database.createGame(plainGame("after-api-backup"));
  const restoreResponse = await fetch(
    `${base}/backups/${backup.id}/restore`,
    json("POST", {}),
  );
  assert.equal(restoreResponse.status, 204);
  assert.equal(ref.current.getGame("after-api-backup"), undefined);
  assert.equal(ref.current.exportSave(sessionId).version, 2);
  assert.ok(ref.current.getWorldMap(ref.current.getSession(sessionId)));

  const emptyDirectory = mkdtempSync(
    join(tmpdir(), "fworld-upgrade-api-empty-"),
  );
  const emptyPath = join(emptyDirectory, "empty.sqlite");
  const emptyDatabase = new databaseApi.GameDatabase(emptyPath);
  const emptyRef = { current: emptyDatabase, path: emptyPath };
  const emptyServer = serverApi.createHttpServer(emptyRef, {
    development: true,
    allowedHosts: ["*"],
    backupDirectory: join(emptyDirectory, "backups"),
  });
  await new Promise((resolve, reject) => {
    emptyServer.once("error", reject);
    emptyServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => emptyServer.close(resolve));
    emptyRef.current.close();
    rmSync(emptyDirectory, { recursive: true, force: true });
  });
  const emptyBase = `http://127.0.0.1:${emptyServer.address().port}/api`;
  const missingDependencyResponse = await fetch(
    `${emptyBase}/saves`,
    json("POST", v2Bundle),
  );
  assert.equal(missingDependencyResponse.status, 409);
  assert.equal(
    (await missingDependencyResponse.json()).code,
    "LORE_DEPENDENCY_MISSING",
  );
  assert.equal(emptyRef.current.listGames().length, 0);
});
test("session management routes start saved worlds, persist metadata, duplicate worlds, and summarize visible turns", async (t) => {
  const { base, database, json } = await openApi(t);
  database.importLorebook(lorebook);
  const profile = database.createAiProfile({
    name: "Saved start profile",
    provider: "gemini",
    model: "gemini-test",
    systemPrompt: "A test narrator.",
  });
  const definition = loreGame("session-management-game");
  const createResponse = await fetch(
    `${base}/games`,
    json("POST", { definition }),
  );
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const savedStartResponse = await fetch(
    `${base}/games/${definition.id}/sessions`,
    json("POST", {
      expectedGameRevision: created.revision,
      name: "  Coastal letter  ",
      profileId: profile.id,
    }),
  );
  assert.equal(savedStartResponse.status, 201);
  const started = await savedStartResponse.json();
  const sessionId = started.value.id;
  assert.equal(started.value.name, "Coastal letter");
  assert.equal(started.value.pinned, false);
  assert.equal(started.revision, 1);
  assert.deepEqual(
    started.value.definitionSnapshot.lorebookRefs,
    definition.lorebookRefs,
  );
  const draftStartResponse = await fetch(
    `${base}/sessions/start`,
    json("POST", {
      definition: plainGame("draft-name-game"),
      ai: { provider: "gemini", model: "gemini-test" },
      name: "  Draft named  ",
    }),
  );
  assert.equal(draftStartResponse.status, 201);
  assert.equal(
    (await draftStartResponse.json()).session.value.name,
    "Draft named",
  );

  const invalidStart = await fetch(
    `${base}/games/${definition.id}/sessions`,
    json("POST", {
      expectedGameRevision: created.revision,
      ai: { provider: "gemini", model: "gemini-test" },
      profileId: profile.id,
    }),
  );
  assert.equal(invalidStart.status, 400);
  assert.equal(database.listSessions(definition.id).length, 1);
  const customStart = await fetch(
    `${base}/games/${definition.id}/sessions`,
    json("POST", {
      expectedGameRevision: created.revision,
      ai: { provider: "custom", model: "custom-test" },
    }),
  );
  assert.equal(customStart.status, 400);
  assert.equal((await customStart.json()).code, "AI_PROFILE_REQUIRED");
  const staleStart = await fetch(
    `${base}/games/${definition.id}/sessions`,
    json("POST", {
      expectedGameRevision: created.revision + 1,
      ai: { provider: "gemini", model: "gemini-test" },
    }),
  );
  assert.equal(staleStart.status, 409);
  const missingProfile = await fetch(
    `${base}/games/${definition.id}/sessions`,
    json("POST", {
      expectedGameRevision: created.revision,
      profileId: "missing-profile",
    }),
  );
  assert.equal(missingProfile.status, 404);
  assert.equal(database.listSessions(definition.id).length, 1);
  assert.equal(database.getGame(definition.id).revision, created.revision);

  const initialSummary = await fetch(
    `${base}/games/${definition.id}/sessions`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.equal(initialSummary.status, 200);
  const [initialRecord] = await initialSummary.json();
  assert.equal(initialRecord.turnCount, 0);
  assert.equal(initialRecord.excerpt, null);
  const emptyMetadata = await fetch(
    `${base}/sessions/${sessionId}/metadata`,
    json("PUT", {}),
  );
  assert.equal(emptyMetadata.status, 400);
  const unknownMetadata = await fetch(
    `${base}/sessions/${sessionId}/metadata`,
    json("PUT", { title: "unsupported" }),
  );
  assert.equal(unknownMetadata.status, 400);
  for (const metadata of [{ name: 7 }, { pinned: "true" }]) {
    const invalidMetadata = await fetch(
      `${base}/sessions/${sessionId}/metadata`,
      json("PUT", metadata),
    );
    assert.equal(invalidMetadata.status, 400);
  }

  const beforeRun = database.getSession(sessionId);
  database.startRun({
    sessionId,
    requestId: "summary-run",
    inputHash: "summary-run",
    expectedRevision: beforeRun.revision,
  });
  const metadataResponse = await fetch(
    `${base}/sessions/${sessionId}/metadata`,
    json("PUT", { name: "  During run  ", pinned: true }),
  );
  assert.equal(metadataResponse.status, 200);
  const updatedMetadata = await metadataResponse.json();
  assert.equal(updatedMetadata.value.name, "During run");
  assert.equal(updatedMetadata.value.pinned, true);
  assert.equal(updatedMetadata.revision, beforeRun.revision);
  assert.equal(updatedMetadata.value.updatedAt, beforeRun.updatedAt);

  const createdAt = new Date().toISOString();
  const messages = [
    {
      id: "summary-player",
      sessionId,
      turnId: "player-action",
      sequence: 0,
      role: "PLAYER",
      content: "I read the note.",
      visibility: "public",
      createdAt,
    },
    {
      id: "summary-event",
      sessionId,
      turnId: "player-action",
      sequence: 1,
      role: "SYSTEM_EVENT",
      content: "The note is opened.",
      visibility: "public",
      createdAt,
    },
    {
      id: "summary-narrator",
      sessionId,
      turnId: "player-action",
      sequence: 2,
      role: "NARRATOR",
      content: "🍋".repeat(61),
      visibility: "public",
      createdAt,
    },
    {
      id: "summary-hidden-player",
      sessionId,
      turnId: "private-action",
      sequence: 3,
      role: "PLAYER",
      content: "not shared",
      visibility: "private",
      knownBy: [],
      createdAt,
    },
    {
      id: "summary-visible-player",
      sessionId,
      turnId: "visible-private-action",
      sequence: 4,
      role: "PLAYER",
      content: "shared with player",
      visibility: "private",
      knownBy: ["player"],
      createdAt,
    },
    {
      id: "summary-hidden-narrator",
      sessionId,
      turnId: "npc-secret",
      sequence: 5,
      role: "NARRATOR",
      content: "Private to Aiko.",
      visibility: "private",
      knownBy: [definition.npcs[0].id],
      createdAt,
    },
  ];
  database.commitRun(sessionId, "summary-run", {
    state: beforeRun.state,
    messages,
    result: { ok: true },
  });
  const getResponse = await fetch(`${base}/sessions/${sessionId}`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(getResponse.status, 200);
  const record = await getResponse.json();
  assert.equal(record.turnCount, 2);
  assert.equal(Buffer.byteLength(record.excerpt, "utf8"), 240);
  assert.equal(record.excerpt, "🍋".repeat(60));
  assert.equal(JSON.stringify(record).includes("Private to Aiko."), false);
  const listedSummary = await fetch(`${base}/games/${definition.id}/sessions`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  const [listedRecord] = await listedSummary.json();
  assert.equal(listedRecord.turnCount, 2);
  assert.equal(listedRecord.excerpt, "🍋".repeat(60));
  assert.equal(
    Object.hasOwn(database.getSession(sessionId), "turnCount"),
    false,
  );
  assert.equal(
    Object.hasOwn(database.exportSave(sessionId).session, "turnCount"),
    false,
  );

  const current = database.getSession(sessionId);
  database.startRun({
    sessionId,
    requestId: "opening-only",
    inputHash: "opening-only",
    expectedRevision: current.revision,
    kind: "opening",
  });
  database.commitRun(sessionId, "opening-only", {
    state: current.state,
    messages: [
      {
        id: "opening-message",
        sessionId,
        turnId: "opening-only",
        sequence: current.nextSequence,
        role: "NARRATOR",
        content: "A quiet opening.",
        visibility: "public",
        createdAt,
      },
    ],
    result: { ok: true },
  });
  const afterOpening = database.sessionSummary(sessionId);
  assert.equal(afterOpening.turnCount, 2);
  assert.equal(afterOpening.excerpt, "A quiet opening.");
  const choiceState = database.getSession(sessionId);
  database.startRun({
    sessionId,
    requestId: "choice-only",
    inputHash: "choice-only",
    expectedRevision: choiceState.revision,
    kind: "choices",
  });
  database.completeReadOnlyRun(sessionId, "choice-only", { choices: [] });
  database.startRun({
    sessionId,
    requestId: "failed-opening",
    inputHash: "failed-opening",
    expectedRevision: choiceState.revision,
    kind: "opening",
  });
  database.failRun(sessionId, "failed-opening", { code: "MODEL_ERROR" });
  assert.equal(database.sessionSummary(sessionId).turnCount, 2);
  const clearName = await fetch(
    `${base}/sessions/${sessionId}/metadata`,
    json("PUT", { name: null }),
  );
  assert.equal(clearName.status, 200);
  const clearedMetadata = await clearName.json();
  assert.equal(clearedMetadata.value.name, undefined);
  assert.equal(clearedMetadata.value.pinned, true);

  const duplicateResponse = await fetch(
    `${base}/games/${definition.id}/duplicate`,
    json("POST", { expectedRevision: created.revision }),
  );
  assert.equal(duplicateResponse.status, 201);
  const duplicate = await duplicateResponse.json();
  assert.notEqual(duplicate.value.id, definition.id);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.value.title, `${definition.title} — salinan`);
  assert.deepEqual(duplicate.value.lorebookRefs, created.value.lorebookRefs);
  for (const collection of [
    "attributes",
    "resources",
    "relationships",
    "items",
    "npcs",
  ]) {
    assert.deepEqual(
      duplicate.value[collection].map((entry) => entry.id),
      created.value[collection].map((entry) => entry.id),
    );
  }
  const duplicateSessions = await fetch(
    `${base}/games/${duplicate.value.id}/sessions`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.deepEqual(await duplicateSessions.json(), []);

  const staleTemplate = await fetch(
    `${base}/templates`,
    json("POST", {
      gameId: definition.id,
      expectedGameRevision: created.revision + 1,
    }),
  );
  assert.equal(staleTemplate.status, 409);
  const templatesAfterStaleSave = await fetch(`${base}/templates`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.deepEqual(await templatesAfterStaleSave.json(), []);
  const templateResponse = await fetch(
    `${base}/templates`,
    json("POST", {
      gameId: definition.id,
      expectedGameRevision: created.revision,
    }),
  );
  assert.equal(templateResponse.status, 201);
  const template = await templateResponse.json();
  const templateBundleResponse = await fetch(
    `${base}/templates/${template.id}`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.equal(templateBundleResponse.status, 200);
  const templateBundle = await templateBundleResponse.json();
  assert.deepEqual(templateBundle.game.lorebookRefs, definition.lorebookRefs);
  assert.equal(Object.hasOwn(templateBundle, "ai"), false);
  assert.equal(JSON.stringify(templateBundle).includes(profile.id), false);
  const templateListResponse = await fetch(`${base}/templates`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.deepEqual(await templateListResponse.json(), [template]);

  const staleDelete = await fetch(
    `${base}/sessions/${sessionId}`,
    json("DELETE", { expectedRevision: 1 }),
  );
  assert.equal(staleDelete.status, 409);
  const active = database.getSession(sessionId);
  database.startRun({
    sessionId,
    requestId: "delete-active",
    inputHash: "delete-active",
    expectedRevision: active.revision,
  });
  const runningDelete = await fetch(
    `${base}/sessions/${sessionId}`,
    json("DELETE", { expectedRevision: active.revision }),
  );
  assert.equal(runningDelete.status, 409);
  assert.equal((await runningDelete.json()).code, "RUN_IN_PROGRESS");
  database.failRun(sessionId, "delete-active", { code: "CANCELLED" });
  const deleteResponse = await fetch(
    `${base}/sessions/${sessionId}`,
    json("DELETE", { expectedRevision: active.revision }),
  );
  assert.equal(deleteResponse.status, 204);
  assert.equal(database.getSession(sessionId), undefined);
  assert.equal(database.getSessionAiBinding(sessionId), undefined);

  const deleteGameResponse = await fetch(
    `${base}/games/${definition.id}`,
    json("DELETE", { expectedRevision: created.revision }),
  );
  assert.equal(deleteGameResponse.status, 204);
  const survivingTemplate = await fetch(`${base}/templates/${template.id}`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal(survivingTemplate.status, 200);
  const health = await fetch(`${base}/health`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.equal((await health.json()).schemaVersion, 5);
});
