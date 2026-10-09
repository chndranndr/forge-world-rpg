import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "vite";

let vite;
let serverApi;
let databaseApi;

test.before(async () => {
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [serverApi, databaseApi] = await Promise.all([
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/server/db.ts"),
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

  const page = await fetch(
    `${base}/sessions/${sessionStart.session.value.id}/messages`,
    { headers: { Origin: "http://127.0.0.1:5173" } },
  );
  assert.deepEqual(await page.json(), {
    messages: [],
    nextBeforeSequence: null,
  });

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
