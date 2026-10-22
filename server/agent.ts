import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { generateText } from "ai";
import { createCustomModel } from "./custom-provider.js";
import type { NarratorApplyResult, TurnResponse } from "../shared/engine.js";
import type {
  CheckRecord,
  ContextTelemetry,
  GameSession,
} from "../shared/types.js";
import {
  createNarratorHarness,
  type NarratorHarness,
} from "./agent/harness.js";
import {
  NarratorContextError,
  type NarratorContextInput,
} from "./agent/context.js";
import type { MemorySearch } from "./agent/knowledge.js";
import {
  AgentTraceCollector,
  runAgent,
  type AttemptEvent,
} from "./agent/runtime.js";
import type { GeminiContextCache } from "./agent/gemini-cache.js";

export interface NarratorInput extends NarratorContextInput {
  providerKey: string;
  providerBaseURL?: string;
  searchMemory: MemorySearch;
  onAttemptStart: (event: AttemptEvent) => void | Promise<void>;
  onAttemptFinish: (event: AttemptEvent) => void | Promise<void>;
  onContext?: (telemetry: ContextTelemetry) => void | Promise<void>;
  contextCache?: {
    client: GeminiContextCache;
    databaseScope: object;
  };
}

export interface NarratorOptions {
  generateText?: typeof generateText;
}

export interface NarratorResult {
  response: TurnResponse;
  check: CheckRecord | null;
  application: NarratorApplyResult | null;
}

function modelFor(
  session: GameSession,
  providerKey: string,
  providerBaseURL?: string,
  fetchOverride?: typeof fetch,
) {
  if (!session.ai.model.trim()) throw new Error("Model session tidak valid.");
  if (session.ai.provider === "custom") {
    if (!providerBaseURL) {
      throw new Error(
        "Profil AI custom belum diterapkan pada sesi ini; pilih profil AI lebih dulu.",
      );
    }
    return createCustomModel(session.ai.model, {
      baseURL: providerBaseURL,
      ...(providerKey ? { apiKey: providerKey } : {}),
    });
  }
  if (!providerKey) throw new Error("Provider key belum dikonfigurasi.");
  if (session.ai.provider === "gemini") {
    return createGoogleGenerativeAI({
      apiKey: providerKey,
      ...(fetchOverride ? { fetch: fetchOverride } : {}),
    })(session.ai.model);
  }
  if (session.ai.provider === "openrouter") {
    const openrouter = createOpenRouter({ apiKey: providerKey });
    return session.ai.model.toLowerCase().startsWith("google/gemini-")
      ? openrouter.chat(session.ai.model, {
          provider: {
            order: ["google-ai-studio"],
            allow_fallbacks: false,
          },
        })
      : openrouter.chat(session.ai.model);
  }
  throw new Error("Provider session tidak dikenal.");
}

export async function runNarrator(
  input: NarratorInput,
  options: NarratorOptions = {},
): Promise<NarratorResult> {
  if (
    input.kind !== "turn" &&
    input.kind !== "opening" &&
    input.kind !== "choices"
  ) {
    throw new Error("Jenis narrator run tidak dikenal.");
  }

  const collector = new AgentTraceCollector();
  let harness: NarratorHarness | undefined;
  let failureTelemetry: ContextTelemetry | undefined;
  try {
    return await runAgent<NarratorResult>(
      {
        provider: input.session.ai.provider,
        model: input.session.ai.model,
        onAttemptStart: input.onAttemptStart,
        onAttemptFinish: input.onAttemptFinish,
        onTrace: (event) => collector.push(event),
        prepare: (signal) => {
          try {
            harness = createNarratorHarness({
              input,
              searchMemory: input.searchMemory,
              signal,
            });
          } catch (error) {
            if (error instanceof NarratorContextError) {
              failureTelemetry = error.telemetry;
            }
            throw error;
          }
          const active = harness;
          const context = active.context;
          const cacheFetch = input.contextCache?.client.fetchFor({
            provider: input.session.ai.provider,
            databaseScope: input.contextCache.databaseScope,
            sessionId: input.session.id,
            audience: context.audience,
            lorebookRefs:
              input.session.lorebookRefs ??
              input.session.definitionSnapshot.lorebookRefs ??
              [],
            model: input.session.ai.model,
            apiKey: input.providerKey,
            context,
            signal,
            onTrace: (event) => collector.push(event),
          });
          const initialModel = modelFor(
            input.session,
            input.providerKey,
            input.providerBaseURL,
            cacheFetch,
          );
          const repairModel = cacheFetch
            ? modelFor(input.session, input.providerKey, input.providerBaseURL)
            : initialModel;
          return {
            request: {
              model: initialModel,
              system: context.system,
              prompt: context.prompt,
              ...(input.kind === "opening" ? {} : { tools: active.tools }),
            },
            validate: (value) => active.validate(value),
            repair: (value) => {
              if (input.contextCache) {
                collector.push({
                  kind: "cache",
                  operation: "bypass",
                  status: "succeeded",
                  reason: "repair",
                  tokenCount: null,
                });
              }
              const repaired = active.repair(value);
              return {
                model: repairModel,
                system: repaired.system,
                prompt: repaired.prompt,
              };
            },
          };
        },
      },
      options,
    );
  } finally {
    const telemetry = harness ? harness.getTelemetry() : failureTelemetry;
    if (telemetry && input.onContext) {
      try {
        await input.onContext({
          ...telemetry,
          trace: collector.snapshot(),
        });
      } catch {}
    }
  }
}
