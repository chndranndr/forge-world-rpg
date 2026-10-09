import type {
  AiConfig,
  ExportBundle,
  GameDefinition,
  GameSession,
  GameTemplateBundle,
  Message,
} from "../shared/types";
import type { Choice } from "../shared/engine";

export interface Versioned<T> {
  value: T;
  revision: number;
}

export type GameRecord = Versioned<GameDefinition>;
export type SessionRecord = Versioned<GameSession>;

export type RunStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface RunResult {
  session?: SessionRecord;
  messages?: Message[];
  choices?: Choice[];
  boundRevision?: number;
}

export interface RunRecord {
  requestId: string;
  status: RunStatus;
  result?: RunResult;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    credentials: "same-origin",
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(
      response.ok
        ? "Backend returned an invalid response."
        : "Backend request failed.",
      response.status,
      "INVALID_RESPONSE",
      response.status >= 500,
    );
  }

  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as Partial<ApiErrorBody>;
    throw new ApiError(
      typeof error.message === "string"
        ? error.message
        : "Backend request failed.",
      response.status,
      typeof error.code === "string" ? error.code : "REQUEST_FAILED",
      error.retryable === true,
      typeof error.requestId === "string" ? error.requestId : undefined,
    );
  }
  return body as T;
}

function json(method: string, value?: unknown): RequestInit {
  return {
    method,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
}

export function getHealth(): Promise<{
  status: "ok";
  schemaVersion: number;
  nodeVersion: string;
}> {
  return api("/health");
}

export function listGames(): Promise<GameRecord[]> {
  return api("/games");
}

export function getGame(id: string): Promise<GameRecord> {
  return api(`/games/${encodeURIComponent(id)}`);
}

export function createGame(definition: GameDefinition): Promise<GameRecord> {
  return api("/games", json("POST", { definition }));
}

export function updateGame(
  id: string,
  expectedRevision: number,
  definition: GameDefinition,
): Promise<GameRecord> {
  return api(
    `/games/${encodeURIComponent(id)}`,
    json("PUT", { expectedRevision, definition }),
  );
}

export function deleteGame(
  id: string,
  expectedRevision: number,
): Promise<void> {
  return api(
    `/games/${encodeURIComponent(id)}`,
    json("DELETE", { expectedRevision }),
  );
}

export function listSessions(gameId: string): Promise<SessionRecord[]> {
  return api(`/games/${encodeURIComponent(gameId)}/sessions`);
}

export function startSession(
  definition: GameDefinition,
  expectedGameRevision: number | undefined,
  ai: AiConfig,
): Promise<{ game: GameRecord; session: SessionRecord }> {
  return api(
    "/sessions/start",
    json("POST", { definition, expectedGameRevision, ai }),
  );
}

export function getSession(id: string): Promise<SessionRecord> {
  return api(`/sessions/${encodeURIComponent(id)}`);
}

export function listMessages(
  sessionId: string,
  options: { beforeSequence?: number; limit?: number } = {},
): Promise<{ messages: Message[]; nextBeforeSequence: number | null }> {
  const query = new URLSearchParams();
  if (options.beforeSequence !== undefined)
    query.set("beforeSequence", String(options.beforeSequence));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const params = query.toString();
  const suffix = params ? `?${params}` : "";
  return api(`/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`);
}

export function updateSessionAi(
  sessionId: string,
  expectedRevision: number,
  ai: AiConfig,
): Promise<SessionRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/ai`,
    json("PUT", { expectedRevision, ai }),
  );
}

export function beginOpening(
  sessionId: string,
  requestId: string,
  expectedRevision: number,
): Promise<RunRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/opening`,
    json("POST", { requestId, expectedRevision }),
  );
}

export function submitTurn(
  sessionId: string,
  requestId: string,
  expectedRevision: number,
  input: string,
): Promise<RunRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/turns`,
    json("POST", { requestId, expectedRevision, input }),
  );
}

export function requestChoices(
  sessionId: string,
  requestId: string,
  expectedRevision: number,
): Promise<RunRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/choices`,
    json("POST", { requestId, expectedRevision }),
  );
}

export function useItem(
  sessionId: string,
  itemId: string,
  requestId: string,
  expectedRevision: number,
): Promise<RunRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/use`,
    json("POST", { requestId, expectedRevision }),
  );
}

export function getRun(
  sessionId: string,
  requestId: string,
): Promise<RunRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(requestId)}`,
  );
}

export function getUsage(sessionId: string): Promise<unknown> {
  return api(`/sessions/${encodeURIComponent(sessionId)}/usage`);
}

export function exportSave(sessionId: string): Promise<ExportBundle> {
  return api(`/sessions/${encodeURIComponent(sessionId)}/save`);
}

export function importSave(
  bundle: unknown,
): Promise<{ gameId: string; sessionId: string }> {
  return api("/saves", json("POST", bundle));
}

export function exportGameTemplate(
  gameId: string,
): Promise<GameTemplateBundle> {
  return api(`/games/${encodeURIComponent(gameId)}/template`);
}

export interface AiSettings {
  providers: Record<"gemini" | "openrouter", { configured: boolean }>;
}

export function getAiSettings(): Promise<AiSettings> {
  return api("/ai/settings");
}

export function saveAiCredential(
  provider: AiConfig["provider"],
  apiKey: string,
): Promise<{ configured: boolean }> {
  return api(`/ai/credentials/${provider}`, json("PUT", { apiKey }));
}

export function testAiConnection(
  ai: AiConfig,
): Promise<{ message: string; usage: unknown }> {
  return api("/ai/test", json("POST", ai));
}

export interface LegacyMigration {
  format: "fworld-legacy-migration";
  version: 1;
  games: GameDefinition[];
  sessions: GameSession[];
  messages: Message[];
}

export interface MigrationReceipt {
  fingerprint: string;
  counts: { games: number; sessions: number; messages: number };
  ids: { games: string[]; sessions: string[]; messages: string[] };
}

export function migrateLegacy(
  payload: LegacyMigration,
): Promise<MigrationReceipt> {
  return api("/migrations/legacy", json("POST", payload));
}

export function readLegacyMigration(
  fingerprint: string,
): Promise<LegacyMigration> {
  return api(`/migrations/legacy/${encodeURIComponent(fingerprint)}/readback`);
}

export function getLegacyMigrationStatus(): Promise<MigrationReceipt | null> {
  return api("/migrations/legacy");
}

export interface BackupRecord {
  id: string;
  createdAt: string;
  size: number;
}

export function createBackup(): Promise<BackupRecord> {
  return api("/backups", json("POST", {}));
}

export function listBackups(): Promise<BackupRecord[]> {
  return api("/backups");
}

export function restoreBackup(id: string): Promise<void> {
  return api(`/backups/${encodeURIComponent(id)}/restore`, json("POST"));
}
