import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const FIXTURES = [
  {
    path: new URL("../tests/fixtures/upgrade-legacy.json", import.meta.url),
    locations: [
      "Hearthvale",
      "Reedbridge",
      "Lantern Market",
      "Glass Hill Observatory",
      "Saltwind Orchard",
    ],
  },
  {
    path: new URL("../tests/fixtures/upgrade-ragnarok.json", import.meta.url),
    locations: ["Prontera", "Morroc", "Morroc Market", "Pyramid", "Sograt"],
  },
];
const SESSION_FACTS = [
  "The player arrived before midday.",
  "A blue mark appeared on a parcel near the road.",
  "Someone promised to return a borrowed cup.",
];
const WARMUP_PASSES = 1;
const MEASURE_PASSES = 5;
const OFFLINE_PROVIDER_KEY = "offline-baseline-only";
const NPC_DETAIL_FIELDS = new Set([
  "name",
  "description",
  "personality",
  "background",
  "role",
  "goals",
  "privateKnowledge",
]);

function assertFixture(fixture, locations, validateDefinition) {
  assert.deepEqual(
    Object.keys(fixture).sort(),
    ["actions", "definition"],
    "fixture outer shape must stay {definition, actions}",
  );
  assert.deepEqual(validateDefinition(fixture.definition), []);
  assert.equal(fixture.definition.items.length, 20);
  assert.ok(fixture.definition.npcs.length >= 5);
  assert.ok(fixture.definition.npcs.length <= 10);
  assert.equal(fixture.actions.length, 20);
  assert.ok(
    fixture.actions.every(
      (action) => typeof action === "string" && action.trim(),
    ),
  );
  assert.equal(SESSION_FACTS.length, 3);
  const scenario = `${fixture.definition.scenario.setting}\n${fixture.definition.scenario.startingSituation}`;
  for (const location of locations) {
    assert.ok(
      scenario.includes(location),
      `${location} must be mentioned in the scenario`,
    );
  }
}

function makeSession(definition, startingLocation) {
  return {
    id: `baseline-session-${definition.id}`,
    gameId: definition.id,
    definitionSnapshot: definition,
    state: {
      attributes: { ...definition.player.attributes },
      resources: { ...definition.player.resources },
      inventory: definition.startingInventory.map((entry) => ({ ...entry })),
      relationships: definition.npcs.map((npc) => ({
        npcId: npc.id,
        values: { ...npc.initialRelationships },
      })),
      facts: SESSION_FACTS.map((text, index) => ({
        id: `baseline-fact-${index + 1}`,
        text,
        visibility: "public",
        knownBy: [],
        createdAt: "2026-10-12T00:00:00.000Z",
        source: "story",
      })),
      world: {
        location: startingLocation,
        time: "12:00",
        scene: definition.scenario.startingSituation,
        activeCharacters: ["player", ...definition.npcs.map((npc) => npc.id)],
      },
    },
    ai: { provider: "gemini", model: "offline-baseline" },
    nextSequence: 0,
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
}

function historyBefore(session, actions, actionIndex) {
  return actions.slice(0, actionIndex).flatMap((content, index) => {
    const turnId = `${session.id}-turn-${index}`;
    const createdAt = "2026-10-12T00:00:00.000Z";
    return [
      {
        id: `${turnId}-player`,
        sessionId: session.id,
        turnId,
        sequence: index * 2,
        role: "PLAYER",
        content,
        createdAt,
      },
      {
        id: `${turnId}-narrator`,
        sessionId: session.id,
        turnId,
        sequence: index * 2 + 1,
        role: "NARRATOR",
        content: "A local shares one useful detail.",
        createdAt,
      },
    ];
  });
}

function findNamedNpcArray(value, key = "") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (/active.?npcs?|nearby.?npcs?/i.test(key)) return value;
    for (const entry of value) {
      const found = findNamedNpcArray(entry);
      if (found) return found;
    }
    return null;
  }
  for (const [childKey, child] of Object.entries(value)) {
    const found = findNamedNpcArray(child, childKey);
    if (found) return found;
  }
  return null;
}

function activeNpcCount(prompt, definition, session) {
  let parsed;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    parsed = null;
  }
  const knownIds = new Set(definition.npcs.map((npc) => npc.id));
  const namedArray = findNamedNpcArray(parsed);
  if (namedArray) {
    const ids = namedArray
      .map((entry) =>
        typeof entry === "string" ? entry : (entry?.id ?? entry?.npcId),
      )
      .filter((id) => knownIds.has(id));
    return {
      count: new Set(ids).size,
      source: "generation_input_active_npc_list",
    };
  }

  const detailedIds = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const id = value.id ?? value.npcId;
    if (
      knownIds.has(id) &&
      Object.keys(value).some((key) => NPC_DETAIL_FIELDS.has(key))
    ) {
      detailedIds.add(id);
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  if (detailedIds.size) {
    return { count: detailedIds.size, source: "generation_input_npc_records" };
  }

  const mentionedIds = definition.npcs
    .map((npc) => npc.id)
    .filter((id) => prompt.includes(JSON.stringify(id)));
  if (mentionedIds.length) {
    return {
      count: new Set(mentionedIds).size,
      source: "generation_input_npc_id_presence",
    };
  }
  const activeIds = session.state.world.activeCharacters.filter((id) =>
    knownIds.has(id),
  );
  return {
    count: new Set(activeIds).size,
    source: "session_active_characters_fallback",
  };
}

function captureInput(options, definition, session) {
  const system = typeof options.system === "string" ? options.system : "";
  const prompt =
    typeof options.prompt === "string"
      ? options.prompt
      : JSON.stringify(options.messages ?? []);
  const totalChars = system.length + prompt.length;
  return {
    systemChars: system.length,
    promptChars: prompt.length,
    totalChars,
    approximateTokens: Math.ceil(totalChars / 4),
    activeNpcs: activeNpcCount(prompt, definition, session),
    sha256: createHash("sha256")
      .update(system)
      .update("\0")
      .update(prompt)
      .digest("hex"),
  };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function summarize(values, digits = 0) {
  const round = (value) => Number(value.toFixed(digits));
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
  };
}

async function loadFixture(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const server = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
const originalFetch = globalThis.fetch;

try {
  const [{ validateDefinition }, agent] = await Promise.all([
    server.ssrLoadModule("/shared/validation.ts"),
    server.ssrLoadModule("/server/agent.ts"),
  ]);
  globalThis.fetch = async () => {
    throw new Error("Network is disabled during upgrade-baseline measurement.");
  };

  const results = [];
  let fakeProviderCalls = 0;
  let measuredProviderCalls = 0;

  for (const fixtureSpec of FIXTURES) {
    const fixture = await loadFixture(fixtureSpec.path);
    assertFixture(fixture, fixtureSpec.locations, validateDefinition);
    const session = makeSession(fixture.definition, fixtureSpec.locations[0]);
    const fixtureSnapshot = JSON.stringify(fixture);
    const sessionSnapshot = JSON.stringify(session);
    const assemblySamples = [];
    const actionInputs = Array(fixture.actions.length);

    for (let pass = 0; pass <= MEASURE_PASSES; pass += 1) {
      for (
        let actionIndex = 0;
        actionIndex < fixture.actions.length;
        actionIndex += 1
      ) {
        const history = historyBefore(session, fixture.actions, actionIndex);
        const before = performance.now();
        let providerCallsForAction = 0;
        let assemblyMs;
        let capturedInput;
        const result = await agent.runNarrator(
          {
            session,
            history,
            kind: "turn",
            playerAction: fixture.actions[actionIndex],
            providerKey: OFFLINE_PROVIDER_KEY,
            searchMemory: async () => [],
            onAttemptStart: () => {},
            onAttemptFinish: () => {},
          },
          {
            generateText: async (options) => {
              providerCallsForAction += 1;
              fakeProviderCalls += 1;
              assemblyMs = performance.now() - before;
              capturedInput = captureInput(
                options,
                fixture.definition,
                session,
              );
              return {
                text: JSON.stringify({
                  narrative: "A nearby character answers carefully.",
                  effects: [],
                  choices: [
                    { id: "choice-1", label: "Ask one more question" },
                    { id: "choice-2", label: "Inspect the nearby clue" },
                    { id: "choice-3", label: "Continue along the route" },
                  ],
                }),
              };
            },
          },
        );

        assert.equal(
          providerCallsForAction,
          1,
          "the injected provider path must run once per action",
        );
        assert.equal(result.response.type, "narrative");
        assert.equal(
          JSON.stringify(session),
          sessionSnapshot,
          "narrator must not mutate the session",
        );
        assert.equal(
          JSON.stringify(fixture),
          fixtureSnapshot,
          "narrator must not mutate the fixture",
        );
        if (assemblyMs === undefined || !capturedInput) {
          throw new Error(
            "The injected provider did not capture generation input.",
          );
        }
        if (pass > 0) {
          assemblySamples.push(assemblyMs);
          measuredProviderCalls += 1;
        }
        if (pass === 1) {
          actionInputs[actionIndex] = {
            actionIndex: actionIndex + 1,
            historyMessages: actionIndex * 2,
            systemChars: capturedInput.systemChars,
            promptChars: capturedInput.promptChars,
            totalChars: capturedInput.totalChars,
            approximateTokens: capturedInput.approximateTokens,
            activeNpcCount: capturedInput.activeNpcs.count,
            activeNpcCountSource: capturedInput.activeNpcs.source,
            inputSha256: capturedInput.sha256,
          };
        }
      }
    }

    results.push({
      fixture: fixture.definition.id,
      validatedBy: "shared/validation.ts validateDefinition",
      counts: {
        locationsMentionedInScenario: fixtureSpec.locations.length,
        npcs: fixture.definition.npcs.length,
        items: fixture.definition.items.length,
        sessionFacts: SESSION_FACTS.length,
        fixedActions: fixture.actions.length,
      },
      promptChars: summarize(actionInputs.map((entry) => entry.promptChars)),
      generationInputChars: summarize(
        actionInputs.map((entry) => entry.totalChars),
      ),
      approximateTokens: {
        method:
          "ceil((systemChars + promptChars) / 4); character-based estimate, not a tokenizer",
        values: summarize(actionInputs.map((entry) => entry.approximateTokens)),
      },
      activeNpcCount: summarize(
        actionInputs.map((entry) => entry.activeNpcCount),
      ),
      fixed20ActionLocalAssemblyMs: {
        p50: Number(percentile(assemblySamples, 0.5).toFixed(3)),
        p95: Number(percentile(assemblySamples, 0.95).toFixed(3)),
        measuredCalls: assemblySamples.length,
        warmupPasses: WARMUP_PASSES,
      },
      actionInputs,
      offlineChecks: {
        injectedProviderReached: true,
        fakeProviderCalls:
          (WARMUP_PASSES + MEASURE_PASSES) * fixture.actions.length,
        realProviderRequests: 0,
        databaseOpened: false,
        fixtureAndSessionUnchanged: true,
        actualBilledUsage: "unverified; no real provider request was made",
      },
    });
  }

  assert.equal(
    fakeProviderCalls,
    (WARMUP_PASSES + MEASURE_PASSES) * 20 * FIXTURES.length,
  );
  assert.equal(measuredProviderCalls, MEASURE_PASSES * 20 * FIXTURES.length);
  process.stdout.write(
    `${JSON.stringify(
      {
        measurement:
          "local runNarrator input assembly with injected deterministic generateText",
        network: "disabled during measurement",
        tokenUsage: "approximate estimate only; actual billed usage unverified",
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
