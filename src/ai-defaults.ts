import { DEFAULT_MODELS, type ProviderId } from "./llm";
import {
  DEFAULT_NARRATOR_SYSTEM_PROMPT,
  normalizeNarratorSystemPrompt,
} from "../shared/narrator-prompt";

const AI_DEFAULTS_KEY = "fworld-ai-defaults";

export type AiDefaults = {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  systemPrompt: string;
  defaultProfileId?: string;
};

function defaultAiDefaults(): AiDefaults {
  return {
    provider: "gemini",
    models: { ...DEFAULT_MODELS },
    systemPrompt: DEFAULT_NARRATOR_SYSTEM_PROMPT,
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "gemini" || value === "openrouter" || value === "custom";
}

function isStoredModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200;
}

export function loadAiDefaults(): AiDefaults {
  try {
    if (typeof localStorage === "undefined") return defaultAiDefaults();
    const raw = localStorage.getItem(AI_DEFAULTS_KEY);
    if (!raw) return defaultAiDefaults();
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("provider" in value) ||
      !isProviderId(value.provider) ||
      !("models" in value)
    ) {
      return defaultAiDefaults();
    }
    const record = value as unknown as Record<string, unknown>;
    const models = value.models as Record<string, unknown>;
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models) ||
      !("gemini" in models) ||
      !isStoredModel(models.gemini) ||
      !("openrouter" in models) ||
      !isStoredModel(models.openrouter)
    ) {
      return defaultAiDefaults();
    }
    let systemPrompt = DEFAULT_NARRATOR_SYSTEM_PROMPT;
    if ("systemPrompt" in value) {
      try {
        systemPrompt = normalizeNarratorSystemPrompt(value.systemPrompt);
      } catch {
        systemPrompt = DEFAULT_NARRATOR_SYSTEM_PROMPT;
      }
    }
    let defaultProfileId: string | undefined;
    if (
      typeof record.defaultProfileId === "string" &&
      record.defaultProfileId.trim().length > 0 &&
      record.defaultProfileId.length <= 256
    ) {
      defaultProfileId = record.defaultProfileId;
    }
    return {
      provider: value.provider,
      models: {
        gemini: models.gemini as string,
        openrouter: models.openrouter as string,
        custom: isStoredModel(models.custom) ? models.custom : "",
      },
      systemPrompt,
      ...(defaultProfileId === undefined ? {} : { defaultProfileId }),
    };
  } catch {
    return defaultAiDefaults();
  }
}

export function storeAiDefaults(value: AiDefaults): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(AI_DEFAULTS_KEY, JSON.stringify(value));
  } catch {
    // Provider/model and narrator preferences are optional; never block story use
    // on storage failure.
  }
}
