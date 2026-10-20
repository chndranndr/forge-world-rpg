import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let llm;

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  llm = await server.ssrLoadModule("/src/llm.ts");
});

test.after(async () => {
  await server.close();
});

test("gemini request uses generateContent with x-goog-api-key", async () => {
  const impl = fakeFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "halo" }] } }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
    }),
  );
  const result = await llm.complete(
    { provider: "gemini", model: "gemini-2.5-flash", apiKey: "g-key" },
    "tes",
    { fetchImpl: impl },
  );
  assert.equal(result.kind, "ok");
  assert.equal(result.text, "halo");
  assert.deepEqual(result.usage, {
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
  });
  const call = impl.calls[0];
  assert.equal(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(call.init.headers["x-goog-api-key"], "g-key");
  assert.equal(call.init.headers.Authorization, undefined);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "tes" }] }]);
});

test("openrouter request uses chat completions with bearer token", async () => {
  const impl = fakeFetch(() =>
    jsonResponse({
      choices: [{ message: { content: "halo juga" } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }),
  );
  const result = await llm.complete(
    { provider: "openrouter", model: "openai/gpt-5-mini", apiKey: "or-key" },
    "tes",
    { fetchImpl: impl },
  );
  assert.equal(result.kind, "ok");
  assert.equal(result.text, "halo juga");
  assert.deepEqual(result.usage, {
    promptTokens: 4,
    completionTokens: 3,
    totalTokens: 7,
  });
  const call = impl.calls[0];
  assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(call.init.headers.Authorization, "Bearer or-key");
  assert.equal(call.init.headers["x-goog-api-key"], undefined);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "openai/gpt-5-mini");
  assert.deepEqual(body.messages, [{ role: "user", content: "tes" }]);
});

test("gemini refusal and empty responses normalize", async () => {
  const refusal = await llm.complete(
    { provider: "gemini", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          promptFeedback: { blockReason: "SAFETY" },
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 0,
            totalTokenCount: 3,
          },
        }),
      ),
    },
  );
  assert.deepEqual(refusal, {
    kind: "refusal",
    reason: "SAFETY",
    usage: { promptTokens: 3, completionTokens: 0, totalTokens: 3 },
  });

  const empty = await llm.complete(
    { provider: "gemini", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          candidates: [{ content: {} }],
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 0,
            totalTokenCount: 4,
          },
        }),
      ),
    },
  );
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.usage, {
    promptTokens: 4,
    completionTokens: 0,
    totalTokens: 4,
  });

  const safetyFinish = await llm.complete(
    { provider: "gemini", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          candidates: [
            { finishReason: "SAFETY", content: { parts: [{ text: "x" }] } },
          ],
        }),
      ),
    },
  );
  assert.equal(safetyFinish.kind, "refusal");
});

test("openrouter error object and empty content normalize", async () => {
  const err = await llm.complete(
    { provider: "openrouter", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          error: { message: "no credit" },
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      ),
    },
  );
  assert.deepEqual(err, {
    kind: "error",
    message: "no credit",
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  });

  const empty = await llm.complete(
    { provider: "openrouter", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          choices: [{ message: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
        }),
      ),
    },
  );
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.usage, {
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
  });
});

test("usage survives malformed model text before turn validation", async () => {
  const result = await llm.complete(
    { provider: "openrouter", model: "m", apiKey: "k" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          choices: [{ message: { content: "not valid turn JSON" } }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
      ),
    },
  );
  assert.equal(result.kind, "ok");
  assert.equal(result.text, "not valid turn JSON");
  assert.deepEqual(result.usage, {
    promptTokens: 8,
    completionTokens: 4,
    totalTokens: 12,
  });
});

test("http failure reports status and provider detail", async () => {
  const result = await llm.complete(
    { provider: "gemini", model: "m", apiKey: "bad" },
    "x",
    {
      fetchImpl: fakeFetch(() =>
        jsonResponse(
          {
            error: { message: "API key not valid." },
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 0,
              totalTokenCount: 1,
            },
          },
          401,
        ),
      ),
    },
  );
  assert.deepEqual(result, {
    kind: "error",
    message: "HTTP 401: API key not valid.",
    usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
  });
});

test("invalid json body does not throw", async () => {
  const impl = fakeFetch(() => new Response("not json", { status: 200 }));
  const result = await llm.complete(
    { provider: "openrouter", model: "m", apiKey: "k" },
    "x",
    { fetchImpl: impl },
  );
  assert.deepEqual(result, {
    kind: "error",
    message: "Respons provider bukan JSON valid.",
  });
  assert.equal(result.usage, undefined);
});

test("timeout aborts a slow provider", async () => {
  const impl = fakeFetch(({ init }) => {
    return new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal.addEventListener("abort", () => reject(new Error("AbortError")), {
        once: true,
      });
    });
  });
  const result = await llm.complete(
    { provider: "gemini", model: "m", apiKey: "k" },
    "x",
    { fetchImpl: impl, timeoutMs: 20 },
  );
  assert.equal(result.kind, "error");
  assert.match(result.message, /batas 20 ms/);
  assert.equal(result.usage, undefined);
});

test("network failure reports error", async () => {
  const impl = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await llm.complete(
    { provider: "openrouter", model: "m", apiKey: "k" },
    "x",
    { fetchImpl: impl },
  );
  assert.equal(result.kind, "error");
  assert.match(result.message, /Jaringan gagal/);
  assert.equal(result.usage, undefined);
});

test("custom provider is rejected by the legacy browser transport before any fetch", async () => {
  const impl = fakeFetch(() => jsonResponse({}));
  const result = await llm.complete(
    { provider: "custom", model: "fixture-model", apiKey: "must-not-send" },
    "tes",
    { fetchImpl: impl },
  );
  assert.equal(result.kind, "error");
  assert.equal(
    result.message,
    "Provider custom hanya tersedia melalui backend.",
  );
  assert.equal(impl.calls.length, 0);
});
