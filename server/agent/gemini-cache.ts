import { createHmac, randomBytes } from "node:crypto";
import type { LorebookRef, ProviderId } from "../../shared/types.js";
import type { PreparedNarratorContext } from "./context.js";
import type { AgentTraceInput } from "./runtime.js";

const CACHE_ORIGIN = "https://generativelanguage.googleapis.com";
const CACHE_URL = `${CACHE_ORIGIN}/v1beta/cachedContents`;
const CACHE_TTL_MS = 300_000;
const CACHE_TTL = "300s";
const EXPIRY_SAFETY_MS = 5_000;
const MAX_RECORDS = 32;
const CACHE_NAME = /^cachedContents\/[A-Za-z0-9_-]+$/;
const ELIGIBLE_MODEL = /^gemini-(?:2\.5|3)(?:[.-][A-Za-z0-9][A-Za-z0-9.-]*)?$/i;

export const CONTEXT_CACHE_MESSAGE =
  "Cache konteks Gemini tidak tersedia. Periksa konfigurasi provider atau nonaktifkan cache eksplisit.";

export class ContextCacheError extends Error {
  constructor() {
    super(CONTEXT_CACHE_MESSAGE);
    this.name = "ContextCacheError";
  }
}

export type ContextCacheMode = "off" | "explicit";

export interface GeminiContextCacheOptions {
  mode: ContextCacheMode;
  fetch?: typeof fetch;
  now?: () => number;
}

type CacheRecord =
  | {
      state: "pending";
      fingerprint: string;
      expiresAt: number;
    }
  | {
      state: "negative";
      fingerprint: string;
      expiresAt: number;
    }
  | {
      state: "resource";
      fingerprint: string;
      expiresAt: number;
      name: string;
      tokenCount: number | null;
      usable: boolean;
    };

export interface ContextCacheFetchOptions {
  provider: ProviderId;
  databaseScope: object;
  sessionId: string;
  audience: { kind: "player" } | { kind: "npc"; npcId: string };
  lorebookRefs: LorebookRef[];
  model: string;
  apiKey: string;
  context: PreparedNarratorContext;
  signal: AbortSignal;
  onTrace?: (event: AgentTraceInput) => void;
}

function eligibleModel(value: string): string | undefined {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("models/")
    ? trimmed.slice("models/".length)
    : trimmed;
  if (!normalized || normalized.includes("/") || normalized.includes("..")) {
    return undefined;
  }
  return ELIGIBLE_MODEL.test(normalized) ? normalized : undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export class GeminiContextCache {
  readonly #mode: ContextCacheMode;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #secret = randomBytes(32);
  readonly #records = new Map<string, CacheRecord>();
  readonly #scopeIds = new WeakMap<object, number>();
  #nextScopeId = 1;

  constructor(options: GeminiContextCacheOptions) {
    this.#mode = options.mode;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  get mode(): ContextCacheMode {
    return this.#mode;
  }

  #scopeKey(scope: object): number {
    const existing = this.#scopeIds.get(scope);
    if (existing !== undefined) return existing;
    const id = this.#nextScopeId;
    this.#nextScopeId += 1;
    this.#scopeIds.set(scope, id);
    return id;
  }

  #prune(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(key);
    }
  }

  fetchFor(options: ContextCacheFetchOptions): typeof fetch | undefined {
    const trace = options.onTrace ?? (() => {});
    const bypass = (
      reason:
        | "disabled"
        | "unsupported_provider"
        | "unsupported_model"
        | "final_answer"
        | "provider_rejected"
        | "capacity"
        | "busy",
    ) => {
      trace({
        kind: "cache",
        operation: "bypass",
        status: "succeeded",
        reason,
        tokenCount: null,
      });
    };
    if (this.#mode === "off") {
      bypass("disabled");
      return undefined;
    }
    if (options.provider !== "gemini") {
      bypass("unsupported_provider");
      return undefined;
    }
    const model = eligibleModel(options.model);
    if (!model) {
      bypass("unsupported_model");
      return undefined;
    }

    const scopeKey = this.#scopeKey(options.databaseScope);
    const credential = createHmac("sha256", this.#secret)
      .update(options.apiKey)
      .digest("hex");
    const identity = JSON.stringify([
      options.context.stablePrompt,
      model,
      options.audience,
      [...options.lorebookRefs]
        .map((ref) => `${ref.packId}@${ref.version}`)
        .sort(),
      options.sessionId,
      credential,
    ]);
    const generatorUrl = `${CACHE_ORIGIN}/v1beta/models/${model}:generateContent`;

    const sendUncached = (url: string, init: RequestInit) =>
      this.#fetch(url, { ...init, redirect: "error" });

    return async (input, init) => {
      const url = requestUrl(input);
      if (url !== generatorUrl || !init || typeof init.body !== "string") {
        throw new ContextCacheError();
      }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (!isObject(parsed) || !Array.isArray(parsed.contents)) {
          throw new Error("Unexpected body");
        }
        body = parsed;
      } catch {
        throw new ContextCacheError();
      }
      const contents = body.contents;
      if (!Array.isArray(contents)) throw new ContextCacheError();
      const first: unknown = contents[0];
      if (!isObject(first) || !Array.isArray(first.parts)) {
        throw new ContextCacheError();
      }
      const firstPart: unknown = first.parts[0];
      if (!isObject(firstPart) || typeof firstPart.text !== "string") {
        throw new ContextCacheError();
      }
      const promptIndex = firstPart.text.indexOf(options.context.prompt);
      if (promptIndex < 0) throw new ContextCacheError();

      // The reserved final-answer step disables tool calls by switching the
      // tool config to NONE. That config has a different cache fingerprint, so
      // creating another resource would add cost and failure surface for a
      // one-off request. Send the intact body uncached instead and leave the
      // existing resource available for later tool-enabled turns.
      const toolConfig = body.toolConfig;
      const functionCallingConfig =
        isObject(toolConfig) && isObject(toolConfig.functionCallingConfig)
          ? toolConfig.functionCallingConfig
          : undefined;
      // The reserved final-answer step removes the tool definitions entirely,
      // which also changes the cache fingerprint. A body without tools that
      // still carries function responses belongs to that step, so send it
      // uncached instead of creating a second resource mid-run.
      const hasToolResult = contents.some(
        (content) =>
          isObject(content) &&
          Array.isArray(content.parts) &&
          content.parts.some(
            (part) => isObject(part) && "functionResponse" in part,
          ),
      );
      if (
        functionCallingConfig?.mode === "NONE" ||
        (body.tools === undefined && hasToolResult)
      ) {
        bypass("final_answer");
        return sendUncached(url, init);
      }

      const fingerprint = createHmac("sha256", this.#secret)
        .update(identity)
        .update("\u0000")
        .update(
          JSON.stringify([
            body.systemInstruction ?? null,
            body.tools ?? null,
            body.toolConfig ?? null,
          ]),
        )
        .digest("hex");
      const key = `${scopeKey}\u0000${fingerprint}`;
      const now = this.#now();
      this.#prune(now);
      const existing = this.#records.get(key);
      if (existing) {
        if (
          existing.state === "resource" &&
          existing.usable &&
          existing.expiresAt - now > EXPIRY_SAFETY_MS
        ) {
          trace({
            kind: "cache",
            operation: "reuse",
            status: "succeeded",
            reason: null,
            tokenCount: existing.tokenCount,
          });
          return this.#sendCached(
            url,
            init,
            body,
            firstPart,
            existing,
            options.context.prompt,
            options.context.dynamicPrompt,
            trace,
          );
        }
        if (existing.state === "negative") {
          bypass("provider_rejected");
          return sendUncached(url, init);
        }
        bypass(existing.state === "pending" ? "busy" : "capacity");
        return sendUncached(url, init);
      }
      if (this.#records.size >= MAX_RECORDS) {
        bypass("capacity");
        return sendUncached(url, init);
      }

      const reservation: CacheRecord = {
        state: "pending",
        fingerprint,
        expiresAt: now + CACHE_TTL_MS,
      };
      this.#records.set(key, reservation);
      let createResponse: Response;
      try {
        createResponse = await this.#fetch(CACHE_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": options.apiKey,
          },
          body: JSON.stringify({
            model: `models/${model}`,
            contents: [
              {
                role: "user",
                parts: [{ text: options.context.stablePrompt }],
              },
            ],
            ...(body.systemInstruction !== undefined
              ? { systemInstruction: body.systemInstruction }
              : {}),
            ...(body.tools !== undefined ? { tools: body.tools } : {}),
            ...(body.toolConfig !== undefined
              ? { toolConfig: body.toolConfig }
              : {}),
            ttl: CACHE_TTL,
          }),
          redirect: "error",
          signal: options.signal,
        });
      } catch {
        if (this.#records.get(key) === reservation) this.#records.delete(key);
        throw new ContextCacheError();
      }
      if (createResponse.status === 400 || createResponse.status === 404) {
        await createResponse.body?.cancel().catch(() => {});
        this.#records.set(key, {
          state: "negative",
          fingerprint,
          expiresAt: this.#now() + CACHE_TTL_MS,
        });
        bypass("provider_rejected");
        return sendUncached(url, init);
      }
      if (!createResponse.ok) {
        await createResponse.body?.cancel().catch(() => {});
        if (this.#records.get(key) === reservation) this.#records.delete(key);
        trace({
          kind: "cache",
          operation: "create",
          status: "failed",
          reason: null,
          tokenCount: null,
        });
        throw new ContextCacheError();
      }
      let resource: {
        name: string;
        expiresAt: number;
        tokenCount: number | null;
      };
      try {
        const raw = (await createResponse.json()) as unknown;
        if (!isObject(raw)) throw new Error("Malformed cache response");
        const name = raw.name;
        const expireTime = raw.expireTime;
        if (typeof name !== "string" || !CACHE_NAME.test(name)) {
          throw new Error("Malformed cache name");
        }
        if (typeof expireTime !== "string") {
          throw new Error("Malformed cache expiry");
        }
        const expiresAt = Date.parse(expireTime);
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new Error("Malformed cache expiry");
        }
        const usage = isObject(raw.usageMetadata) ? raw.usageMetadata : {};
        resource = {
          name,
          expiresAt,
          tokenCount: tokenCount(usage.totalTokenCount),
        };
      } catch {
        if (this.#records.get(key) === reservation) this.#records.delete(key);
        trace({
          kind: "cache",
          operation: "create",
          status: "failed",
          reason: null,
          tokenCount: null,
        });
        throw new ContextCacheError();
      }
      const record: CacheRecord = {
        state: "resource",
        fingerprint,
        expiresAt: resource.expiresAt,
        name: resource.name,
        tokenCount: resource.tokenCount,
        usable: !options.signal.aborted,
      };
      this.#records.set(key, record);
      trace({
        kind: "cache",
        operation: "create",
        status: "succeeded",
        reason: null,
        tokenCount: resource.tokenCount,
      });
      if (options.signal.aborted) {
        trace({
          kind: "cache",
          operation: "invalidate",
          status: "succeeded",
          reason: null,
          tokenCount: resource.tokenCount,
        });
        throw new ContextCacheError();
      }
      return this.#sendCached(
        url,
        init,
        body,
        firstPart,
        record,
        options.context.prompt,
        options.context.dynamicPrompt,
        trace,
      );
    };
  }

  async #sendCached(
    url: string,
    init: RequestInit,
    body: Record<string, unknown>,
    firstPart: Record<string, unknown>,
    record: Extract<CacheRecord, { state: "resource" }>,
    prompt: string,
    dynamicPrompt: string,
    trace: (event: AgentTraceInput) => void,
  ): Promise<Response> {
    const text = firstPart.text as string;
    const index = text.indexOf(prompt);
    if (index < 0) {
      this.#invalidate(record, trace);
      throw new ContextCacheError();
    }
    const replacement = `${text.slice(0, index)}${dynamicPrompt}${text.slice(
      index + prompt.length,
    )}`;
    const contents = body.contents as unknown[];
    const firstContent = { ...(contents[0] as Record<string, unknown>) };
    const parts = [...(firstContent.parts as unknown[])];
    parts[0] = { ...firstPart, text: replacement };
    firstContent.parts = parts;
    const transformed: Record<string, unknown> = {
      ...body,
      contents: [firstContent, ...contents.slice(1)],
      cachedContent: record.name,
    };
    delete transformed.systemInstruction;
    delete transformed.tools;
    delete transformed.toolConfig;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        body: JSON.stringify(transformed),
        redirect: "error",
      });
    } catch (error) {
      this.#invalidate(record, trace);
      throw error;
    }
    if (!response.ok) this.#invalidate(record, trace);
    return response;
  }

  #invalidate(
    record: Extract<CacheRecord, { state: "resource" }>,
    trace: (event: AgentTraceInput) => void,
  ): void {
    record.usable = false;
    trace({
      kind: "cache",
      operation: "invalidate",
      status: "succeeded",
      reason: null,
      tokenCount: record.tokenCount,
    });
  }
}
