import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { normalizeCustomBaseURL } from "../shared/ai-profile.js";

export function createCustomModel(
  model: string,
  config: { baseURL: string; apiKey?: string },
) {
  const baseURL = normalizeCustomBaseURL(config.baseURL);
  const provider = createOpenAICompatible({
    name: "custom",
    baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    fetch: (input, init) =>
      globalThis.fetch(input, { ...init, redirect: "error" }),
  });
  return provider.chatModel(model);
}
