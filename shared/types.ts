export type ProviderId = "gemini" | "openrouter" | "custom";

export const PLAYER_ID = "player";

export interface AttributeDefinition {
  id: string;
  name: string;
  description?: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface ResourceDefinition {
  id: string;
  name: string;
  description?: string;
  min: number;
  max?: number;
  initialValue: number;
}

export interface RelationshipDefinition {
  id: string;
  name: string;
  description?: string;
  min: number;
  max: number;
  defaultValue: number;
}
export interface RelationshipPartyDefinition {
  id: string;
  name: string;
  type: string;
  initialStance: "friendly" | "neutral" | "wary" | "hostile";
  secret?: string;
}

export type EffectOperation = "ADD" | "SUBTRACT" | "SET";

export type AddFactEffect = {
  type: "ADD_FACT";
  text: string;
  visibility?: FactVisibility;
  knownBy?: string[];
  revealableTo?: string[];
};

export type ItemEffect =
  | {
      type: "ATTRIBUTE_CHANGE";
      target: string;
      operation: EffectOperation;
      value: number;
    }
  | {
      type: "RESOURCE_CHANGE";
      target: string;
      operation: EffectOperation;
      value: number;
    }
  | {
      type: "RELATIONSHIP_CHANGE";
      target: string;
      npcId?: string;
      operation: EffectOperation;
      value: number;
    }
  | { type: "ADD_ITEM"; target: string; quantity: number }
  | { type: "REMOVE_ITEM"; target: string; quantity: number }
  | AddFactEffect
  | { type: "REMOVE_FACT"; target: string }
  | { type: "DISCOVER_LORE"; loreId: string }
  | { type: "REVEAL_FACT"; factId: string; npcId: string }
  | { type: "SET_FLAG"; target: string; value: boolean }
  | { type: "NPC_PRESENCE"; npcId: string; present: boolean };
export type RegisterNpcEffect = {
  type: "REGISTER_NPC";
  id: string;
  name: string;
  description?: string;
  personality: string[];
  role?: string;
  goals: string[];
};

export type TurnEffect = ItemEffect | RegisterNpcEffect;

export interface ItemDefinition {
  id: string;
  name: string;
  description?: string;
  stackable: boolean;
  maxStack?: number;
  consumable: boolean;
  effects: ItemEffect[];
  tags: string[];
}

export interface PlayerDefinition {
  name: string;
  description?: string;
  background?: string;
  personality?: string;
  notes?: string;
  role?: string;
  pronoun?: "neutral" | "masculine" | "feminine";
  age?: string;
  goal?: string;
  fear?: string;

  attributes: Record<string, number>;
  resources: Record<string, number>;
}

export interface NpcDefinition {
  id: string;
  name: string;
  description?: string;
  personality: string[];
  background?: string;
  role?: string;
  voice?: string;

  goals: string[];
  privateKnowledge: string[];
  initialRelationships: Record<string, number>;
  attributes?: Record<string, number>;
}

export interface Scenario {
  setting: string;
  startingSituation: string;
  worldRules?: string;
  tone?: string;
  genre?: string;
  additionalContext?: string;
  trigger?: string;
  narratorStyle?:
    | "cinematic-second-person"
    | "literary-third-person"
    | "concise-second-person";
  tempo?: "slow" | "medium" | "fast";
  turnLength?: "short" | "medium" | "long";
  pointOfView?: "second-person" | "limited-third-person";
  contentLimits?: string;
}

export interface StartingInventoryEntry {
  itemId: string;
  quantity: number;
  owner?: string;
  place?: string;
}

export interface LorebookRef {
  packId: string;
  version: number;
}

export interface LoreDependency extends LorebookRef {
  digest: string;
}

export type LoreKind =
  | "world"
  | "region"
  | "location"
  | "place"
  | "npc"
  | "faction"
  | "history"
  | "monster"
  | "item"
  | "activity"
  | "other";

export type LoreVisibility = "public" | "narrator" | "discovery";

export interface LoreProvenance {
  sourceId: string;
  sourceUrl?: string;
  license?: string;
  revision?: string;
  canon?: "anime-2004" | "game" | "manhwa" | "original" | "mixed";
  era?: string;
}

export interface LoreMetadata {
  actorId?: string;
  itemId?: string;
  discoverAt?: string[];
  discoveryKeywords?: string[];
  requiredFlag?: string;
  blockedByFlag?: string;
}

export interface LoreEntry {
  id: string;
  kind: LoreKind;
  name: string;
  aliases: string[];
  parentId?: string;
  summary: string;
  body: string;
  tags: string[];
  visibility: LoreVisibility;
  metadata: LoreMetadata;
  provenance: LoreProvenance;
}

export type LoreLinkRelation =
  "PARENT_OF" | "CONNECTED_TO" | "LOCATED_IN" | "PRESENT_AT" | "RELATED_TO";

export interface LoreLink {
  fromId: string;
  toId: string;
  relation: LoreLinkRelation;
}

export const LOREBOOK_FORMAT = "fworld-lorebook";
export const LOREBOOK_VERSION = 1;

export interface LorebookPack {
  format: typeof LOREBOOK_FORMAT;
  version: typeof LOREBOOK_VERSION;
  pack: {
    id: string;
    version: number;
    name: string;
    description?: string;
  };
  entries: LoreEntry[];
  links: LoreLink[];
}

export interface LorePackHeader {
  id: string;
  version: number;
  name: string;
  description?: string;
  entryCount: number;
  linkCount: number;
  digest: string;
}

export interface WorldLocation {
  id: string;
  name: string;
  aliases: string[];
  summary?: string;
  parentId?: string;
  npcIds: string[];
  requiredFlag?: string;
}

export interface WorldConnection {
  fromId: string;
  toId: string;
  blockedByFlag?: string;
}

export interface WorldMap {
  locations: WorldLocation[];
  connections: WorldConnection[];
  flags?: Record<string, boolean>;
}

export type NpcPresenceValue =
  "present" | "absent" | { locationId: string; present?: boolean };

export type NpcPresence = Record<string, NpcPresenceValue>;

export interface StorySummary {
  sessionId: string;
  fromSequence: number;
  toSequence: number;
  summary: string;
  sourceDigest: string;
  visibility: "public" | "private";
  knownBy: string[];
  createdAt: string;
}

export interface ContextSectionTelemetry {
  chars: number;
  count: number;
  omitted: number;
}

export interface ContextTelemetry {
  contextChars: number;
  approximateTokens: number;
  tokenEstimateMethod: string;
  sections: Record<string, ContextSectionTelemetry>;
  selectedLoreIds: string[];
  omissions: string[];
  toolCalls: number;
  repairs: number;
  trace?: AgentTrace;
}

export type AgentTraceFinishReason =
  "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export type AgentTraceCacheReason =
  | "disabled"
  | "unsupported_provider"
  | "unsupported_model"
  | "repair"
  | "provider_rejected"
  | "capacity"
  | "busy";

export type AgentTraceEvent =
  | {
      kind: "model";
      elapsedMs: number;
      attempt: number;
      phase: "initial" | "repair";
      status: "started" | "succeeded" | "failed";
      finishReason: AgentTraceFinishReason | null;
    }
  | {
      kind: "tool";
      elapsedMs: number;
      name: string;
      status: "succeeded" | "failed";
      resultChars: number | null;
    }
  | {
      kind: "validation";
      elapsedMs: number;
      status: "accepted" | "rejected";
    }
  | { kind: "repair"; elapsedMs: number }
  | {
      kind: "cache";
      elapsedMs: number;
      operation: "create" | "reuse" | "bypass" | "invalidate";
      status: "succeeded" | "failed";
      reason: AgentTraceCacheReason | null;
      tokenCount: number | null;
    };

export interface AgentTrace {
  events: AgentTraceEvent[];
  dropped: number;
}

export type MessageVisibility = "public" | "private";

export interface GameDefinition {
  id: string;
  title: string;
  description?: string;
  genre?: string;
  tone?: string;
  language?: string;
  ageRating?: "all-ages" | "teen-13-plus" | "adult-18-plus";

  scenario: Scenario;
  attributes: AttributeDefinition[];
  resources: ResourceDefinition[];
  relationshipParties?: RelationshipPartyDefinition[];

  relationships: RelationshipDefinition[];
  items: ItemDefinition[];
  player: PlayerDefinition;
  npcs: NpcDefinition[];
  startingInventory: StartingInventoryEntry[];
  worldMap?: WorldMap;
  startingLocationId?: string;
  lorebookRefs?: LorebookRef[];
  updatedAt: string;
}

export interface WorldState {
  location: string;
  time: string;
  scene: string;
  activeCharacters: string[];
  locationId?: string;
  flags?: Record<string, boolean>;
  discoveredLoreIds?: string[];
  npcPresence?: NpcPresence;
}

export type FactVisibility = "public" | "private";

export interface Fact {
  id: string;
  text: string;
  visibility: FactVisibility;
  knownBy: string[];
  revealableTo?: string[];
  createdAt: string;
  source: "config" | "story";
}

export interface InventoryEntry {
  itemId: string;
  quantity: number;
  owner?: string;
  place?: string;
}

export interface RelationshipState {
  npcId: string;
  values: Record<string, number>;
}

export interface SessionState {
  attributes: Record<string, number>;
  resources: Record<string, number>;
  inventory: InventoryEntry[];
  relationships: RelationshipState[];
  facts: Fact[];
  world: WorldState;
}

export interface AiConfig {
  provider: ProviderId;
  model: string;
  systemPrompt?: string;
}

export interface GameSession {
  id: string;
  gameId: string;
  definitionSnapshot: GameDefinition;
  state: SessionState;
  ai: AiConfig;
  nextSequence: number;
  updatedAt: string;
  name?: string;
  pinned?: boolean;
  worldMap?: WorldMap;
  lorebookRefs?: LorebookRef[];
}

export type MessageRole = "PLAYER" | "NPC" | "NARRATOR" | "SYSTEM_EVENT";

export type CheckMode = "OFF" | "LOW" | "NORMAL" | "HIGH";

export type CheckOutcome = "FAILURE" | "PARTIAL_SUCCESS" | "SUCCESS";

export interface CheckRecord {
  attributeId: string;
  difficulty: number;
  mode: CheckMode;
  score: number;
  outcome: CheckOutcome;
}

export interface Message {
  id: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  role: MessageRole;
  speakerId?: string;
  content: string;
  visibility?: MessageVisibility;
  knownBy?: string[];
  check?: CheckRecord;
  createdAt: string;
}

export const EXPORT_FORMAT = "fworld-save";
export const EXPORT_VERSION = 1;
export const EXPORT_VERSION_WITH_LORE = 2;

interface ExportBundleBase {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  game: GameDefinition;
  session: GameSession;
  messages: Message[];
}

export type ExportBundle =
  | (ExportBundleBase & { version: 1; loreDependencies?: never })
  | (ExportBundleBase & {
      version: typeof EXPORT_VERSION_WITH_LORE;
      loreDependencies: LoreDependency[];
    });

export const TEMPLATE_FORMAT = "fworld-template";
export const TEMPLATE_VERSION = 1;

export interface GameTemplateBundle {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  exportedAt: string;
  game: Omit<GameDefinition, "id" | "updatedAt">;
  ai?: Pick<AiConfig, "provider" | "model">;
}
