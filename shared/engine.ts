import { PLAYER_ID } from "./types.js";

import type {
  AttributeDefinition,
  CheckMode,
  CheckOutcome,
  CheckRecord,
  EffectOperation,
  Fact,
  GameDefinition,
  ItemDefinition,
  ItemEffect,
  RelationshipDefinition,
  ResourceDefinition,
  SessionState,
} from "./types.js";

export function buildInitialState(game: GameDefinition): SessionState {
  const attributes: Record<string, number> = {};
  for (const attribute of game.attributes) {
    attributes[attribute.id] =
      game.player.attributes[attribute.id] ?? attribute.defaultValue;
  }
  const resources: Record<string, number> = {};
  for (const resource of game.resources) {
    resources[resource.id] =
      game.player.resources[resource.id] ?? resource.initialValue;
  }
  const inventory = game.startingInventory.map((entry) => ({
    itemId: entry.itemId,
    quantity: entry.quantity,
  }));
  const relationships = game.npcs.map((npc) => {
    const values: Record<string, number> = {};
    for (const definition of game.relationships) {
      values[definition.id] =
        npc.initialRelationships[definition.id] ?? definition.defaultValue;
    }
    return { npcId: npc.id, values };
  });
  const facts: SessionState["facts"] = [];
  return {
    attributes,
    resources,
    inventory,
    relationships,
    facts,
    world: {
      location: "",
      time: "",
      scene: game.scenario.startingSituation,
      activeCharacters: [PLAYER_ID, ...game.npcs.map((npc) => npc.id)],
    },
  };
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface ApplyResult {
  state: SessionState;
  applied: string[];
}

export interface CheckParams {
  attributeId: string;
  difficulty: number;
  mode: CheckMode;
  npcId?: string;
}

function fail(message: string): never {
  throw new EngineError(message);
}

function findAttribute(game: GameDefinition, id: string): AttributeDefinition {
  const def = game.attributes.find((entry) => entry.id === id);
  if (!def) fail(`Atribut "${id}" tidak dikenal`);
  return def;
}

function findResource(game: GameDefinition, id: string): ResourceDefinition {
  const def = game.resources.find((entry) => entry.id === id);
  if (!def) fail(`Sumber daya "${id}" tidak dikenal`);
  return def;
}

function findRelationship(
  game: GameDefinition,
  id: string,
): RelationshipDefinition {
  const def = game.relationships.find((entry) => entry.id === id);
  if (!def) fail(`Hubungan "${id}" tidak dikenal`);
  return def;
}

function findItem(game: GameDefinition, id: string): ItemDefinition {
  const item = game.items.find((entry) => entry.id === id);
  if (!item) fail(`Item "${id}" tidak dikenal`);
  return item;
}

function checkQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    fail("Jumlah item harus bilangan bulat minimal 1");
  }
}

function compute(
  current: number,
  operation: EffectOperation,
  value: number,
): number {
  switch (operation) {
    case "ADD":
      return current + value;
    case "SUBTRACT":
      return current - value;
    case "SET":
      return value;
  }
}

function applyOne(
  game: GameDefinition,
  next: SessionState,
  effect: ItemEffect,
): string {
  switch (effect.type) {
    case "ATTRIBUTE_CHANGE": {
      const def = findAttribute(game, effect.target);
      const current = next.attributes[def.id] ?? def.defaultValue;
      const result = compute(current, effect.operation, effect.value);
      if (!Number.isFinite(result)) {
        fail(`Hasil perubahan atribut "${def.name}" tidak valid`);
      }
      if (result < def.min || result > def.max) {
        fail(
          `Atribut "${def.name}" menjadi ${result}, di luar batas ${def.min} sampai ${def.max}`,
        );
      }
      next.attributes[def.id] = result;
      return `Atribut ${def.name} berubah dari ${current} menjadi ${result}`;
    }
    case "RESOURCE_CHANGE": {
      const def = findResource(game, effect.target);
      const current = next.resources[def.id] ?? def.initialValue;
      const result = compute(current, effect.operation, effect.value);
      if (!Number.isFinite(result)) {
        fail(`Hasil perubahan sumber daya "${def.name}" tidak valid`);
      }
      if (result < def.min || (def.max !== undefined && result > def.max)) {
        const maxText =
          def.max === undefined ? "tak terbatas" : String(def.max);
        fail(
          `Sumber daya "${def.name}" menjadi ${result}, di luar batas ${def.min} sampai ${maxText}`,
        );
      }
      next.resources[def.id] = result;
      return `Sumber daya ${def.name} berubah dari ${current} menjadi ${result}`;
    }
    case "RELATIONSHIP_CHANGE": {
      const rel = findRelationship(game, effect.target);
      if (!effect.npcId) {
        fail(`Perubahan hubungan "${rel.name}" membutuhkan NPC`);
      }
      const npc = game.npcs.find((entry) => entry.id === effect.npcId);
      if (!npc) fail(`NPC "${effect.npcId}" tidak dikenal`);
      const entry = next.relationships.find((r) => r.npcId === npc.id);
      if (!entry) fail(`NPC "${npc.name}" belum memiliki catatan hubungan`);
      const current = entry.values[rel.id] ?? rel.defaultValue;
      const result = compute(current, effect.operation, effect.value);
      if (!Number.isFinite(result)) {
        fail(`Hasil perubahan hubungan "${rel.name}" tidak valid`);
      }
      if (result < rel.min || result > rel.max) {
        fail(
          `Hubungan "${rel.name}" dengan ${npc.name} menjadi ${result}, di luar batas ${rel.min} sampai ${rel.max}`,
        );
      }
      entry.values[rel.id] = result;
      return `Hubungan ${rel.name} dengan ${npc.name} berubah dari ${current} menjadi ${result}`;
    }
    case "ADD_ITEM": {
      const item = findItem(game, effect.target);
      checkQuantity(effect.quantity);
      if (item.stackable) {
        const entry = next.inventory.find((inv) => inv.itemId === item.id);
        const owned = entry?.quantity ?? 0;
        const total = owned + effect.quantity;
        if (item.maxStack !== undefined && total > item.maxStack) {
          fail(`${item.name} melebihi tumpukan maksimal ${item.maxStack}`);
        }
        if (entry) {
          entry.quantity = total;
        } else {
          next.inventory.push({ itemId: item.id, quantity: effect.quantity });
        }
      } else {
        if (effect.quantity !== 1) {
          fail(`${item.name} tidak bisa ditumpuk; jumlah harus 1`);
        }
        next.inventory.push({ itemId: item.id, quantity: 1 });
      }
      return `${item.name} ditambahkan sebanyak ${effect.quantity}`;
    }
    case "REMOVE_ITEM": {
      const item = findItem(game, effect.target);
      checkQuantity(effect.quantity);
      const index = next.inventory.findIndex((inv) => inv.itemId === item.id);
      const entry = index === -1 ? undefined : next.inventory[index];
      if (!entry || entry.quantity < effect.quantity) {
        fail(`${item.name} tidak cukup untuk dihapus`);
      }
      entry.quantity -= effect.quantity;
      if (entry.quantity === 0) {
        next.inventory.splice(next.inventory.indexOf(entry), 1);
      }
      return `${item.name} dihapus sebanyak ${effect.quantity}`;
    }
    case "ADD_FACT": {
      if (effect.text.trim().length === 0) {
        fail("Fakta tidak boleh kosong");
      }
      const fact: Fact = {
        id: crypto.randomUUID(),
        text: effect.text,
        visibility: "public",
        knownBy: [],
        createdAt: new Date().toISOString(),
        source: "story",
      };
      next.facts.push(fact);
      return `Fakta baru dicatat: "${fact.text}"`;
    }
    case "REMOVE_FACT": {
      const fact = next.facts.find((entry) => entry.id === effect.target);
      if (!fact) fail(`Fakta "${effect.target}" tidak ditemukan`);
      next.facts.splice(next.facts.indexOf(fact), 1);
      return `Fakta dihapus: "${fact.text}"`;
    }
  }
}

export function applyEffects(
  game: GameDefinition,
  state: SessionState,
  effects: ItemEffect[],
): ApplyResult {
  const next = structuredClone(state);
  const applied: string[] = [];
  for (const effect of effects) {
    applied.push(applyOne(game, next, effect));
  }
  return { state: next, applied };
}

export function validateCheckRequest(
  game: GameDefinition,
  _state: SessionState,
  params: CheckParams,
): string[] {
  const problems: string[] = [];
  const attr = game.attributes.find((entry) => entry.id === params.attributeId);
  if (!attr) {
    problems.push(`Atribut "${params.attributeId}" tidak dikenal`);
  }
  if (!Number.isInteger(params.difficulty) || params.difficulty < 0) {
    problems.push("Tingkat kesulitan harus bilangan bulat minimal 0");
  }
  if (params.npcId !== undefined) {
    const npc = game.npcs.find((entry) => entry.id === params.npcId);
    if (!npc) {
      problems.push(`NPC "${params.npcId}" tidak dikenal`);
    } else if (npc.attributes?.[params.attributeId] === undefined) {
      problems.push(
        `NPC "${npc.name}" tidak memiliki atribut "${params.attributeId}"`,
      );
    }
  }
  return problems;
}

const MODE_MODIFIERS: Record<CheckMode, { min: number; max: number }> = {
  OFF: { min: 0, max: 0 },
  LOW: { min: -1, max: 1 },
  NORMAL: { min: -3, max: 3 },
  HIGH: { min: -5, max: 5 },
};

export function runCheck(
  game: GameDefinition,
  state: SessionState,
  params: CheckParams,
  random: () => number,
): CheckRecord {
  let base: number;
  if (params.npcId !== undefined) {
    const npc = game.npcs.find((entry) => entry.id === params.npcId);
    if (!npc) fail(`NPC "${params.npcId}" tidak dikenal`);
    const value = npc.attributes?.[params.attributeId];
    if (value === undefined) {
      fail(`NPC "${npc.name}" tidak memiliki atribut "${params.attributeId}"`);
    }
    base = value;
  } else {
    const attr = findAttribute(game, params.attributeId);
    base = state.attributes[attr.id] ?? attr.defaultValue;
  }
  const range = MODE_MODIFIERS[params.mode];
  const modifier =
    Math.floor(random() * (range.max - range.min + 1)) + range.min;
  const score = base + modifier;
  let outcome: CheckOutcome;
  if (score >= params.difficulty) {
    outcome = "SUCCESS";
  } else if (score >= params.difficulty - 2) {
    outcome = "PARTIAL_SUCCESS";
  } else {
    outcome = "FAILURE";
  }
  return {
    attributeId: params.attributeId,
    difficulty: params.difficulty,
    mode: params.mode,
    score,
    outcome,
  };
}

export function useItem(
  game: GameDefinition,
  state: SessionState,
  itemId: string,
): ApplyResult {
  const item = findItem(game, itemId);
  const owned = state.inventory.find((entry) => entry.itemId === itemId);
  if (!owned || owned.quantity < 1) {
    fail(`${item.name} tidak ada di inventaris`);
  }
  const result = applyEffects(game, state, item.effects);
  if (item.consumable) {
    const entry = result.state.inventory.find((inv) => inv.itemId === itemId);
    if (!entry || entry.quantity < 1) {
      fail(`Jumlah ${item.name} habis setelah efek diterapkan`);
    }
    entry.quantity -= 1;
    if (entry.quantity === 0) {
      result.state.inventory.splice(result.state.inventory.indexOf(entry), 1);
    }
  }
  return result;
}

export interface CheckRequest {
  type: "check_request";
  params: CheckParams;
}

export interface Choice {
  id: string;
  label: string;
}

export interface NarrativeProposal {
  type: "narrative";
  narrative: string;
  effects: ItemEffect[];
  world?: { location?: string; time?: string; scene?: string };
  choices: Choice[];
}

export type TurnResponse = CheckRequest | NarrativeProposal;

const CHECK_MODES: Record<string, true> = {
  OFF: true,
  LOW: true,
  NORMAL: true,
  HIGH: true,
};

function parseOperation(raw: unknown): EffectOperation {
  if (raw === "ADD" || raw === "SUBTRACT" || raw === "SET") return raw;
  fail("Operation harus ADD, SUBTRACT, atau SET");
}

function parseValue(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  fail("Value harus angka finite");
}

function parseQuantityNumber(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  fail("Quantity harus bilangan bulat minimal 1");
}

function parseEffect(raw: unknown): ItemEffect {
  if (raw === null || typeof raw !== "object") {
    fail("Effect harus berupa object");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") fail("Effect membutuhkan type string");
  const target = typeof obj.target === "string" ? obj.target.trim() : "";
  const npcId =
    typeof obj.npcId === "string" && obj.npcId.trim()
      ? obj.npcId.trim()
      : undefined;

  switch (type) {
    case "ATTRIBUTE_CHANGE":
    case "RESOURCE_CHANGE":
      return {
        type,
        target,
        operation: parseOperation(obj.operation),
        value: parseValue(obj.value),
      };
    case "RELATIONSHIP_CHANGE":
      return {
        type,
        target,
        npcId,
        operation: parseOperation(obj.operation),
        value: parseValue(obj.value),
      };
    case "ADD_ITEM":
    case "REMOVE_ITEM":
      return {
        type,
        target,
        quantity: parseQuantityNumber(obj.quantity),
      };
    case "ADD_FACT": {
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) fail("ADD_FACT membutuhkan text");
      return { type, text };
    }
    case "REMOVE_FACT":
      return { type, target };
    default:
      fail(`Tipe effect tidak dikenal: "${type}"`);
  }
}

export function parseTurnResponse(raw: unknown): TurnResponse {
  if (raw === null || typeof raw !== "object") {
    fail("Respons AI bukan JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.requiresCheck === true) {
    const attribute = obj.attribute;
    const difficulty = obj.difficulty;
    if (typeof attribute !== "string" || !attribute.trim()) {
      fail("Check request membutuhkan attribute string");
    }
    if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) {
      fail("Check request membutuhkan difficulty angka");
    }
    const mode =
      typeof obj.mode === "string" && obj.mode in CHECK_MODES
        ? (obj.mode as CheckMode)
        : "NORMAL";
    const npcId =
      typeof obj.npcId === "string" && obj.npcId.trim()
        ? obj.npcId.trim()
        : undefined;
    return {
      type: "check_request",
      params: { attributeId: attribute.trim(), difficulty, mode, npcId },
    };
  }

  const narrative = obj.narrative;
  if (typeof narrative !== "string" || !narrative.trim()) {
    fail("Respons AI membutuhkan narrative string");
  }

  const effects: ItemEffect[] = [];
  if (Array.isArray(obj.effects)) {
    for (const effect of obj.effects) {
      effects.push(parseEffect(effect));
    }
  }

  let world: NarrativeProposal["world"];
  const rawWorld = obj.world;
  if (rawWorld !== null && typeof rawWorld === "object") {
    const w = rawWorld as Record<string, unknown>;
    const location =
      typeof w.location === "string" && w.location.trim()
        ? w.location.trim()
        : undefined;
    const time =
      typeof w.time === "string" && w.time.trim() ? w.time.trim() : undefined;
    const scene =
      typeof w.scene === "string" && w.scene.trim()
        ? w.scene.trim()
        : undefined;
    if (location || time || scene) {
      world = { location, time, scene };
    }
  }

  const choices: Choice[] = [];
  if (Array.isArray(obj.choices)) {
    for (const raw of obj.choices) {
      if (raw === null || typeof raw !== "object") continue;
      const choice = raw as Record<string, unknown>;
      const label = typeof choice.label === "string" ? choice.label.trim() : "";
      if (!label) continue;
      const id =
        typeof choice.id === "string" && choice.id.trim()
          ? choice.id.trim()
          : `choice-${choices.length + 1}`;
      choices.push({ id, label });
    }
  }

  return {
    type: "narrative",
    narrative: narrative.trim(),
    effects,
    world,
    choices,
  };
}
