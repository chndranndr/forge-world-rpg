import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { buildInitialState } from "../shared/engine.js";
import {
  parseLorebookPack,
  LorebookValidationError,
  MAX_LOREBOOK_BYTES,
} from "../shared/lore.js";
import { exportTemplate, parseTemplate } from "../shared/template.js";
import { parseWorldMap, resolveLocation } from "../shared/world.js";
import {
  createExportBundle,
  hasDangerousKeysDeep,
  pickGameDefinition,
  validateDefinition,
  validateDefinitionUpdate,
  validateExportBundle,
  validatePlayability,
} from "../shared/validation.js";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type AgentTrace,
  type AgentTraceCacheReason,
  type AgentTraceEvent,
  type AgentTraceFinishReason,
  type AiConfig,
  PLAYER_ID,
  type ContextTelemetry,
  type ExportBundle,
  type GameDefinition,
  type GameSession,
  type LorebookPack,
  type LorebookRef,
  type LoreDependency,
  type LoreEntry,
  type LoreKind,
  type LoreLink,
  type LorePackHeader,
  type Message,
  type NpcDefinition,
  type SessionState,
  type StorySummary,
  type WorldLocation,
  type WorldMap,
  type GameTemplateBundle,
} from "../shared/types.js";
import { normalizeNarratorSystemPrompt } from "../shared/narrator-prompt.js";
import {
  normalizeAiProfileInput,
  normalizeCustomBaseURL,
  type AiProfileInput,
} from "../shared/ai-profile.js";

export { ImportError } from "../shared/validation.js";

const SCHEMA_VERSION = 5;
const DOCUMENT_LIMIT = 2 * 1024 * 1024;
const TRANSFER_LIMIT = 32 * 1024 * 1024;
const ID_LIMIT = 256;
const LOREBOOK_LIMIT = MAX_LOREBOOK_BYTES;
const LOREBOOK_BATCH_SIZE = 250;
const MAX_SUMMARY_RANGES_PER_CALL = 5;
const SUMMARY_MAX_BYTES = 4_000;
const SUMMARY_EXCERPT_BYTES = 280;
const SUMMARY_IDLE_RETRY_MS = 30_000;
const ROLES = new Set(["PLAYER", "NPC", "NARRATOR", "SYSTEM_EVENT"]);
const RUN_STATUSES = new Set(["running", "committed", "failed", "interrupted"]);
const AI_KINDS = new Set(["turn", "opening", "choices", "connection_test"]);
const AI_STATUSES = new Set(["running", "succeeded", "failed", "unknown"]);
const MESSAGE_AUDIENCE_SCOPE = `(
  m.visibility = 'public' OR (
    m.visibility = 'private' AND EXISTS (
      SELECT 1 FROM json_each(COALESCE(m.known_by_json, '[]')) known
      WHERE known.value = ?
    )
  ) OR (m.visibility IS NULL AND ? = 'player')
)`;

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DatabaseError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
  }
}

export class NotFoundError extends DatabaseError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
  }
}

export class ConflictError extends DatabaseError {
  constructor(message: string, code = "CONFLICT") {
    super(message, code);
  }
}

export class CorruptDatabaseError extends DatabaseError {
  constructor(message: string) {
    super(message, "CORRUPT_DATABASE");
  }
}

export type StoredGame = GameDefinition & { revision: number };
export type StoredSession = GameSession & { revision: number };
export interface VersionedValue<T> {
  value: T;
  revision: number;
}
export interface SessionStartResult {
  game: VersionedValue<GameDefinition>;
  session: VersionedValue<GameSession>;
}
export interface StartSessionForDefinitionInput {
  definition: unknown;
  expectedGameRevision?: number;
  sessionId?: string;
  ai?: unknown;
  profileId?: string;
  name?: unknown;
}
export interface StartSavedSessionInput {
  gameId: string;
  expectedGameRevision: number;
  name?: unknown;
  ai?: unknown;
  profileId?: unknown;
  sessionId?: string;
}
export interface SessionMetadataPatch {
  name?: unknown;
  pinned?: unknown;
}
export interface SessionSummaryMetrics {
  turnCount: number;
  excerpt: string | null;
}
export interface SavedTemplateRecord {
  id: string;
  title: string;
  createdAt: string;
}
export type StoredAiProfile = AiProfileInput & {
  id: string;
  revision: number;
  credentialId: string;
};
export interface StoredAiBinding {
  profileId: string;
  credentialId: string;
  provider: AiConfig["provider"];
  baseURL?: string;
}
interface AiProfileSnapshot {
  ai: AiConfig;
  profileId: string;
  credentialId: string;
}
export type RunStatus = "running" | "committed" | "failed" | "interrupted";
export type RunKind = "turn" | "opening" | "choices" | "item_use";

export interface RunRecord {
  sessionId: string;
  requestId: string;
  inputHash: string;
  expectedRevision: number;
  kind: RunKind;
  status: RunStatus;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface MessagePage {
  messages: Message[];
  nextAfterSequence: number | null;
  nextBeforeSequence: number | null;
  hasMore: boolean;
}

export interface AiUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
}

export interface AiRequestRecord {
  id: string;
  sessionId: string | null;
  requestId: string | null;
  kind: "turn" | "opening" | "choices" | "connection_test";
  attempt: number;
  provider: AiConfig["provider"];
  model: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  usage: Required<AiUsage>;
  latencyMs: number | null;
  finishReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary {
  requests: number;
  statuses: Record<AiRequestRecord["status"], number>;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  unknownUsageRequests: number;
  latencyMs: number | null;
}

export interface MigrationReceipt {
  fingerprint: string;
  counts: { games: number; sessions: number; messages: number };
  ids: { games: string[]; sessions: string[]; messages: string[] };
  verified: true;
  verifiedAt: string;
}

export type MemoryResult =
  | {
      kind: "fact";
      id: string;
      excerpt: string;
      source: "config" | "story";
      visibility: "public" | "private";
      knownBy: string[];
      createdAt: string;
    }
  | {
      kind: "message";
      id: string;
      turnId: string;
      sequence: number;
      role: Message["role"];
      speakerId?: string;
      excerpt: string;
      createdAt: string;
    };

export interface AiRequestStart {
  id?: string;
  sessionId?: string | null;
  requestId?: string | null;
  kind: AiRequestRecord["kind"];
  attempt: number;
  provider: AiConfig["provider"];
  model: string;
}

export interface AiRequestFinish {
  status: Exclude<AiRequestRecord["status"], "running">;
  usage?: AiUsage;
  latencyMs?: number | null;
  finishReason?: string | null;
}

export interface SessionUpdate {
  ai?: unknown;
  definitionSnapshot?: unknown;
  state?: unknown;
  profileId?: string;
}

export interface RunCommit {
  state: unknown;
  messages: unknown[];
  result: unknown;
  definitionSnapshot?: unknown;
}

export interface RunCommitResult {
  session: StoredSession;
  run: RunRecord;
}

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonText(value: unknown, limit = DOCUMENT_LIMIT): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new ValidationError("Payload bukan JSON yang dapat disimpan.");
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") > limit) {
    throw new ValidationError("Ukuran payload melampaui batas.");
  }
  return text;
}
function normalizeSessionName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("Session name harus string.");
  }
  const name = value.trim();
  if (!name || name.length > 256) {
    throw new ValidationError("Session name harus sepanjang 1–256 karakter.");
  }
  return name;
}

function parseJson<T>(text: string, label: string, limit = DOCUMENT_LIMIT): T {
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new CorruptDatabaseError(`${label} melampaui batas ukuran.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CorruptDatabaseError(`${label} bukan JSON valid.`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new ValidationError("Nilai JSON tidak valid.");
  return text;
}
function validateStoredTemplate(raw: unknown): GameTemplateBundle {
  if (
    !isObject(raw) ||
    Object.keys(raw).some(
      (key) => !["format", "version", "exportedAt", "game"].includes(key),
    ) ||
    raw.format !== "fworld-template" ||
    raw.version !== 1 ||
    typeof raw.exportedAt !== "string" ||
    !raw.exportedAt ||
    !isObject(raw.game)
  ) {
    throw new CorruptDatabaseError(
      "Saved template memiliki bentuk tidak valid.",
    );
  }
  let game: GameTemplateBundle["game"];
  try {
    game = parseTemplate(raw).draft;
  } catch (error) {
    throw new CorruptDatabaseError(
      `Saved template tidak valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(raw.game) !== canonicalJson(game)) {
    throw new CorruptDatabaseError(
      "Saved template berisi field game yang tidak didukung.",
    );
  }
  return {
    format: "fworld-template",
    version: 1,
    exportedAt: raw.exportedAt,
    game,
  };
}
const LORE_KINDS: Record<LoreKind, true> = {
  world: true,
  region: true,
  location: true,
  place: true,
  npc: true,
  faction: true,
  history: true,
  monster: true,
  item: true,
  activity: true,
  other: true,
};

function isLoreKind(value: string): value is LoreKind {
  return Object.hasOwn(LORE_KINDS, value);
}
const LORE_LINK_RELATIONS: Record<LoreLink["relation"], true> = {
  PARENT_OF: true,
  CONNECTED_TO: true,
  LOCATED_IN: true,
  PRESENT_AT: true,
  RELATED_TO: true,
};

function isLoreLinkRelation(value: unknown): value is LoreLink["relation"] {
  return typeof value === "string" && Object.hasOwn(LORE_LINK_RELATIONS, value);
}

function loreLinkRelation(value: unknown): LoreLink["relation"] {
  if (!isLoreLinkRelation(value)) {
    throw new CorruptDatabaseError("Lore link relation rusak.");
  }
  return value;
}

function parseLoreRefs(raw: unknown): LorebookRef[] {
  if (!Array.isArray(raw) || raw.length > 64) {
    throw new ValidationError(
      "lorebookRefs harus array dengan paling banyak 64 versi.",
    );
  }
  const refs: LorebookRef[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (
      !isObject(item) ||
      Object.keys(item).some((key) => !["packId", "version"].includes(key))
    ) {
      throw new ValidationError(
        `lorebookRefs[${index}] harus berisi packId dan version saja.`,
      );
    }
    assertId(item.packId, `lorebookRefs[${index}].packId`);
    if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) {
      throw new ValidationError(
        `lorebookRefs[${index}].version harus integer positif.`,
      );
    }
    const ref = { packId: item.packId, version: Number(item.version) };
    const key = `${ref.packId}\u0000${ref.version}`;
    if (seen.has(key)) {
      throw new ValidationError(
        `lorebookRefs duplikat: ${ref.packId}@${ref.version}.`,
      );
    }
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
function sameLoreRefs(left: LorebookRef[], right: LorebookRef[]): boolean {
  const key = (refs: LorebookRef[]) =>
    refs.map((ref) => `${ref.packId}\u0000${ref.version}`).sort();
  return canonicalJson(key(left)) === canonicalJson(key(right));
}

const TRACE_FINISH_REASONS: Record<string, true> = {
  stop: true,
  length: true,
  "content-filter": true,
  "tool-calls": true,
  error: true,
  other: true,
};

const TRACE_CACHE_REASONS: Record<string, true> = {
  disabled: true,
  unsupported_provider: true,
  unsupported_model: true,
  repair: true,
  provider_rejected: true,
  capacity: true,
  busy: true,
};

const TRACE_EVENT_FIELDS: Record<string, string[]> = {
  model: ["kind", "elapsedMs", "attempt", "phase", "status", "finishReason"],
  tool: ["kind", "elapsedMs", "name", "status", "resultChars"],
  validation: ["kind", "elapsedMs", "status"],
  repair: ["kind", "elapsedMs"],
  cache: ["kind", "elapsedMs", "operation", "status", "reason", "tokenCount"],
};

function credentialLike(value: string): boolean {
  return /^(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-|eyJ[A-Za-z0-9_-]{20,}\.)/i.test(
    value,
  );
}

function traceCount(value: unknown, label: string, max = 10_000_000): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > max
  ) {
    throw new ValidationError(`${label} tidak valid.`);
  }
  return Number(value);
}

function validateAgentTrace(raw: unknown): AgentTrace | undefined {
  if (
    !isObject(raw) ||
    Object.keys(raw).some((key) => !["events", "dropped"].includes(key)) ||
    !Object.hasOwn(raw, "events") ||
    !Object.hasOwn(raw, "dropped") ||
    !Array.isArray(raw.events) ||
    raw.events.length > 128
  ) {
    throw new ValidationError("Context trace tidak valid.");
  }
  const dropped = traceCount(raw.dropped, "trace.dropped", 1_000_000);
  const events: AgentTraceEvent[] = [];
  for (const rawEvent of raw.events) {
    if (!isObject(rawEvent) || typeof rawEvent.kind !== "string") {
      throw new ValidationError("Context trace event tidak valid.");
    }
    const fields = TRACE_EVENT_FIELDS[rawEvent.kind];
    if (
      !fields ||
      Object.keys(rawEvent).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(rawEvent, key))
    ) {
      throw new ValidationError("Context trace event tidak valid.");
    }
    const elapsedMs = traceCount(
      rawEvent.elapsedMs,
      "trace.elapsedMs",
      86_400_000,
    );
    if (rawEvent.kind === "model") {
      const attempt = traceCount(rawEvent.attempt, "trace.attempt", 1_000_000);
      if (
        attempt < 1 ||
        (rawEvent.phase !== "initial" && rawEvent.phase !== "repair") ||
        (rawEvent.status !== "started" &&
          rawEvent.status !== "succeeded" &&
          rawEvent.status !== "failed") ||
        (rawEvent.finishReason !== null &&
          (typeof rawEvent.finishReason !== "string" ||
            !Object.hasOwn(TRACE_FINISH_REASONS, rawEvent.finishReason)))
      ) {
        throw new ValidationError("Context trace event tidak valid.");
      }
      events.push({
        kind: "model",
        elapsedMs,
        attempt,
        phase: rawEvent.phase,
        status: rawEvent.status,
        finishReason: rawEvent.finishReason as AgentTraceFinishReason | null,
      });
    } else if (rawEvent.kind === "tool") {
      if (
        typeof rawEvent.name !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,64}$/.test(rawEvent.name) ||
        credentialLike(rawEvent.name) ||
        (rawEvent.status !== "succeeded" && rawEvent.status !== "failed")
      ) {
        throw new ValidationError("Context trace event tidak valid.");
      }
      events.push({
        kind: "tool",
        elapsedMs,
        name: rawEvent.name,
        status: rawEvent.status,
        resultChars:
          rawEvent.resultChars === null
            ? null
            : traceCount(rawEvent.resultChars, "trace.resultChars"),
      });
    } else if (rawEvent.kind === "validation") {
      if (rawEvent.status !== "accepted" && rawEvent.status !== "rejected") {
        throw new ValidationError("Context trace event tidak valid.");
      }
      events.push({
        kind: "validation",
        elapsedMs,
        status: rawEvent.status,
      });
    } else if (rawEvent.kind === "repair") {
      events.push({ kind: "repair", elapsedMs });
    } else {
      if (
        (rawEvent.operation !== "create" &&
          rawEvent.operation !== "reuse" &&
          rawEvent.operation !== "bypass" &&
          rawEvent.operation !== "invalidate") ||
        (rawEvent.status !== "succeeded" && rawEvent.status !== "failed") ||
        (rawEvent.reason !== null &&
          (typeof rawEvent.reason !== "string" ||
            !Object.hasOwn(TRACE_CACHE_REASONS, rawEvent.reason)))
      ) {
        throw new ValidationError("Context trace event tidak valid.");
      }
      events.push({
        kind: "cache",
        elapsedMs,
        operation: rawEvent.operation,
        status: rawEvent.status,
        reason: rawEvent.reason as AgentTraceCacheReason | null,
        tokenCount:
          rawEvent.tokenCount === null
            ? null
            : traceCount(rawEvent.tokenCount, "trace.tokenCount"),
      });
    }
  }
  if (events.length === 0 && dropped === 0) return undefined;
  return { events, dropped };
}

function validateContextTelemetry(raw: unknown): ContextTelemetry {
  const keys = [
    "contextChars",
    "approximateTokens",
    "tokenEstimateMethod",
    "sections",
    "selectedLoreIds",
    "omissions",
    "toolCalls",
    "repairs",
  ];
  if (
    !isObject(raw) ||
    Object.keys(raw).some((key) => !keys.includes(key) && key !== "trace") ||
    keys.some((key) => !Object.hasOwn(raw, key))
  ) {
    throw new ValidationError(
      "Context telemetry harus berisi field yang diizinkan.",
    );
  }
  const count = (value: unknown, label: string, max = 10_000_000): number => {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) > max
    ) {
      throw new ValidationError(`${label} tidak valid.`);
    }
    return Number(value);
  };
  if (
    typeof raw.tokenEstimateMethod !== "string" ||
    !/^[A-Za-z0-9_./:-]{1,64}$/.test(raw.tokenEstimateMethod) ||
    credentialLike(raw.tokenEstimateMethod)
  ) {
    throw new ValidationError("tokenEstimateMethod tidak valid.");
  }
  if (!isObject(raw.sections) || Object.keys(raw.sections).length > 32) {
    throw new ValidationError("sections tidak valid.");
  }
  const sections: ContextTelemetry["sections"] = {};
  for (const [name, value] of Object.entries(raw.sections)) {
    if (
      !/^[A-Za-z0-9_.:-]{1,64}$/.test(name) ||
      credentialLike(name) ||
      !isObject(value) ||
      Object.keys(value).some(
        (key) => !["chars", "count", "omitted"].includes(key),
      ) ||
      ["chars", "count", "omitted"].some((key) => !Object.hasOwn(value, key))
    ) {
      throw new ValidationError("Context section telemetry tidak valid.");
    }
    sections[name] = {
      chars: count(value.chars, "section.chars"),
      count: count(value.count, "section.count", 1_000_000),
      omitted: count(value.omitted, "section.omitted", 1_000_000),
    };
  }
  const safeList = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.length > 512) {
      throw new ValidationError(`${label} tidak valid.`);
    }
    return value.map((item) => {
      if (
        typeof item !== "string" ||
        !/^[\p{L}\p{N}_.:/-]{1,256}$/u.test(item) ||
        credentialLike(item)
      ) {
        throw new ValidationError(`${label} harus berisi identifier saja.`);
      }
      return item;
    });
  };
  const trace = Object.hasOwn(raw, "trace")
    ? validateAgentTrace(raw.trace)
    : undefined;
  return {
    contextChars: count(raw.contextChars, "contextChars"),
    approximateTokens: count(raw.approximateTokens, "approximateTokens"),
    tokenEstimateMethod: raw.tokenEstimateMethod,
    sections,
    selectedLoreIds: safeList(raw.selectedLoreIds, "selectedLoreIds"),
    omissions: safeList(raw.omissions, "omissions"),
    toolCalls: count(raw.toolCalls, "toolCalls", 1_000_000),
    repairs: count(raw.repairs, "repairs", 1_000_000),
    ...(trace ? { trace } : {}),
  };
}

function parseLorebook(raw: unknown): LorebookPack {
  jsonText(raw, LOREBOOK_LIMIT);
  assertNoDangerousKeys(raw);
  try {
    return parseLorebookPack(raw);
  } catch (error) {
    if (error instanceof LorebookValidationError) {
      throw new ValidationError(error.problems.join(" "));
    }
    throw new ValidationError(
      `Lorebook tidak valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalLorebook(pack: LorebookPack): LorebookPack {
  return {
    ...pack,
    pack: { ...pack.pack },
    entries: [...pack.entries].sort((a, b) => a.id.localeCompare(b.id)),
    links: [...pack.links].sort(
      (a, b) =>
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId) ||
        a.relation.localeCompare(b.relation),
    ),
  };
}

function pageOptions(
  options: { limit?: number; offset?: number },
  defaultLimit = 50,
): { limit: number; offset: number } {
  const limit = options.limit ?? defaultLimit;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit harus integer 1 sampai 100.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new ValidationError("offset harus integer 0 sampai 1000000.");
  }
  return { limit, offset };
}

function assertTokenCount(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${label} harus integer >= 0.`);
  }
}

function assertId(value: unknown, label = "id"): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > ID_LIMIT ||
    value.includes("\0")
  ) {
    throw new ValidationError(`${label} tidak valid.`);
  }
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ValidationError("Revision harus integer positif.");
  }
}

function assertSequence(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ValidationError("Sequence harus integer >= 0.");
  }
}

function assertNoDangerousKeys(value: unknown): void {
  if (hasDangerousKeysDeep(value)) {
    throw new ValidationError("Payload mengandung key berbahaya.");
  }
}

function validateDefinitionShape(raw: unknown): void {
  if (!isObject(raw)) throw new ValidationError("Game harus object.");
  assertNoDangerousKeys(raw);
  const errors: string[] = [];
  const arrays = [
    "attributes",
    "resources",
    "relationships",
    "items",
    "npcs",
    "startingInventory",
  ] as const;
  for (const key of arrays) {
    if (Array.isArray(raw[key]) && raw[key].some((entry) => !isObject(entry))) {
      errors.push(`${key} berisi entry bukan object.`);
    }
  }
  if (Array.isArray(raw.items)) {
    raw.items.forEach((item, index) => {
      if (!isObject(item)) return;
      if (
        Array.isArray(item.tags) &&
        item.tags.some((tag) => typeof tag !== "string")
      ) {
        errors.push(`items[${index}].tags berisi nilai bukan string.`);
      }
      if (
        Array.isArray(item.effects) &&
        item.effects.some((effect) => !isObject(effect))
      ) {
        errors.push(`items[${index}].effects berisi entry bukan object.`);
      }
    });
  }
  if (Array.isArray(raw.npcs)) {
    raw.npcs.forEach((npc, index) => {
      if (!isObject(npc)) return;
      for (const field of ["personality", "goals", "privateKnowledge"]) {
        if (
          Array.isArray(npc[field]) &&
          npc[field].some((entry) => typeof entry !== "string")
        ) {
          errors.push(`npcs[${index}].${field} berisi nilai bukan string.`);
        }
      }
    });
  }
  if (errors.length) throw new ValidationError(errors.join(" "));
}

function validateDefinitionDocument(
  raw: unknown,
  updatedAt?: string,
): GameDefinition {
  jsonText(raw);
  validateDefinitionShape(raw);
  if (
    isObject(raw) &&
    raw.updatedAt !== undefined &&
    (typeof raw.updatedAt !== "string" || !raw.updatedAt)
  ) {
    throw new ValidationError("updatedAt harus string tidak kosong.");
  }
  let errors: string[];
  try {
    errors = validateDefinition(raw as GameDefinition);
  } catch (error) {
    throw new ValidationError(
      `Definition tidak valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (errors.length) throw new ValidationError(errors.join(" "));
  const definition = pickGameDefinition(raw);
  definition.updatedAt = updatedAt ?? definition.updatedAt;
  if (typeof definition.updatedAt !== "string" || !definition.updatedAt) {
    definition.updatedAt = new Date().toISOString();
  }
  errors = validateDefinition(definition);
  if (errors.length) throw new ValidationError(errors.join(" "));
  assertId(definition.id, "game.id");
  return definition;
}

function normalizeAi(raw: unknown): AiConfig {
  if (!isObject(raw)) throw new ValidationError("AI config harus object.");
  if (
    raw.provider !== "gemini" &&
    raw.provider !== "openrouter" &&
    raw.provider !== "custom"
  ) {
    throw new ValidationError("AI provider tidak dikenal.");
  }
  if (
    typeof raw.model !== "string" ||
    !raw.model.trim() ||
    raw.model.length > 256
  ) {
    throw new ValidationError("AI model tidak valid.");
  }
  let systemPrompt: string;
  try {
    systemPrompt = normalizeNarratorSystemPrompt(raw.systemPrompt);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error
        ? error.message
        : "System prompt narrator tidak valid.",
    );
  }
  return {
    provider: raw.provider,
    model: raw.model.trim(),
    systemPrompt,
  };
}

function assertPlainArray(
  value: unknown,
  label: string,
): asserts value is JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new ValidationError(`${label} harus array object yang valid.`);
  }
}

function withoutLorebookRefs<T extends GameDefinition | GameSession>(
  value: T,
): Omit<T, "lorebookRefs"> {
  const { lorebookRefs: _lorebookRefs, ...rest } = value;
  return rest;
}

function makeBundle(
  game: GameDefinition,
  session: GameSession,
  messages: Message[],
): ExportBundle {
  const validationMap = session.worldMap ?? game.worldMap;
  const validationGame = withoutLorebookRefs(
    validationMap === undefined ? game : { ...game, worldMap: validationMap },
  );
  const validationSnapshot = withoutLorebookRefs({
    ...session.definitionSnapshot,
    ...(validationMap === undefined ? {} : { worldMap: validationMap }),
  });
  const validationSession = withoutLorebookRefs({
    ...session,
    definitionSnapshot: validationSnapshot,
  });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    game: validationGame,
    session: validationSession,
    messages,
  };
}

function validateSessionDocument(
  session: GameSession,
  messages: Message[],
): GameSession {
  assertId(session.id, "session.id");
  assertId(session.gameId, "session.gameId");
  if (!Number.isSafeInteger(session.nextSequence) || session.nextSequence < 0) {
    throw new ValidationError("nextSequence tidak valid.");
  }
  const definition = validateDefinitionDocument(session.definitionSnapshot);
  if (definition.id !== session.gameId) {
    throw new ValidationError("Snapshot gameId tidak cocok dengan session.");
  }
  const ai = normalizeAi(session.ai);
  const lorebookRefs =
    session.lorebookRefs === undefined
      ? undefined
      : parseLoreRefs(session.lorebookRefs);
  if (
    !sameLoreRefs(
      parseLoreRefs(definition.lorebookRefs ?? []),
      parseLoreRefs(session.lorebookRefs ?? []),
    )
  ) {
    throw new ValidationError(
      "Session lorebookRefs tidak cocok dengan snapshot.",
    );
  }
  const worldMap =
    session.worldMap === undefined
      ? undefined
      : parseWorldMap(
          session.worldMap,
          definition.npcs.map((npc) => npc.id),
        );
  if (typeof session.updatedAt !== "string" || !session.updatedAt) {
    throw new ValidationError("session.updatedAt harus string tidak kosong.");
  }
  const stateOnly = {
    ...session,
    definitionSnapshot: definition,
    ...(lorebookRefs === undefined ? {} : { lorebookRefs }),
    ...(worldMap === undefined ? {} : { worldMap }),
    ai,
    nextSequence: 0,
  };
  validateExportBundle(makeBundle(definition, stateOnly, []));
  if (messages.length) {
    const maxSequence = messages.reduce(
      (max, message) => Math.max(max, message.sequence),
      -1,
    );
    if (session.nextSequence !== maxSequence + 1) {
      throw new ValidationError("nextSequence tidak sesuai messages.");
    }
  } else if (session.nextSequence !== 0) {
    throw new ValidationError("nextSequence tidak sesuai messages.");
  }
  const checked = validateExportBundle(
    makeBundle(
      definition,
      { ...stateOnly, nextSequence: session.nextSequence },
      messages,
    ),
  );
  return {
    ...checked.session,
    definitionSnapshot: definition,
    ...(lorebookRefs === undefined ? {} : { lorebookRefs }),
    ...(worldMap === undefined ? {} : { worldMap }),
  };
}

function validateMessages(
  session: GameSession,
  rawMessages: unknown[],
): Message[] {
  assertPlainArray(rawMessages, "messages");
  for (const [index, message] of rawMessages.entries()) {
    if (
      typeof message.id !== "string" ||
      typeof message.sessionId !== "string" ||
      typeof message.turnId !== "string" ||
      !Number.isSafeInteger(message.sequence) ||
      typeof message.role !== "string" ||
      typeof message.content !== "string" ||
      typeof message.createdAt !== "string" ||
      (message.speakerId !== undefined &&
        typeof message.speakerId !== "string") ||
      (message.visibility !== undefined &&
        message.visibility !== "public" &&
        message.visibility !== "private") ||
      (message.knownBy !== undefined &&
        (!Array.isArray(message.knownBy) ||
          message.knownBy.some((id) => typeof id !== "string"))) ||
      (message.check !== undefined && !isObject(message.check))
    ) {
      throw new ValidationError(`messages[${index}] shape tidak valid.`);
    }
    assertNoDangerousKeys(message);
    assertId(message.id, `messages[${index}].id`);
    assertId(message.sessionId, `messages[${index}].sessionId`);
    assertId(message.turnId, `messages[${index}].turnId`);
    assertSequence(message.sequence);
    if (Array.isArray(message.knownBy)) {
      for (const recipient of message.knownBy) {
        assertId(recipient, `messages[${index}].knownBy`);
      }
    }
    if (Buffer.byteLength(message.content, "utf8") > DOCUMENT_LIMIT) {
      throw new ValidationError(`messages[${index}] content terlalu besar.`);
    }
  }
  const messages = rawMessages as unknown as Message[];
  if (messages.length === 0) return [];
  const maxSequence = messages.reduce(
    (max, message) =>
      Number.isSafeInteger(message.sequence)
        ? Math.max(max, message.sequence)
        : max,
    -1,
  );
  const candidate = { ...session, nextSequence: maxSequence + 1 };
  return validateExportBundle(
    makeBundle(session.definitionSnapshot, candidate, messages),
  ).messages;
}

function readRun(row: SqlRow): RunRecord {
  const status = String(row.status) as RunStatus;
  if (!RUN_STATUSES.has(status)) {
    throw new CorruptDatabaseError("Status run tidak dikenal.");
  }
  return {
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    inputHash: String(row.input_hash),
    expectedRevision: Number(row.expected_revision),
    kind: String(row.kind) as RunKind,
    status,
    ...(row.result_json === null
      ? {}
      : { result: parseJson(row.result_json as string, "Run result") }),
    ...(row.error_json === null
      ? {}
      : { error: parseJson(row.error_json as string, "Run error") }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function readAiRequest(row: SqlRow): AiRequestRecord {
  const provider = String(row.provider);
  const status = String(row.status) as AiRequestRecord["status"];
  if (
    (provider !== "gemini" &&
      provider !== "openrouter" &&
      provider !== "custom") ||
    !AI_STATUSES.has(status)
  ) {
    throw new CorruptDatabaseError("Ledger AI rusak.");
  }
  return {
    id: String(row.id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    kind: String(row.kind) as AiRequestRecord["kind"],
    attempt: Number(row.attempt),
    provider,
    model: String(row.model),
    status,
    usage: {
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens:
        row.output_tokens === null ? null : Number(row.output_tokens),
      totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
      cachedInputTokens:
        row.cached_input_tokens === null
          ? null
          : Number(row.cached_input_tokens),
      reasoningTokens:
        row.reasoning_tokens === null ? null : Number(row.reasoning_tokens),
    },
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    finishReason: row.finish_reason === null ? null : String(row.finish_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function gameValue(value: StoredGame): GameDefinition {
  const { revision: _revision, ...game } = value;
  return game;
}

function sessionValue(value: StoredSession): GameSession {
  const { revision: _revision, ...session } = value;
  return session;
}

function assertCounter(value: unknown, label: string): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw new ValidationError(`${label} harus null atau integer >= 0.`);
  }
}

function normalizeUsage(raw: AiUsage | undefined): Required<AiUsage> {
  const usage = raw ?? {};
  const result = {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
  };
  for (const [key, value] of Object.entries(result)) assertCounter(value, key);
  return result;
}

function makeFtsQuery(query: string): string {
  if (query.length > 512) throw new ValidationError("Query terlalu panjang.");
  return [...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .slice(0, 10)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}
const TOPIC_STOP_WORDS: Record<string, true> = {
  a: true,
  an: true,
  and: true,
  are: true,
  at: true,
  about: true,
  can: true,
  could: true,
  did: true,
  do: true,
  for: true,
  from: true,
  go: true,
  head: true,
  here: true,
  i: true,
  in: true,
  is: true,
  it: true,
  ke: true,
  kita: true,
  kamu: true,
  me: true,
  move: true,
  my: true,
  of: true,
  on: true,
  please: true,
  saya: true,
  she: true,
  tell: true,
  the: true,
  there: true,
  they: true,
  this: true,
  to: true,
  travel: true,
  aku: true,
  arrive: true,
  bicara: true,
  berangkat: true,
  berbicara: true,
  dari: true,
  di: true,
  ngobrol: true,
  pindah: true,
  pergi: true,
  cerita: true,
  ceritakan: true,
  tanya: true,
  menuju: true,
  tiba: true,
  talk: true,
  ask: true,
  say: true,
  said: true,
  speak: true,
  where: true,
  what: true,
  now: true,
  current: true,
  currently: true,
  mau: true,
  ingin: true,
  tolong: true,
  tentang: true,
  yang: true,
  dan: true,
  atau: true,
  ini: true,
  itu: true,
  apa: true,
  dengan: true,
  sekitar: true,
  tadi: true,
  sekarang: true,
};

function makeTopicFtsQuery(
  query: string,
  operator: "AND" | "OR",
  omittedTerms?: ReadonlySet<string>,
): string {
  if (Buffer.byteLength(query, "utf8") > 512) {
    throw new ValidationError("Query terlalu panjang.");
  }
  const tokens =
    query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const topic = [
    ...new Set(
      tokens.filter(
        (token) =>
          token.length > 1 &&
          !Object.hasOwn(TOPIC_STOP_WORDS, token) &&
          (!omittedTerms || !omittedTerms.has(token)),
      ),
    ),
  ].slice(0, 10);
  return topic.length
    ? topic
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(` ${operator} `)
    : "";
}

export class GameDatabase {
  readonly #db: DatabaseSync;
  readonly #path: string;
  #closed = false;
  #summaryImmediate: ReturnType<typeof setImmediate> | undefined;
  #summaryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #summaryMaintenanceRunning = false;

  constructor(databasePath: string) {
    if (typeof databasePath !== "string" || !databasePath.trim()) {
      throw new ValidationError("Path database wajib diisi.");
    }
    this.#path = resolve(databasePath);
    this.#db = new DatabaseSync(this.#path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE turns SET status = 'interrupted', error_json = ?, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(
          jsonText({ code: "INTERRUPTED", message: "Server restarted." }),
          now(),
        );
      this.#db
        .prepare(
          "UPDATE ai_requests SET status = 'unknown', updated_at = ? WHERE status = 'running'",
        )
        .run(now());
    });
    this.#scheduleSummaryMaintenance();
  }

  #schemaObjectExists(name: string): boolean {
    return Boolean(
      this.#db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?")
        .get(name),
    );
  }

  #missingSchemaTables(version: number): string[] {
    const existing = new Set(
      this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
        )
        .all()
        .map((row) => String(row.name)),
    );
    const names = [
      "games",
      "sessions",
      "messages",
      "turns",
      "ai_requests",
      "migrations",
    ];
    if (version >= 2) {
      names.push(
        "lore_packs",
        "lore_entries",
        "lore_links",
        "context_telemetry",
        "story_summaries",
        "story_summary_cursors",
      );
    }
    if (version >= 3) {
      names.push("ai_credentials", "ai_profiles", "session_ai_bindings");
    }
    if (version >= 5) names.push("saved_templates");
    return names.filter((name) => !existing.has(name));
  }

  #ensureCoreSchema(): void {
    const rebuildMessagesFts = [
      "messages",
      "messages_fts",
      "messages_ai",
      "messages_ad",
      "messages_au",
    ].some((name) => !this.#schemaObjectExists(name));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY NOT NULL,
        definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
        definition_snapshot_json TEXT NOT NULL CHECK (json_valid(definition_snapshot_json)),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        ai_json TEXT NOT NULL CHECK (json_valid(ai_json)),
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_by_game
        ON sessions(game_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        role TEXT NOT NULL CHECK (role IN ('PLAYER','NPC','NARRATOR','SYSTEM_EVENT')),
        speaker_id TEXT,
        content TEXT NOT NULL,
        check_json TEXT CHECK (check_json IS NULL OR json_valid(check_json)),
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_page ON messages(session_id, sequence);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
        kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','item_use')),
        status TEXT NOT NULL CHECK (status IN ('running','committed','failed','interrupted')),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn_per_session
        ON turns(session_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS ai_requests (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','connection_test')),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter','custom')),
        model TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        finish_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ai_usage_by_session
        ON ai_requests(session_id, created_at);
      CREATE INDEX IF NOT EXISTS ai_usage_by_run
        ON ai_requests(session_id, request_id, attempt);
      CREATE UNIQUE INDEX IF NOT EXISTS ai_attempt_once
        ON ai_requests(session_id, request_id, kind, attempt)
        WHERE request_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS migrations (
        fingerprint TEXT PRIMARY KEY NOT NULL,
        counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
        ids_json TEXT NOT NULL CHECK (json_valid(ids_json)),
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    if (rebuildMessagesFts) {
      this.#db.exec(
        "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')",
      );
    }
  }

  #ensureV2Columns(): void {
    const sessionColumns = this.#db
      .prepare("PRAGMA table_info(sessions)")
      .all();
    if (!sessionColumns.some((column) => column.name === "world_map_json")) {
      this.#db.exec(
        "ALTER TABLE sessions ADD COLUMN world_map_json TEXT CHECK (world_map_json IS NULL OR json_valid(world_map_json))",
      );
    }
    if (!sessionColumns.some((column) => column.name === "lore_refs_json")) {
      this.#db.exec(
        "ALTER TABLE sessions ADD COLUMN lore_refs_json TEXT CHECK (lore_refs_json IS NULL OR json_valid(lore_refs_json))",
      );
    }
    const messageColumns = this.#db
      .prepare("PRAGMA table_info(messages)")
      .all();
    if (!messageColumns.some((column) => column.name === "visibility")) {
      this.#db.exec(
        "ALTER TABLE messages ADD COLUMN visibility TEXT CHECK (visibility IS NULL OR visibility IN ('public','private'))",
      );
    }
    if (!messageColumns.some((column) => column.name === "known_by_json")) {
      this.#db.exec(
        "ALTER TABLE messages ADD COLUMN known_by_json TEXT CHECK (known_by_json IS NULL OR json_valid(known_by_json))",
      );
    }
  }

  #ensureV2Schema(): void {
    const rebuildLoreFts = ["lore_entries", "lore_entries_fts"].some(
      (name) => !this.#schemaObjectExists(name),
    );
    const rebuildSummaryFts = [
      "story_summaries",
      "story_summaries_fts",
      "story_summaries_ai",
      "story_summaries_ad",
      "story_summaries_au",
    ].some((name) => !this.#schemaObjectExists(name));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS lore_packs (
        pack_id TEXT NOT NULL,
        pack_version INTEGER NOT NULL CHECK (pack_version > 0),
        name TEXT NOT NULL,
        description TEXT,
        entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
        link_count INTEGER NOT NULL CHECK (link_count >= 0),
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pack_id, pack_version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS lore_entries (
        pack_id TEXT NOT NULL,
        pack_version INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
        parent_id TEXT,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
        visibility TEXT NOT NULL CHECK (visibility IN ('public','narrator','discovery')),
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        PRIMARY KEY (pack_id, pack_version, entry_id),
        FOREIGN KEY (pack_id, pack_version)
          REFERENCES lore_packs(pack_id, pack_version) ON DELETE CASCADE,
        FOREIGN KEY (pack_id, pack_version, parent_id)
          REFERENCES lore_entries(pack_id, pack_version, entry_id)
          DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE INDEX IF NOT EXISTS lore_entries_by_parent
        ON lore_entries(pack_id, pack_version, parent_id, entry_id);
      CREATE INDEX IF NOT EXISTS lore_entries_by_kind
        ON lore_entries(pack_id, pack_version, kind, visibility, entry_id);
      CREATE TABLE IF NOT EXISTS lore_links (
        pack_id TEXT NOT NULL,
        pack_version INTEGER NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (pack_id, pack_version, from_id, to_id, relation),
        FOREIGN KEY (pack_id, pack_version)
          REFERENCES lore_packs(pack_id, pack_version) ON DELETE CASCADE,
        FOREIGN KEY (pack_id, pack_version, from_id)
          REFERENCES lore_entries(pack_id, pack_version, entry_id)
          ON DELETE CASCADE,
        FOREIGN KEY (pack_id, pack_version, to_id)
          REFERENCES lore_entries(pack_id, pack_version, entry_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS lore_links_by_target
        ON lore_links(pack_id, pack_version, to_id, relation, from_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS lore_entries_fts USING fts5(
        pack_id UNINDEXED, pack_version UNINDEXED, entry_id UNINDEXED,
        name, aliases, summary, body,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS context_telemetry (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        context_chars INTEGER NOT NULL CHECK (context_chars >= 0),
        approximate_tokens INTEGER NOT NULL CHECK (approximate_tokens >= 0),
        token_estimate_method TEXT NOT NULL,
        sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
        selected_lore_ids_json TEXT NOT NULL CHECK (json_valid(selected_lore_ids_json)),
        omissions_json TEXT NOT NULL CHECK (json_valid(omissions_json)),
        tool_calls INTEGER NOT NULL CHECK (tool_calls >= 0),
        repairs INTEGER NOT NULL CHECK (repairs >= 0),
        trace_json TEXT NOT NULL DEFAULT '{"events":[],"dropped":0}' CHECK (json_valid(trace_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id),
        FOREIGN KEY (session_id, request_id)
          REFERENCES turns(session_id, request_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS story_summaries (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
        to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
        summary TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
        known_by_json TEXT NOT NULL CHECK (json_valid(known_by_json)),
        created_at TEXT NOT NULL,
        UNIQUE (session_id, from_sequence, to_sequence, visibility, known_by_json, source_digest)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS story_summaries_by_session
        ON story_summaries(session_id, to_sequence DESC);
      CREATE INDEX IF NOT EXISTS story_summaries_by_scope
        ON story_summaries(session_id, visibility, to_sequence DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS story_summaries_fts USING fts5(
        summary, content='story_summaries', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS story_summaries_ai AFTER INSERT ON story_summaries BEGIN
        INSERT INTO story_summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS story_summaries_ad AFTER DELETE ON story_summaries BEGIN
        INSERT INTO story_summaries_fts(story_summaries_fts, rowid, summary)
        VALUES ('delete', old.rowid, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS story_summaries_au AFTER UPDATE OF summary ON story_summaries BEGIN
        INSERT INTO story_summaries_fts(story_summaries_fts, rowid, summary)
        VALUES ('delete', old.rowid, old.summary);
        INSERT INTO story_summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
      END;
      CREATE TABLE IF NOT EXISTS story_summary_cursors (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0)
      ) STRICT;
    `);
    if (rebuildLoreFts) {
      this.#db.exec(`
        DELETE FROM lore_entries_fts;
        INSERT INTO lore_entries_fts(
          pack_id, pack_version, entry_id, name, aliases, summary, body
        )
        SELECT e.pack_id, e.pack_version, e.entry_id, e.name,
          COALESCE(
            (SELECT group_concat(value, ' ') FROM json_each(e.aliases_json)),
            ''
          ),
          e.summary, e.body
        FROM lore_entries e;
      `);
    }
    if (rebuildSummaryFts) {
      this.#db.exec(
        "INSERT INTO story_summaries_fts(story_summaries_fts) VALUES ('rebuild')",
      );
    }
  }

  #ensureV3Schema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ai_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter','custom')),
        base_url TEXT,
        CHECK (
          (provider = 'custom' AND base_url IS NOT NULL) OR
          (provider <> 'custom' AND base_url IS NULL)
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ai_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL REFERENCES ai_credentials(id),
        model TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_ai_bindings (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES ai_profiles(id),
        credential_id TEXT NOT NULL REFERENCES ai_credentials(id)
      ) STRICT;
    `);
  }

  #ensureV4Schema(): void {
    const columns = this.#db
      .prepare("PRAGMA table_info(context_telemetry)")
      .all();
    if (!columns.some((column) => column.name === "trace_json")) {
      this.#db.exec(
        `ALTER TABLE context_telemetry ADD COLUMN trace_json TEXT NOT NULL DEFAULT '{"events":[],"dropped":0}' CHECK (json_valid(trace_json))`,
      );
    }
  }
  #ensureV5Schema(): void {
    const columns = this.#db.prepare("PRAGMA table_info(sessions)").all();
    if (!columns.some((column) => column.name === "name")) {
      this.#db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
    }
    if (!columns.some((column) => column.name === "pinned")) {
      this.#db.exec(
        "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))",
      );
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS saved_templates (
        id TEXT PRIMARY KEY NOT NULL,
        bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  #ensureAiRequestProviderCheck(): void {
    const table = this.#db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_requests'",
      )
      .get() as SqlRow | undefined;
    if (!table || String(table.sql).includes("'custom'")) return;
    this.#db.exec(`
      ALTER TABLE ai_requests RENAME TO ai_requests_schema_v2;
      DROP INDEX IF EXISTS ai_usage_by_session;
      DROP INDEX IF EXISTS ai_usage_by_run;
      DROP INDEX IF EXISTS ai_attempt_once;
      CREATE TABLE ai_requests (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','connection_test')),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter','custom')),
        model TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        finish_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO ai_requests (
        id, session_id, request_id, kind, attempt, provider, model,
        input_tokens, output_tokens, total_tokens, cached_input_tokens,
        reasoning_tokens, status, latency_ms, finish_reason, created_at, updated_at
      )
      SELECT
        id, session_id, request_id, kind, attempt, provider, model,
        input_tokens, output_tokens, total_tokens, cached_input_tokens,
        reasoning_tokens, status, latency_ms, finish_reason, created_at, updated_at
      FROM ai_requests_schema_v2;
      DROP TABLE ai_requests_schema_v2;
      CREATE INDEX IF NOT EXISTS ai_usage_by_session
        ON ai_requests(session_id, created_at);
      CREATE INDEX IF NOT EXISTS ai_usage_by_run
        ON ai_requests(session_id, request_id, attempt);
      CREATE UNIQUE INDEX IF NOT EXISTS ai_attempt_once
        ON ai_requests(session_id, request_id, kind, attempt)
        WHERE request_id IS NOT NULL;
    `);
  }

  #migrate(): void {
    const version = Number(
      (this.#db.prepare("PRAGMA user_version").get() as SqlRow).user_version,
    );
    if (version > SCHEMA_VERSION) {
      throw new DatabaseError(
        `Database schema ${version} lebih baru dari dukungan ${SCHEMA_VERSION}.`,
        "SCHEMA_VERSION",
      );
    }
    if (
      version !== 0 &&
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== SCHEMA_VERSION
    ) {
      throw new DatabaseError(
        `Database schema ${version} tidak didukung.`,
        "SCHEMA_VERSION",
      );
    }
    const missingTables =
      version === 0 ? [] : this.#missingSchemaTables(version);
    this.#transaction(() => {
      this.#ensureCoreSchema();
      this.#ensureV2Columns();
      this.#ensureV2Schema();
      this.#ensureV3Schema();
      this.#ensureV4Schema();
      this.#ensureV5Schema();
      this.#ensureAiRequestProviderCheck();
      if (version !== SCHEMA_VERSION) {
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      }
    });
    if (missingTables.length > 0) {
      console.warn(
        "[fworld] SQLite recreated missing tables; deleted rows are not restored. Restore a backup to recover them; derived search indexes are rebuilt.",
        { tables: missingTables },
      );
    }
  }
  #scheduleSummaryMaintenance(delay = 0): void {
    if (this.#closed) return;
    if (delay > 0) {
      if (this.#summaryRetryTimer) return;
      this.#summaryRetryTimer = setTimeout(() => {
        this.#summaryRetryTimer = undefined;
        this.#scheduleSummaryMaintenance();
      }, delay);
      this.#summaryRetryTimer.unref();
      return;
    }
    if (this.#summaryImmediate || this.#summaryMaintenanceRunning) return;
    if (this.#summaryRetryTimer) {
      clearTimeout(this.#summaryRetryTimer);
      this.#summaryRetryTimer = undefined;
    }
    this.#summaryImmediate = setImmediate(() => {
      this.#summaryImmediate = undefined;
      this.#reconcileSummaryBatch();
    });
    this.#summaryImmediate.unref();
  }

  #reconcileSummaryBatch(): void {
    if (this.#closed || this.#summaryMaintenanceRunning) return;
    this.#summaryMaintenanceRunning = true;
    let failed = false;
    try {
      const sessions = this.#db
        .prepare(
          `SELECT s.id FROM sessions s
           LEFT JOIN story_summary_cursors c ON c.session_id = s.id
           WHERE s.next_sequence > COALESCE(c.next_sequence, 0)
           ORDER BY s.updated_at DESC, s.id LIMIT 8`,
        )
        .all() as SqlRow[];
      for (const row of sessions) {
        try {
          this.compactStory(String(row.id));
        } catch {
          failed = true;
        }
      }
    } catch {
      failed = true;
    } finally {
      this.#summaryMaintenanceRunning = false;
      if (failed || this.#closed) {
        this.#scheduleSummaryMaintenance(SUMMARY_IDLE_RETRY_MS);
        return;
      }
      let pending = false;
      try {
        pending = Boolean(
          this.#db
            .prepare(
              `SELECT 1 AS found FROM sessions s
               LEFT JOIN story_summary_cursors c ON c.session_id = s.id
               WHERE s.next_sequence > COALESCE(c.next_sequence, 0) LIMIT 1`,
            )
            .get(),
        );
      } catch {
        this.#scheduleSummaryMaintenance(SUMMARY_IDLE_RETRY_MS);
        return;
      }
      this.#scheduleSummaryMaintenance(pending ? 0 : SUMMARY_IDLE_RETRY_MS);
    }
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new DatabaseError("Database sudah ditutup.", "CLOSED");
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original SQLite or validation error.
      }
      throw error;
    }
  }

  #getGameRow(id: string): SqlRow | undefined {
    return this.#db.prepare("SELECT * FROM games WHERE id = ?").get(id) as
      SqlRow | undefined;
  }

  #gameFromRow(row: SqlRow): StoredGame {
    const raw = parseJson<unknown>(
      row.definition_json as string,
      "Game definition",
    );
    const definition = validateDefinitionDocument(raw);
    if (definition.id !== row.id) {
      throw new CorruptDatabaseError(
        "Game id tidak cocok dengan row database.",
      );
    }
    return { ...definition, revision: Number(row.revision) };
  }

  #getSessionRow(id: string): SqlRow | undefined {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      SqlRow | undefined;
  }

  #sessionFromRow(row: SqlRow): StoredSession {
    const definitionSnapshot = validateDefinitionDocument(
      parseJson(row.definition_snapshot_json as string, "Session definition"),
    );
    const state = parseJson<SessionState>(
      row.state_json as string,
      "Session state",
    );
    const ai = normalizeAi(
      parseJson(row.ai_json as string, "Session AI config"),
    );
    const session: GameSession = {
      id: String(row.id),
      gameId: String(row.game_id),
      definitionSnapshot,
      state,
      ai,
      nextSequence: Number(row.next_sequence),
      updatedAt: String(row.updated_at),
    };
    const pinned = Number(row.pinned);
    if (pinned !== 0 && pinned !== 1) {
      throw new CorruptDatabaseError("Session pinned rusak.");
    }
    if (row.name !== null) {
      if (typeof row.name !== "string") {
        throw new CorruptDatabaseError("Session name rusak.");
      }
      try {
        session.name = normalizeSessionName(row.name);
      } catch {
        throw new CorruptDatabaseError("Session name rusak.");
      }
    }
    session.pinned = pinned === 1;
    try {
      if (row.world_map_json !== null) {
        session.worldMap = parseWorldMap(
          parseJson(row.world_map_json as string, "Session world map"),
          definitionSnapshot.npcs.map((npc) => npc.id),
        );
      }
      if (row.lore_refs_json !== null) {
        session.lorebookRefs = parseLoreRefs(
          parseJson(
            row.lore_refs_json as string,
            "Session lorebook references",
          ),
        );
      }
    } catch (error) {
      throw new CorruptDatabaseError(
        `Session world pins tidak valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !sameLoreRefs(
        parseLoreRefs(definitionSnapshot.lorebookRefs ?? []),
        parseLoreRefs(session.lorebookRefs ?? []),
      )
    ) {
      throw new CorruptDatabaseError(
        "Session lorebook references tidak cocok dengan snapshot.",
      );
    }
    assertId(session.id, "session.id");
    assertId(session.gameId, "session.gameId");
    if (definitionSnapshot.id !== session.gameId) {
      throw new CorruptDatabaseError("Session game reference tidak cocok.");
    }
    const stateOnly = { ...session, nextSequence: 0 };
    try {
      validateExportBundle(makeBundle(definitionSnapshot, stateOnly, []));
    } catch (error) {
      throw new CorruptDatabaseError(
        `Session state tidak valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const max = this.#db
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM messages WHERE session_id = ?",
      )
      .get(session.id) as SqlRow;
    const expected = max.sequence === null ? 0 : Number(max.sequence) + 1;
    if (session.nextSequence !== expected) {
      throw new CorruptDatabaseError(
        "Session nextSequence tidak sesuai history.",
      );
    }
    return { ...session, revision: Number(row.revision) };
  }

  #messageFromRow(row: SqlRow): Message {
    const role = String(row.role);
    if (!ROLES.has(role)) throw new CorruptDatabaseError("Message role rusak.");
    const message: Message = {
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: String(row.turn_id),
      sequence: Number(row.sequence),
      role: role as Message["role"],
      content: String(row.content),
      createdAt: String(row.created_at),
    };
    if (row.speaker_id !== null) message.speakerId = String(row.speaker_id);
    if (row.visibility !== null) {
      if (row.visibility !== "public" && row.visibility !== "private") {
        throw new CorruptDatabaseError("Message visibility rusak.");
      }
      message.visibility = row.visibility;
    }
    if (row.known_by_json !== null) {
      message.knownBy = parseJson(
        row.known_by_json as string,
        "Message knowledge",
      );
    }
    if (row.check_json !== null) {
      message.check = parseJson(row.check_json as string, "Message check");
    }
    assertId(message.id, "message.id");
    assertId(message.sessionId, "message.sessionId");
    assertId(message.turnId, "message.turnId");
    assertSequence(message.sequence);
    if (Buffer.byteLength(message.content, "utf8") > DOCUMENT_LIMIT) {
      throw new CorruptDatabaseError("Message content melampaui batas.");
    }
    return message;
  }

  #messages(
    sessionId: string,
    after = -1,
    limit = Number.MAX_SAFE_INTEGER,
  ): Message[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(sessionId, after, limit) as SqlRow[];
    return rows.map((row) => this.#messageFromRow(row));
  }
  #checkExpected(actual: number, expected: number, label: string): void {
    assertRevision(expected);
    if (actual !== expected) {
      throw new ConflictError(
        `${label} revision conflict: expected ${expected}, found ${actual}.`,
      );
    }
  }

  #assertNoRunningRun(sessionId: string): void {
    const running = this.#db
      .prepare(
        "SELECT 1 AS found FROM turns WHERE session_id = ? AND status = 'running'",
      )
      .get(sessionId);
    if (running)
      throw new ConflictError(
        "Session sedang menjalankan turn.",
        "RUN_IN_PROGRESS",
      );
  }

  #insertGame(definition: GameDefinition, revision = 1): void {
    this.#db
      .prepare(
        "INSERT INTO games(id, definition_json, revision, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(definition.id, jsonText(definition), revision, definition.updatedAt);
  }

  #insertSession(session: GameSession, revision = 1): void {
    this.#db
      .prepare(
        `INSERT INTO sessions(
           id, game_id, definition_snapshot_json, state_json, ai_json,
           next_sequence, revision, updated_at, world_map_json, lore_refs_json,
           name, pinned
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.gameId,
        jsonText(session.definitionSnapshot),
        jsonText(session.state),
        jsonText(session.ai),
        session.nextSequence,
        revision,
        session.updatedAt,
        session.worldMap === undefined ? null : jsonText(session.worldMap),
        session.lorebookRefs === undefined
          ? null
          : jsonText(session.lorebookRefs),
        session.name ?? null,
        session.pinned === true ? 1 : 0,
      );
  }

  #insertMessage(message: Message): void {
    this.#db
      .prepare(
        `INSERT INTO messages(
           id, session_id, turn_id, sequence, role, speaker_id, content,
           check_json, created_at, visibility, known_by_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.turnId,
        message.sequence,
        message.role,
        message.speakerId ?? null,
        message.content,
        message.check === undefined ? null : jsonText(message.check),
        message.createdAt,
        message.visibility ?? null,
        message.knownBy === undefined ? null : jsonText(message.knownBy),
      );
  }
  #packRow(ref: LorebookRef): SqlRow | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM lore_packs WHERE pack_id = ? AND pack_version = ?",
      )
      .get(ref.packId, ref.version) as SqlRow | undefined;
  }

  #packHeaderFromRow(row: SqlRow): LorePackHeader {
    return {
      id: String(row.pack_id),
      version: Number(row.pack_version),
      name: String(row.name),
      ...(row.description === null
        ? {}
        : { description: String(row.description) }),
      entryCount: Number(row.entry_count),
      linkCount: Number(row.link_count),
      digest: String(row.digest),
    };
  }

  #loreEntryFromRow(row: SqlRow): LoreEntry {
    const rawEntry: Record<string, unknown> = {
      id: String(row.entry_id),
      kind: String(row.kind),
      name: String(row.name),
      aliases: parseJson(row.aliases_json as string, "Lore aliases"),
      summary: String(row.summary),
      body: String(row.body),
      tags: parseJson(row.tags_json as string, "Lore tags"),
      visibility: String(row.visibility),
      metadata: parseJson(row.metadata_json as string, "Lore metadata"),
      provenance: parseJson(row.provenance_json as string, "Lore provenance"),
    };
    if (row.parent_id !== null) {
      assertId(row.parent_id, "Lore parent id");
      rawEntry.parentId = String(row.parent_id);
    }
    const withoutParent = { ...rawEntry };
    delete withoutParent.parentId;
    try {
      const checked = parseLorebookPack({
        format: "fworld-lorebook",
        version: 1,
        pack: { id: "database-row", version: 1, name: "Database row" },
        entries: [withoutParent],
        links: [],
      }).entries[0];
      if (!checked) throw new CorruptDatabaseError("Lore entry rusak.");
      if (typeof rawEntry.parentId === "string") {
        checked.parentId = rawEntry.parentId;
      }
      return checked;
    } catch (error) {
      throw new CorruptDatabaseError(
        `Lore entry rusak: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #loreEntryRow(ref: LorebookRef, entryId: string): SqlRow | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM lore_entries
         WHERE pack_id = ? AND pack_version = ? AND entry_id = ?`,
      )
      .get(ref.packId, ref.version, entryId) as SqlRow | undefined;
  }
  #addPinnedLocationIdentity(
    refs: LorebookRef[],
    locationId: string,
    localLocationIds: Set<string>,
    addIdentityTerms: (value: string) => void,
  ): void {
    const refsJson = jsonText(refs);
    const refClause = refs.length
      ? "s.lore_refs_json = ?"
      : "(s.lore_refs_json IS NULL OR s.lore_refs_json = '[]')";
    let ids = [locationId];
    const visited = new Set<string>();
    for (let depth = 0; depth < 16 && ids.length; depth += 1) {
      ids = ids.filter((id) => {
        if (visited.has(id)) return false;
        visited.add(id);
        return true;
      });
      if (ids.length === 0) break;
      const rows = this.#db
        .prepare(
          `SELECT json_extract(location.value, '$.id') AS id,
             json_extract(location.value, '$.name') AS name,
             json_extract(location.value, '$.aliases') AS aliases_json,
             json_extract(location.value, '$.parentId') AS parent_id
           FROM sessions s, json_each(s.world_map_json, '$.locations') location
           WHERE ${refClause}
             AND json_extract(s.state_json, '$.world.locationId') = ?
             AND json_extract(location.value, '$.id') IN (${ids.map(() => "?").join(",")})
           LIMIT 256`,
        )
        .all(
          ...(refs.length ? [refsJson] : []),
          locationId,
          ...ids,
        ) as SqlRow[];
      const parents = new Set<string>();
      for (const row of rows) {
        if (typeof row.id === "string") {
          localLocationIds.add(row.id);
          addIdentityTerms(row.id);
        }
        if (typeof row.name === "string") addIdentityTerms(row.name);
        if (row.aliases_json !== null) {
          const aliases = parseJson<unknown>(
            String(row.aliases_json),
            "Pinned location aliases",
          );
          if (Array.isArray(aliases)) {
            for (const alias of aliases) {
              if (typeof alias === "string") addIdentityTerms(alias);
            }
          }
        }
        if (typeof row.parent_id === "string") parents.add(row.parent_id);
      }
      ids = [...parents];
    }
  }

  #requirePack(ref: LorebookRef): SqlRow {
    const [checked] = parseLoreRefs([ref]);
    const row = checked ? this.#packRow(checked) : undefined;
    if (!row) {
      throw new NotFoundError(
        `Lorebook ${ref.packId}@${ref.version} tidak ditemukan.`,
      );
    }
    return row;
  }

  importLorebook(
    raw: unknown,
    options: { dryRun?: boolean } = {},
  ): {
    pack: LorePackHeader;
    entries: number;
    links: number;
    digest: string;
    dryRun: boolean;
    existing: boolean;
  } {
    if (
      !isObject(options) ||
      Object.keys(options).some((key) => key !== "dryRun")
    ) {
      throw new ValidationError("Opsi import lorebook tidak dikenal.");
    }
    if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
      throw new ValidationError("dryRun harus boolean.");
    }
    const pack = canonicalLorebook(parseLorebook(raw));
    const digest = createHash("sha256")
      .update(canonicalJson(pack))
      .digest("hex");
    const ref = { packId: pack.pack.id, version: pack.pack.version };
    const existing = this.#packRow(ref);
    if (existing && String(existing.digest) !== digest) {
      throw new ConflictError(
        `Lorebook ${ref.packId}@${ref.version} sudah diterbitkan dengan konten berbeda.`,
        "LOREBOOK_VERSION_CONFLICT",
      );
    }
    const dryRun = options.dryRun ?? false;
    const header: LorePackHeader = {
      id: ref.packId,
      version: ref.version,
      name: pack.pack.name,
      ...(pack.pack.description === undefined
        ? {}
        : { description: pack.pack.description }),
      entryCount: pack.entries.length,
      linkCount: pack.links.length,
      digest,
    };
    if (dryRun || existing) {
      return {
        pack: header,
        entries: pack.entries.length,
        links: pack.links.length,
        digest,
        dryRun,
        existing: Boolean(existing),
      };
    }
    this.#transaction(() => {
      const raced = this.#packRow(ref);
      if (raced) {
        if (String(raced.digest) !== digest) {
          throw new ConflictError(
            `Lorebook ${ref.packId}@${ref.version} sudah diterbitkan dengan konten berbeda.`,
            "LOREBOOK_VERSION_CONFLICT",
          );
        }
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO lore_packs(
             pack_id, pack_version, name, description, entry_count, link_count,
             digest, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ref.packId,
          ref.version,
          pack.pack.name,
          pack.pack.description ?? null,
          pack.entries.length,
          pack.links.length,
          digest,
          now(),
        );
      const insertEntry = this.#db.prepare(
        `INSERT INTO lore_entries(
           pack_id, pack_version, entry_id, kind, name, aliases_json, parent_id,
           summary, body, tags_json, visibility, metadata_json, provenance_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.#db.prepare(
        `INSERT INTO lore_entries_fts(
           pack_id, pack_version, entry_id, name, aliases, summary, body
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (
        let offset = 0;
        offset < pack.entries.length;
        offset += LOREBOOK_BATCH_SIZE
      ) {
        for (const entry of pack.entries.slice(
          offset,
          offset + LOREBOOK_BATCH_SIZE,
        )) {
          insertEntry.run(
            ref.packId,
            ref.version,
            entry.id,
            entry.kind,
            entry.name,
            jsonText(entry.aliases),
            entry.parentId ?? null,
            entry.summary,
            entry.body,
            jsonText(entry.tags),
            entry.visibility,
            jsonText(entry.metadata),
            jsonText(entry.provenance),
          );
          insertFts.run(
            ref.packId,
            ref.version,
            entry.id,
            entry.name,
            entry.aliases.join(" "),
            entry.summary,
            entry.body,
          );
        }
      }
      const insertLink = this.#db.prepare(
        `INSERT INTO lore_links(pack_id, pack_version, from_id, to_id, relation)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (
        let offset = 0;
        offset < pack.links.length;
        offset += LOREBOOK_BATCH_SIZE
      ) {
        for (const link of pack.links.slice(
          offset,
          offset + LOREBOOK_BATCH_SIZE,
        )) {
          insertLink.run(
            ref.packId,
            ref.version,
            link.fromId,
            link.toId,
            link.relation,
          );
        }
      }
    });
    return {
      pack: header,
      entries: pack.entries.length,
      links: pack.links.length,
      digest,
      dryRun: false,
      existing: false,
    };
  }

  listLorebooks(options: { limit?: number; offset?: number } = {}): {
    packs: LorePackHeader[];
    total: number;
  } {
    this.#assertOpen();
    const { limit, offset } = pageOptions(options);
    const total = Number(
      (
        this.#db
          .prepare("SELECT COUNT(*) AS total FROM lore_packs")
          .get() as SqlRow
      ).total,
    );
    const rows = this.#db
      .prepare(
        `SELECT * FROM lore_packs
         ORDER BY created_at DESC, pack_id, pack_version DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as SqlRow[];
    return { packs: rows.map((row) => this.#packHeaderFromRow(row)), total };
  }

  validateLoreBindings(
    rawRefs: LorebookRef[],
    rawDefinition?: GameDefinition,
  ): void {
    this.#assertOpen();
    const refs = parseLoreRefs(rawRefs);
    const definition =
      rawDefinition === undefined
        ? undefined
        : validateDefinitionDocument(rawDefinition);
    const knownNpcIds = new Set(definition?.npcs.map((npc) => npc.id) ?? []);
    const knownItemIds = new Set(
      definition?.items.map((item) => item.id) ?? [],
    );
    const entryIds = new Set<string>();
    for (const ref of refs) {
      const pack = this.#packRow(ref);
      if (!pack) {
        throw new ConflictError(
          `Lore dependency ${ref.packId}@${ref.version} belum dipasang.`,
          "LORE_DEPENDENCY_MISSING",
        );
      }
      const rows = this.#db
        .prepare(
          `SELECT entry_id, metadata_json FROM lore_entries
           WHERE pack_id = ? AND pack_version = ? ORDER BY entry_id`,
        )
        .all(ref.packId, ref.version) as SqlRow[];
      for (const row of rows) {
        const entryId = String(row.entry_id);
        if (entryIds.has(entryId)) {
          throw new ConflictError(
            `Lore entry ID ${entryId} muncul pada lebih dari satu pack.`,
            "INVALID_LORE_BINDING",
          );
        }
        entryIds.add(entryId);
        const metadata = parseJson<unknown>(
          row.metadata_json as string,
          "Lore metadata",
        );
        if (!isObject(metadata)) {
          throw new CorruptDatabaseError("Lore metadata bukan object.");
        }
        if (
          definition &&
          typeof metadata.actorId === "string" &&
          !knownNpcIds.has(metadata.actorId)
        ) {
          throw new ConflictError(
            `Lore entry ${entryId} merujuk NPC ${metadata.actorId} yang tidak dikonfigurasi.`,
            "INVALID_LORE_BINDING",
          );
        }
        if (
          definition &&
          typeof metadata.itemId === "string" &&
          !knownItemIds.has(metadata.itemId)
        ) {
          throw new ConflictError(
            `Lore entry ${entryId} merujuk item ${metadata.itemId} yang tidak dikonfigurasi.`,
            "INVALID_LORE_BINDING",
          );
        }
      }
    }
  }

  getLoreEntry(refs: LorebookRef[], entryId: string): LoreEntry | undefined {
    assertId(entryId, "lore.entryId");
    const checkedRefs = parseLoreRefs(refs);
    const matches: LoreEntry[] = [];
    for (const ref of checkedRefs) {
      this.#requirePack(ref);
      const row = this.#loreEntryRow(ref, entryId);
      if (row) matches.push(this.#loreEntryFromRow(row));
    }
    if (matches.length > 1) {
      throw new ConflictError(
        `Lore entry ID ${entryId} muncul pada lebih dari satu pack.`,
        "INVALID_LORE_BINDING",
      );
    }
    return matches[0];
  }

  listLoreEntries(
    ref: LorebookRef,
    options: {
      query?: string;
      kind?: LoreKind;
      parentId?: string;
      limit?: number;
      offset?: number;
      discoveredLoreIds?: string[];
    } = {},
  ): { entries: LoreEntry[]; total: number } {
    this.#assertOpen();
    this.#requirePack(ref);
    const { limit, offset } = pageOptions(options);
    if (options.kind !== undefined && !isLoreKind(options.kind)) {
      throw new ValidationError("Lore kind tidak dikenal.");
    }
    if (options.parentId !== undefined) assertId(options.parentId, "parentId");
    const discoveredLoreIds = options.discoveredLoreIds ?? [];
    if (!Array.isArray(discoveredLoreIds) || discoveredLoreIds.length > 500) {
      throw new ValidationError("discoveredLoreIds melampaui batas.");
    }
    for (const id of discoveredLoreIds) assertId(id, "discoveredLoreId");
    const where = [
      "e.pack_id = ?",
      "e.pack_version = ?",
      discoveredLoreIds.length === 0
        ? "e.visibility = 'public'"
        : `(e.visibility = 'public' OR (e.visibility = 'discovery' AND e.entry_id IN (${discoveredLoreIds.map(() => "?").join(",")})))`,
    ];
    const params: (string | number)[] = [
      ref.packId,
      ref.version,
      ...discoveredLoreIds,
    ];
    if (options.kind !== undefined) {
      where.push("e.kind = ?");
      params.push(options.kind);
    }
    if (options.parentId !== undefined) {
      where.push("e.parent_id = ?");
      params.push(options.parentId);
    }
    const query = options.query;
    if (query !== undefined && typeof query !== "string") {
      throw new ValidationError("Query lore harus string.");
    }
    const trimmed = query?.trim();
    const ftsQuery = trimmed ? makeFtsQuery(trimmed) : "";
    if (trimmed && !ftsQuery) return { entries: [], total: 0 };
    const join = ftsQuery
      ? `JOIN lore_entries_fts
           ON lore_entries_fts.pack_id = e.pack_id
          AND lore_entries_fts.pack_version = e.pack_version
          AND lore_entries_fts.entry_id = e.entry_id`
      : "";
    if (ftsQuery) {
      where.push("lore_entries_fts MATCH ?");
      params.push(ftsQuery);
    }
    const whereSql = where.join(" AND ");
    const total = Number(
      (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS total FROM lore_entries e ${join}
             WHERE ${whereSql}`,
          )
          .get(...params) as SqlRow
      ).total,
    );
    const exactMatch = trimmed ?? "";
    const order = ftsQuery
      ? `CASE WHEN lower(e.entry_id) = lower(?) OR lower(e.name) = lower(?)
           OR EXISTS (SELECT 1 FROM json_each(e.aliases_json) a WHERE lower(a.value) = lower(?))
         THEN 0 ELSE 1 END, bm25(lore_entries_fts), e.entry_id`
      : "e.kind, e.name COLLATE NOCASE, e.entry_id";
    const rows = this.#db
      .prepare(
        `SELECT e.* FROM lore_entries e ${join} WHERE ${whereSql}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(
        ...params,
        ...(ftsQuery ? [exactMatch, exactMatch, exactMatch] : []),
        limit,
        offset,
      ) as SqlRow[];
    return { entries: rows.map((row) => this.#loreEntryFromRow(row)), total };
  }

  listLoreLinks(
    ref: LorebookRef,
    entryId: string,
    options: { limit?: number; offset?: number } = {},
  ): { links: LoreLink[]; total: number } {
    this.#assertOpen();
    this.#requirePack(ref);
    assertId(entryId, "lore.entryId");
    const { limit, offset } = pageOptions(options);
    const visible = `l.pack_id = ? AND l.pack_version = ?
      AND (l.from_id = ? OR l.to_id = ?)
      AND source.visibility = 'public' AND target.visibility = 'public'`;
    const params = [ref.packId, ref.version, entryId, entryId];
    const total = Number(
      (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS total FROM lore_links l
             JOIN lore_entries source ON source.pack_id = l.pack_id
              AND source.pack_version = l.pack_version AND source.entry_id = l.from_id
             JOIN lore_entries target ON target.pack_id = l.pack_id
              AND target.pack_version = l.pack_version AND target.entry_id = l.to_id
             WHERE ${visible}`,
          )
          .get(...params) as SqlRow
      ).total,
    );
    const rows = this.#db
      .prepare(
        `SELECT l.from_id, l.to_id, l.relation FROM lore_links l
         JOIN lore_entries source ON source.pack_id = l.pack_id
          AND source.pack_version = l.pack_version AND source.entry_id = l.from_id
         JOIN lore_entries target ON target.pack_id = l.pack_id
          AND target.pack_version = l.pack_version AND target.entry_id = l.to_id
         WHERE ${visible}
         ORDER BY l.from_id, l.relation, l.to_id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SqlRow[];
    return {
      links: rows.map((row) => ({
        fromId: String(row.from_id),
        toId: String(row.to_id),
        relation: loreLinkRelation(row.relation),
      })),
      total,
    };
  }

  exportLorebook(ref: LorebookRef): LorebookPack {
    this.#assertOpen();
    const packRow = this.#requirePack(ref);
    const entryRows = this.#db
      .prepare(
        `SELECT * FROM lore_entries
         WHERE pack_id = ? AND pack_version = ? ORDER BY entry_id`,
      )
      .all(ref.packId, ref.version) as SqlRow[];
    const linkRows = this.#db
      .prepare(
        `SELECT from_id, to_id, relation FROM lore_links
         WHERE pack_id = ? AND pack_version = ?
         ORDER BY from_id, to_id, relation`,
      )
      .all(ref.packId, ref.version) as SqlRow[];
    const header = this.#packHeaderFromRow(packRow);
    const pack: LorebookPack = {
      format: "fworld-lorebook",
      version: 1,
      pack: {
        id: header.id,
        version: header.version,
        name: header.name,
        ...(header.description === undefined
          ? {}
          : { description: header.description }),
      },
      entries: entryRows.map((row) => this.#loreEntryFromRow(row)),
      links: linkRows.map((row) => ({
        fromId: String(row.from_id),
        toId: String(row.to_id),
        relation: loreLinkRelation(row.relation),
      })),
    };
    return parseLorebook(pack);
  }
  #compileDefinitionWorldMap(definition: GameDefinition): WorldMap | undefined {
    const refs =
      definition.lorebookRefs === undefined
        ? []
        : parseLoreRefs(definition.lorebookRefs);
    this.validateLoreBindings(refs, definition);
    const knownNpcIds = definition.npcs.map((npc) => npc.id);
    const base: WorldMap = definition.worldMap
      ? parseWorldMap(definition.worldMap, knownNpcIds)
      : { locations: [], connections: [], flags: {} };
    const flags = { ...(base.flags ?? {}) };
    const locations = new Map(
      base.locations.map((location) => [
        location.id,
        structuredClone(location),
      ]),
    );
    const entries = new Map<string, LoreEntry>();
    const links: LoreLink[] = [];
    for (const ref of refs) {
      const rows = this.#db
        .prepare(
          `SELECT * FROM lore_entries
           WHERE pack_id = ? AND pack_version = ? AND visibility = 'public'
             AND kind IN ('location','place','npc')
           ORDER BY entry_id`,
        )
        .all(ref.packId, ref.version) as SqlRow[];
      for (const row of rows) {
        const entry = this.#loreEntryFromRow(row);
        entries.set(entry.id, entry);
        if (entry.kind !== "location" && entry.kind !== "place") continue;
        const current = locations.get(entry.id);
        const location = current ?? {
          id: entry.id,
          name: entry.name,
          aliases: [],
          npcIds: [],
        };
        location.name = current?.name ?? entry.name;
        location.aliases = [
          ...new Set([...location.aliases, ...entry.aliases]),
        ];
        if (location.summary === undefined && entry.summary) {
          location.summary = entry.summary;
        }
        if (
          location.parentId === undefined &&
          entry.parentId !== undefined &&
          locations.has(entry.parentId)
        ) {
          location.parentId = entry.parentId;
        }
        if (
          location.requiredFlag === undefined &&
          entry.metadata.requiredFlag !== undefined
        ) {
          location.requiredFlag = entry.metadata.requiredFlag;
          flags[entry.metadata.requiredFlag] ??= false;
        }
        locations.set(entry.id, location);
      }
      const linkRows = this.#db
        .prepare(
          `SELECT from_id, to_id, relation FROM lore_links
           WHERE pack_id = ? AND pack_version = ?
             AND relation IN ('PARENT_OF','CONNECTED_TO','LOCATED_IN','PRESENT_AT')
           ORDER BY from_id, to_id, relation`,
        )
        .all(ref.packId, ref.version) as SqlRow[];
      for (const row of linkRows) {
        links.push({
          fromId: String(row.from_id),
          toId: String(row.to_id),
          relation: loreLinkRelation(row.relation),
        });
      }
    }
    const ensureFlag = (flag: string | undefined): void => {
      if (flag !== undefined && !Object.hasOwn(flags, flag))
        flags[flag] = false;
    };
    const addNpc = (locationId: string, npcId: string): void => {
      const visited = new Set<string>();
      let currentId: string | undefined = locationId;
      while (currentId !== undefined && !visited.has(currentId)) {
        visited.add(currentId);
        const location = locations.get(currentId);
        if (!location) break;
        if (!location.npcIds.includes(npcId)) location.npcIds.push(npcId);
        currentId = location.parentId;
      }
    };
    const actorIdByEntry = new Map<string, string>();
    for (const entry of entries.values()) {
      if (entry.kind === "npc" && entry.metadata.actorId) {
        actorIdByEntry.set(entry.id, entry.metadata.actorId);
        if (entry.parentId && locations.has(entry.parentId)) {
          addNpc(entry.parentId, entry.metadata.actorId);
        }
      }
      if (
        entry.parentId &&
        locations.has(entry.id) &&
        locations.has(entry.parentId)
      ) {
        const location = locations.get(entry.id);
        if (location && location.parentId === undefined) {
          location.parentId = entry.parentId;
        }
      }
    }
    const connectionKeys = new Set(
      base.connections.map((edge) =>
        [edge.fromId, edge.toId].sort().join("\u0000"),
      ),
    );
    for (const link of links) {
      if (link.relation === "PARENT_OF") {
        const parent = locations.get(link.fromId);
        const child = locations.get(link.toId);
        if (parent && child && child.parentId === undefined) {
          child.parentId = parent.id;
        }
      } else if (link.relation === "LOCATED_IN") {
        const child = locations.get(link.fromId);
        const parent = locations.get(link.toId);
        if (parent && child && child.parentId === undefined) {
          child.parentId = parent.id;
        }
      } else if (link.relation === "CONNECTED_TO") {
        const from = locations.get(link.fromId);
        const to = locations.get(link.toId);
        if (!from || !to || from.id === to.id) continue;
        const key = [from.id, to.id].sort().join("\u0000");
        if (connectionKeys.has(key)) continue;
        const blockedByFlag =
          entries.get(from.id)?.metadata.blockedByFlag ??
          entries.get(to.id)?.metadata.blockedByFlag;
        ensureFlag(blockedByFlag);
        connectionKeys.add(key);
        base.connections.push({
          fromId: from.id,
          toId: to.id,
          ...(blockedByFlag === undefined ? {} : { blockedByFlag }),
        });
      } else if (link.relation === "PRESENT_AT") {
        const fromActor = actorIdByEntry.get(link.fromId);
        const toActor = actorIdByEntry.get(link.toId);
        if (fromActor && locations.has(link.toId)) {
          addNpc(link.toId, fromActor);
        } else if (toActor && locations.has(link.fromId)) {
          addNpc(link.fromId, toActor);
        }
      }
    }
    if (locations.size === 0 && definition.worldMap === undefined) {
      return undefined;
    }
    const worldMap: WorldMap = {
      locations: [...locations.values()]
        .map((location) => ({
          ...location,
          aliases: [...new Set(location.aliases)].sort(),
          npcIds: [...new Set(location.npcIds)].sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      connections: base.connections.sort(
        (a, b) =>
          a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId),
      ),
      flags,
    };
    try {
      return parseWorldMap(worldMap, knownNpcIds);
    } catch (error) {
      throw new ConflictError(
        `World map lore tidak dapat dipin: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_LORE_BINDING",
      );
    }
  }

  getWorldMap(
    sessionOrDefinition: GameSession | GameDefinition,
  ): WorldMap | undefined {
    this.#assertOpen();
    if ("definitionSnapshot" in sessionOrDefinition) {
      if (!sessionOrDefinition.worldMap) return undefined;
      return parseWorldMap(
        sessionOrDefinition.worldMap,
        sessionOrDefinition.definitionSnapshot.npcs.map((npc) => npc.id),
      );
    }
    const definition = validateDefinitionDocument(sessionOrDefinition);
    return this.#compileDefinitionWorldMap(definition);
  }
  #retrieveLoreEntries(
    refs: LorebookRef[],
    options: {
      locationId?: string;
      identityLocations?: WorldLocation[];
      query?: string;
      discoveredLoreIds?: string[];
      limit?: number;
      narrator?: boolean;
      includeUndiscoveredDiscovery?: boolean;
    },
  ): { entries: LoreEntry[]; omitted: boolean } {
    const checkedRefs = parseLoreRefs(refs);
    for (const ref of checkedRefs) this.#requirePack(ref);
    const limit = options.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationError("limit harus integer 1 sampai 50.");
    }
    if (options.query !== undefined && typeof options.query !== "string") {
      throw new ValidationError("Query lore harus string.");
    }
    if (
      options.discoveredLoreIds !== undefined &&
      !Array.isArray(options.discoveredLoreIds)
    ) {
      throw new ValidationError("discoveredLoreIds harus array.");
    }
    const discoveredIds = options.discoveredLoreIds ?? [];
    if (discoveredIds.length > 500) {
      throw new ValidationError("discoveredLoreIds melampaui batas.");
    }
    for (const id of discoveredIds) assertId(id, "discoveredLoreId");
    if (
      options.narrator !== undefined &&
      typeof options.narrator !== "boolean"
    ) {
      throw new ValidationError("narrator harus boolean.");
    }
    if (
      options.query !== undefined &&
      Buffer.byteLength(options.query, "utf8") > 512
    ) {
      throw new ValidationError("Query terlalu panjang.");
    }
    const discovered = new Set(discoveredIds);
    const visibility = (alias: string): string => {
      const clauses = [`${alias}.visibility = 'public'`];
      if (options.narrator) clauses.push(`${alias}.visibility = 'narrator'`);
      if (discovered.size) {
        clauses.push(
          `(${alias}.visibility = 'discovery' AND ${alias}.entry_id IN (${[...discovered].map(() => "?").join(",")}))`,
        );
      }
      if (options.includeUndiscoveredDiscovery && options.locationId) {
        clauses.push(
          `(${alias}.visibility = 'discovery' AND EXISTS (SELECT 1 FROM json_each(${alias}.metadata_json, '$.discoverAt') d WHERE d.value = ?))`,
        );
      }
      return `(${clauses.join(" OR ")})`;
    };
    const visibilityParams = [
      ...discovered,
      ...(options.includeUndiscoveredDiscovery && options.locationId
        ? [options.locationId]
        : []),
    ];
    const localLocationIds = new Set<string>();
    const localAncestorEntries: LoreEntry[] = [];
    const omittedTerms = new Set<string>();
    const addIdentityTerms = (value: string): void => {
      for (const token of value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu) ?? []) {
        omittedTerms.add(token);
      }
    };
    const mayViewEntry = (entry: LoreEntry): boolean =>
      entry.visibility === "public" ||
      (options.narrator === true && entry.visibility === "narrator") ||
      (entry.visibility === "discovery" &&
        (discovered.has(entry.id) ||
          (options.includeUndiscoveredDiscovery === true &&
            options.locationId !== undefined &&
            entry.metadata.discoverAt?.includes(options.locationId) === true)));
    if (options.locationId !== undefined) {
      assertId(options.locationId, "locationId");
      localLocationIds.add(options.locationId);
      const mapLocations = new Map(
        (options.identityLocations ?? []).map((location) => [
          location.id,
          location,
        ]),
      );
      let mapParent: string | undefined = options.locationId;
      const mapVisited = new Set<string>();
      for (let depth = 0; mapParent !== undefined && depth < 16; depth += 1) {
        if (mapVisited.has(mapParent)) break;
        mapVisited.add(mapParent);
        const location = mapLocations.get(mapParent);
        if (!location) break;
        localLocationIds.add(location.id);
        addIdentityTerms(location.id);
        addIdentityTerms(location.name);
        for (const alias of location.aliases) addIdentityTerms(alias);
        mapParent = location.parentId;
      }
      for (const ref of checkedRefs) {
        let parentId: string | undefined = options.locationId;
        let inLocationHierarchy = true;
        const visited = new Set<string>();
        for (let depth = 0; parentId !== undefined && depth < 16; depth += 1) {
          if (visited.has(parentId)) break;
          visited.add(parentId);
          const row = this.#loreEntryRow(ref, parentId);
          if (!row) break;
          const entry = this.#loreEntryFromRow(row);
          if (entry.kind === "location" || entry.kind === "place") {
            if (!inLocationHierarchy) break;
            localLocationIds.add(entry.id);
            addIdentityTerms(entry.id);
            addIdentityTerms(entry.name);
            for (const alias of entry.aliases) addIdentityTerms(alias);
          } else if (entry.kind === "region" || entry.kind === "world") {
            inLocationHierarchy = false;
            localLocationIds.delete(entry.id);
            if (mayViewEntry(entry)) {
              localAncestorEntries.push(entry);
              addIdentityTerms(entry.id);
              addIdentityTerms(entry.name);
              for (const alias of entry.aliases) addIdentityTerms(alias);
            }
          } else {
            break;
          }
          parentId = entry.parentId;
        }
      }
      this.#addPinnedLocationIdentity(
        checkedRefs,
        options.locationId,
        localLocationIds,
        addIdentityTerms,
      );
    }
    const localEntries: LoreEntry[] = [];
    let omitted = false;
    const locations = [...localLocationIds];
    if (locations.length) {
      for (const ref of checkedRefs) {
        const marks = locations.map(() => "?").join(",");
        const neighborSql = `
          SELECT CASE WHEN l.from_id IN (${marks}) THEN l.to_id ELSE l.from_id END
          FROM lore_links l
          WHERE l.pack_id = ? AND l.pack_version = ?
            AND l.relation IN ('PRESENT_AT','LOCATED_IN','PARENT_OF')
            AND (l.from_id IN (${marks}) OR l.to_id IN (${marks}))
        `;
        const candidateLimit = Math.min(limit * 4, 200);
        const rows = this.#db
          .prepare(
            `SELECT e.* FROM lore_entries e
             WHERE e.pack_id = ? AND e.pack_version = ?
               AND e.kind IN ('location','place','npc','activity')
               AND ${visibility("e")}
               AND (
                 e.entry_id IN (${marks}) OR e.parent_id IN (${marks})
                 OR e.entry_id IN (${neighborSql})
               )
             ORDER BY CASE WHEN e.entry_id = ? THEN 0
               WHEN e.kind = 'location' THEN 1
               WHEN e.kind = 'place' THEN 2
               WHEN e.kind = 'npc' THEN 3 ELSE 4 END, e.entry_id
             LIMIT ?`,
          )
          .all(
            ref.packId,
            ref.version,
            ...visibilityParams,
            ...locations,
            ...locations,
            ...locations,
            ref.packId,
            ref.version,
            ...locations,
            ...locations,
            options.locationId ?? "",
            candidateLimit + 1,
          ) as SqlRow[];
        if (rows.length > candidateLimit) {
          rows.pop();
          omitted = true;
        }
        localEntries.push(...rows.map((row) => this.#loreEntryFromRow(row)));
      }
    }
    const query = options.query?.trim();
    const queryTokens =
      query
        ?.normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const hasNonLocalTopic = queryTokens.some(
      (token) =>
        token.length > 1 &&
        !Object.hasOwn(TOPIC_STOP_WORDS, token) &&
        !omittedTerms.has(token),
    );
    const exactEntries: LoreEntry[] = [];
    const topicEntries: LoreEntry[] = [];
    if (query) {
      for (const ref of checkedRefs) {
        const rows = this.#db
          .prepare(
            `SELECT e.* FROM lore_entries e
             WHERE e.pack_id = ? AND e.pack_version = ? AND ${visibility("e")}
               AND (lower(e.entry_id) = lower(?) OR lower(e.name) = lower(?)
                 OR EXISTS (
                   SELECT 1 FROM json_each(e.aliases_json) a
                   WHERE lower(a.value) = lower(?)
                 ))
               AND (? = 1 OR e.kind <> 'history' OR lower(e.entry_id) = lower(?))
             ORDER BY e.entry_id LIMIT ?`,
          )
          .all(
            ref.packId,
            ref.version,
            ...visibilityParams,
            query,
            query,
            query,
            options.locationId === undefined || hasNonLocalTopic ? 1 : 0,
            query,
            limit + 1,
          ) as SqlRow[];
        if (rows.length > limit) {
          rows.pop();
          omitted = true;
        }
        exactEntries.push(...rows.map((row) => this.#loreEntryFromRow(row)));
      }
      const topicQuery = makeTopicFtsQuery(query, "OR", omittedTerms);
      if (topicQuery) {
        const scope = checkedRefs
          .map(() => "(e.pack_id = ? AND e.pack_version = ?)")
          .join(" OR ");
        const scopeParams = checkedRefs.flatMap((ref) => [
          ref.packId,
          ref.version,
        ]);
        if (scope) {
          const rows = this.#db
            .prepare(
              `SELECT e.* FROM lore_entries_fts
               JOIN lore_entries e ON e.pack_id = lore_entries_fts.pack_id
                AND e.pack_version = lore_entries_fts.pack_version
                AND e.entry_id = lore_entries_fts.entry_id
               WHERE lore_entries_fts MATCH ? AND (${scope})
                 AND ${visibility("e")}
               ORDER BY CASE WHEN lower(e.entry_id) = lower(?)
                   OR lower(e.name) = lower(?)
                   OR EXISTS (
                     SELECT 1 FROM json_each(e.aliases_json) a
                     WHERE lower(a.value) = lower(?)
                   )
                 THEN 0 ELSE 1 END, bm25(lore_entries_fts), e.entry_id
               LIMIT ?`,
            )
            .all(
              topicQuery,
              ...scopeParams,
              ...visibilityParams,
              query,
              query,
              query,
              limit * 2 + 1,
            ) as SqlRow[];
          if (rows.length > limit * 2) {
            rows.pop();
            omitted = true;
          }
          topicEntries.push(...rows.map((row) => this.#loreEntryFromRow(row)));
        }
      }
    }
    const selected = new Map<string, { entry: LoreEntry; rank: number }>();
    for (const entry of exactEntries) {
      selected.set(entry.id, { entry, rank: 0 });
    }
    for (const entry of localAncestorEntries) {
      if (!selected.has(entry.id)) selected.set(entry.id, { entry, rank: 1 });
    }
    const topicRank = hasNonLocalTopic ? 2 : 3;
    const localRank = hasNonLocalTopic ? 3 : 2;
    for (const entry of topicEntries) {
      if (!selected.has(entry.id))
        selected.set(entry.id, { entry, rank: topicRank });
    }
    for (const entry of localEntries) {
      if (!selected.has(entry.id))
        selected.set(entry.id, { entry, rank: localRank });
    }
    const all = [...selected.values()].sort((a, b) => a.rank - b.rank);
    if (all.length > limit) {
      all.length = limit;
      omitted = true;
    }
    const localIds = new Set([
      ...localAncestorEntries.map((entry) => entry.id),
      ...localEntries.map((entry) => entry.id),
    ]);
    return {
      entries: all.map(({ entry }) => ({
        ...entry,
        body: localIds.has(entry.id) ? "" : truncateUtf8(entry.body, 1_200),
      })),
      omitted,
    };
  }

  retrieveLore(
    refs: LorebookRef[],
    options: {
      locationId?: string;
      query?: string;
      discoveredLoreIds?: string[];
      limit?: number;
      narrator?: boolean;
    } = {},
  ): LoreEntry[] {
    this.#assertOpen();
    return this.#retrieveLoreEntries(refs, options).entries;
  }
  retrieveLoreForTurn(
    refs: LorebookRef[],
    options: {
      locationId?: string;
      query?: string;
      discoveredLoreIds?: string[];
      limit?: number;
    } = {},
  ): LoreEntry[] {
    this.#assertOpen();
    return this.#retrieveLoreEntries(refs, {
      ...options,
      narrator: true,
      includeUndiscoveredDiscovery: true,
    }).entries;
  }

  previewLore(
    rawDefinition: unknown,
    options: { locationId?: string; query?: string } = {},
  ): {
    entries: LoreEntry[];
    locationId?: string;
    activeNpcIds: string[];
    omitted: string[];
  } {
    const definition = validateDefinitionDocument(rawDefinition);
    const map = this.getWorldMap(definition);
    let locationId: string | undefined;
    if (options.locationId !== undefined) {
      if (
        typeof options.locationId !== "string" ||
        !options.locationId.trim()
      ) {
        throw new ValidationError("locationId tidak valid.");
      }
      if (map) {
        const resolved = resolveLocation(map, options.locationId);
        if (resolved.kind === "ambiguous") {
          throw new ValidationError(
            `Lokasi ambigu: ${resolved.ids.join(", ")}.`,
          );
        }
        if (resolved.kind === "unknown") {
          throw new ValidationError("Lokasi tidak ditemukan pada world map.");
        }
        locationId = resolved.location.id;
      } else {
        locationId = options.locationId;
      }
    }
    const refs = definition.lorebookRefs ?? [];
    const result = this.#retrieveLoreEntries(refs, {
      ...(locationId === undefined ? {} : { locationId }),
      ...(map === undefined ? {} : { identityLocations: map.locations }),
      ...(options.query === undefined ? {} : { query: options.query }),
      limit: 20,
    });
    const location = map?.locations.find((entry) => entry.id === locationId);
    return {
      entries: result.entries,
      ...(locationId === undefined ? {} : { locationId }),
      activeNpcIds: location ? [...location.npcIds] : [],
      omitted: result.omitted
        ? ["Additional matching entries were omitted by the preview limit."]
        : [],
    };
  }

  createGame(raw: unknown): StoredGame {
    const definition = validateDefinitionDocument(raw, now());
    this.validateLoreBindings(definition.lorebookRefs ?? [], definition);
    this.#transaction(() => this.#insertGame(definition));
    return { ...definition, revision: 1 };
  }

  getGame(id: string): StoredGame | undefined {
    assertId(id, "game.id");
    this.#assertOpen();
    const row = this.#getGameRow(id);
    return row ? this.#gameFromRow(row) : undefined;
  }

  listGames(): StoredGame[] {
    this.#assertOpen();
    return (
      this.#db
        .prepare("SELECT * FROM games ORDER BY updated_at DESC, id")
        .all() as SqlRow[]
    ).map((row) => this.#gameFromRow(row));
  }

  updateGame(id: string, raw: unknown, expectedRevision: number): StoredGame {
    assertId(id, "game.id");
    assertRevision(expectedRevision);
    const definition = validateDefinitionDocument(raw, now());
    if (definition.id !== id)
      throw new ValidationError("Game id tidak boleh berubah.");
    this.validateLoreBindings(definition.lorebookRefs ?? [], definition);
    this.#transaction(() => {
      const row = this.#getGameRow(id);
      if (!row) throw new NotFoundError("Game tidak ditemukan.");
      this.#updateGameRow(row, definition, expectedRevision);
    });
    return { ...definition, revision: expectedRevision + 1 };
  }

  #updateGameRow(
    row: SqlRow,
    definition: GameDefinition,
    expectedRevision: number,
  ): number {
    const id = definition.id;
    this.#checkExpected(Number(row.revision), expectedRevision, "Game");
    const originalDefinition = this.#gameFromRow(row);
    const hasSessions = this.#db
      .prepare("SELECT 1 AS found FROM sessions WHERE game_id = ? LIMIT 1")
      .get(id);
    if (hasSessions) {
      if (
        this.#db
          .prepare(
            `SELECT 1 AS found FROM turns t JOIN sessions s ON s.id = t.session_id
             WHERE s.game_id = ? AND t.status = 'running' LIMIT 1`,
          )
          .get(id)
      ) {
        throw new ConflictError(
          "Game memiliki session dengan run yang sedang berjalan.",
        );
      }
      const errors = validateDefinitionUpdate(originalDefinition, definition);
      if (errors.length) throw new ValidationError(errors.join(" "));
    }
    const result = this.#db
      .prepare(
        "UPDATE games SET definition_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .run(jsonText(definition), definition.updatedAt, id, expectedRevision);
    if (Number(result.changes) !== 1)
      throw new ConflictError("Game revision berubah.");
    return expectedRevision + 1;
  }

  deleteGame(id: string, expectedRevision: number): void {
    assertId(id, "game.id");
    assertRevision(expectedRevision);
    this.#transaction(() => {
      const row = this.#getGameRow(id);
      if (!row) throw new NotFoundError("Game tidak ditemukan.");
      this.#checkExpected(Number(row.revision), expectedRevision, "Game");
      if (
        this.#db
          .prepare(
            `SELECT 1 AS found FROM turns t JOIN sessions s ON s.id = t.session_id
             WHERE s.game_id = ? AND t.status = 'running' LIMIT 1`,
          )
          .get(id)
      ) {
        throw new ConflictError(
          "Game memiliki session dengan run yang sedang berjalan.",
          "RUN_IN_PROGRESS",
        );
      }
      this.#db.prepare("DELETE FROM sessions WHERE game_id = ?").run(id);
      this.#db
        .prepare("DELETE FROM games WHERE id = ? AND revision = ?")
        .run(id, expectedRevision);
    });
  }
  duplicateGame(id: string, expectedRevision: number): StoredGame {
    assertId(id, "game.id");
    assertRevision(expectedRevision);
    let duplicate!: GameDefinition;
    this.#transaction(() => {
      const row = this.#getGameRow(id);
      if (!row) throw new NotFoundError("Game tidak ditemukan.");
      const original = this.#gameFromRow(row);
      this.#checkExpected(original.revision, expectedRevision, "Game");
      duplicate = validateDefinitionDocument({
        ...gameValue(original),
        id: randomUUID(),
        title: `${original.title} — salinan`,
        updatedAt: now(),
      });
      this.validateLoreBindings(duplicate.lorebookRefs ?? [], duplicate);
      this.#insertGame(duplicate);
    });
    return { ...duplicate, revision: 1 };
  }

  saveTemplate(
    gameId: string,
    expectedGameRevision: number,
  ): SavedTemplateRecord {
    assertId(gameId, "gameId");
    assertRevision(expectedGameRevision);
    return this.#transaction(() => {
      const row = this.#getGameRow(gameId);
      if (!row) throw new NotFoundError("Game tidak ditemukan.");
      const game = this.#gameFromRow(row);
      this.#checkExpected(game.revision, expectedGameRevision, "Game");
      const bundle = exportTemplate(gameValue(game));
      const id = randomUUID();
      const createdAt = now();
      this.#db
        .prepare(
          "INSERT INTO saved_templates(id, bundle_json, created_at) VALUES (?, ?, ?)",
        )
        .run(id, jsonText(bundle), createdAt);
      return { id, title: bundle.game.title, createdAt };
    });
  }

  listTemplates(): SavedTemplateRecord[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        "SELECT id, bundle_json, created_at FROM saved_templates ORDER BY created_at DESC, id",
      )
      .all() as SqlRow[];
    return rows.map((row) => {
      assertId(String(row.id), "template.id");
      const bundle = validateStoredTemplate(
        parseJson(row.bundle_json as string, "Saved template"),
      );
      const createdAt = String(row.created_at);
      if (!createdAt)
        throw new CorruptDatabaseError("Saved template timestamp rusak.");
      return { id: String(row.id), title: bundle.game.title, createdAt };
    });
  }

  getTemplate(id: string): GameTemplateBundle | undefined {
    assertId(id, "template.id");
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT bundle_json FROM saved_templates WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row
      ? validateStoredTemplate(
          parseJson(row.bundle_json as string, "Saved template"),
        )
      : undefined;
  }

  #credential(id: string): {
    provider: AiConfig["provider"];
    baseURL?: string;
  } {
    const row = this.#db
      .prepare("SELECT * FROM ai_credentials WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new CorruptDatabaseError("Credential AI tidak ditemukan.");
    const provider = String(row.provider);
    if (
      provider !== "gemini" &&
      provider !== "openrouter" &&
      provider !== "custom"
    ) {
      throw new CorruptDatabaseError("Provider credential AI rusak.");
    }
    let baseURL: string | undefined;
    if (row.base_url !== null) {
      try {
        baseURL = normalizeCustomBaseURL(row.base_url);
      } catch {
        throw new CorruptDatabaseError("Base URL credential AI rusak.");
      }
    }
    if (provider === "custom" && baseURL === undefined) {
      throw new CorruptDatabaseError("Credential custom tanpa Base URL.");
    }
    if (provider !== "custom" && baseURL !== undefined) {
      throw new CorruptDatabaseError("Credential non-custom memuat Base URL.");
    }
    return { provider, ...(baseURL === undefined ? {} : { baseURL }) };
  }

  #profileFromRow(row: SqlRow): StoredAiProfile {
    const credential = this.#credential(String(row.credential_id));
    let input: AiProfileInput;
    try {
      input = normalizeAiProfileInput({
        name: row.name,
        provider: credential.provider,
        model: row.model,
        systemPrompt: row.system_prompt,
        ...(credential.baseURL === undefined
          ? {}
          : { baseURL: credential.baseURL }),
      });
    } catch (error) {
      throw new CorruptDatabaseError(
        `Profil AI rusak: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
      throw new CorruptDatabaseError("Revision profil AI rusak.");
    }
    return {
      ...input,
      id: String(row.id),
      revision: Number(row.revision),
      credentialId: String(row.credential_id),
    };
  }

  #profileInput(raw: unknown): AiProfileInput {
    try {
      return normalizeAiProfileInput(raw);
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : "Profil AI tidak valid.",
      );
    }
  }

  #profileSnapshot(profileId: string): AiProfileSnapshot {
    assertId(profileId, "profile.id");
    const row = this.#db
      .prepare("SELECT * FROM ai_profiles WHERE id = ?")
      .get(profileId) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Profil AI tidak ditemukan.");
    const profile = this.#profileFromRow(row);
    return {
      ai: {
        provider: profile.provider,
        model: profile.model,
        systemPrompt: profile.systemPrompt,
      },
      profileId: profile.id,
      credentialId: profile.credentialId,
    };
  }

  #setSessionAiBinding(
    sessionId: string,
    profileId: string,
    credentialId: string,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO session_ai_bindings(session_id, profile_id, credential_id)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           profile_id = excluded.profile_id,
           credential_id = excluded.credential_id`,
      )
      .run(sessionId, profileId, credentialId);
  }

  listAiProfiles(): StoredAiProfile[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT * FROM ai_profiles ORDER BY name COLLATE NOCASE, id")
      .all() as SqlRow[];
    return rows.map((row) => this.#profileFromRow(row));
  }

  getAiProfile(id: string): StoredAiProfile | undefined {
    assertId(id, "profile.id");
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT * FROM ai_profiles WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#profileFromRow(row) : undefined;
  }

  createAiProfile(raw: unknown): StoredAiProfile {
    const input = this.#profileInput(raw);
    const id = randomUUID();
    const credentialId = randomUUID();
    const timestamp = now();
    this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO ai_credentials(id, provider, base_url) VALUES (?, ?, ?)",
        )
        .run(
          credentialId,
          input.provider,
          input.provider === "custom" ? input.baseURL : null,
        );
      this.#db
        .prepare(
          `INSERT INTO ai_profiles(
             id, name, credential_id, model, system_prompt, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          credentialId,
          input.model,
          input.systemPrompt,
          timestamp,
          timestamp,
        );
    });
    return { ...input, id, revision: 1, credentialId };
  }

  updateAiProfile(
    id: string,
    raw: unknown,
    expectedRevision: number,
  ): StoredAiProfile {
    assertId(id, "profile.id");
    assertRevision(expectedRevision);
    const input = this.#profileInput(raw);
    let updated!: StoredAiProfile;
    this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM ai_profiles WHERE id = ?")
        .get(id) as SqlRow | undefined;
      if (!row) throw new NotFoundError("Profil AI tidak ditemukan.");
      this.#checkExpected(Number(row.revision), expectedRevision, "Profil AI");
      const currentCredential = this.#credential(String(row.credential_id));
      const identityChanged =
        currentCredential.provider !== input.provider ||
        (input.provider === "custom" &&
          currentCredential.baseURL !== input.baseURL);
      let credentialId = String(row.credential_id);
      if (identityChanged) {
        credentialId = randomUUID();
        this.#db
          .prepare(
            "INSERT INTO ai_credentials(id, provider, base_url) VALUES (?, ?, ?)",
          )
          .run(
            credentialId,
            input.provider,
            input.provider === "custom" ? input.baseURL : null,
          );
      }
      const result = this.#db
        .prepare(
          `UPDATE ai_profiles SET name = ?, credential_id = ?, model = ?,
             system_prompt = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          input.name,
          credentialId,
          input.model,
          input.systemPrompt,
          now(),
          id,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) {
        throw new ConflictError("Profil AI revision berubah.");
      }
      updated = {
        ...input,
        id,
        revision: expectedRevision + 1,
        credentialId,
      };
    });
    return updated;
  }

  getSessionAiBinding(sessionId: string): StoredAiBinding | undefined {
    assertId(sessionId, "session.id");
    this.#assertOpen();
    const row = this.#db
      .prepare(
        "SELECT profile_id, credential_id FROM session_ai_bindings WHERE session_id = ?",
      )
      .get(sessionId) as SqlRow | undefined;
    if (!row) return undefined;
    const profileId = String(row.profile_id);
    if (
      !this.#db
        .prepare("SELECT 1 AS found FROM ai_profiles WHERE id = ?")
        .get(profileId)
    ) {
      throw new CorruptDatabaseError(
        "Binding profil AI menunjuk profil hilang.",
      );
    }
    const credential = this.#credential(String(row.credential_id));
    return {
      profileId,
      credentialId: String(row.credential_id),
      provider: credential.provider,
      ...(credential.baseURL === undefined
        ? {}
        : { baseURL: credential.baseURL }),
    };
  }

  #validateAiMetadata(): void {
    const credentials = this.#db
      .prepare("SELECT id FROM ai_credentials")
      .all() as SqlRow[];
    for (const row of credentials) this.#credential(String(row.id));
    for (const profile of this.listAiProfiles()) void profile;
    const sessions = this.#db
      .prepare("SELECT id, ai_json FROM sessions")
      .all() as SqlRow[];
    for (const row of sessions) {
      const id = String(row.id);
      const binding = this.getSessionAiBinding(id);
      if (!binding) continue;
      const ai = normalizeAi(parseJson(row.ai_json as string, "Session AI"));
      if (ai.provider !== binding.provider) {
        throw new CorruptDatabaseError(
          "Binding AI sesi tidak cocok dengan snapshot.",
        );
      }
    }
  }

  applySessionAiProfile(
    sessionId: string,
    profileId: string,
    expectedRevision: number,
  ): StoredSession {
    return this.updateSession(sessionId, { profileId }, expectedRevision);
  }

  startSessionForDefinition(
    input: StartSessionForDefinitionInput,
  ): SessionStartResult {
    if (!isObject(input))
      throw new ValidationError("Session start harus object.");
    const name =
      input.name === undefined ? undefined : normalizeSessionName(input.name);
    const definition = validateDefinitionDocument(input.definition, now());
    const playability = validatePlayability(definition);
    if (playability.length) throw new ValidationError(playability.join(" "));
    const hasProfile = input.profileId !== undefined;
    const hasAi = input.ai !== undefined;
    if (hasProfile === hasAi) {
      throw new ValidationError(
        "Session start harus memakai tepat salah satu ai atau profileId.",
      );
    }
    let ai: AiConfig | undefined;
    if (hasAi) {
      ai = normalizeAi(input.ai);
      if (ai.provider === "custom") {
        throw new ValidationError("Pilih profil AI untuk provider custom.");
      }
    }
    const lorebookRefs =
      definition.lorebookRefs === undefined
        ? undefined
        : parseLoreRefs(definition.lorebookRefs);
    this.validateLoreBindings(lorebookRefs ?? [], definition);
    const worldMap = this.getWorldMap(definition);
    const sessionId = input.sessionId ?? randomUUID();
    assertId(sessionId, "session.id");
    if (input.expectedGameRevision !== undefined) {
      assertRevision(input.expectedGameRevision);
    }
    let gameRevision = 1;
    let session!: GameSession;
    this.#transaction(() => {
      const snapshot =
        input.profileId === undefined
          ? undefined
          : this.#profileSnapshot(input.profileId);
      const existing = this.#getGameRow(definition.id);
      if (existing) {
        if (input.expectedGameRevision === undefined) {
          throw new ConflictError(
            "expectedGameRevision wajib untuk game yang sudah ada.",
          );
        }
        gameRevision = this.#updateGameRow(
          existing,
          definition,
          input.expectedGameRevision,
        );
      } else if (input.expectedGameRevision !== undefined) {
        throw new ConflictError(
          "Game dengan expectedGameRevision tidak ditemukan.",
        );
      } else {
        this.#insertGame(definition);
      }
      session = {
        id: sessionId,
        gameId: definition.id,
        definitionSnapshot: structuredClone(definition),
        state: buildInitialState(definition, worldMap),
        ai: snapshot ? snapshot.ai : ai!,
        nextSequence: 0,
        updatedAt: now(),
        ...(name === undefined ? {} : { name }),
        pinned: false,
        ...(worldMap === undefined ? {} : { worldMap }),
        ...(lorebookRefs === undefined ? {} : { lorebookRefs }),
      };
      this.#insertSession(session);
      if (snapshot) {
        this.#setSessionAiBinding(
          session.id,
          snapshot.profileId,
          snapshot.credentialId,
        );
      }
    });
    return {
      game: { value: structuredClone(definition), revision: gameRevision },
      session: { value: session, revision: 1 },
    };
  }

  startSession(input: StartSessionForDefinitionInput): SessionStartResult {
    return this.startSessionForDefinition(input);
  }
  startSavedSession(input: StartSavedSessionInput): StoredSession {
    if (
      !isObject(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            "gameId",
            "expectedGameRevision",
            "name",
            "ai",
            "profileId",
            "sessionId",
          ].includes(key),
      )
    ) {
      throw new ValidationError("Saved session start tidak valid.");
    }
    assertId(input.gameId, "gameId");
    assertRevision(input.expectedGameRevision);
    const name =
      input.name === undefined ? undefined : normalizeSessionName(input.name);
    const hasProfile = input.profileId !== undefined;
    const hasAi = input.ai !== undefined;
    if (hasProfile === hasAi) {
      throw new ValidationError(
        "Session start harus memakai tepat salah satu ai atau profileId.",
      );
    }
    let ai: AiConfig | undefined;
    if (hasAi) {
      ai = normalizeAi(input.ai);
      if (ai.provider === "custom") {
        throw new ValidationError("Pilih profil AI untuk provider custom.");
      }
    }
    const sessionId = input.sessionId ?? randomUUID();
    assertId(sessionId, "session.id");
    let session!: GameSession;
    this.#transaction(() => {
      const row = this.#getGameRow(input.gameId);
      if (!row) throw new NotFoundError("Game tidak ditemukan.");
      const game = this.#gameFromRow(row);
      this.#checkExpected(game.revision, input.expectedGameRevision, "Game");
      const playability = validatePlayability(game);
      if (playability.length) throw new ValidationError(playability.join(" "));
      let snapshot: AiProfileSnapshot | undefined;
      if (input.profileId !== undefined) {
        const profileId = input.profileId;
        assertId(profileId, "profileId");
        snapshot = this.#profileSnapshot(profileId);
      }
      const lorebookRefs =
        game.lorebookRefs === undefined
          ? undefined
          : parseLoreRefs(game.lorebookRefs);
      this.validateLoreBindings(lorebookRefs ?? [], game);
      const worldMap = this.getWorldMap(game);
      session = {
        id: sessionId,
        gameId: game.id,
        definitionSnapshot: structuredClone(gameValue(game)),
        state: buildInitialState(game, worldMap),
        ai: snapshot ? snapshot.ai : ai!,
        nextSequence: 0,
        updatedAt: now(),
        ...(name === undefined ? {} : { name }),
        pinned: false,
        ...(worldMap === undefined ? {} : { worldMap }),
        ...(lorebookRefs === undefined ? {} : { lorebookRefs }),
      };
      this.#validateSessionState(session);
      this.#insertSession(session);
      if (snapshot) {
        this.#setSessionAiBinding(
          session.id,
          snapshot.profileId,
          snapshot.credentialId,
        );
      }
    });
    return { ...session, revision: 1 };
  }

  getSession(id: string): StoredSession | undefined {
    assertId(id, "session.id");
    this.#assertOpen();
    const row = this.#getSessionRow(id);
    return row ? this.#sessionFromRow(row) : undefined;
  }

  listSessions(gameId: string): StoredSession[] {
    assertId(gameId, "game.id");
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        "SELECT * FROM sessions WHERE game_id = ? ORDER BY updated_at DESC, id",
      )
      .all(gameId) as SqlRow[];
    return rows.map((row) => this.#sessionFromRow(row));
  }
  updateSessionMetadata(
    id: string,
    patch: SessionMetadataPatch,
  ): StoredSession {
    assertId(id, "session.id");
    if (
      !isObject(patch) ||
      Object.keys(patch).some((key) => !["name", "pinned"].includes(key)) ||
      !Object.keys(patch).some((key) => patch[key] !== undefined)
    ) {
      throw new ValidationError(
        "Session metadata update kosong atau tidak valid.",
      );
    }
    const name =
      patch.name === undefined
        ? undefined
        : patch.name === null
          ? null
          : normalizeSessionName(patch.name);
    if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
      throw new ValidationError("Session pinned harus boolean.");
    }
    this.#transaction(() => {
      const row = this.#getSessionRow(id);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const current = this.#sessionFromRow(row);
      this.#db
        .prepare("UPDATE sessions SET name = ?, pinned = ? WHERE id = ?")
        .run(
          name === undefined ? (current.name ?? null) : name,
          patch.pinned === undefined
            ? current.pinned
              ? 1
              : 0
            : patch.pinned
              ? 1
              : 0,
          id,
        );
    });
    return this.getSession(id)!;
  }

  sessionSummary(id: string): SessionSummaryMetrics {
    assertId(id, "session.id");
    this.#assertOpen();
    if (!this.#getSessionRow(id)) {
      throw new NotFoundError("Session tidak ditemukan.");
    }
    const count = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT m.turn_id) AS turn_count FROM messages m
         WHERE m.session_id = ? AND m.role IN ('PLAYER','SYSTEM_EVENT')
         AND ${MESSAGE_AUDIENCE_SCOPE}`,
      )
      .get(id, PLAYER_ID, PLAYER_ID) as SqlRow;
    const narrator = this.#db
      .prepare(
        `SELECT m.content FROM messages m
         WHERE m.session_id = ? AND m.role = 'NARRATOR'
         AND ${MESSAGE_AUDIENCE_SCOPE}
         ORDER BY m.sequence DESC LIMIT 1`,
      )
      .get(id, PLAYER_ID, PLAYER_ID) as SqlRow | undefined;
    const excerpt =
      narrator === undefined ? "" : truncateUtf8(String(narrator.content), 240);
    return {
      turnCount: Number(count.turn_count),
      excerpt: excerpt || null,
    };
  }

  updateSession(
    id: string,
    patch: SessionUpdate,
    expectedRevision: number,
  ): StoredSession {
    assertId(id, "session.id");
    assertRevision(expectedRevision);
    if (
      !isObject(patch) ||
      Object.keys(patch).some(
        (key) =>
          !["ai", "definitionSnapshot", "state", "profileId"].includes(key),
      ) ||
      Object.keys(patch).length === 0
    ) {
      throw new ValidationError("Session update kosong.");
    }
    if (patch.ai !== undefined && patch.profileId !== undefined) {
      throw new ValidationError(
        "Session update tidak boleh menggabungkan ai dan profileId.",
      );
    }
    this.#assertOpen();
    let updated!: GameSession;
    this.#transaction(() => {
      const row = this.#getSessionRow(id);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const stored = this.#sessionFromRow(row);
      this.#checkExpected(stored.revision, expectedRevision, "Session");
      this.#assertNoRunningRun(id);
      const definitionSnapshot = structuredClone(
        patch.definitionSnapshot === undefined
          ? stored.definitionSnapshot
          : validateDefinitionDocument(patch.definitionSnapshot),
      );
      if (stored.definitionSnapshot.worldMap === undefined) {
        delete definitionSnapshot.worldMap;
      } else {
        definitionSnapshot.worldMap = structuredClone(
          stored.definitionSnapshot.worldMap,
        );
      }
      if (stored.definitionSnapshot.startingLocationId === undefined) {
        delete definitionSnapshot.startingLocationId;
      } else {
        definitionSnapshot.startingLocationId =
          stored.definitionSnapshot.startingLocationId;
      }
      if (stored.lorebookRefs === undefined) {
        delete definitionSnapshot.lorebookRefs;
      } else {
        definitionSnapshot.lorebookRefs = structuredClone(stored.lorebookRefs);
      }
      if (definitionSnapshot.id !== stored.gameId) {
        throw new ValidationError(
          "Snapshot tidak boleh mengganti game session.",
        );
      }
      if (patch.definitionSnapshot !== undefined) {
        const errors = validateDefinitionUpdate(
          stored.definitionSnapshot,
          definitionSnapshot,
        );
        if (errors.length) throw new ValidationError(errors.join(" "));
      }
      const state =
        patch.state === undefined
          ? stored.state
          : (JSON.parse(jsonText(patch.state)) as SessionState);
      let ai: AiConfig;
      let snapshot: AiProfileSnapshot | undefined;
      let clearBinding = false;
      if (patch.profileId !== undefined) {
        if (
          typeof patch.profileId !== "string" ||
          !patch.profileId.trim() ||
          patch.profileId.length > 256
        ) {
          throw new ValidationError("profileId tidak valid.");
        }
        snapshot = this.#profileSnapshot(patch.profileId);
        ai = snapshot.ai;
      } else if (patch.ai !== undefined) {
        ai = normalizeAi(patch.ai);
        const binding = this.getSessionAiBinding(id);
        if (binding) {
          if (ai.provider !== binding.provider) clearBinding = true;
        } else if (ai.provider === "custom") {
          throw new ValidationError("Pilih profil AI untuk provider custom.");
        }
      } else {
        ai = stored.ai;
      }
      updated = {
        id,
        gameId: stored.gameId,
        definitionSnapshot,
        state,
        ai,
        nextSequence: stored.nextSequence,
        updatedAt: now(),
        ...(stored.name === undefined ? {} : { name: stored.name }),
        pinned: stored.pinned,
        ...(stored.worldMap === undefined
          ? {}
          : { worldMap: structuredClone(stored.worldMap) }),
        ...(stored.lorebookRefs === undefined
          ? {}
          : { lorebookRefs: structuredClone(stored.lorebookRefs) }),
      };
      this.#validateSessionState(updated);
      const result = this.#db
        .prepare(
          `UPDATE sessions SET definition_snapshot_json = ?, state_json = ?, ai_json = ?,
           revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
          jsonText(updated.definitionSnapshot),
          jsonText(updated.state),
          jsonText(updated.ai),
          updated.updatedAt,
          id,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) {
        throw new ConflictError("Session revision berubah.");
      }
      if (snapshot) {
        this.#setSessionAiBinding(
          id,
          snapshot.profileId,
          snapshot.credentialId,
        );
      } else if (clearBinding) {
        this.#db
          .prepare("DELETE FROM session_ai_bindings WHERE session_id = ?")
          .run(id);
      }
    });
    return { ...updated, revision: expectedRevision + 1 };
  }

  deleteSession(id: string, expectedRevision: number): void {
    assertId(id, "session.id");
    assertRevision(expectedRevision);
    this.#transaction(() => {
      const row = this.#getSessionRow(id);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const session = this.#sessionFromRow(row);
      this.#checkExpected(session.revision, expectedRevision, "Session");
      this.#assertNoRunningRun(id);
      this.#db
        .prepare("DELETE FROM sessions WHERE id = ? AND revision = ?")
        .run(id, expectedRevision);
    });
  }

  #validateSessionState(session: GameSession): void {
    const stateOnly = { ...session, nextSequence: 0 };
    try {
      validateExportBundle(
        makeBundle(session.definitionSnapshot, stateOnly, []),
      );
    } catch (error) {
      throw new ValidationError(
        `Session state tidak valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  listMessages(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): MessagePage {
    assertId(sessionId, "session.id");
    const after = options.afterSequence ?? -1;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < -1) {
      throw new ValidationError("afterSequence tidak valid.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit harus integer 1 sampai 100.");
    }
    const row = this.#getSessionRow(sessionId);
    if (!row) throw new NotFoundError("Session tidak ditemukan.");
    const session = this.#sessionFromRow(row);
    const messages = this.#messages(sessionId, after, limit + 1);
    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
    const checked = messages.length
      ? validateMessages(session, messages)
      : messages;
    return {
      messages: checked,
      nextAfterSequence: checked.length ? checked.at(-1)!.sequence : null,
      nextBeforeSequence: null,
      hasMore,
    };
  }

  listMessagesBefore(
    sessionId: string,
    beforeSequence: number,
    limit = 50,
  ): MessagePage {
    assertId(sessionId, "session.id");
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 0) {
      throw new ValidationError("beforeSequence tidak valid.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit harus integer 1 sampai 100.");
    }
    const row = this.#getSessionRow(sessionId);
    if (!row) throw new NotFoundError("Session tidak ditemukan.");
    const session = this.#sessionFromRow(row);
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.session_id = ? AND m.sequence < ?
         AND ${MESSAGE_AUDIENCE_SCOPE}
         ORDER BY m.sequence DESC LIMIT ?`,
      )
      .all(
        sessionId,
        beforeSequence,
        "player",
        "player",
        limit + 1,
      ) as SqlRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const page = rows.map((item) => this.#messageFromRow(item)).reverse();
    const messages = page.length ? validateMessages(session, page) : page;
    return {
      messages,
      nextAfterSequence: null,
      nextBeforeSequence: messages.length ? messages[0].sequence : null,
      hasMore,
    };
  }

  getHistory(sessionId: string): Message[] {
    assertId(sessionId, "session.id");
    const row = this.#getSessionRow(sessionId);
    if (!row) throw new NotFoundError("Session tidak ditemukan.");
    const session = this.#sessionFromRow(row);
    const messages = this.#messages(sessionId);
    return messages.length ? validateMessages(session, messages) : messages;
  }
  getRecentHistory(sessionId: string, limit = 24, npcId?: string): Message[] {
    assertId(sessionId, "session.id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit harus integer 1 sampai 100.");
    }
    const row = this.#getSessionRow(sessionId);
    if (!row) throw new NotFoundError("Session tidak ditemukan.");
    const session = this.#sessionFromRow(row);
    if (
      npcId !== undefined &&
      !session.definitionSnapshot.npcs.some((npc) => npc.id === npcId)
    ) {
      throw new NotFoundError("NPC tidak ditemukan pada session.");
    }
    const audienceId = npcId ?? "player";
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.session_id = ? AND m.sequence < ?
         AND ${MESSAGE_AUDIENCE_SCOPE}
         ORDER BY m.sequence DESC LIMIT ?`,
      )
      .all(
        sessionId,
        session.nextSequence,
        audienceId,
        audienceId,
        limit,
      ) as SqlRow[];
    const messages = rows.map((item) => this.#messageFromRow(item)).reverse();
    return messages.length ? validateMessages(session, messages) : messages;
  }

  startRun(input: {
    sessionId: string;
    requestId: string;
    inputHash: string;
    expectedRevision: number;
    kind?: RunKind;
  }): RunRecord {
    assertId(input.sessionId, "session.id");
    assertId(input.requestId, "requestId");
    assertRevision(input.expectedRevision);
    if (
      typeof input.inputHash !== "string" ||
      !input.inputHash.trim() ||
      input.inputHash.length > 256
    ) {
      throw new ValidationError("inputHash tidak valid.");
    }
    const kind = input.kind ?? "turn";
    if (!new Set(["turn", "opening", "choices", "item_use"]).has(kind)) {
      throw new ValidationError("Run kind tidak dikenal.");
    }
    return this.#transaction(() => {
      const sessionRow = this.#getSessionRow(input.sessionId);
      if (!sessionRow) throw new NotFoundError("Session tidak ditemukan.");
      const session = this.#sessionFromRow(sessionRow);
      const existing = this.#db
        .prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?")
        .get(input.sessionId, input.requestId) as SqlRow | undefined;
      if (existing) {
        const run = readRun(existing);
        if (
          run.inputHash !== input.inputHash ||
          run.expectedRevision !== input.expectedRevision ||
          run.kind !== kind
        ) {
          throw new ConflictError("Request ID dipakai dengan input berbeda.");
        }
        return run;
      }
      this.#checkExpected(session.revision, input.expectedRevision, "Session");
      this.#assertNoRunningRun(input.sessionId);
      const created = now();
      this.#db
        .prepare(
          `INSERT INTO turns(session_id, request_id, input_hash, expected_revision, kind,
           status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          input.sessionId,
          input.requestId,
          input.inputHash,
          input.expectedRevision,
          kind,
          created,
          created,
        );
      return this.getRun(input.sessionId, input.requestId)!;
    });
  }

  getRun(sessionId: string, requestId: string): RunRecord | undefined {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?")
      .get(sessionId, requestId) as SqlRow | undefined;
    return row ? readRun(row) : undefined;
  }

  completeReadOnlyRun(
    sessionId: string,
    requestId: string,
    result: unknown,
  ): RunRecord {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    assertNoDangerousKeys(result);
    const resultJson = jsonText(result);
    return this.#transaction(() => {
      const runRow = this.#db
        .prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?")
        .get(sessionId, requestId) as SqlRow | undefined;
      if (!runRow) throw new NotFoundError("Run tidak ditemukan.");
      const run = readRun(runRow);
      if (run.kind !== "choices") {
        throw new ValidationError("completeReadOnlyRun hanya untuk choices.");
      }
      if (run.status === "committed") {
        if (canonicalJson(run.result) !== canonicalJson(result)) {
          throw new ConflictError("Run telah selesai dengan result berbeda.");
        }
        return run;
      }
      if (run.status !== "running") {
        throw new ConflictError(
          `Run berstatus ${run.status} tidak dapat diselesaikan.`,
        );
      }
      const row = this.#getSessionRow(sessionId);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const session = this.#sessionFromRow(row);
      this.#checkExpected(session.revision, run.expectedRevision, "Session");
      this.#db
        .prepare(
          `UPDATE turns SET status = 'committed', result_json = ?, error_json = NULL,
           updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'running'`,
        )
        .run(resultJson, now(), sessionId, requestId);
      return this.getRun(sessionId, requestId)!;
    });
  }

  failRun(sessionId: string, requestId: string, error: unknown): RunRecord {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    assertNoDangerousKeys(error);
    const errorJson = jsonText(error);
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?")
        .get(sessionId, requestId) as SqlRow | undefined;
      if (!row) throw new NotFoundError("Run tidak ditemukan.");
      const run = readRun(row);
      if (run.status === "failed") return run;
      if (run.status !== "running") {
        throw new ConflictError(
          `Run berstatus ${run.status} tidak dapat digagalkan.`,
        );
      }
      this.#db
        .prepare(
          "UPDATE turns SET status = 'failed', error_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'running'",
        )
        .run(errorJson, now(), sessionId, requestId);
      return this.getRun(sessionId, requestId)!;
    });
  }

  commitRun(
    sessionId: string,
    requestId: string,
    commit: RunCommit,
  ): RunCommitResult {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    assertNoDangerousKeys(commit.result);
    assertNoDangerousKeys(commit.state);
    if (commit.definitionSnapshot !== undefined) {
      assertNoDangerousKeys(commit.definitionSnapshot);
    }
    const resultJson = jsonText(commit.result);
    const state = JSON.parse(jsonText(commit.state)) as SessionState;
    let session!: StoredSession;
    let run!: RunRecord;
    this.#transaction(() => {
      const runRow = this.#db
        .prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?")
        .get(sessionId, requestId) as SqlRow | undefined;
      if (!runRow) throw new NotFoundError("Run tidak ditemukan.");
      const currentRun = readRun(runRow);
      if (currentRun.status === "committed") {
        if (canonicalJson(currentRun.result) !== canonicalJson(commit.result)) {
          throw new ConflictError("Run telah commit dengan result berbeda.");
        }
        const existingSession = this.getSession(sessionId);
        if (!existingSession)
          throw new NotFoundError("Session tidak ditemukan.");
        session = existingSession;
        run = currentRun;
        return;
      }
      if (currentRun.status !== "running") {
        throw new ConflictError(
          `Run berstatus ${currentRun.status} tidak dapat di-commit.`,
        );
      }
      const row = this.#getSessionRow(sessionId);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const current = this.#sessionFromRow(row);
      this.#checkExpected(
        current.revision,
        currentRun.expectedRevision,
        "Session",
      );
      if (!Array.isArray(commit.messages)) {
        throw new ValidationError("messages harus array.");
      }
      const definitionSnapshot =
        commit.definitionSnapshot === undefined
          ? current.definitionSnapshot
          : validateDefinitionDocument(commit.definitionSnapshot);
      const messages = validateMessages(
        { ...current, definitionSnapshot },
        commit.messages,
      );
      let next = current.nextSequence;
      for (const message of messages) {
        if (message.sessionId !== sessionId || message.sequence !== next++) {
          throw new ValidationError(
            "Message harus milik session dan sequence berurutan.",
          );
        }
      }
      if (messages.length === 0) {
        throw new ValidationError("Run commit harus menambahkan message.");
      }
      const updated: GameSession = {
        ...sessionValue(current),
        definitionSnapshot,
        state,
        nextSequence: next,
        updatedAt: now(),
      };
      const allMessages = [...this.#messages(sessionId), ...messages];
      validateSessionDocument(updated, allMessages);
      const snapshotJson =
        commit.definitionSnapshot === undefined
          ? null
          : jsonText(definitionSnapshot);
      this.#db
        .prepare(
          `UPDATE sessions SET definition_snapshot_json = COALESCE(?, definition_snapshot_json),
           state_json = ?, next_sequence = ?, revision = revision + 1,
           updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
          snapshotJson,
          jsonText(state),
          next,
          updated.updatedAt,
          sessionId,
          currentRun.expectedRevision,
        );
      for (const message of messages) this.#insertMessage(message);
      this.#db
        .prepare(
          `UPDATE turns SET status = 'committed', result_json = ?, error_json = NULL,
           updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'running'`,
        )
        .run(resultJson, updated.updatedAt, sessionId, requestId);
      session = { ...updated, revision: current.revision + 1 };
      run = this.getRun(sessionId, requestId)!;
    });
    this.#scheduleSummaryMaintenance();
    return { session, run };
  }

  startAiRequest(input: AiRequestStart): AiRequestRecord {
    const id = input.id ?? randomUUID();
    assertId(id, "aiRequest.id");
    if (input.sessionId !== undefined && input.sessionId !== null) {
      assertId(input.sessionId, "session.id");
    }
    if (input.requestId !== undefined && input.requestId !== null) {
      assertId(input.requestId, "requestId");
    }
    if (!AI_KINDS.has(input.kind))
      throw new ValidationError("AI request kind tidak dikenal.");
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new ValidationError("attempt harus integer positif.");
    }
    const ai = normalizeAi({ provider: input.provider, model: input.model });
    const created = now();
    this.#transaction(() => {
      if (input.kind !== "connection_test" && input.requestId != null) {
        if (input.sessionId == null) {
          throw new ValidationError("AI run request membutuhkan sessionId.");
        }
        const run = this.#db
          .prepare(
            "SELECT kind, status FROM turns WHERE session_id = ? AND request_id = ?",
          )
          .get(input.sessionId, input.requestId) as SqlRow | undefined;
        if (!run) throw new NotFoundError("Run ledger tidak ditemukan.");
        if (run.status !== "running" || run.kind !== input.kind) {
          throw new ConflictError(
            "AI attempt tidak cocok dengan run yang aktif.",
          );
        }
      }
      this.#db
        .prepare(
          `INSERT INTO ai_requests(id, session_id, request_id, kind, attempt, provider, model,
           status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          id,
          input.sessionId ?? null,
          input.requestId ?? null,
          input.kind,
          input.attempt,
          ai.provider,
          ai.model,
          created,
          created,
        );
    });
    return this.#getAiRequest(id)!;
  }

  #getAiRequest(id: string): AiRequestRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM ai_requests WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? readAiRequest(row) : undefined;
  }

  finishAiRequest(id: string, finish: AiRequestFinish): AiRequestRecord {
    assertId(id, "aiRequest.id");
    if (!AI_STATUSES.has(finish.status)) {
      throw new ValidationError("Status penyelesaian AI tidak valid.");
    }
    const usage = normalizeUsage(finish.usage);
    const latency = finish.latencyMs ?? null;
    assertCounter(latency, "latencyMs");
    const reason = finish.finishReason ?? null;
    if (
      reason !== null &&
      (typeof reason !== "string" || reason.length > 256)
    ) {
      throw new ValidationError("finishReason tidak valid.");
    }
    return this.#transaction(() => {
      const current = this.#getAiRequest(id);
      if (!current) throw new NotFoundError("AI request tidak ditemukan.");
      if (current.status !== "running") {
        const same =
          current.status === finish.status &&
          canonicalJson(current.usage) === canonicalJson(usage) &&
          current.latencyMs === latency &&
          current.finishReason === reason;
        if (same) return current;
        throw new ConflictError(
          "AI request telah selesai dengan hasil berbeda.",
        );
      }
      const updated = now();
      this.#db
        .prepare(
          `UPDATE ai_requests SET input_tokens = ?, output_tokens = ?, total_tokens = ?,
           cached_input_tokens = ?, reasoning_tokens = ?, status = ?, latency_ms = ?,
           finish_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          usage.cachedInputTokens,
          usage.reasoningTokens,
          finish.status,
          latency,
          reason,
          updated,
          id,
        );
      return this.#getAiRequest(id)!;
    });
  }

  getUsageSummary(sessionId: string, requestId?: string): UsageSummary {
    assertId(sessionId, "session.id");
    if (requestId !== undefined) assertId(requestId, "requestId");
    this.#assertOpen();
    const where =
      requestId === undefined
        ? "session_id = ?"
        : "session_id = ? AND request_id = ?";
    const params =
      requestId === undefined ? [sessionId] : [sessionId, requestId];
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS requests,
         SUM(status = 'running') AS running, SUM(status = 'succeeded') AS succeeded,
         SUM(status = 'failed') AS failed, SUM(status = 'unknown') AS unknown,
         SUM(input_tokens) AS input, COUNT(input_tokens) AS input_known,
         SUM(output_tokens) AS output, COUNT(output_tokens) AS output_known,
         SUM(total_tokens) AS total, COUNT(total_tokens) AS total_known,
         SUM(cached_input_tokens) AS cached, COUNT(cached_input_tokens) AS cached_known,
         SUM(reasoning_tokens) AS reasoning, COUNT(reasoning_tokens) AS reasoning_known,
         SUM(latency_ms) AS latency, COUNT(latency_ms) AS latency_known,
         SUM(input_tokens IS NULL OR output_tokens IS NULL OR total_tokens IS NULL) AS unknown_usage
         FROM ai_requests WHERE ${where}`,
      )
      .get(...params) as SqlRow;
    const total = (sum: unknown, count: unknown): number | null =>
      Number(count) === 0 ? null : Number(sum);
    return {
      requests: Number(row.requests),
      statuses: {
        running: Number(row.running ?? 0),
        succeeded: Number(row.succeeded ?? 0),
        failed: Number(row.failed ?? 0),
        unknown: Number(row.unknown ?? 0),
      },
      inputTokens: total(row.input, row.input_known),
      outputTokens: total(row.output, row.output_known),
      totalTokens: total(row.total, row.total_known),
      cachedInputTokens: total(row.cached, row.cached_known),
      reasoningTokens: total(row.reasoning, row.reasoning_known),
      unknownUsageRequests: Number(row.unknown_usage ?? 0),
      latencyMs: total(row.latency, row.latency_known),
    };
  }
  saveContextTelemetry(
    sessionId: string,
    requestId: string,
    rawTelemetry: ContextTelemetry,
  ): void {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    const telemetry = validateContextTelemetry(rawTelemetry);
    jsonText(telemetry, 64 * 1024);
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    const loreRefs = parseLoreRefs(
      session.lorebookRefs ?? session.definitionSnapshot.lorebookRefs ?? [],
    );
    for (const loreId of telemetry.selectedLoreIds) {
      if (!loreRefs.some((ref) => this.#loreEntryRow(ref, loreId))) {
        throw new ValidationError(
          `selectedLoreId ${loreId} tidak ada pada lore yang dipin.`,
        );
      }
    }
    this.#transaction(() => {
      const run = this.#db
        .prepare(
          "SELECT 1 AS found FROM turns WHERE session_id = ? AND request_id = ?",
        )
        .get(sessionId, requestId);
      if (!run) throw new NotFoundError("Run ledger tidak ditemukan.");
      const old = this.#db
        .prepare(
          "SELECT * FROM context_telemetry WHERE session_id = ? AND request_id = ?",
        )
        .get(sessionId, requestId) as SqlRow | undefined;
      if (old) {
        const previous = validateContextTelemetry({
          contextChars: old.context_chars,
          approximateTokens: old.approximate_tokens,
          tokenEstimateMethod: old.token_estimate_method,
          sections: parseJson(old.sections_json as string, "Context sections"),
          selectedLoreIds: parseJson(
            old.selected_lore_ids_json as string,
            "Selected lore IDs",
          ),
          omissions: parseJson(
            old.omissions_json as string,
            "Context omissions",
          ),
          toolCalls: old.tool_calls,
          repairs: old.repairs,
          ...(old.trace_json === undefined
            ? {}
            : {
                trace: parseJson(old.trace_json as string, "Context trace"),
              }),
        });
        if (canonicalJson(previous) !== canonicalJson(telemetry)) {
          throw new ConflictError(
            "Context telemetry sudah disimpan dengan nilai berbeda.",
          );
        }
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO context_telemetry(
             session_id, request_id, context_chars, approximate_tokens,
             token_estimate_method, sections_json, selected_lore_ids_json,
             omissions_json, tool_calls, repairs, trace_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          requestId,
          telemetry.contextChars,
          telemetry.approximateTokens,
          telemetry.tokenEstimateMethod,
          jsonText(telemetry.sections),
          jsonText(telemetry.selectedLoreIds),
          jsonText(telemetry.omissions),
          telemetry.toolCalls,
          telemetry.repairs,
          jsonText(telemetry.trace ?? { events: [], dropped: 0 }),
          now(),
        );
    });
  }

  getContextTelemetry(
    sessionId: string,
    requestId: string,
  ): ContextTelemetry | undefined {
    assertId(sessionId, "session.id");
    assertId(requestId, "requestId");
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT * FROM context_telemetry
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as SqlRow | undefined;
    if (!row) return undefined;
    try {
      return validateContextTelemetry({
        contextChars: row.context_chars,
        approximateTokens: row.approximate_tokens,
        tokenEstimateMethod: row.token_estimate_method,
        sections: parseJson(row.sections_json as string, "Context sections"),
        selectedLoreIds: parseJson(
          row.selected_lore_ids_json as string,
          "Selected lore IDs",
        ),
        omissions: parseJson(row.omissions_json as string, "Context omissions"),
        toolCalls: row.tool_calls,
        repairs: row.repairs,
        ...(row.trace_json === undefined
          ? {}
          : {
              trace: parseJson(row.trace_json as string, "Context trace"),
            }),
      });
    } catch (error) {
      throw new CorruptDatabaseError(
        `Context telemetry rusak: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  estimateTokens(
    chars: number,
    provider: AiConfig["provider"],
    model: string,
  ): { approximateTokens: number; method: string } {
    assertTokenCount(chars, "chars");
    if (
      (provider !== "gemini" &&
        provider !== "openrouter" &&
        provider !== "custom") ||
      typeof model !== "string" ||
      !model.trim() ||
      model.length > 256
    ) {
      throw new ValidationError("Provider atau model tidak valid.");
    }
    this.#assertOpen();
    const observed = this.#db
      .prepare(
        `SELECT SUM(usage.input_tokens) AS tokens,
           SUM(t.context_chars) AS chars
         FROM context_telemetry t
         JOIN (
           SELECT session_id, request_id, MAX(input_tokens) AS input_tokens
           FROM ai_requests
           WHERE provider = ? AND model = ? AND status = 'succeeded'
             AND request_id IS NOT NULL AND input_tokens > 0
           GROUP BY session_id, request_id
         ) usage ON usage.session_id = t.session_id
           AND usage.request_id = t.request_id
         WHERE t.context_chars > 0`,
      )
      .get(provider, model) as SqlRow;
    const observedChars = Number(observed.chars ?? 0);
    const observedTokens = Number(observed.tokens ?? 0);
    if (observedChars > 0 && observedTokens > 0) {
      return {
        approximateTokens: Math.ceil((chars * observedTokens) / observedChars),
        method: "observed-ratio",
      };
    }
    return { approximateTokens: Math.ceil(chars / 4), method: "chars-per-4" };
  }

  searchMemory(
    sessionId: string,
    query: string,
    npcId?: string,
  ): MemoryResult[] {
    assertId(sessionId, "session.id");
    if (typeof query !== "string")
      throw new ValidationError("Query harus string.");
    const ftsQuery = makeFtsQuery(query.trim());
    if (!ftsQuery) return [];
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    if (
      npcId !== undefined &&
      !session.definitionSnapshot.npcs.some((npc) => npc.id === npcId)
    ) {
      throw new NotFoundError("NPC tidak ditemukan pada session.");
    }
    const audienceId = npcId ?? "player";
    const facts = session.state.facts.filter((fact) => {
      if (fact.visibility === "private" && !fact.knownBy.includes(audienceId)) {
        return false;
      }
      const text = fact.text.normalize("NFKC").toLocaleLowerCase();
      const tokens =
        query
          .normalize("NFKC")
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}_-]+/gu) ?? [];
      let matches = false;
      for (const token of tokens) {
        if (text.includes(token)) {
          matches = true;
          break;
        }
      }
      return matches;
    });
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.session_id = ? AND ${MESSAGE_AUDIENCE_SCOPE}
         ORDER BY bm25(messages_fts), m.sequence DESC LIMIT 20`,
      )
      .all(ftsQuery, sessionId, audienceId, audienceId) as SqlRow[];
    const messages = rows.map((row) => this.#messageFromRow(row));
    if (messages.length) validateMessages(session, messages);
    const results: MemoryResult[] = [];
    let excerptBytes = 0;
    const add = (result: MemoryResult): void => {
      if (results.length >= 5 || excerptBytes >= 4000) return;
      const text = result.kind === "fact" ? result.excerpt : result.excerpt;
      const remaining = 4000 - excerptBytes;
      const excerpt = truncateUtf8(text, remaining);
      if (!excerpt) return;
      excerptBytes += Buffer.byteLength(excerpt, "utf8");
      results.push({ ...result, excerpt });
    };
    for (const fact of facts) {
      add({
        kind: "fact",
        id: fact.id,
        excerpt: fact.text,
        source: fact.source,
        visibility: fact.visibility,
        knownBy: fact.knownBy,
        createdAt: fact.createdAt,
      });
    }
    for (const message of messages) {
      add({
        kind: "message",
        id: message.id,
        turnId: message.turnId,
        sequence: message.sequence,
        role: message.role,
        ...(message.speakerId ? { speakerId: message.speakerId } : {}),
        excerpt: message.content,
        createdAt: message.createdAt,
      });
    }
    return results;
  }
  compactStory(sessionId: string, rangeSize = 20): number {
    assertId(sessionId, "session.id");
    if (!Number.isSafeInteger(rangeSize) || rangeSize < 1 || rangeSize > 100) {
      throw new ValidationError("rangeSize harus integer 1 sampai 100.");
    }
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#getSessionRow(sessionId);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const session = this.#sessionFromRow(row);
      const cursorRow = this.#db
        .prepare(
          "SELECT next_sequence FROM story_summary_cursors WHERE session_id = ?",
        )
        .get(sessionId) as SqlRow | undefined;
      let cursor = cursorRow ? Number(cursorRow.next_sequence) : 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new CorruptDatabaseError("Story summary cursor rusak.");
      }
      let inserted = 0;
      for (
        let range = 0;
        range < MAX_SUMMARY_RANGES_PER_CALL && cursor < session.nextSequence;
        range += 1
      ) {
        const end = Math.min(cursor + rangeSize, session.nextSequence);
        const rows = this.#db
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ? AND sequence >= ? AND sequence < ?
               AND sequence < ?
             ORDER BY sequence LIMIT ?`,
          )
          .all(
            sessionId,
            cursor,
            end,
            session.nextSequence,
            rangeSize,
          ) as SqlRow[];
        const messages = rows.map((item) => this.#messageFromRow(item));
        if (messages.length) validateMessages(session, messages);
        const groups = new Map<
          string,
          {
            visibility: "public" | "private";
            knownBy: string[];
            messages: Message[];
          }
        >();
        for (const message of messages) {
          const visibility = message.visibility ?? "private";
          const knownBy = [
            ...new Set(
              message.visibility === undefined
                ? ["player"]
                : (message.knownBy ?? []),
            ),
          ].sort();
          const key = canonicalJson([visibility, knownBy]);
          let group = groups.get(key);
          if (!group) {
            group = { visibility, knownBy, messages: [] };
            groups.set(key, group);
          }
          group.messages.push(message);
        }
        for (const [, group] of [...groups].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const lines: string[] = [];
          let summaryBytes = 0;
          for (const message of group.messages) {
            const prefix = `${message.sequence} ${message.role}${
              message.speakerId ? `(${message.speakerId})` : ""
            }: `;
            const prefixBytes = Buffer.byteLength(prefix, "utf8");
            const separatorBytes = lines.length ? 1 : 0;
            const remaining = Math.max(
              0,
              Math.min(
                SUMMARY_EXCERPT_BYTES - prefixBytes,
                SUMMARY_MAX_BYTES - summaryBytes - separatorBytes - prefixBytes,
              ),
            );
            if (remaining === 0) continue;
            const excerpt = truncateUtf8(message.content, remaining);
            const line = `${prefix}${excerpt}`;
            const bytes = Buffer.byteLength(line, "utf8");
            if (summaryBytes + separatorBytes + bytes > SUMMARY_MAX_BYTES)
              break;
            lines.push(line);
            summaryBytes += separatorBytes + bytes;
          }
          const summary = lines.join("\n");
          if (!summary) continue;
          const sourceDigest = createHash("sha256")
            .update(canonicalJson(group.messages))
            .digest("hex");
          const result = this.#db
            .prepare(
              `INSERT OR IGNORE INTO story_summaries(
                 session_id, from_sequence, to_sequence, summary, source_digest,
                 visibility, known_by_json, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              sessionId,
              cursor,
              end - 1,
              summary,
              sourceDigest,
              group.visibility,
              jsonText(group.knownBy),
              now(),
            );
          inserted += Number(result.changes);
        }
        cursor = end;
        this.#db
          .prepare(
            `INSERT INTO story_summary_cursors(session_id, next_sequence)
             VALUES (?, ?)
             ON CONFLICT(session_id) DO UPDATE SET next_sequence = excluded.next_sequence`,
          )
          .run(sessionId, cursor);
      }
      return inserted;
    });
  }

  getStorySummaries(
    sessionId: string,
    options: { query?: string; npcId?: string; limit?: number } = {},
  ): StorySummary[] {
    assertId(sessionId, "session.id");
    if (
      !isObject(options) ||
      Object.keys(options).some(
        (key) => !["query", "npcId", "limit"].includes(key),
      )
    ) {
      throw new ValidationError("Opsi story summaries tidak dikenal.");
    }
    this.#assertOpen();
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    const limit = options.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationError("limit harus integer 1 sampai 50.");
    }
    if (options.query !== undefined && typeof options.query !== "string") {
      throw new ValidationError("Query summary harus string.");
    }
    if (
      options.npcId !== undefined &&
      !session.definitionSnapshot.npcs.some((npc) => npc.id === options.npcId)
    ) {
      throw new NotFoundError("NPC tidak ditemukan pada session.");
    }
    const npcId = options.npcId ?? "player";
    const query = options.query?.trim();
    const ftsQuery = query ? makeTopicFtsQuery(query, "OR") : "";
    if (query && !ftsQuery) return [];
    const join = ftsQuery
      ? "JOIN story_summaries_fts ON story_summaries_fts.rowid = s.rowid"
      : "";
    const params: (string | number)[] = [sessionId];
    const search = ftsQuery ? "AND story_summaries_fts MATCH ?" : "";
    if (ftsQuery) params.push(ftsQuery);
    params.push(npcId, limit);
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM story_summaries s ${join}
         WHERE s.session_id = ? ${search}
           AND (s.visibility = 'public' OR (
             s.visibility = 'private' AND EXISTS (
               SELECT 1 FROM json_each(s.known_by_json) known
               WHERE known.value = ?
             )
           ))
         ORDER BY ${
           ftsQuery
             ? "bm25(story_summaries_fts), s.to_sequence DESC, s.from_sequence DESC"
             : "s.to_sequence DESC, s.from_sequence DESC"
         }
         LIMIT ?`,
      )
      .all(...params) as SqlRow[];
    return rows.map((item) => {
      const knownBy = parseJson<unknown>(
        item.known_by_json as string,
        "Story summary knowledge",
      );
      if (
        !Array.isArray(knownBy) ||
        knownBy.some((value) => typeof value !== "string")
      ) {
        throw new CorruptDatabaseError("Story summary knowledge rusak.");
      }
      return {
        sessionId: String(item.session_id),
        fromSequence: Number(item.from_sequence),
        toSequence: Number(item.to_sequence),
        summary: String(item.summary),
        sourceDigest: String(item.source_digest),
        visibility: String(item.visibility) as StorySummary["visibility"],
        knownBy,
        createdAt: String(item.created_at),
      };
    });
  }

  getNpcDetails(
    sessionId: string,
    npcId: string,
  ): NpcDefinition & { relationship: Record<string, number> | null } {
    assertId(sessionId, "session.id");
    assertId(npcId, "npc.id");
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    const npc = session.definitionSnapshot.npcs.find(
      (entry) => entry.id === npcId,
    );
    if (!npc) throw new NotFoundError("NPC tidak ditemukan pada session.");
    const relationship = session.state.relationships.find(
      (entry) => entry.npcId === npcId,
    );
    return {
      ...structuredClone(npc),
      relationship: relationship ? structuredClone(relationship.values) : null,
    };
  }

  getItemDetails(
    sessionId: string,
    itemId: string,
  ): GameDefinition["items"][number] & { quantity: number } {
    assertId(sessionId, "session.id");
    assertId(itemId, "item.id");
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    const item = session.definitionSnapshot.items.find(
      (entry) => entry.id === itemId,
    );
    if (!item) throw new NotFoundError("Item tidak ditemukan pada session.");
    return {
      ...structuredClone(item),
      quantity: session.state.inventory
        .filter((entry) => entry.itemId === itemId)
        .reduce((sum, entry) => sum + entry.quantity, 0),
    };
  }

  exportSave(sessionId: string): ExportBundle {
    const session = this.getSession(sessionId);
    if (!session) throw new NotFoundError("Session tidak ditemukan.");
    const messages = this.getHistory(sessionId);
    const refs = parseLoreRefs(
      session.lorebookRefs ?? session.definitionSnapshot.lorebookRefs ?? [],
    );
    this.validateLoreBindings(refs, session.definitionSnapshot);
    const dependencies: LoreDependency[] = refs.map((ref) => {
      const row = this.#packRow(ref);
      if (!row) {
        throw new ConflictError(
          `Lore dependency ${ref.packId}@${ref.version} belum dipasang.`,
          "LORE_DEPENDENCY_MISSING",
        );
      }
      return { ...ref, digest: String(row.digest) };
    });
    const bundle = createExportBundle(session, messages, now(), dependencies);
    jsonText(bundle, TRANSFER_LIMIT);
    return bundle;
  }

  importSave(raw: unknown): { gameId: string; sessionId: string } {
    jsonText(raw, TRANSFER_LIMIT);
    assertNoDangerousKeys(raw);
    if (isObject(raw)) {
      validateDefinitionShape(raw.game);
      if (isObject(raw.session))
        validateDefinitionShape(raw.session.definitionSnapshot);
    }
    const prepared = validateExportBundle(raw);
    assertId(prepared.game.id, "game.id");
    assertId(prepared.session.id, "session.id");
    const refs = parseLoreRefs(prepared.game.lorebookRefs ?? []);
    if (prepared.loreDependencies !== undefined) {
      const keys = (values: LorebookRef[]) =>
        values.map((ref) => `${ref.packId}\u0000${ref.version}`).sort();
      const equalRefs = (candidate: LorebookRef[]): boolean =>
        canonicalJson(keys(refs)) === canonicalJson(keys(candidate));
      const sessionRefs =
        prepared.session.lorebookRefs === undefined
          ? undefined
          : parseLoreRefs(prepared.session.lorebookRefs);
      const snapshotRefs =
        prepared.session.definitionSnapshot.lorebookRefs === undefined
          ? undefined
          : parseLoreRefs(prepared.session.definitionSnapshot.lorebookRefs);
      if (
        (sessionRefs !== undefined && !equalRefs(sessionRefs)) ||
        (snapshotRefs !== undefined && !equalRefs(snapshotRefs))
      ) {
        throw new ConflictError(
          "Session pins berbeda dari manifest save.",
          "INVALID_LORE_BINDING",
        );
      }
      this.validateLoreBindings(refs, prepared.game);
      for (const dependency of prepared.loreDependencies) {
        const row = this.#packRow(dependency);
        if (!row) {
          throw new ConflictError(
            `Lore dependency ${dependency.packId}@${dependency.version} belum dipasang.`,
            "LORE_DEPENDENCY_MISSING",
          );
        }
        if (String(row.digest) !== dependency.digest) {
          throw new ConflictError(
            `Lore dependency ${dependency.packId}@${dependency.version} memiliki digest berbeda.`,
            "LORE_DEPENDENCY_MISMATCH",
          );
        }
      }
    } else if (refs.length) {
      throw new ConflictError(
        "Save lore-bound wajib menyertakan manifest v2.",
        "INVALID_LORE_BINDING",
      );
    }
    const gameId = randomUUID();
    const sessionId = randomUUID();
    const game: GameDefinition = { ...prepared.game, id: gameId };
    const definitionSnapshot: GameDefinition = {
      ...prepared.session.definitionSnapshot,
      id: gameId,
      ...(prepared.loreDependencies === undefined
        ? {}
        : { lorebookRefs: structuredClone(refs) }),
    };
    const session: GameSession = {
      ...prepared.session,
      id: sessionId,
      gameId,
      definitionSnapshot,
      ai: normalizeAi(prepared.session.ai),
      updatedAt: now(),
      ...(prepared.loreDependencies === undefined
        ? {}
        : { lorebookRefs: structuredClone(refs) }),
    };
    const messages = prepared.messages.map((message) => ({
      ...message,
      id: randomUUID(),
      sessionId,
    }));
    validateSessionDocument(session, messages);
    this.#transaction(() => {
      this.#insertGame(game);
      this.#insertSession(session);
      for (const message of messages) this.#insertMessage(message);
    });
    return { gameId, sessionId };
  }

  transferLegacyStores(raw: unknown): MigrationReceipt {
    jsonText(raw, TRANSFER_LIMIT);
    assertNoDangerousKeys(raw);
    if (!isObject(raw))
      throw new ValidationError("Legacy stores harus object.");
    assertPlainArray(raw.games, "games");
    assertPlainArray(raw.sessions, "sessions");
    assertPlainArray(raw.messages, "messages");

    const gameById = new Map<string, GameDefinition>();
    for (const entry of raw.games) {
      const game = validateDefinitionDocument(entry);
      if (gameById.has(game.id))
        throw new ConflictError(`Game duplikat: ${game.id}.`);
      gameById.set(game.id, game);
    }

    const sessionById = new Map<string, GameSession>();
    const messagesBySession = new Map<string, Message[]>();
    for (const entry of raw.sessions) {
      if (!isObject(entry))
        throw new ValidationError("Legacy session bukan object.");
      assertId(entry.id, "session.id");
      assertId(entry.gameId, "session.gameId");
      if (!gameById.has(entry.gameId)) {
        throw new ValidationError(
          `Session ${entry.id} merujuk game yang hilang.`,
        );
      }
      const snapshot = validateDefinitionDocument(entry.definitionSnapshot);
      if (snapshot.id !== entry.gameId) {
        throw new ValidationError(
          `Session ${entry.id} memiliki snapshot game yang salah.`,
        );
      }
      const id = entry.id;
      if (sessionById.has(id))
        throw new ConflictError(`Session duplikat: ${id}.`);
      sessionById.set(id, entry as unknown as GameSession);
      messagesBySession.set(id, []);
    }

    const messageIds = new Set<string>();
    const allMessages: Message[] = [];
    for (const entry of raw.messages) {
      if (!isObject(entry))
        throw new ValidationError("Legacy message bukan object.");
      assertId(entry.id, "message.id");
      assertId(entry.sessionId, "message.sessionId");
      if (messageIds.has(entry.id))
        throw new ConflictError(`Message duplikat: ${entry.id}.`);
      messageIds.add(entry.id);
      const group = messagesBySession.get(entry.sessionId);
      if (!group)
        throw new ValidationError(
          `Message ${entry.id} merujuk session yang hilang.`,
        );
      group.push(entry as unknown as Message);
      allMessages.push(entry as unknown as Message);
    }

    for (const [id, rawSession] of sessionById) {
      const session = validateSessionDocument(
        rawSession,
        messagesBySession.get(id)!,
      );
      sessionById.set(id, { ...session, pinned: session.pinned ?? false });
    }
    const normalized = {
      games: [...gameById.values()].sort((a, b) => a.id.localeCompare(b.id)),
      sessions: [...sessionById.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      messages: allMessages
        .map((message) => {
          const owner = sessionById.get(message.sessionId)!;
          return validateMessages(owner, [message])[0];
        })
        .sort(
          (a, b) =>
            a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence,
        ),
    };
    const canonical = canonicalJson(normalized);
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    const counts = {
      games: normalized.games.length,
      sessions: normalized.sessions.length,
      messages: normalized.messages.length,
    };
    const ids = {
      games: normalized.games.map((game) => game.id),
      sessions: normalized.sessions.map((session) => session.id),
      messages: normalized.messages.map((message) => message.id),
    };

    return this.#transaction(() => {
      const old = this.#db
        .prepare("SELECT receipt_json FROM migrations WHERE fingerprint = ?")
        .get(fingerprint) as SqlRow | undefined;
      if (old)
        return parseJson<MigrationReceipt>(
          old.receipt_json as string,
          "Migration receipt",
        );

      for (const game of normalized.games) {
        const existing = this.#getGameRow(game.id);
        if (existing) {
          if (
            canonicalJson(gameValue(this.#gameFromRow(existing))) !==
            canonicalJson(game)
          ) {
            throw new ConflictError(
              `Game ID ${game.id} sudah dipakai data berbeda.`,
            );
          }
        } else {
          this.#insertGame(game);
        }
      }
      for (const session of normalized.sessions) {
        const existing = this.#getSessionRow(session.id);
        if (existing) {
          const current = this.#sessionFromRow(existing);
          if (canonicalJson(sessionValue(current)) !== canonicalJson(session)) {
            throw new ConflictError(
              `Session ID ${session.id} sudah dipakai data berbeda.`,
            );
          }
        } else {
          this.#insertSession(session);
        }
      }
      for (const message of normalized.messages) {
        const existing = this.#db
          .prepare("SELECT * FROM messages WHERE id = ?")
          .get(message.id) as SqlRow | undefined;
        if (existing) {
          if (
            canonicalJson(this.#messageFromRow(existing)) !==
            canonicalJson(message)
          ) {
            throw new ConflictError(
              `Message ID ${message.id} sudah dipakai data berbeda.`,
            );
          }
        } else {
          this.#insertMessage(message);
        }
      }

      for (const game of normalized.games) {
        if (
          canonicalJson(
            gameValue(this.#gameFromRow(this.#getGameRow(game.id)!)),
          ) !== canonicalJson(game)
        ) {
          throw new CorruptDatabaseError(`Read-back game gagal: ${game.id}.`);
        }
      }
      for (const session of normalized.sessions) {
        const row = this.#getSessionRow(session.id);
        if (
          !row ||
          canonicalJson(sessionValue(this.#sessionFromRow(row))) !==
            canonicalJson(session)
        ) {
          throw new CorruptDatabaseError(
            `Read-back session gagal: ${session.id}.`,
          );
        }
      }
      for (const message of normalized.messages) {
        const row = this.#db
          .prepare("SELECT * FROM messages WHERE id = ?")
          .get(message.id) as SqlRow;
        if (
          canonicalJson(this.#messageFromRow(row)) !== canonicalJson(message)
        ) {
          throw new CorruptDatabaseError(
            `Read-back message gagal: ${message.id}.`,
          );
        }
      }
      const receipt: MigrationReceipt = {
        fingerprint,
        counts,
        ids,
        verified: true,
        verifiedAt: now(),
      };
      this.#db
        .prepare(
          "INSERT INTO migrations(fingerprint, counts_json, ids_json, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          fingerprint,
          jsonText(counts),
          jsonText(ids),
          jsonText(receipt),
          receipt.verifiedAt,
        );
      return receipt;
    });
  }

  getMigrationReceipt(fingerprint: string): MigrationReceipt | undefined {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new ValidationError("Fingerprint migrasi tidak valid.");
    }
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT receipt_json FROM migrations WHERE fingerprint = ?")
      .get(fingerprint) as SqlRow | undefined;
    return row
      ? parseJson<MigrationReceipt>(
          row.receipt_json as string,
          "Migration receipt",
        )
      : undefined;
  }

  getLatestMigrationReceipt(): MigrationReceipt | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        "SELECT receipt_json FROM migrations ORDER BY created_at DESC LIMIT 1",
      )
      .get() as SqlRow | undefined;
    return row
      ? parseJson<MigrationReceipt>(
          row.receipt_json as string,
          "Migration receipt",
        )
      : undefined;
  }

  hasRunningRuns(): boolean {
    this.#assertOpen();
    return Boolean(
      this.#db
        .prepare(
          "SELECT 1 AS found FROM turns WHERE status = 'running' LIMIT 1",
        )
        .get(),
    );
  }

  async backupTo(targetPath: string): Promise<string> {
    this.#assertOpen();
    const target = resolve(targetPath);
    if (target.toLocaleLowerCase() === this.#path.toLocaleLowerCase()) {
      throw new ValidationError(
        "Backup harus memakai path berbeda dari database aktif.",
      );
    }
    await backup(this.#db, target);
    return target;
  }

  static async restoreFrom(
    backupPath: string,
    databasePath: string,
  ): Promise<GameDatabase> {
    const sourcePath = resolve(backupPath);
    const targetPath = resolve(databasePath);
    if (sourcePath.toLocaleLowerCase() === targetPath.toLocaleLowerCase()) {
      throw new ValidationError("Restore memerlukan path tujuan berbeda.");
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const stagePath = `${targetPath}.restore-${randomUUID()}`;
    const previousPath = `${targetPath}.previous-${randomUUID()}`;
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const version = Number(
        (source.prepare("PRAGMA user_version").get() as SqlRow).user_version,
      );
      if (
        version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== SCHEMA_VERSION
      ) {
        throw new DatabaseError(
          "File backup bukan database Fworld yang didukung.",
          "SCHEMA_VERSION",
        );
      }
      const integrity = source.prepare("PRAGMA quick_check").get() as SqlRow;
      if (integrity.quick_check !== "ok") {
        throw new CorruptDatabaseError("Backup SQLite gagal quick_check.");
      }
      await backup(source, stagePath);
    } finally {
      source.close();
    }
    try {
      const staged = new GameDatabase(stagePath);
      try {
        const integrity = staged.#db
          .prepare("PRAGMA quick_check")
          .get() as SqlRow;
        if (integrity.quick_check !== "ok") {
          throw new CorruptDatabaseError(
            "Backup SQLite gagal quick_check setelah migrasi.",
          );
        }
        if (staged.#db.prepare("PRAGMA foreign_key_check").all().length) {
          throw new CorruptDatabaseError("Backup melanggar foreign key.");
        }
        staged.#validateAiMetadata();
        staged.listTemplates();
        for (const game of staged.listGames()) {
          const refs = parseLoreRefs(game.lorebookRefs ?? []);
          if (refs.length) staged.validateLoreBindings(refs, game);
          for (const session of staged.listSessions(game.id)) {
            staged.getHistory(session.id);
            staged.getWorldMap(session);
            const sessionRefs = parseLoreRefs(session.lorebookRefs ?? []);
            if (sessionRefs.length) {
              staged.validateLoreBindings(
                sessionRefs,
                session.definitionSnapshot,
              );
            }
          }
        }
      } finally {
        staged.close();
      }
      await rm(`${stagePath}-wal`, { force: true });
      await rm(`${stagePath}-shm`, { force: true });
      const oldFiles: Array<[string, string]> = [
        [targetPath, previousPath],
        [`${targetPath}-wal`, `${previousPath}-wal`],
        [`${targetPath}-shm`, `${previousPath}-shm`],
      ];
      const moved: Array<[string, string]> = [];
      const moveIfPresent = async (
        from: string,
        to: string,
      ): Promise<boolean> => {
        try {
          await rename(from, to);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      let installed = false;
      try {
        for (const [from, to] of oldFiles) {
          if (await moveIfPresent(from, to)) moved.push([from, to]);
        }
        await rename(stagePath, targetPath);
        installed = true;
        const restored = new GameDatabase(targetPath);
        for (const [, oldPath] of moved) {
          try {
            await rm(oldPath, { force: true });
          } catch {}
        }
        return restored;
      } catch (error) {
        if (installed) {
          await rm(targetPath, { force: true });
          await rm(`${targetPath}-wal`, { force: true });
          await rm(`${targetPath}-shm`, { force: true });
        }
        for (const [oldPath, from] of moved.reverse()) {
          await rename(from, oldPath);
        }
        throw error;
      }
    } finally {
      await rm(stagePath, { force: true });
      await rm(`${stagePath}-wal`, { force: true });
      await rm(`${stagePath}-shm`, { force: true });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#summaryImmediate) {
      clearImmediate(this.#summaryImmediate);
      this.#summaryImmediate = undefined;
    }
    if (this.#summaryRetryTimer) {
      clearTimeout(this.#summaryRetryTimer);
      this.#summaryRetryTimer = undefined;
    }
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.#db.close();
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let size = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes) break;
    result += char;
    size += bytes;
  }
  return result;
}

function now(): string {
  return new Date().toISOString();
}
