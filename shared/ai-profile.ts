import type { ProviderId } from "./types.js";
import { normalizeNarratorSystemPrompt } from "./narrator-prompt.js";

export const MAX_AI_PROFILE_NAME_CHARS = 100;
export const MAX_AI_PROFILE_MODEL_CHARS = 200;
export const MAX_CUSTOM_BASE_URL_CHARS = 2048;

export interface AiProfileFields {
  name: string;
  model: string;
  systemPrompt: string;
}

export type AiProfileInput =
  | (AiProfileFields & { provider: "gemini" | "openrouter" })
  | (AiProfileFields & { provider: "custom"; baseURL: string });

export type AiProfile = AiProfileInput & {
  id: string;
  revision: number;
  credentialConfigured: boolean;
};

const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};
const PROFILE_INPUT_FIELDS: Record<string, true> = {
  name: true,
  provider: true,
  model: true,
  systemPrompt: true,
  baseURL: true,
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === "gemini" || value === "openrouter" || value === "custom";
}

export function normalizeCustomBaseURL(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Base URL custom wajib diisi.");
  }
  const text = value.trim();
  if (text.length > MAX_CUSTOM_BASE_URL_CHARS) {
    throw new Error(
      `Base URL custom melebihi batas ${MAX_CUSTOM_BASE_URL_CHARS} karakter.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error("Base URL custom memuat karakter kontrol.");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL custom bukan URL yang valid.");
  }
  if (url.username || url.password) {
    throw new Error("Base URL custom tidak boleh memuat userinfo.");
  }
  if (url.search) {
    throw new Error("Base URL custom tidak boleh memuat query.");
  }
  if (url.hash) {
    throw new Error("Base URL custom tidak boleh memuat fragment.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL custom harus memakai HTTPS atau HTTP loopback.");
  }
  if (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS[url.hostname.toLowerCase()] !== true
  ) {
    throw new Error(
      "HTTP hanya diizinkan untuk endpoint loopback (localhost, 127.0.0.1, atau [::1]).",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    throw new Error(
      "Base URL custom harus memuat prefix API, misalnya https://api.example.com/v1.",
    );
  }
  if (path.toLowerCase().endsWith("/chat/completions")) {
    throw new Error(
      "Base URL custom tidak boleh berakhir dengan /chat/completions.",
    );
  }
  return `${url.protocol}//${url.host}${path}`;
}

function profileRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Profil AI harus object.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PROFILE_INPUT_FIELDS[key] !== true) {
      throw new Error(`Field profil AI tidak dikenal: ${key}.`);
    }
  }
  return record;
}

export function normalizeAiProfileInput(raw: unknown): AiProfileInput {
  const record = profileRecord(raw);
  if (!isProviderId(record.provider)) {
    throw new Error("Provider profil AI tidak dikenal.");
  }
  if (typeof record.name !== "string") {
    throw new Error("Nama profil AI harus berupa teks.");
  }
  const name = record.name.trim();
  if (!name || name.length > MAX_AI_PROFILE_NAME_CHARS) {
    throw new Error(
      `Nama profil AI harus 1-${MAX_AI_PROFILE_NAME_CHARS} karakter.`,
    );
  }
  if (typeof record.model !== "string") {
    throw new Error("Model profil AI harus berupa teks.");
  }
  const model = record.model.trim();
  if (!model || model.length > MAX_AI_PROFILE_MODEL_CHARS) {
    throw new Error(
      `Model profil AI harus 1-${MAX_AI_PROFILE_MODEL_CHARS} karakter.`,
    );
  }
  const systemPrompt = normalizeNarratorSystemPrompt(record.systemPrompt);
  if (record.provider === "custom") {
    return {
      name,
      provider: "custom",
      model,
      systemPrompt,
      baseURL: normalizeCustomBaseURL(record.baseURL),
    };
  }
  if (record.baseURL !== undefined) {
    throw new Error("Base URL hanya berlaku untuk provider custom.");
  }
  return { name, provider: record.provider, model, systemPrompt };
}
