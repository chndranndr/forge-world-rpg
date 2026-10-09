import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let api;

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  api = await server.ssrLoadModule("/src/api.ts");
});

test.after(async () => {
  await server.close();
});

test("API calls use same-origin JSON and encode path identifiers", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(
      JSON.stringify({ definition: { id: "a/b" }, revision: 2 }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await api.getGame("a/b");
    assert.equal(result.revision, 2);
    assert.equal(request.input, "/api/games/a%2Fb");
    assert.equal(request.init.credentials, "same-origin");
    assert.equal(request.init.method, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saving an AI credential uses the provider-specific local API route", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ configured: true }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await api.saveAiCredential("gemini", "test-gemini-key-123");
    assert.deepEqual(result, { configured: true });
    assert.equal(request.input, "/api/ai/credentials/gemini");
    assert.equal(request.init.method, "PUT");
    assert.deepEqual(JSON.parse(request.init.body), {
      apiKey: "test-gemini-key-123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API errors retain conflict and retry metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "REVISION_CONFLICT",
        message: "Game changed.",
        retryable: true,
        requestId: "request-1",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(
      api.updateGame("game-1", 1, { id: "game-1" }),
      (error) =>
        error instanceof api.ApiError &&
        error.status === 409 &&
        error.code === "REVISION_CONFLICT" &&
        error.retryable &&
        error.requestId === "request-1",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API rejects non-JSON responses without exposing response bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("sensitive provider body", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });

  try {
    await assert.rejects(
      api.getHealth(),
      (error) =>
        error instanceof api.ApiError &&
        error.message === "Backend request failed." &&
        error.code === "INVALID_RESPONSE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
