import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createFixtureServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "vite";

let vite;
let serverApi;
let databaseApi;
let narratorPrompt;

test.before(async () => {
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  [serverApi, databaseApi, narratorPrompt] = await Promise.all([
    vite.ssrLoadModule("/server/main.ts"),
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/shared/narrator-prompt.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
});

const ORIGIN = "http://127.0.0.1:5173";

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

function narrative(text) {
  return JSON.stringify({ narrative: text, effects: [], choices: [] });
}

function completion(text) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "fixture-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

function toolCompletion(name, args) {
  return {
    id: "chatcmpl-tool",
    object: "chat.completion",
    created: 0,
    model: "fixture-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

function startFixture(script = () => completion(narrative("Fixture scene."))) {
  const requests = [];
  const server = createFixtureServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = undefined;
      }
      const record = {
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(record);
      const scripted = script(record, requests.length);
      const status = scripted.status ?? 200;
      const headers = {
        "content-type": "application/json",
        ...(scripted.headers ?? {}),
      };
      response.writeHead(status, headers);
      response.end(JSON.stringify(scripted.body ?? {}));
    });
  });
  server.listen(0, "127.0.0.1");
  return {
    server,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    origin: () => `http://127.0.0.1:${server.address().port}`,
  };
}

async function withBackend(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fworld-ai-profiles-"));
  const databasePath = join(directory, "data.sqlite");
  const envFilePath = options.envFilePath ?? join(directory, ".env");
  const credentialEnvironmentNames = [
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "FWORLD_GEMINI_API_KEY",
    "FWORLD_OPENROUTER_API_KEY",
  ];
  const previous = Object.fromEntries(
    credentialEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of credentialEnvironmentNames) delete process.env[name];
  if (options.globalGeminiKey) {
    process.env.FWORLD_GEMINI_API_KEY = options.globalGeminiKey;
  }
  const database = new databaseApi.GameDatabase(databasePath);
  const ref = { current: database, path: databasePath };
  const server = serverApi.createHttpServer(ref, {
    development: true,
    allowedHosts: ["*"],
    backupDirectory: join(directory, "backups"),
    envFilePath,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    ref.current.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("FWORLD_AI_KEY_")) delete process.env[name];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const json = (method, body) => ({
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const get = (path) =>
    fetch(`${base}${path}`, { headers: { Origin: ORIGIN } });

  const createProfile = async (input, expectedStatus = 201) => {
    const response = await fetch(`${base}/ai/profiles`, json("POST", input));
    const body = await response.json();
    assert.equal(
      response.status,
      expectedStatus,
      `profile create: ${JSON.stringify(body)}`,
    );
    return body;
  };
  const saveKey = async (profile, apiKey) => {
    const response = await fetch(
      `${base}/ai/profiles/${profile.id}/credential`,
      json("PUT", { expectedRevision: profile.revision, apiKey }),
    );
    const body = await response.json();
    assert.equal(
      response.status,
      200,
      `profile key save: ${JSON.stringify(body)}`,
    );
    return body.credentialConfigured;
  };
  const startSession = async (definition, profileId) => {
    const response = await fetch(
      `${base}/sessions/start`,
      json("POST", { definition, profileId }),
    );
    const body = await response.json();
    assert.equal(
      response.status,
      201,
      `session start: ${JSON.stringify(body)}`,
    );
    return body.session.value;
  };
  const sessionRevision = async (sessionId) => {
    const response = await get(`/sessions/${sessionId}`);
    assert.equal(response.status, 200);
    return (await response.json()).revision;
  };
  const runAction = async (sessionId, action, payload = {}) => {
    const revision = await sessionRevision(sessionId);
    const response = await fetch(
      `${base}/sessions/${sessionId}/${action}`,
      json("POST", {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        ...payload,
      }),
    );
    const body = await response.json();
    if (response.status !== 202) return { status: response.status, body };
    for (let attempt = 0; attempt < 400; attempt++) {
      const poll = await get(`/sessions/${sessionId}/runs/${body.requestId}`);
      assert.equal(poll.status, 200);
      const record = await poll.json();
      if (record.status !== "running") return { status: 202, run: record };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Run did not settle.");
  };

  return {
    directory,
    envFilePath,
    database,
    ref,
    base,
    json,
    get,
    createProfile,
    saveKey,
    startSession,
    sessionRevision,
    runAction,
  };
}

test("profile metadata and credentials are managed separately without provider calls", async (t) => {
  const fixture = startFixture();
  t.after(() => fixture.close());
  const backend = await withBackend(t);
  const { base, json, get, createProfile, saveKey } = backend;

  const created = await createProfile({
    name: "Router satu",
    provider: "openrouter",
    model: "vendor/model-x",
    systemPrompt: "Prompt profil satu.",
  });
  assert.equal(created.credentialConfigured, false);
  assert.equal(created.revision, 1);
  assert.ok(!("credentialId" in created));
  assert.ok(!("apiKey" in created));
  assert.equal(created.provider, "openrouter");

  const listed = await (await get("/ai/profiles")).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.ok(!JSON.stringify(listed).includes("credentialId"));
  assert.ok(!JSON.stringify(listed).includes("apiKey"));

  const invalidInputs = [
    {
      name: "Custom tanpa URL",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
    },
    {
      name: "Custom http jauh",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
      baseURL: "http://api.example.com/v1",
    },
    {
      name: "Custom tanpa prefix",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
      baseURL: "https://api.example.com",
    },
    {
      name: "Custom chat suffix",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
      baseURL: "https://api.example.com/v1/chat/completions",
    },
    {
      name: "Gemini berbase",
      provider: "gemini",
      model: "m",
      systemPrompt: "p",
      baseURL: "https://api.example.com/v1",
    },
    { name: "", provider: "gemini", model: "m", systemPrompt: "p" },
    { name: "Model kosong", provider: "gemini", model: " ", systemPrompt: "p" },
    {
      name: "Prompt kosong",
      provider: "gemini",
      model: "m",
      systemPrompt: "  ",
    },
    {
      name: "Field asing",
      provider: "gemini",
      model: "m",
      systemPrompt: "p",
      endpoint: "x",
    },
  ];
  for (const input of invalidInputs) {
    const response = await fetch(`${base}/ai/profiles`, json("POST", input));
    assert.equal(
      response.status,
      400,
      `expected 400 for ${JSON.stringify(input)}`,
    );
  }
  const controlChars = await fetch(
    `${base}/ai/profiles`,
    json("POST", {
      name: "Control",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
      baseURL: "https://api.example.com/v1\u0007",
    }),
  );
  assert.equal(controlChars.status, 400);
  const tooLong = await fetch(
    `${base}/ai/profiles`,
    json("POST", {
      name: "Long",
      provider: "custom",
      model: "m",
      systemPrompt: "p",
      baseURL: `https://api.example.com/${"a".repeat(2100)}`,
    }),
  );
  assert.equal(tooLong.status, 400);

  const keyOne = "key-one-abc";
  assert.equal(await saveKey(created, keyOne), true);
  const envContents = readFileSync(backend.envFilePath, "utf8");
  assert.match(envContents, /^FWORLD_AI_KEY_[0-9A-F]+=key-one-abc$/m);
  assert.ok(envContents.includes(keyOne));
  assert.ok(
    Object.keys(process.env).some((name) => name.startsWith("FWORLD_AI_KEY_")),
  );
  const afterKey = await (await get("/ai/profiles")).json();
  assert.equal(afterKey[0].credentialConfigured, true);
  assert.ok(!JSON.stringify(afterKey).includes(keyOne));

  const keyTwo = "key-two-def";
  assert.equal(await saveKey(created, keyTwo), true);
  const rotated = readFileSync(backend.envFilePath, "utf8");
  assert.ok(rotated.includes(keyTwo));
  assert.ok(!rotated.includes(keyOne));
  assert.equal(
    rotated.split("\n").filter((line) => line.includes("FWORLD_AI_KEY_"))
      .length,
    1,
  );

  const staleUpdate = await fetch(
    `${base}/ai/profiles/${created.id}`,
    json("PUT", {
      expectedRevision: created.revision + 5,
      name: "Router satu",
      provider: "openrouter",
      model: "vendor/model-y",
      systemPrompt: "Prompt profil satu.",
    }),
  );
  assert.equal(staleUpdate.status, 409);
  const unchanged = await (await get("/ai/profiles")).json();
  assert.equal(unchanged[0].model, "vendor/model-x");
  assert.equal(unchanged[0].revision, created.revision);

  const staleKey = await fetch(
    `${base}/ai/profiles/${created.id}/credential`,
    json("PUT", {
      expectedRevision: created.revision + 5,
      apiKey: "key-three",
    }),
  );
  assert.equal(staleKey.status, 409);
  assert.equal(
    readFileSync(backend.envFilePath, "utf8").includes("key-three"),
    false,
  );

  const metadataOnly = await fetch(
    `${base}/ai/profiles/${created.id}`,
    json("PUT", {
      expectedRevision: created.revision,
      name: "Router satu edit",
      provider: "openrouter",
      model: "vendor/model-y",
      systemPrompt: "Prompt profil satu.",
    }),
  );
  assert.equal(metadataOnly.status, 200);
  const edited = await metadataOnly.json();
  assert.equal(edited.revision, created.revision + 1);
  assert.equal(edited.credentialConfigured, true);
  assert.equal(edited.name, "Router satu edit");

  const keyRejected = await fetch(
    `${base}/ai/profiles/${created.id}`,
    json("PUT", {
      expectedRevision: edited.revision,
      name: "Router satu edit",
      provider: "openrouter",
      model: "vendor/model-y",
      systemPrompt: "Prompt profil satu.",
      apiKey: "must-not-save",
    }),
  );
  assert.equal(keyRejected.status, 400);

  assert.equal(await saveKey(edited, ""), false);
  const removedEnv = readFileSync(backend.envFilePath, "utf8");
  assert.ok(!removedEnv.includes(keyTwo));
  assert.ok(
    Object.keys(process.env).every(
      (name) => !name.startsWith("FWORLD_AI_KEY_"),
    ),
  );
  const removed = await (await get("/ai/profiles")).json();
  assert.equal(removed[0].credentialConfigured, false);

  assert.equal(fixture.requests.length, 0);
});

test("credential persistence failures keep status and environment unchanged", async (t) => {
  const backend = await withBackend(t, {
    envFilePath: join(
      mkdtempSync(join(tmpdir(), "fworld-env-dir-")),
      "as-directory",
    ),
  });
  const created = await backend.createProfile({
    name: "Broken env",
    provider: "gemini",
    model: "gemini-test",
    systemPrompt: "Prompt.",
  });
  const directoryPath = backend.envFilePath;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(directoryPath, { recursive: true });
  const response = await fetch(
    `${backend.base}/ai/profiles/${created.id}/credential`,
    backend.json("PUT", {
      expectedRevision: created.revision,
      apiKey: "never-saved",
    }),
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "CREDENTIAL_PERSISTENCE_FAILED");
  const listed = await (await backend.get("/ai/profiles")).json();
  assert.equal(listed[0].credentialConfigured, false);
  assert.ok(
    Object.keys(process.env).every(
      (name) => !name.startsWith("FWORLD_AI_KEY_"),
    ),
  );
});

test("custom profiles drive the OpenAI-compatible adapter with tools, repair, and auth isolation", async (t) => {
  const fixture = startFixture((_record, count) => {
    if (count === 1) {
      return { body: toolCompletion("search_memory", { query: "harbor" }) };
    }
    if (count === 2) {
      return { body: completion("not-json") };
    }
    return { body: completion(narrative("The harbor glows under the rain.")) };
  });
  t.after(() => fixture.close());
  const backend = await withBackend(t);
  const profile = await backend.createProfile({
    name: "Fixture custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt fixture.",
    baseURL: `${fixture.origin()}/v1`,
  });
  assert.equal(await backend.saveKey(profile, "fixture-key-123"), true);
  const session = await backend.startSession(
    game("custom-tools-game"),
    profile.id,
  );

  const turn = await backend.runAction(session.id, "turns", {
    input: "Aku mencari mercusuar.",
  });
  assert.equal(turn.status, 202, JSON.stringify(turn.body));
  assert.equal(turn.run.status, "succeeded", JSON.stringify(turn.run));
  assert.equal(
    turn.run.result.messages[1].content,
    "The harbor glows under the rain.",
  );

  assert.equal(fixture.requests.length, 3);
  for (const request of fixture.requests) {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-key-123");
    assert.equal(request.body.model, "fixture-model");
  }
  assert.ok(Array.isArray(fixture.requests[0].body.tools));
  assert.ok(
    fixture.requests[0].body.tools.some(
      (tool) => tool.function.name === "search_memory",
    ),
  );
  assert.ok(
    fixture.requests[1].body.messages.some(
      (message) => message.role === "tool",
    ),
  );

  const telemetry = backend.database.getContextTelemetry(
    session.id,
    turn.run.requestId,
  );
  assert.equal(telemetry.toolCalls, 1);
  assert.equal(telemetry.repairs, 1);

  const history = backend.database.getHistory(session.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].role, "NARRATOR");
});

test("custom redirects, keyless profiles, and provider errors stay isolated from state", async (t) => {
  const redirectTarget = startFixture();
  t.after(() => redirectTarget.close());
  const authFixture = startFixture((record, count) => {
    if (count === 1) {
      return {
        status: 307,
        headers: { location: `${redirectTarget.origin()}/v1/chat/completions` },
        body: {},
      };
    }
    if (record.headers.authorization === undefined && count === 2) {
      return { body: completion(narrative("Keyless narration arrives.")) };
    }
    if (count === 3) {
      return {
        status: 401,
        body: { error: { message: "denied", type: "invalid_request_error" } },
      };
    }
    return { body: completion(narrative("Unused.")) };
  });
  t.after(() => authFixture.close());
  const backend = await withBackend(t);

  const redirectProfile = await backend.createProfile({
    name: "Redirect custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt.",
    baseURL: `${authFixture.origin()}/v1`,
  });
  await backend.saveKey(redirectProfile, "redirect-key");
  const redirectSession = await backend.startSession(
    game("redirect-game"),
    redirectProfile.id,
  );
  const redirectTurn = await backend.runAction(redirectSession.id, "turns", {
    input: "Pergi.",
  });
  assert.equal(redirectTurn.status, 202);
  assert.equal(redirectTurn.run.status, "failed");
  assert.equal(redirectTarget.requests.length, 0);
  assert.equal(backend.database.getHistory(redirectSession.id).length, 0);

  const keylessProfile = await backend.createProfile({
    name: "Keyless custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt.",
    baseURL: `${authFixture.origin()}/v1`,
  });
  const keylessSession = await backend.startSession(
    game("keyless-game"),
    keylessProfile.id,
  );
  const keylessTurn = await backend.runAction(keylessSession.id, "turns", {
    input: "Tanpa key.",
  });
  assert.equal(keylessTurn.status, 202, JSON.stringify(keylessTurn.body));
  assert.equal(
    keylessTurn.run.status,
    "succeeded",
    JSON.stringify(keylessTurn.run),
  );
  const keylessRequest = authFixture.requests[1];
  assert.equal(keylessRequest.headers.authorization, undefined);

  const failingProfile = await backend.createProfile({
    name: "Failing custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt.",
    baseURL: `${authFixture.origin()}/v1`,
  });
  await backend.saveKey(failingProfile, "failing-key");
  const failingSession = await backend.startSession(
    game("failing-game"),
    failingProfile.id,
  );
  const failingTurn = await backend.runAction(failingSession.id, "turns", {
    input: "Gagal.",
  });
  assert.equal(failingTurn.status, 202);
  assert.equal(failingTurn.run.status, "failed");
  const after = backend.database.getSession(failingSession.id);
  assert.equal(after.nextSequence, 0);
  assert.equal(backend.database.getHistory(failingSession.id).length, 0);
  assert.equal(
    backend.database.getUsageSummary(
      failingSession.id,
      failingTurn.run.requestId,
    ).requests,
    1,
  );
});

test("gemini profiles without keys never fall back to global credentials", async (t) => {
  const backend = await withBackend(t, {
    globalGeminiKey: "global-key-present",
  });
  const profile = await backend.createProfile({
    name: "Gemini keyless",
    provider: "gemini",
    model: "gemini-test",
    systemPrompt: narratorPrompt.DEFAULT_NARRATOR_SYSTEM_PROMPT,
  });
  const session = await backend.startSession(
    game("gemini-keyless-game"),
    profile.id,
  );
  const opening = await backend.runAction(session.id, "opening");
  assert.equal(opening.status, 503);
  assert.equal(opening.body.code, "PROVIDER_NOT_CONFIGURED");

  const test = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", { profileId: profile.id }),
  );
  assert.equal(test.status, 503);
  assert.equal((await test.json()).code, "PROVIDER_NOT_CONFIGURED");
});

test("endpoint identity isolates sessions, rotation applies to bound runs, and reapply refreshes snapshot", async (t) => {
  const fixtureA = startFixture(() => ({
    body: completion(narrative("Endpoint A narration.")),
  }));
  t.after(() => fixtureA.close());
  const fixtureB = startFixture(() => ({
    body: completion(narrative("Endpoint B narration.")),
  }));
  t.after(() => fixtureB.close());
  const backend = await withBackend(t);

  const profile = await backend.createProfile({
    name: "Endpoint A profile",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt awal.",
    baseURL: `${fixtureA.origin()}/v1`,
  });
  await backend.saveKey(profile, "key-a");
  const sessionA = await backend.startSession(
    game("endpoint-game"),
    profile.id,
  );
  const turnA1 = await backend.runAction(sessionA.id, "turns", {
    input: "A satu.",
  });
  assert.equal(turnA1.run.status, "succeeded", JSON.stringify(turnA1.run));
  assert.equal(fixtureA.requests[0].headers.authorization, "Bearer key-a");

  const moved = await fetch(
    `${backend.base}/ai/profiles/${profile.id}`,
    backend.json("PUT", {
      expectedRevision: profile.revision,
      name: "Endpoint A profile",
      provider: "custom",
      model: "fixture-model",
      systemPrompt: "Prompt awal.",
      baseURL: `${fixtureB.origin()}/v1`,
    }),
  );
  assert.equal(moved.status, 200);
  const movedProfile = await moved.json();
  assert.equal(movedProfile.credentialConfigured, false);
  assert.equal(await backend.saveKey(movedProfile, "key-b"), true);

  const sessionB = await backend.startSession(
    game("endpoint-game-b"),
    movedProfile.id,
  );
  const turnB1 = await backend.runAction(sessionB.id, "turns", {
    input: "B satu.",
  });
  assert.equal(turnB1.run.status, "succeeded", JSON.stringify(turnB1.run));
  assert.equal(fixtureB.requests[0].headers.authorization, "Bearer key-b");

  const aBeforeTurn = fixtureA.requests.length;
  const turnA2 = await backend.runAction(sessionA.id, "turns", {
    input: "A dua.",
  });
  assert.equal(turnA2.run.status, "succeeded", JSON.stringify(turnA2.run));
  assert.equal(fixtureA.requests.length, aBeforeTurn + 1);
  assert.equal(
    fixtureA.requests[aBeforeTurn].headers.authorization,
    "Bearer key-a",
  );
  assert.equal(fixtureB.requests.length, 1);

  const secondProfile = await backend.createProfile({
    name: "Endpoint B other",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Prompt lain.",
    baseURL: `${fixtureB.origin()}/v1`,
  });
  await backend.saveKey(secondProfile, "key-d");
  const sessionD = await backend.startSession(
    game("endpoint-game-d"),
    secondProfile.id,
  );

  assert.equal(await backend.saveKey(movedProfile, "key-c"), true);
  const turnB2 = await backend.runAction(sessionB.id, "turns", {
    input: "B dua.",
  });
  assert.equal(turnB2.run.status, "succeeded", JSON.stringify(turnB2.run));
  const bRequests = fixtureB.requests.length;
  assert.equal(
    fixtureB.requests[bRequests - 1].headers.authorization,
    "Bearer key-c",
  );

  const turnD = await backend.runAction(sessionD.id, "turns", {
    input: "D satu.",
  });
  assert.equal(turnD.run.status, "succeeded", JSON.stringify(turnD.run));
  const dRequest = fixtureB.requests[fixtureB.requests.length - 1];
  assert.equal(dRequest.headers.authorization, "Bearer key-d");

  const beforeApply = backend.database.getSession(sessionA.id);
  const historyBeforeApply = backend.database.getHistory(sessionA.id).length;
  const revision = await backend.sessionRevision(sessionA.id);
  const applied = await fetch(
    `${backend.base}/sessions/${sessionA.id}/ai-profile`,
    backend.json("PUT", { expectedRevision: revision, profileId: profile.id }),
  );
  assert.equal(applied.status, 200);
  const appliedBody = await applied.json();
  assert.equal(appliedBody.revision, revision + 1);
  assert.equal(appliedBody.value.ai.systemPrompt, "Prompt awal.");
  const afterApply = backend.database.getSession(sessionA.id);
  assert.equal(afterApply.nextSequence, beforeApply.nextSequence);
  assert.deepEqual(afterApply.state, beforeApply.state);
  assert.equal(
    backend.database.getHistory(sessionA.id).length,
    historyBeforeApply,
  );

  const turnA3 = await backend.runAction(sessionA.id, "turns", {
    input: "A tiga.",
  });
  assert.equal(turnA3.run.status, "succeeded", JSON.stringify(turnA3.run));
  const lastA = fixtureB.requests[fixtureB.requests.length - 1];
  assert.equal(lastA.headers.authorization, "Bearer key-c");

  const bindingInfo = await (
    await backend.get(`/sessions/${sessionA.id}/ai-profile`)
  ).json();
  assert.equal(bindingInfo.profileId, profile.id);
  assert.equal(bindingInfo.baseURL, `${fixtureB.origin()}/v1`);
  assert.equal(bindingInfo.credentialConfigured, true);
});

test("imported custom saves stay unbound until a local profile is applied", async (t) => {
  const fixture = startFixture(() => ({
    body: completion(narrative("Export narration.")),
  }));
  t.after(() => fixture.close());
  const backend = await withBackend(t);
  const profile = await backend.createProfile({
    name: "Export custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Export prompt.",
    baseURL: `${fixture.origin()}/v1`,
  });
  await backend.saveKey(profile, "export-key");
  const session = await backend.startSession(game("export-game"), profile.id);
  await backend.runAction(session.id, "turns", { input: "Ekspor." });

  const save = await (await backend.get(`/sessions/${session.id}/save`)).json();
  const saveText = JSON.stringify(save);
  assert.equal(save.session.ai.provider, "custom");
  assert.equal(save.session.ai.model, "fixture-model");
  assert.ok(!saveText.includes("export-key"));
  assert.ok(!saveText.includes("credentialId"));
  assert.ok(!saveText.includes("profileId"));
  assert.ok(!saveText.includes("baseURL"));

  const imported = await fetch(
    `${backend.base}/saves`,
    backend.json("POST", save),
  );
  assert.equal(imported.status, 201);
  const importedIds = await imported.json();
  const importedSession = backend.database.getSession(importedIds.sessionId);
  assert.equal(importedSession.ai.provider, "custom");
  assert.equal(
    backend.database.getSessionAiBinding(importedIds.sessionId),
    undefined,
  );

  const requestsBefore = fixture.requests.length;
  const importedTurn = await backend.runAction(importedIds.sessionId, "turns", {
    input: "Belum ada profil.",
  });
  assert.equal(importedTurn.status, 503);
  assert.equal(importedTurn.body.code, "AI_PROFILE_REQUIRED");
  assert.equal(fixture.requests.length, requestsBefore);
  assert.equal(backend.database.getHistory(importedIds.sessionId).length, 2);

  const revision = await backend.sessionRevision(importedIds.sessionId);
  const applied = await fetch(
    `${backend.base}/sessions/${importedIds.sessionId}/ai-profile`,
    backend.json("PUT", { expectedRevision: revision, profileId: profile.id }),
  );
  assert.equal(applied.status, 200);
  const boundTurn = await backend.runAction(importedIds.sessionId, "turns", {
    input: "Sekarang pakai profil.",
  });
  assert.equal(
    boundTurn.run.status,
    "succeeded",
    JSON.stringify(boundTurn.run),
  );
  assert.equal(
    fixture.requests[fixture.requests.length - 1].headers.authorization,
    "Bearer export-key",
  );
});

test("start, manual session AI, and connection test routes require explicit custom profiles", async (t) => {
  const fixture = startFixture(() => ({
    body: completion(narrative("Route narration.")),
  }));
  t.after(() => fixture.close());
  const backend = await withBackend(t);
  const profile = await backend.createProfile({
    name: "Route custom",
    provider: "custom",
    model: "fixture-model",
    systemPrompt: "Route prompt.",
    baseURL: `${fixture.origin()}/v1`,
  });
  await backend.saveKey(profile, "route-key");
  const session = await backend.startSession(game("route-game"), profile.id);

  const ambiguousStart = await fetch(
    `${backend.base}/sessions/start`,
    backend.json("POST", {
      definition: game("ambiguous-game"),
      ai: { provider: "gemini", model: "gemini-test" },
      profileId: profile.id,
    }),
  );
  assert.equal(ambiguousStart.status, 400);
  const missingStart = await fetch(
    `${backend.base}/sessions/start`,
    backend.json("POST", { definition: game("missing-source-game") }),
  );
  assert.equal(missingStart.status, 400);
  const legacyCustomStart = await fetch(
    `${backend.base}/sessions/start`,
    backend.json("POST", {
      definition: game("legacy-custom-game"),
      ai: { provider: "custom", model: "fixture-model" },
    }),
  );
  assert.equal(legacyCustomStart.status, 400);
  assert.equal((await legacyCustomStart.json()).code, "AI_PROFILE_REQUIRED");
  assert.equal(backend.database.getGame("legacy-custom-game"), undefined);

  const legacy = backend.database.startSessionForDefinition({
    definition: game("legacy-gemini-game"),
    ai: { provider: "gemini", model: "gemini-test" },
    sessionId: "legacy-gemini-session",
  });
  const legacyCustomEdit = await fetch(
    `${backend.base}/sessions/legacy-gemini-session/ai`,
    backend.json("PUT", {
      expectedRevision: legacy.session.revision,
      ai: { provider: "custom", model: "fixture-model" },
    }),
  );
  assert.equal(legacyCustomEdit.status, 400);
  assert.equal((await legacyCustomEdit.json()).code, "AI_PROFILE_REQUIRED");

  const revision = await backend.sessionRevision(session.id);
  const boundEdit = await fetch(
    `${backend.base}/sessions/${session.id}/ai`,
    backend.json("PUT", {
      expectedRevision: revision,
      ai: {
        provider: "custom",
        model: "fixture-model-v2",
        systemPrompt: "Route prompt v2.",
      },
    }),
  );
  assert.equal(
    boundEdit.status,
    200,
    JSON.stringify(await boundEdit.clone().json()),
  );
  const binding = backend.database.getSessionAiBinding(session.id);
  assert.equal(binding.profileId, profile.id);
  assert.equal(binding.baseURL, `${fixture.origin()}/v1`);
  const editedTurn = await backend.runAction(session.id, "turns", {
    input: "Model manual.",
  });
  assert.equal(
    editedTurn.run.status,
    "succeeded",
    JSON.stringify(editedTurn.run),
  );
  assert.equal(
    fixture.requests[fixture.requests.length - 1].body.model,
    "fixture-model-v2",
  );
  assert.equal(
    fixture.requests[fixture.requests.length - 1].headers.authorization,
    "Bearer route-key",
  );

  const bothTest = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", {
      profileId: profile.id,
      provider: "gemini",
      model: "gemini-test",
    }),
  );
  assert.equal(bothTest.status, 400);
  const emptyTest = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", {}),
  );
  assert.equal(emptyTest.status, 400);
  const bareCustomTest = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", { provider: "custom", model: "fixture-model" }),
  );
  assert.equal(bareCustomTest.status, 400);
  assert.equal((await bareCustomTest.json()).code, "AI_PROFILE_REQUIRED");
  const profileTest = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", { profileId: profile.id }),
  );
  assert.equal(
    profileTest.status,
    200,
    JSON.stringify(await profileTest.clone().json()),
  );
  const boundDraftTest = await fetch(
    `${backend.base}/ai/test`,
    backend.json("POST", {
      provider: "custom",
      model: "fixture-model",
      sessionId: session.id,
    }),
  );
  assert.equal(
    boundDraftTest.status,
    200,
    JSON.stringify(await boundDraftTest.clone().json()),
  );

  const missingProfile = await fetch(
    `${backend.base}/ai/profiles/missing`,
    backend.json("PUT", {
      expectedRevision: 1,
      name: "Nope",
      provider: "gemini",
      model: "gemini-test",
      systemPrompt: "Prompt.",
    }),
  );
  assert.equal(missingProfile.status, 404);
  const missingKeyProfile = await fetch(
    `${backend.base}/ai/profiles/missing/credential`,
    backend.json("PUT", { expectedRevision: 1, apiKey: "x" }),
  );
  assert.equal(missingKeyProfile.status, 404);
});

test("reasoning setting persists globally and validates input", async (t) => {
  const previousReasoning = process.env.FWORLD_AI_REASONING;
  delete process.env.FWORLD_AI_REASONING;
  const backend = await withBackend(t);
  t.after(() => {
    if (previousReasoning === undefined) delete process.env.FWORLD_AI_REASONING;
    else process.env.FWORLD_AI_REASONING = previousReasoning;
  });
  writeFileSync(
    backend.envFilePath,
    "GEMINI_API_KEY=keep-me\nFWORLD_GEMINI_SAFETY=off\n",
  );

  // Unset behaves as enabled, matching the runtime default.
  const initial = await backend.get("/ai/reasoning");
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { enabled: true });

  const profile = await backend.createProfile({
    name: "Reasoning profil",
    provider: "gemini",
    model: "gemini-3-flash",
    systemPrompt: "Prompt sesi tetap.",
  });
  const session = await backend.startSession(
    game("reasoning-game"),
    profile.id,
  );
  const before = await (await backend.get(`/sessions/${session.id}`)).json();

  const offResponse = await fetch(
    `${backend.base}/ai/reasoning`,
    backend.json("PUT", { enabled: false }),
  );
  assert.equal(offResponse.status, 200);
  assert.deepEqual(await offResponse.json(), { enabled: false });
  assert.equal(process.env.FWORLD_AI_REASONING, "off");
  const offEnv = readFileSync(backend.envFilePath, "utf8");
  assert.match(offEnv, /^FWORLD_AI_REASONING=off$/m);
  assert.ok(offEnv.includes("GEMINI_API_KEY=keep-me"));
  assert.ok(offEnv.includes("FWORLD_GEMINI_SAFETY=off"));

  const onResponse = await fetch(
    `${backend.base}/ai/reasoning`,
    backend.json("PUT", { enabled: true }),
  );
  assert.equal(onResponse.status, 200);
  assert.deepEqual(await onResponse.json(), { enabled: true });
  assert.equal(process.env.FWORLD_AI_REASONING, "on");
  const onEnv = readFileSync(backend.envFilePath, "utf8");
  assert.match(onEnv, /^FWORLD_AI_REASONING=on$/m);
  assert.equal(
    onEnv.split("\n").filter((line) => line.startsWith("FWORLD_AI_REASONING="))
      .length,
    1,
    "enabling rewrites the key instead of dropping it",
  );
  assert.ok(onEnv.includes("GEMINI_API_KEY=keep-me"));
  assert.ok(onEnv.includes("FWORLD_GEMINI_SAFETY=off"));

  const after = await (await backend.get(`/sessions/${session.id}`)).json();
  assert.deepEqual(after.value.ai, before.value.ai);
  assert.equal(after.revision, before.revision);

  const invalidPayloads = [
    {},
    { enabled: "off" },
    { enabled: 0 },
    { enabled: null },
    { enabled: false, extra: true },
    [],
  ];
  for (const payload of invalidPayloads) {
    const response = await fetch(
      `${backend.base}/ai/reasoning`,
      backend.json("PUT", payload),
    );
    assert.equal(
      response.status,
      400,
      `expected 400 for ${JSON.stringify(payload)}`,
    );
  }
  assert.equal(readFileSync(backend.envFilePath, "utf8"), onEnv);
});

test("reasoning setting creates a missing backend env file", async (t) => {
  const previousReasoning = process.env.FWORLD_AI_REASONING;
  delete process.env.FWORLD_AI_REASONING;
  const backend = await withBackend(t);
  t.after(() => {
    if (previousReasoning === undefined) delete process.env.FWORLD_AI_REASONING;
    else process.env.FWORLD_AI_REASONING = previousReasoning;
  });

  const response = await fetch(
    `${backend.base}/ai/reasoning`,
    backend.json("PUT", { enabled: false }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.equal(
    readFileSync(backend.envFilePath, "utf8"),
    "FWORLD_AI_REASONING=off",
  );
  assert.equal(process.env.FWORLD_AI_REASONING, "off");
});
