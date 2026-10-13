import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "vite";

let vite;
let serverApi;
let databaseApi;
let turnApi;
let loreApi;

test.before(async () => {
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [serverApi, databaseApi, turnApi, loreApi] = await Promise.all([
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
    vite.ssrLoadModule("/shared/lore.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

function game(id) {
  return {
    id,
    title: "Lantern Cafe",
    scenario: { setting: "Kamakura", startingSituation: "Rain at the harbor." },
    attributes: [{ id: "wit", name: "Wit", min: 0, max: 10, defaultValue: 4 }],
    resources: [{ id: "yen", name: "Yen", min: 0, initialValue: 100 }],
    relationships: [
      { id: "trust", name: "Trust", min: -10, max: 10, defaultValue: 0 },
    ],
    items: [],
    player: { name: "Ren", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("persists context overflow before any AI attempt or state commit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fworld-context-overflow-"));
  const database = new databaseApi.GameDatabase(join(directory, "data.sqlite"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const definition = game("context-overflow");
  definition.player.description = "x".repeat(25_000);
  const started = database.startSession({
    definition,
    ai: { provider: "gemini", model: "gemini-test" },
  });
  const session = started.session.value;
  const requestId = "context-overflow-opening";
  turnApi.startSessionRun(database, {
    sessionId: session.id,
    requestId,
    expectedRevision: started.session.revision,
    work: { kind: "opening" },
    providerKey: "",
  });

  let run = database.getRun(session.id, requestId);
  for (let attempt = 0; run?.status === "running" && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    run = database.getRun(session.id, requestId);
  }
  assert.equal(run?.status, "failed");
  assert.equal(run.error.code, "CONTEXT_TOO_LARGE");
  assert.match(
    run.error.message,
    /\d+ karakter.*batasnya 24000 karakter dan 6000 token/i,
  );
  assert.match(run.error.message, /ringkas konfigurasi game atau aksi pemain/i);

  const after = database.getSession(session.id);
  assert.equal(after.revision, started.session.revision);
  assert.equal(after.nextSequence, 0);
  assert.deepEqual(after.state, session.state);
  assert.equal(database.getHistory(session.id).length, 0);
  assert.equal(database.getUsageSummary(session.id, requestId).requests, 0);
});

test("local API enforces origin and JSON writes, returns revisions, and restores SQLite backups", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fworld-http-"));
  const databasePath = join(directory, "data.sqlite");
  const backupDirectory = join(directory, "backups");
  const envFilePath = join(directory, ".env");
  const credentialEnvironmentNames = [
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "FWORLD_GEMINI_API_KEY",
    "FWORLD_OPENROUTER_API_KEY",
  ];
  const previousCredentials = Object.fromEntries(
    credentialEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of credentialEnvironmentNames) delete process.env[name];
  writeFileSync(
    envFilePath,
    "GEMINI_API_KEY=\nOPENROUTER_API_KEY=\nFWORLD_GEMINI_API_KEY=\nFWORLD_OPENROUTER_API_KEY=\nFWORLD_DATA_DIR=./data\n",
  );
  const database = new databaseApi.GameDatabase(databasePath);
  const ref = { current: database, path: databasePath };
  const server = serverApi.createHttpServer(ref, {
    development: true,
    allowedHosts: ["*"],
    backupDirectory,
    envFilePath,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    ref.current.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api`;
  const json = (method, body, extra = {}) => ({
    method,
    headers: {
      Origin: "http://127.0.0.1:5173",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const pack = JSON.parse(
    readFileSync(
      new URL("../examples/lorebook-prontera.json", import.meta.url),
      "utf8",
    ),
  );
  const envelope = JSON.stringify({ lorebook: pack, dryRun: true });
  const envelopeBytes =
    Buffer.byteLength(JSON.stringify({ lorebook: null, dryRun: false })) -
    Buffer.byteLength("null");
  const requestLimit = loreApi.MAX_LOREBOOK_BYTES + envelopeBytes;
  const paddedBody = `${envelope}${" ".repeat(
    requestLimit - Buffer.byteLength(envelope),
  )}`;
  const imported = await fetch(`${base}/lorebooks/import`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:5173",
      "Content-Type": "application/json",
    },
    body: paddedBody,
  });
  assert.equal(
    imported.status,
    200,
    `wrapped max-size lorebook rejected: ${JSON.stringify(await imported.clone().json())}`,
  );
  const dryRun = await imported.json();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.entries, pack.entries.length);

  const settingsBefore = await fetch(`${base}/ai/settings`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.deepEqual(await settingsBefore.json(), {
    providers: {
      gemini: { configured: false },
      openrouter: { configured: false },
    },
  });

  const savedKey = "test-gemini-key-123";
  const credentialResponse = await fetch(
    `${base}/ai/credentials/gemini`,
    json("PUT", { apiKey: savedKey }),
  );
  assert.equal(credentialResponse.status, 200);
  assert.deepEqual(await credentialResponse.json(), { configured: true });
  assert.equal(process.env.FWORLD_GEMINI_API_KEY, savedKey);
  const envContents = readFileSync(envFilePath, "utf8");
  assert.match(envContents, /^FWORLD_GEMINI_API_KEY=test-gemini-key-123$/m);
  assert.match(envContents, /^OPENROUTER_API_KEY=$/m);
  assert.match(envContents, /^FWORLD_DATA_DIR=\.\/data$/m);
  assert.equal(
    (envContents.match(/^FWORLD_GEMINI_API_KEY=/gm) ?? []).length,
    1,
  );

  const replacementKey = "test-gemini-key-replacement-124";
  const replacementResponse = await fetch(
    `${base}/ai/credentials/gemini`,
    json("PUT", { apiKey: replacementKey }),
  );
  assert.equal(replacementResponse.status, 200);
  assert.deepEqual(await replacementResponse.json(), { configured: true });
  assert.equal(process.env.FWORLD_GEMINI_API_KEY, replacementKey);
  const replacedContents = readFileSync(envFilePath, "utf8");
  assert.match(
    replacedContents,
    /^FWORLD_GEMINI_API_KEY=test-gemini-key-replacement-124$/m,
  );
  assert.doesNotMatch(replacedContents, /test-gemini-key-123/);
  assert.equal(
    (replacedContents.match(/^FWORLD_GEMINI_API_KEY=/gm) ?? []).length,
    1,
  );

  const openRouterResponse = await fetch(
    `${base}/ai/credentials/openrouter`,
    json("PUT", { apiKey: "test-openrouter-key-456" }),
  );
  assert.equal(openRouterResponse.status, 200);
  assert.deepEqual(await openRouterResponse.json(), { configured: true });
  assert.equal(
    process.env.FWORLD_OPENROUTER_API_KEY,
    "test-openrouter-key-456",
  );

  const settingsAfter = await fetch(`${base}/ai/settings`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  assert.deepEqual(await settingsAfter.json(), {
    providers: {
      gemini: { configured: true },
      openrouter: { configured: true },
    },
  });

  const invalidKey = await fetch(
    `${base}/ai/credentials/gemini`,
    json("PUT", { apiKey: "invalid\nOPENROUTER_API_KEY=leak" }),
  );
  assert.equal(invalidKey.status, 400);
  assert.equal(process.env.FWORLD_GEMINI_API_KEY, replacementKey);

  const foreign = await fetch(`${base}/games`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ definition: game("blocked") }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(database.listGames().length, 0);

  const missingType = await fetch(`${base}/games`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ definition: game("blocked") }),
  });
  assert.equal(missingType.status, 415);

  const created = await fetch(
    `${base}/games`,
    json("POST", { definition: game("api-game") }),
  );
  assert.equal(
    created.status,
    201,
    `game create failed: ${JSON.stringify(await created.clone().json())}`,
  );
  const gameRecord = await created.json();
  assert.equal(gameRecord.value.id, "api-game");
  assert.equal(gameRecord.revision, 1);

  const started = await fetch(
    `${base}/sessions/start`,
    json("POST", {
      definition: game("api-game"),
      expectedGameRevision: gameRecord.revision,
      ai: { provider: "gemini", model: "gemini-test" },
    }),
  );
  assert.equal(started.status, 201);
  const sessionStart = await started.json();
  assert.equal(sessionStart.session.value.gameId, "api-game");
  assert.equal(sessionStart.session.revision, 1);

  const stale = await fetch(
    `${base}/games/api-game`,
    json("PUT", {
      definition: game("api-game"),
      expectedRevision: 1,
    }),
  );
  assert.equal(stale.status, 409);

  const transcriptSessionId = sessionStart.session.value.id;
  const transcriptSession = database.getSession(transcriptSessionId);
  const transcriptRequestId = "transcript-scope";
  const transcriptMessages = [
    {
      id: "transcript-public",
      sessionId: transcriptSessionId,
      turnId: transcriptRequestId,
      sequence: 0,
      role: "NARRATOR",
      content: "The old public passage.",
      visibility: "public",
      createdAt: "2026-10-12T00:00:00.000Z",
    },
    {
      id: "transcript-player",
      sessionId: transcriptSessionId,
      turnId: transcriptRequestId,
      sequence: 1,
      role: "NARRATOR",
      content: "The player knows this.",
      visibility: "private",
      knownBy: ["player"],
      createdAt: "2026-10-12T00:00:01.000Z",
    },
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `transcript-hidden-${index}`,
      sessionId: transcriptSessionId,
      turnId: transcriptRequestId,
      sequence: index + 2,
      role: "NARRATOR",
      content: `Private NPC passage ${index}.`,
      visibility: "private",
      knownBy: [],
      createdAt: "2026-10-12T00:00:02.000Z",
    })),
  ];
  database.startRun({
    sessionId: transcriptSessionId,
    requestId: transcriptRequestId,
    inputHash: "transcript-scope-hash",
    expectedRevision: transcriptSession.revision,
  });
  database.commitRun(transcriptSessionId, transcriptRequestId, {
    state: transcriptSession.state,
    messages: transcriptMessages,
    result: { committed: transcriptMessages.length },
  });
  const page = await fetch(
    `${base}/sessions/${transcriptSessionId}/messages?limit=1`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  const firstPage = await page.json();
  assert.deepEqual(
    firstPage.messages.map((message) => message.sequence),
    [1],
  );
  assert.equal(firstPage.nextBeforeSequence, 1);
  const previousPage = await fetch(
    `${base}/sessions/${transcriptSessionId}/messages?limit=1&beforeSequence=1`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  const secondPage = await previousPage.json();
  assert.deepEqual(
    secondPage.messages.map((message) => message.sequence),
    [0],
  );
  assert.equal(secondPage.nextBeforeSequence, null);

  const backupResponse = await fetch(`${base}/backups`, json("POST", {}));
  assert.equal(backupResponse.status, 201);
  const backup = await backupResponse.json();

  const secondGame = await fetch(
    `${base}/games`,
    json("POST", { definition: game("later-game") }),
  );
  assert.equal(
    secondGame.status,
    201,
    `second game create failed: ${JSON.stringify(await secondGame.clone().json())}`,
  );
  const restored = await fetch(
    `${base}/backups/${backup.id}/restore`,
    json("POST", {}),
  );
  assert.equal(restored.status, 204);
  assert.equal(ref.current.getGame("api-game").id, "api-game");
  assert.equal(ref.current.getGame("later-game"), undefined);
});
