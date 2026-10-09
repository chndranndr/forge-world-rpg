export type ProviderId = "gemini" | "openrouter";

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

export type EffectOperation = "ADD" | "SUBTRACT" | "SET";

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
  | { type: "ADD_FACT"; text: string }
  | { type: "REMOVE_FACT"; target: string };

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
}

export interface StartingInventoryEntry {
  itemId: string;
  quantity: number;
}

export interface GameDefinition {
  id: string;
  title: string;
  description?: string;
  genre?: string;
  tone?: string;
  language?: string;
  scenario: Scenario;
  attributes: AttributeDefinition[];
  resources: ResourceDefinition[];
  relationships: RelationshipDefinition[];
  items: ItemDefinition[];
  player: PlayerDefinition;
  npcs: NpcDefinition[];
  startingInventory: StartingInventoryEntry[];
  updatedAt: string;
}

export interface WorldState {
  location: string;
  time: string;
  scene: string;
  activeCharacters: string[];
}

export type FactVisibility = "public" | "private";

export interface Fact {
  id: string;
  text: string;
  visibility: FactVisibility;
  knownBy: string[];
  createdAt: string;
  source: "config" | "story";
}

export interface InventoryEntry {
  itemId: string;
  quantity: number;
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
}

export interface GameSession {
  id: string;
  gameId: string;
  definitionSnapshot: GameDefinition;
  state: SessionState;
  ai: AiConfig;
  nextSequence: number;
  updatedAt: string;
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
  check?: CheckRecord;
  createdAt: string;
}

export const EXPORT_FORMAT = "fworld-save";
export const EXPORT_VERSION = 1;

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  game: GameDefinition;
  session: GameSession;
  messages: Message[];
}

export const TEMPLATE_FORMAT = "fworld-template";
export const TEMPLATE_VERSION = 1;

export interface GameTemplateBundle {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  exportedAt: string;
  game: Omit<GameDefinition, "id" | "updatedAt">;
  ai?: AiConfig;
}
