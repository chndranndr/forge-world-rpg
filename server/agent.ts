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
  type AgentProviderOptions,
  type AgentReasoning,
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

// Google AI Studio refuses role-play prompts with safety filters enabled.
// FWORLD_GEMINI_SAFETY=off relaxes the harm categories Google lets a request
// adjust for the direct Gemini provider only. CIVIC_INTEGRITY is excluded
// because it cannot be disabled, and OpenRouter-hosted models keep their own
// policy, including PROHIBITED_CONTENT blocks that these thresholds do not
// override.
const GEMINI_SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

// Z.ai's GLM-5.3 family always reasons, so OpenRouter cannot switch it off;
// its documented floor is effort "low". No `exclude` there: the reasoning
// details carry the tool signatures the tool loop needs.
const GLM_MANDATORY_REASONING = /^glm-5\.3(?:$|[.:-])/;
// Flash families accept a disabled thinking config. The unified AI SDK
// reasoning option is deliberately used here so the installed SDK maps "none"
// to each model's documented floor: 2.5 Flash gets budget 0, Gemini 3 Flash
// gets thinkingLevel "minimal" before 3.7 and "low" from 3.7 on.
const GEMINI_DISABLES_REASONING =
  /^gemini-(?:2\.5|3(?:\.\d+)?)-flash(?:$|[-.])/;
// Gemini 3 Pro rejects "minimal" (low is its documented floor).
const GEMINI_3_PRO = /^gemini-3(?:\.\d+)?-pro(?:$|[-.])/;
// OpenRouter-hosted Gemini 3 reasons mandatorily: its docs warn that effort
// "none" is rejected there and that hiding the details loses the signatures
// the tool loop continues. Only Gemini 3 Flash and Pro are covered; other
// families keep the generic off switch.
const OPENROUTER_GEMINI_3 = /^gemini-3(?:\.\d+)?-(?:flash|pro)(?:$|[-.])/;

// The lowest thinking level each OpenRouter Gemini 3 family accepts: Flash
// takes "minimal" before 3.7 and "low" from 3.7 on (the threshold the
// installed @ai-sdk/google coerces), while Pro starts at "low" per the
// provider docs. The SDK's own minimum helper reports "minimal" for Pro, which
// those docs contradict, so the documented floor wins.
function openRouterReasoningFloor(
  model: string,
): "minimal" | "low" | undefined {
  if (!OPENROUTER_GEMINI_3.test(model)) return undefined;
  if (GEMINI_3_PRO.test(model)) return "low";
  const version = /^gemini-3\.(\d+)-flash(?:$|-(?!lite(?:-|$)))/.exec(model);
  // Unversioned Flash ids ("gemini-3-flash-preview") keep the "minimal" floor.
  if (version == null) return "minimal";
  return Number(version[1]) >= 7 ? "low" : "minimal";
}

function modelBasename(session: GameSession): string {
  const model = session.ai.model.toLowerCase().trim();
  return model.split("/").at(-1) ?? model;
}

function reasoningFor(session: GameSession): AgentReasoning | undefined {
  if (process.env.FWORLD_AI_REASONING !== "off") return undefined;
  if (session.ai.provider !== "gemini") return undefined;
  const model = modelBasename(session);
  if (GEMINI_DISABLES_REASONING.test(model)) return "none";
  if (GEMINI_3_PRO.test(model)) return "low";
  // Gemini 2.5 Pro and unknown families cannot disable thinking: budget 0 and
  // "minimal" are both rejected there, so their provider default stays.
  return undefined;
}

function providerOptionsFor(
  session: GameSession,
): AgentProviderOptions | undefined {
  if (session.ai.provider === "openrouter") {
    if (process.env.FWORLD_AI_REASONING !== "off") return undefined;
    const model = modelBasename(session);
    if (/^gemini-2\.5-pro(?:$|[-.])/.test(model)) return undefined;
    // Mandatory-reasoning families get their documented floor and no
    // `exclude`, so their reasoning details keep flowing back.
    const floor =
      openRouterReasoningFloor(model) ??
      (GLM_MANDATORY_REASONING.test(model) ? "low" : undefined);
    if (floor) return { openrouter: { reasoning: { effort: floor } } };
    return {
      openrouter: {
        reasoning: { enabled: false, effort: "none" as const, exclude: true },
      },
    };
  }
  if (session.ai.provider !== "gemini") return undefined;
  if (process.env.FWORLD_GEMINI_SAFETY !== "off") return undefined;
  return {
    google: {
      safetySettings: GEMINI_SAFETY_CATEGORIES.map((category) => ({
        category,
        threshold: "BLOCK_NONE" as const,
      })),
    },
  };
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
          const providerOptions = providerOptionsFor(input.session);
          const reasoning = reasoningFor(input.session);
          return {
            request: {
              model: initialModel,
              system: context.system,
              prompt: context.prompt,
              ...(input.kind === "opening" ? {} : { tools: active.tools }),
              ...(providerOptions ? { providerOptions } : {}),
              ...(reasoning ? { reasoning } : {}),
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
                ...(providerOptions ? { providerOptions } : {}),
                ...(reasoning ? { reasoning } : {}),
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
