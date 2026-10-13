import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/upgrade-legacy.json", import.meta.url),
    "utf8",
  ),
);
const providerKey = "upgrade-baseline-offline-key";
const choices = [
  { id: "ask-oren", label: "Ask Oren about the parcel" },
  { id: "inspect-tag", label: "Inspect the parcel tag" },
  { id: "follow-trail", label: "Follow the trail toward Reedbridge" },
];
const openingNarrative = "Mara notices a fresh blue mark on the parcel.";
const choicesNarrative = "The notice board offers three useful next steps.";
const turnNarrative = "Oren marks the route sketch with a blue thread.";
const factText = "Oren marked the route sketch with blue thread.";
const responses = [
  {
    narrative: openingNarrative,
    effects: [],
    world: {
      location: "Model-proposed display location",
      time: "18:45",
      scene: "Model-proposed display scene",
    },
    choices,
  },
  {
    narrative: choicesNarrative,
    effects: [],
    world: { location: "Choices must not move the session" },
    choices,
  },
  {
    narrative: turnNarrative,
    effects: [
      {
        type: "RESOURCE_CHANGE",
        target: "coin",
        operation: "ADD",
        value: 7,
      },
      { type: "ADD_FACT", text: factText },
    ],
    choices,
  },
];
const originalFetch = globalThis.fetch;
let providerCalls = 0;

let vite;
let databaseApi;
let turnApi;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  globalThis.fetch = async () => {
    const response = responses[providerCalls];
    if (!response) throw new Error("Unexpected provider request.");
    providerCalls += 1;
    return openRouterResponse(response, `offline-${providerCalls}`);
  };
  [databaseApi, turnApi] = await Promise.all([
    vite.ssrLoadModule("/server/db.ts"),
    vite.ssrLoadModule("/server/turn.ts"),
  ]);
});

test.after(async () => {
  await vite?.close();
  globalThis.fetch = originalFetch;
});

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
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function waitForRun(db, sessionId, requestId) {
  let run;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    run = db.getRun(sessionId, requestId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Run ${requestId} did not finish after 100 event-loop turns.`);
}

function visibleHistory(history) {
  return history.map(({ sequence, role, content }) => ({
    sequence,
    role,
    content,
  }));
}

test("backend run baselines preserve state and retries", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fworld-upgrade-baseline-"));
  const databasePath = join(directory, "data.sqlite");
  let database = new databaseApi.GameDatabase(databasePath);
  let databaseOpen = true;
  t.after(() => {
    if (databaseOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const sessionId = "upgrade-baseline-session";
  const started = database.startSessionForDefinition({
    definition: structuredClone(fixture.definition),
    ai: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    sessionId,
  });
  const originalSession = database.getSession(sessionId);
  assert.ok(originalSession);
  assert.equal(originalSession.revision, started.session.revision);
  assert.equal(originalSession.state.resources.coin, 30);
  assert.deepEqual(originalSession.state.facts, []);

  try {
    const openingInput = {
      sessionId,
      requestId: "upgrade-opening",
      expectedRevision: originalSession.revision,
      work: { kind: "opening" },
      providerKey,
    };
    const openingStart = turnApi.startSessionRun(database, openingInput);
    const openingRun = await waitForRun(
      database,
      sessionId,
      openingInput.requestId,
    );
    assert.equal(
      openingRun.status,
      "committed",
      JSON.stringify(openingRun.error),
    );
    assert.equal(openingStart.status, "running");
    assert.equal(providerCalls, 1);

    const afterOpening = database.getSession(sessionId);
    assert.equal(afterOpening.revision, originalSession.revision + 1);
    assert.equal(afterOpening.nextSequence, 1);
    assert.deepEqual(afterOpening.state, originalSession.state);
    assert.deepEqual(visibleHistory(database.getHistory(sessionId)), [
      { sequence: 0, role: "NARRATOR", content: openingNarrative },
    ]);

    const beforeChoices = database.getSession(sessionId);
    const historyBeforeChoices = database.getHistory(sessionId);
    const choicesInput = {
      sessionId,
      requestId: "upgrade-choices",
      expectedRevision: beforeChoices.revision,
      work: { kind: "choices" },
      providerKey,
    };
    const choicesStart = turnApi.startSessionRun(database, choicesInput);
    const choicesRun = await waitForRun(
      database,
      sessionId,
      choicesInput.requestId,
    );
    assert.equal(
      choicesRun.status,
      "committed",
      JSON.stringify(choicesRun.error),
    );
    assert.equal(choicesStart.status, "running");
    assert.equal(providerCalls, 2);
    assert.deepEqual(choicesRun.result, {
      choices,
      boundRevision: beforeChoices.revision,
    });
    assert.deepEqual(database.getSession(sessionId), beforeChoices);
    assert.deepEqual(database.getHistory(sessionId), historyBeforeChoices);

    const beforeTurn = database.getSession(sessionId);
    const turnInput = {
      sessionId,
      requestId: "upgrade-no-lore-turn",
      expectedRevision: beforeTurn.revision,
      work: { kind: "turn", input: fixture.actions[0] },
      providerKey,
    };
    const turnStart = turnApi.startSessionRun(database, turnInput);
    const turnRun = await waitForRun(database, sessionId, turnInput.requestId);
    assert.equal(turnRun.status, "committed", JSON.stringify(turnRun.error));
    assert.equal(turnStart.status, "running");
    assert.equal(providerCalls, 3);

    const afterTurn = database.getSession(sessionId);
    assert.equal(afterTurn.revision, beforeTurn.revision + 1);
    assert.equal(afterTurn.nextSequence, beforeTurn.nextSequence + 3);
    assert.deepEqual(afterTurn.state.resources, { coin: 37 });
    assert.deepEqual(
      afterTurn.state.facts.map(({ text }) => text),
      [factText],
    );
    assert.deepEqual(afterTurn.state.attributes, beforeTurn.state.attributes);
    assert.deepEqual(afterTurn.state.inventory, beforeTurn.state.inventory);
    assert.deepEqual(
      afterTurn.state.relationships,
      beforeTurn.state.relationships,
    );
    assert.deepEqual(afterTurn.state.world, beforeTurn.state.world);
    const historyAfterTurn = database.getHistory(sessionId);
    assert.deepEqual(visibleHistory(historyAfterTurn), [
      { sequence: 0, role: "NARRATOR", content: openingNarrative },
      { sequence: 1, role: "PLAYER", content: fixture.actions[0] },
      { sequence: 2, role: "NARRATOR", content: turnNarrative },
      {
        sequence: 3,
        role: "SYSTEM_EVENT",
        content:
          `Sumber daya Coin berubah dari 30 menjadi 37 | ` +
          `Fakta baru dicatat: "${factText}"`,
      },
    ]);

    await new Promise((resolve) => setImmediate(resolve));
    database.close();
    databaseOpen = false;
    database = new databaseApi.GameDatabase(databasePath);
    databaseOpen = true;

    const retriedRun = turnApi.startSessionRun(database, turnInput);
    assert.equal(retriedRun.status, "committed");
    assert.deepEqual(retriedRun.result, turnRun.result);
    assert.equal(providerCalls, 3);
    assert.deepEqual(database.getSession(sessionId), afterTurn);
    assert.deepEqual(database.getHistory(sessionId), historyAfterTurn);
    assert.deepEqual(database.getSession(sessionId).state.resources, {
      coin: 37,
    });
    assert.deepEqual(
      database.getSession(sessionId).state.facts.map(({ text }) => text),
      [factText],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
