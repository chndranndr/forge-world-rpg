import type { ProviderId } from "../shared/types";

export type { ProviderId } from "../shared/types";

export interface LlmSettings {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: "gemini-2.5-flash",
  openrouter: "openai/gpt-5-mini",
  custom: "",
};

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

type LlmResultPayload =
  | { kind: "ok"; text: string }
  | { kind: "refusal"; reason: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type LlmResult = LlmResultPayload & { usage?: LlmUsage };

export interface CompleteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;

function requestFor(
  settings: LlmSettings,
  prompt: string,
): { url: string; init: RequestInit } {
  if (settings.provider === "gemini") {
    return {
      url: `${GEMINI_BASE}/${encodeURIComponent(settings.model)}:generateContent`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": settings.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      },
    };
  }
  return {
    url: OPENROUTER_URL,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
        "X-Title": "Fworld",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: prompt }],
      }),
    },
  };
}

function field(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === "object" && key in obj) {
    // 'in' menjamin key ada; nilai tetap dikonsumsi sebagai unknown.
    const record: Record<string, unknown> = obj as Record<string, unknown>;
    return record[key];
  }
  return undefined;
}

function textField(obj: unknown, key: string): string | undefined {
  const value = field(obj, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(obj: unknown, key: string): number | undefined {
  const value = field(obj, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function httpError(
  res: Response,
): Promise<{ message: string; body?: unknown }> {
  let message = `HTTP ${res.status}`;
  try {
    const body: unknown = JSON.parse(await res.text());
    const detail =
      textField(field(body, "error"), "message") ?? textField(body, "message");
    if (detail) message += `: ${detail}`;
    return { message, body };
  } catch {
    // Body bukan JSON; status saja cukup sebagai pesan error.
    return { message };
  }
}

function usageFrom(provider: ProviderId, body: unknown): LlmUsage | undefined {
  const source = field(body, provider === "gemini" ? "usageMetadata" : "usage");
  if (!source) return undefined;
  const usage: LlmUsage =
    provider === "gemini"
      ? {
          promptTokens: numberField(source, "promptTokenCount"),
          completionTokens: numberField(source, "candidatesTokenCount"),
          totalTokens: numberField(source, "totalTokenCount"),
        }
      : {
          promptTokens: numberField(source, "prompt_tokens"),
          completionTokens: numberField(source, "completion_tokens"),
          totalTokens: numberField(source, "total_tokens"),
        };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

const GEMINI_SAFETY_FINISH: Record<string, true> = {
  SAFETY: true,
  PROHIBITED_CONTENT: true,
  BLOCKLIST: true,
};

function parseGemini(body: unknown): LlmResultPayload {
  const blockReason = textField(field(body, "promptFeedback"), "blockReason");
  if (blockReason) return { kind: "refusal", reason: blockReason };

  const candidates = field(body, "candidates");
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  const finishReason = textField(candidate, "finishReason");
  if (finishReason && finishReason in GEMINI_SAFETY_FINISH) {
    return { kind: "refusal", reason: finishReason };
  }

  const parts = field(field(candidate, "content"), "parts");
  const text = Array.isArray(parts)
    ? parts.map((part) => textField(part, "text") ?? "").join("")
    : "";
  if (!text.trim()) return { kind: "empty" };
  return { kind: "ok", text };
}

function parseOpenRouter(body: unknown): LlmResultPayload {
  const detail = textField(field(body, "error"), "message");
  if (detail) return { kind: "error", message: detail };

  const choices = field(body, "choices");
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const text = textField(field(choice, "message"), "content");
  if (!text) return { kind: "empty" };
  return { kind: "ok", text };
}

export async function complete(
  settings: LlmSettings,
  prompt: string,
  options: CompleteOptions = {},
): Promise<LlmResult> {
  if (settings.provider === "custom") {
    return {
      kind: "error",
      message: "Provider custom hanya tersedia melalui backend.",
    };
  }
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const { url, init } = requestFor(settings, prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onUserAbort = () => controller.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });

  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const failure = await httpError(res);
      const usage = usageFrom(settings.provider, failure.body);
      return {
        kind: "error",
        message: failure.message,
        ...(usage ? { usage } : {}),
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "error", message: "Respons provider bukan JSON valid." };
    }
    const usage = usageFrom(settings.provider, body);
    const result =
      settings.provider === "gemini"
        ? parseGemini(body)
        : parseOpenRouter(body);
    return usage ? { ...result, usage } : result;
  } catch (err) {
    if (signal?.aborted)
      return { kind: "error", message: "Request dibatalkan." };
    if (controller.signal.aborted) {
      return {
        kind: "error",
        message: `Request melebihi batas ${timeoutMs} ms.`,
      };
    }
    const detail =
      err instanceof Error && err.message ? ` (${err.message})` : "";
    return {
      kind: "error",
      message: `Jaringan gagal atau provider tidak terjangkau${detail}.`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}
