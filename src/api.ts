import type {
  AiConfig,
  ExportBundle,
  Fact,
  GameDefinition,
  GameSession,
  GameTemplateBundle,
  ItemDefinition,
  ItemEffect,
  LoreEntry,
  LoreKind,
  LoreLink,
  LorebookPack,
  LorebookRef,
  LorePackHeader,
  Message,
  NpcDefinition,
  RelationshipPartyDefinition,
  SessionState,
  WorldLocation,
  WorldState,
} from "../shared/types";
import type { Choice } from "../shared/engine";
import type { AiProfile, AiProfileInput } from "../shared/ai-profile";

export interface Versioned<T> {
  value: T;
  revision: number;
}

export type GameRecord = Versioned<GameDefinition>;
export type PlayerNpc = Omit<
  NpcDefinition,
  "privateKnowledge" | "initialRelationships" | "attributes"
>;
export type PlayerItemEffect = Exclude<
  ItemEffect,
  | { type: "ADD_FACT" }
  | { type: "REMOVE_FACT" }
  | { type: "DISCOVER_LORE" }
  | { type: "REVEAL_FACT" }
  | { type: "SET_FLAG" }
  | { type: "NPC_PRESENCE" }
>;
export type PlayerItem = Omit<ItemDefinition, "effects"> & {
  effects: PlayerItemEffect[];
};
export type PlayerRelationshipParty = Omit<
  RelationshipPartyDefinition,
  "secret"
>;
export type PlayerGameDefinition = Omit<
  Pick<
    GameDefinition,
    | "id"
    | "title"
    | "description"
    | "genre"
    | "tone"
    | "language"
    | "ageRating"
    | "relationshipParties"
    | "attributes"
    | "resources"
    | "relationships"
    | "player"
    | "startingInventory"
    | "lorebookRefs"
    | "updatedAt"
  >,
  "relationshipParties"
> & {
  relationshipParties?: PlayerRelationshipParty[];
  items: PlayerItem[];
  npcs: PlayerNpc[];
};
export type PlayerFact = Omit<Fact, "knownBy" | "revealableTo">;
export type PlayerWorldState = Omit<
  WorldState,
  "flags" | "discoveredLoreIds" | "npcPresence" | "activeCharacters"
>;
export type PlayerSessionState = Omit<
  SessionState,
  "facts" | "world" | "relationships"
> & {
  facts: PlayerFact[];
  world: PlayerWorldState;
};
export type PlayerSession = Omit<
  GameSession,
  "definitionSnapshot" | "state" | "worldMap"
> & {
  definitionSnapshot: PlayerGameDefinition;
  state: PlayerSessionState;
};
export type SessionRecord = Versioned<PlayerSession>;
export type SessionSummaryRecord = SessionRecord & {
  turnCount: number;
  excerpt: string | null;
};
export interface SessionMetadataPatch {
  name?: string | null;
  pinned?: boolean;
}
export interface SavedTemplateRecord {
  id: string;
  title: string;
  createdAt: string;
}
export type PlayerMessage = Omit<Message, "knownBy">;
export type PlayerLoreEntry = Pick<
  LoreEntry,
  | "id"
  | "kind"
  | "name"
  | "aliases"
  | "parentId"
  | "summary"
  | "body"
  | "tags"
  | "visibility"
  | "provenance"
>;
export type SessionLoreEntry = Omit<PlayerLoreEntry, "body">;

export interface SessionWorldPerson extends Pick<
  PlayerNpc,
  "id" | "name" | "role" | "description"
> {
  relationships: Array<{
    id: string;
    name: string;
    min: number;
    max: number;
    value: number;
  }>;
}

export interface SessionWorldView {
  location: { id?: string; name: string; summary?: string } | null;
  locations: Array<Pick<WorldLocation, "id" | "name" | "parentId" | "summary">>;
  people: SessionWorldPerson[];
  facts: Array<Pick<PlayerFact, "id" | "text" | "createdAt" | "source">>;
  activities: SessionLoreEntry[];
  discoveries: SessionLoreEntry[];
}

export interface LorebookList {
  packs: LorePackHeader[];
  total: number;
}

export interface LorebookImportResult {
  pack: LorePackHeader;
  entries: number;
  links: number;
  digest: string;
  dryRun: boolean;
  existing: boolean;
}

export interface LoreEntryPage {
  entries: PlayerLoreEntry[];
  total: number;
}

export interface LoreLinkPage {
  links: LoreLink[];
  total: number;
}

export interface LorePreview {
  entries: SessionLoreEntry[];
  locationId?: string;
  activeNpcIds: string[];
  omitted: string[];
}

export type RunStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface RunResult {
  session?: SessionRecord;
  messages?: PlayerMessage[];
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
function querySuffix(values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const params = query.toString();
  return params ? `?${params}` : "";
}

export interface PageOptions {
  limit?: number;
  offset?: number;
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
export function duplicateGame(
  id: string,
  expectedRevision: number,
): Promise<GameRecord> {
  return api(
    `/games/${encodeURIComponent(id)}/duplicate`,
    json("POST", { expectedRevision }),
  );
}

export function listSessions(gameId: string): Promise<SessionSummaryRecord[]> {
  return api(`/games/${encodeURIComponent(gameId)}/sessions`);
}

export function startSession(
  definition: GameDefinition,
  expectedGameRevision: number | undefined,
  source:
    { ai: AiConfig; profileId?: never } | { profileId: string; ai?: never },
): Promise<{ game: GameRecord; session: SessionRecord }> {
  return api(
    "/sessions/start",
    json("POST", { definition, expectedGameRevision, ...source }),
  );
}

export function startSavedSession(
  gameId: string,
  expectedGameRevision: number,
  source:
    { ai: AiConfig; profileId?: never } | { profileId: string; ai?: never },
  name?: string,
): Promise<SessionRecord> {
  return api(
    `/games/${encodeURIComponent(gameId)}/sessions`,
    json("POST", {
      expectedGameRevision,
      ...(name === undefined ? {} : { name }),
      ...source,
    }),
  );
}

export function getSession(id: string): Promise<SessionSummaryRecord> {
  return api(`/sessions/${encodeURIComponent(id)}`);
}

export function updateSessionMetadata(
  id: string,
  patch: SessionMetadataPatch,
): Promise<SessionRecord> {
  return api(
    `/sessions/${encodeURIComponent(id)}/metadata`,
    json("PUT", patch),
  );
}

export function deleteSession(
  id: string,
  expectedRevision: number,
): Promise<void> {
  return api(
    `/sessions/${encodeURIComponent(id)}`,
    json("DELETE", { expectedRevision }),
  );
}

export function getSessionWorld(sessionId: string): Promise<SessionWorldView> {
  return api(`/sessions/${encodeURIComponent(sessionId)}/world`);
}

export function listLorebooks(
  options: PageOptions = {},
): Promise<LorebookList> {
  return api(`/lorebooks${querySuffix(options)}`);
}

export function importLorebook(
  lorebook: unknown,
  dryRun?: boolean,
): Promise<LorebookImportResult> {
  return api(
    "/lorebooks/import",
    json("POST", { lorebook, ...(dryRun === undefined ? {} : { dryRun }) }),
  );
}

export function listLoreEntries(
  ref: LorebookRef,
  options: PageOptions & {
    query?: string;
    kind?: LoreKind;
    parentId?: string;
  } = {},
): Promise<LoreEntryPage> {
  return api(
    `/lorebooks/${encodeURIComponent(ref.packId)}/versions/${ref.version}/entries${querySuffix(options)}`,
  );
}

export function listLoreLinks(
  ref: LorebookRef,
  entryId: string,
  options: PageOptions = {},
): Promise<LoreLinkPage> {
  return api(
    `/lorebooks/${encodeURIComponent(ref.packId)}/versions/${ref.version}/links${querySuffix({ entryId, ...options })}`,
  );
}

export function exportLorebook(ref: LorebookRef): Promise<LorebookPack> {
  return api(
    `/lorebooks/${encodeURIComponent(ref.packId)}/versions/${ref.version}/export`,
  );
}

export function previewLore(
  definition: GameDefinition,
  options: { locationId?: string; query?: string } = {},
): Promise<LorePreview> {
  return api("/lorebooks/preview", json("POST", { definition, ...options }));
}

export function listMessages(
  sessionId: string,
  options: { beforeSequence?: number; limit?: number } = {},
): Promise<{ messages: PlayerMessage[]; nextBeforeSequence: number | null }> {
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
export function saveGameTemplate(
  gameId: string,
  expectedGameRevision: number,
): Promise<SavedTemplateRecord> {
  return api("/templates", json("POST", { gameId, expectedGameRevision }));
}

export function listSavedTemplates(): Promise<SavedTemplateRecord[]> {
  return api("/templates");
}

export function getSavedTemplate(id: string): Promise<GameTemplateBundle> {
  return api(`/templates/${encodeURIComponent(id)}`);
}

export interface AiSettings {
  providers: Record<"gemini" | "openrouter", { configured: boolean }>;
}

export function getAiSettings(): Promise<AiSettings> {
  return api("/ai/settings");
}

export interface AiReasoningState {
  enabled: boolean;
}

export function getAiReasoning(): Promise<AiReasoningState> {
  return api("/ai/reasoning");
}

export function saveAiReasoning(enabled: boolean): Promise<AiReasoningState> {
  return api("/ai/reasoning", json("PUT", { enabled }));
}

export function saveAiCredential(
  provider: "gemini" | "openrouter",
  apiKey: string,
): Promise<{ configured: boolean }> {
  return api(`/ai/credentials/${provider}`, json("PUT", { apiKey }));
}

export function listAiProfiles(): Promise<AiProfile[]> {
  return api("/ai/profiles");
}

export function createAiProfile(input: AiProfileInput): Promise<AiProfile> {
  return api("/ai/profiles", json("POST", input));
}

export function updateAiProfile(
  id: string,
  expectedRevision: number,
  input: AiProfileInput,
): Promise<AiProfile> {
  return api(
    `/ai/profiles/${encodeURIComponent(id)}`,
    json("PUT", { expectedRevision, ...input }),
  );
}

export function saveAiProfileCredential(
  id: string,
  expectedRevision: number,
  apiKey: string,
): Promise<{ credentialConfigured: boolean }> {
  return api(
    `/ai/profiles/${encodeURIComponent(id)}/credential`,
    json("PUT", { expectedRevision, apiKey }),
  );
}

export interface SessionAiProfileInfo {
  profileId: string;
  baseURL?: string;
  credentialConfigured: boolean;
}

export function getSessionAiProfile(
  sessionId: string,
): Promise<SessionAiProfileInfo | null> {
  return api(`/sessions/${encodeURIComponent(sessionId)}/ai-profile`);
}

export function applySessionAiProfile(
  sessionId: string,
  expectedRevision: number,
  profileId: string,
): Promise<SessionRecord> {
  return api(
    `/sessions/${encodeURIComponent(sessionId)}/ai-profile`,
    json("PUT", { expectedRevision, profileId }),
  );
}

export function testAiConnection(
  input:
    | { profileId: string; sessionId?: string }
    | { provider: AiConfig["provider"]; model: string; sessionId?: string },
): Promise<{ message: string; usage: unknown }> {
  return api("/ai/test", json("POST", input));
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
