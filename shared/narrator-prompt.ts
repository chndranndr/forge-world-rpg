import builtInPrompt from "./narrator-system-prompt.json" with { type: "json" };

export const DEFAULT_NARRATOR_SYSTEM_PROMPT = builtInPrompt.systemPrompt;
export const MAX_NARRATOR_SYSTEM_PROMPT_CHARS = 8_000;

export function normalizeNarratorSystemPrompt(value: unknown): string {
  if (value === undefined) return DEFAULT_NARRATOR_SYSTEM_PROMPT;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "System prompt narrator harus berupa teks yang tidak kosong.",
    );
  }
  if (value.length > MAX_NARRATOR_SYSTEM_PROMPT_CHARS) {
    throw new Error(
      `System prompt narrator melebihi batas ${MAX_NARRATOR_SYSTEM_PROMPT_CHARS} karakter.`,
    );
  }
  return value;
}
