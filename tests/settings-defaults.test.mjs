import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let vite;
let defaults;
let narratorPrompt;
const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  defaults = await vite.ssrLoadModule("/src/ai-defaults.ts");
  narratorPrompt = await vite.ssrLoadModule("/shared/narrator-prompt.ts");
});

test.after(async () => {
  await vite?.close();
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

function installLocalStorage(value) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("legacy global AI defaults retain models, add the custom slot, and stay manual", () => {
  const legacyDefaults = {
    provider: "openrouter",
    models: { gemini: "old-gemini-model", openrouter: "old-router-model" },
  };
  installLocalStorage({
    getItem: (key) =>
      key === "fworld-ai-defaults" ? JSON.stringify(legacyDefaults) : null,
    setItem: () => {},
  });

  const loaded = defaults.loadAiDefaults();
  assert.equal(loaded.provider, "openrouter");
  assert.equal(loaded.models.gemini, "old-gemini-model");
  assert.equal(loaded.models.openrouter, "old-router-model");
  assert.equal(loaded.models.custom, "");
  assert.equal(loaded.defaultProfileId, undefined);
  assert.equal(
    loaded.systemPrompt,
    narratorPrompt.DEFAULT_NARRATOR_SYSTEM_PROMPT,
  );
});

test("edited global narrator prompts and default profile persist in browser defaults", () => {
  const storage = memoryStorage();
  installLocalStorage(storage);
  const edited = {
    provider: "gemini",
    models: {
      gemini: "custom-gemini",
      openrouter: "custom-router",
      custom: "",
    },
    systemPrompt: "Edited complete narrator prompt.",
    defaultProfileId: "profile-abc",
  };

  defaults.storeAiDefaults(edited);
  assert.deepEqual(defaults.loadAiDefaults(), edited);
  assert.equal(storage.values.size, 1);
});

test("malformed default profile ids are ignored without resetting other preferences", () => {
  installLocalStorage(
    memoryStorageWith(
      JSON.stringify({
        provider: "gemini",
        models: { gemini: "kept-gemini", openrouter: "kept-router" },
        systemPrompt: "Kept prompt.",
        defaultProfileId: 42,
      }),
    ),
  );
  const loaded = defaults.loadAiDefaults();
  assert.equal(loaded.provider, "gemini");
  assert.equal(loaded.models.gemini, "kept-gemini");
  assert.equal(loaded.systemPrompt, "Kept prompt.");
  assert.equal(loaded.defaultProfileId, undefined);
});

function memoryStorageWith(raw) {
  return {
    getItem: (key) => (key === "fworld-ai-defaults" ? raw : null),
    setItem: () => {},
  };
}
