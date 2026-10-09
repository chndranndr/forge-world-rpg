import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { buildInitialState } from "../shared/engine.js";
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
  type AiConfig,
  type ExportBundle,
  type GameDefinition,
  type GameSession,
  type Message,
  type NpcDefinition,
  type SessionState,
} from "../shared/types.js";

export { ImportError } from "../shared/validation.js";

const SCHEMA_VERSION = 1;
const DOCUMENT_LIMIT = 2 * 1024 * 1024;
const TRANSFER_LIMIT = 32 * 1024 * 1024;
const ID_LIMIT = 256;
const ROLES = new Set(["PLAYER", "NPC", "NARRATOR", "SYSTEM_EVENT"]);
const RUN_STATUSES = new Set(["running", "committed", "failed", "interrupted"]);
const AI_KINDS = new Set(["turn", "opening", "choices", "connection_test"]);
const AI_STATUSES = new Set(["running", "succeeded", "failed", "unknown"]);

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
  constructor(message: string) {
    super(message, "CONFLICT");
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
  ai: unknown;
  sessionId?: string;
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
}

export interface RunCommit {
  state: unknown;
  messages: unknown[];
  result: unknown;
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
  if (raw.provider !== "gemini" && raw.provider !== "openrouter") {
    throw new ValidationError("AI provider tidak dikenal.");
  }
  if (
    typeof raw.model !== "string" ||
    !raw.model.trim() ||
    raw.model.length > 256
  ) {
    throw new ValidationError("AI model tidak valid.");
  }
  return { provider: raw.provider, model: raw.model.trim() };
}

function assertPlainArray(
  value: unknown,
  label: string,
): asserts value is JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new ValidationError(`${label} harus array object yang valid.`);
  }
}

function makeBundle(
  game: GameDefinition,
  session: GameSession,
  messages: Message[],
): ExportBundle {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    game,
    session,
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
  if (typeof session.updatedAt !== "string" || !session.updatedAt) {
    throw new ValidationError("session.updatedAt harus string tidak kosong.");
  }
  const stateOnly = {
    ...session,
    definitionSnapshot: definition,
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
    makeBundle(definition, session, messages),
  );
  return checked.session;
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
      (message.check !== undefined && !isObject(message.check))
    ) {
      throw new ValidationError(`messages[${index}] shape tidak valid.`);
    }
    assertNoDangerousKeys(message);
    assertId(message.id, `messages[${index}].id`);
    assertId(message.sessionId, `messages[${index}].sessionId`);
    assertId(message.turnId, `messages[${index}].turnId`);
    assertSequence(message.sequence);
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
    (provider !== "gemini" && provider !== "openrouter") ||
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

export class GameDatabase {
  readonly #db: DatabaseSync;
  readonly #path: string;
  #closed = false;

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
    if (version === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE games (
          id TEXT PRIMARY KEY NOT NULL,
          definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
          revision INTEGER NOT NULL CHECK (revision > 0),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
          definition_snapshot_json TEXT NOT NULL CHECK (json_valid(definition_snapshot_json)),
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          ai_json TEXT NOT NULL CHECK (json_valid(ai_json)),
          next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
          revision INTEGER NOT NULL CHECK (revision > 0),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX sessions_by_game ON sessions(game_id, updated_at DESC);
        CREATE TABLE messages (
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
        CREATE INDEX messages_page ON messages(session_id, sequence);
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content, content='messages', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TABLE turns (
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
        CREATE UNIQUE INDEX one_running_turn_per_session ON turns(session_id) WHERE status = 'running';
        CREATE TABLE ai_requests (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          request_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('turn','opening','choices','connection_test')),
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          provider TEXT NOT NULL CHECK (provider IN ('gemini','openrouter')),
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
        CREATE INDEX ai_usage_by_session ON ai_requests(session_id, created_at);
        CREATE INDEX ai_usage_by_run ON ai_requests(session_id, request_id, attempt);
        CREATE UNIQUE INDEX ai_attempt_once ON ai_requests(session_id, request_id, kind, attempt)
          WHERE request_id IS NOT NULL;
        CREATE TABLE migrations (
          fingerprint TEXT PRIMARY KEY NOT NULL,
          counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
          ids_json TEXT NOT NULL CHECK (json_valid(ids_json)),
          receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
          created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
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
    if (running) throw new ConflictError("Session sedang menjalankan turn.");
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
           next_sequence, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  #insertMessage(message: Message): void {
    this.#db
      .prepare(
        `INSERT INTO messages(
           id, session_id, turn_id, sequence, role, speaker_id, content, check_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  createGame(raw: unknown): StoredGame {
    const definition = validateDefinitionDocument(raw, now());
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
    const sessionRows = this.#db
      .prepare("SELECT * FROM sessions WHERE game_id = ? ORDER BY id")
      .all(id) as SqlRow[];
    if (sessionRows.length) {
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
      const errors = validateDefinitionUpdate(
        this.#gameFromRow(row),
        definition,
      );
      if (errors.length) throw new ValidationError(errors.join(" "));
    }
    const result = this.#db
      .prepare(
        "UPDATE games SET definition_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .run(jsonText(definition), definition.updatedAt, id, expectedRevision);
    if (Number(result.changes) !== 1)
      throw new ConflictError("Game revision berubah.");
    for (const sessionRow of sessionRows) {
      const current = this.#sessionFromRow(sessionRow);
      const updated: GameSession = {
        ...sessionValue(current),
        definitionSnapshot: structuredClone(definition),
        updatedAt: definition.updatedAt,
      };
      validateSessionDocument(updated, this.#messages(updated.id));
      const sessionResult = this.#db
        .prepare(
          `UPDATE sessions SET definition_snapshot_json = ?, revision = revision + 1,
           updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
          jsonText(updated.definitionSnapshot),
          updated.updatedAt,
          updated.id,
          current.revision,
        );
      if (Number(sessionResult.changes) !== 1) {
        throw new ConflictError(`Session ${updated.id} revision berubah.`);
      }
    }
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
          .prepare("SELECT 1 AS found FROM sessions WHERE game_id = ? LIMIT 1")
          .get(id)
      ) {
        throw new ConflictError("Game masih memiliki session.");
      }
      this.#db
        .prepare("DELETE FROM games WHERE id = ? AND revision = ?")
        .run(id, expectedRevision);
    });
  }

  startSessionForDefinition(
    input: StartSessionForDefinitionInput,
  ): SessionStartResult {
    if (!isObject(input))
      throw new ValidationError("Session start harus object.");
    const definition = validateDefinitionDocument(input.definition, now());
    const playability = validatePlayability(definition);
    if (playability.length) throw new ValidationError(playability.join(" "));
    const ai = normalizeAi(input.ai);
    const sessionId = input.sessionId ?? randomUUID();
    assertId(sessionId, "session.id");
    if (input.expectedGameRevision !== undefined) {
      assertRevision(input.expectedGameRevision);
    }
    let gameRevision = 1;
    let session!: GameSession;
    this.#transaction(() => {
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
        state: buildInitialState(definition),
        ai,
        nextSequence: 0,
        updatedAt: now(),
      };
      this.#insertSession(session);
    });
    return {
      game: { value: structuredClone(definition), revision: gameRevision },
      session: { value: session, revision: 1 },
    };
  }

  startSession(input: StartSessionForDefinitionInput): SessionStartResult {
    return this.startSessionForDefinition(input);
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
        (key) => !["ai", "definitionSnapshot", "state"].includes(key),
      ) ||
      Object.keys(patch).length === 0
    ) {
      throw new ValidationError("Session update kosong.");
    }
    this.#assertOpen();
    let updated!: GameSession;
    this.#transaction(() => {
      const row = this.#getSessionRow(id);
      if (!row) throw new NotFoundError("Session tidak ditemukan.");
      const stored = this.#sessionFromRow(row);
      this.#checkExpected(stored.revision, expectedRevision, "Session");
      this.#assertNoRunningRun(id);
      const definitionSnapshot =
        patch.definitionSnapshot === undefined
          ? stored.definitionSnapshot
          : validateDefinitionDocument(patch.definitionSnapshot);
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
      const ai = patch.ai === undefined ? stored.ai : normalizeAi(patch.ai);
      updated = {
        id,
        gameId: stored.gameId,
        definitionSnapshot,
        state,
        ai,
        nextSequence: stored.nextSequence,
        updatedAt: now(),
      };
      this.#validateSessionState(updated);
      this.#db
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
        `SELECT * FROM messages WHERE session_id = ? AND sequence < ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(sessionId, beforeSequence, limit + 1) as SqlRow[];
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
      const messages = validateMessages(current, commit.messages);
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
        id: current.id,
        gameId: current.gameId,
        definitionSnapshot: current.definitionSnapshot,
        state,
        ai: current.ai,
        nextSequence: next,
        updatedAt: now(),
      };
      const allMessages = [...this.#messages(sessionId), ...messages];
      validateSessionDocument(updated, allMessages);
      this.#db
        .prepare(
          `UPDATE sessions SET state_json = ?, next_sequence = ?, revision = revision + 1,
           updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
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
    const facts = session.state.facts.filter((fact) => {
      if (
        npcId &&
        fact.visibility === "private" &&
        !fact.knownBy.includes(npcId)
      ) {
        return false;
      }
      const text = fact.text.normalize("NFKC").toLocaleLowerCase();
      const tokens =
        query
          .normalize("NFKC")
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}_-]+/gu) ?? [];
      return tokens.some((token) => text.includes(token));
    });
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.session_id = ? ORDER BY bm25(messages_fts), m.sequence DESC LIMIT 20`,
      )
      .all(ftsQuery, sessionId) as SqlRow[];
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
    const bundle = createExportBundle(session, messages, now());
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
    const gameId = randomUUID();
    const sessionId = randomUUID();
    const game: GameDefinition = { ...prepared.game, id: gameId };
    const session: GameSession = {
      ...prepared.session,
      id: sessionId,
      gameId,
      definitionSnapshot: {
        ...prepared.session.definitionSnapshot,
        id: gameId,
      },
      ai: normalizeAi(prepared.session.ai),
      updatedAt: now(),
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
      sessionById.set(id, session);
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
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const version = Number(
        (source.prepare("PRAGMA user_version").get() as SqlRow).user_version,
      );
      if (version !== SCHEMA_VERSION) {
        throw new DatabaseError(
          "File backup bukan database Fworld yang didukung.",
          "SCHEMA_VERSION",
        );
      }
      const integrity = source.prepare("PRAGMA quick_check").get() as SqlRow;
      if (integrity.quick_check !== "ok") {
        throw new CorruptDatabaseError("Backup SQLite gagal quick_check.");
      }
      await backup(source, targetPath);
    } finally {
      source.close();
    }
    return new GameDatabase(targetPath);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
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
