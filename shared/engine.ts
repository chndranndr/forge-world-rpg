import { PLAYER_ID } from "./types.js";
import { sceneParticipants } from "./world.js";

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
  LoreEntry,
  RelationshipDefinition,
  ResourceDefinition,
  SessionState,
  WorldMap,
} from "./types.js";

export interface EffectContext {
  worldMap?: WorldMap;
  loreEntries?: LoreEntry[];
  playerAction?: string;
}

export function buildInitialState(
  game: GameDefinition,
  worldMap = game.worldMap,
): SessionState {
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
  const start = worldMap?.locations.find(
    (location) => location.id === game.startingLocationId,
  );
  const world: SessionState["world"] = {
    location: start?.name ?? "",
    time: "",
    scene: game.scenario.startingSituation,
    activeCharacters: sceneParticipants(
      worldMap,
      start?.id,
      {},
      game.npcs.map((npc) => npc.id),
    ),
  };
  if (worldMap) {
    world.flags = structuredClone(worldMap.flags ?? {});
    world.discoveredLoreIds = [];
    world.npcPresence = {};
    if (start) world.locationId = start.id;
  }
  return { attributes, resources, inventory, relationships, facts, world };
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

const NEGATED_ACTION_PREFIX =
  /(?:\bnot|\bnever|\bwon't|\bcannot|\bcan't|\bdon't|\bdont|\btidak|\bnggak|\bgak|\bjangan|\bbatal)\s+(?:[\p{L}\p{N}_]+\s+){0,4}$/iu;

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedTextValue = text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  const normalizedPhrase = phrase
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (!normalizedPhrase) return false;
  let offset = 0;
  while (offset < normalizedTextValue.length) {
    const index = normalizedTextValue.indexOf(normalizedPhrase, offset);
    if (index < 0) return false;
    const before = normalizedTextValue[index - 1];
    const after = normalizedTextValue[index + normalizedPhrase.length];
    if (
      (before === undefined || !/[\p{L}\p{N}_]/u.test(before)) &&
      (after === undefined || !/[\p{L}\p{N}_]/u.test(after))
    ) {
      const prefix = normalizedTextValue.slice(Math.max(0, index - 48), index);
      if (!NEGATED_ACTION_PREFIX.test(prefix)) return true;
    }
    offset = index + 1;
  }
  return false;
}

function hasExplicitAction(action: string, intent: RegExp): boolean {
  const match = intent.exec(action);
  if (!match || match.index === undefined) return false;
  const prefix = action.slice(Math.max(0, match.index - 48), match.index);
  return !NEGATED_ACTION_PREFIX.test(prefix);
}

function validateEffectRecipients(
  game: GameDefinition,
  recipientIds: string[],
  label: string,
): void {
  const knownIds = new Set([PLAYER_ID, ...game.npcs.map((npc) => npc.id)]);
  if (recipientIds.some((id) => !knownIds.has(id))) {
    fail(`${label} merujuk penerima yang tidak dikenal`);
  }
}

function refreshActiveCharacters(
  game: GameDefinition,
  next: SessionState,
  context?: EffectContext,
): void {
  next.world.activeCharacters = sceneParticipants(
    context?.worldMap,
    next.world.locationId,
    next.world.npcPresence,
    game.npcs.map((npc) => npc.id),
  );
}

const DISCOVERY_ACTION =
  /\b(?:inspect|read|search|examine|investigate|periksa|baca|cari|selidiki)\b/iu;
const REVEAL_ACTION =
  /\b(?:tell|reveal|share|inform|ungkap|bagikan|sampaikan|ceritakan)\b|beri\s+tahu|kasih\s+tahu|memberitahu/iu;

export function isLoreDiscoveryActionAllowed(
  entry: LoreEntry,
  action: string,
): boolean {
  const keywordMatch = (entry.metadata.discoveryKeywords ?? []).some(
    (keyword) => containsPhrase(action, keyword),
  );
  return hasExplicitAction(action, DISCOVERY_ACTION) || keywordMatch;
}

function applyOne(
  game: GameDefinition,
  next: SessionState,
  effect: ItemEffect,
  context?: EffectContext,
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
      if (effect.text.trim().length === 0) fail("Fakta tidak boleh kosong");
      if (
        effect.visibility !== undefined &&
        effect.visibility !== "public" &&
        effect.visibility !== "private"
      ) {
        fail("Visibilitas fakta tidak dikenal");
      }
      const knownBy = effect.knownBy ?? [];
      const revealableTo = effect.revealableTo ?? [];
      validateEffectRecipients(game, knownBy, "knownBy");
      validateEffectRecipients(game, revealableTo, "revealableTo");
      const fact: Fact = {
        id: crypto.randomUUID(),
        text: effect.text,
        visibility: effect.visibility ?? "public",
        knownBy: [...knownBy],
        ...(effect.revealableTo === undefined
          ? {}
          : { revealableTo: [...revealableTo] }),
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
    case "DISCOVER_LORE": {
      if (!context?.worldMap)
        fail("DISCOVER_LORE membutuhkan world map yang dipin");
      const lore = context.loreEntries?.find(
        (entry) => entry.id === effect.loreId,
      );
      if (!lore || lore.visibility !== "discovery") {
        fail(
          `Lore discovery "${effect.loreId}" tidak ditemukan atau tidak dapat ditemukan`,
        );
      }
      const currentLocationId = next.world.locationId;
      if (
        !currentLocationId ||
        !context.worldMap.locations.some(
          ({ id }) => id === currentLocationId,
        ) ||
        !lore.metadata.discoverAt?.includes(currentLocationId)
      ) {
        fail(`Lore "${lore.id}" tidak dapat ditemukan di lokasi ini`);
      }
      for (const flag of [
        lore.metadata.requiredFlag,
        lore.metadata.blockedByFlag,
      ]) {
        if (flag && !Object.hasOwn(context.worldMap.flags ?? {}, flag)) {
          fail(
            `Lore "${lore.id}" merujuk flag "${flag}" yang tidak dideklarasikan`,
          );
        }
      }
      if (
        lore.metadata.requiredFlag &&
        next.world.flags?.[lore.metadata.requiredFlag] !== true
      ) {
        fail(
          `Lore "${lore.id}" membutuhkan flag "${lore.metadata.requiredFlag}"`,
        );
      }
      if (
        lore.metadata.blockedByFlag &&
        next.world.flags?.[lore.metadata.blockedByFlag] === true
      ) {
        fail(
          `Lore "${lore.id}" diblokir oleh flag "${lore.metadata.blockedByFlag}"`,
        );
      }
      const action = context.playerAction ?? "";
      if (!isLoreDiscoveryActionAllowed(lore, action)) {
        fail(`Aksi pemain tidak mengizinkan discovery "${lore.id}"`);
      }
      const discovered = next.world.discoveredLoreIds ?? [];
      if (!discovered.includes(lore.id)) {
        next.world.discoveredLoreIds = [...discovered, lore.id];
      }
      return `Lore ditemukan: "${lore.name}"`;
    }
    case "REVEAL_FACT": {
      const fact = next.facts.find((entry) => entry.id === effect.factId);
      if (!fact) fail(`Fakta "${effect.factId}" tidak ditemukan`);
      if (fact.visibility !== "private") {
        fail(`Fakta "${fact.id}" bukan fakta privat`);
      }
      if (!fact.revealableTo?.includes(effect.npcId)) {
        fail(`Fakta "${fact.id}" tidak mengizinkan penerima "${effect.npcId}"`);
      }
      if (
        effect.npcId !== PLAYER_ID &&
        (!game.npcs.some((npc) => npc.id === effect.npcId) ||
          !next.world.activeCharacters.includes(effect.npcId))
      ) {
        fail(`Penerima "${effect.npcId}" bukan pemain atau NPC yang hadir`);
      }
      if (!hasExplicitAction(context?.playerAction ?? "", REVEAL_ACTION)) {
        fail("REVEAL_FACT membutuhkan aksi tell/reveal/share yang eksplisit");
      }
      if (!fact.knownBy.includes(effect.npcId)) {
        fact.knownBy.push(effect.npcId);
      }
      return `Fakta "${fact.id}" dibagikan kepada "${effect.npcId}"`;
    }
    case "SET_FLAG": {
      if (
        !context?.worldMap ||
        !Object.hasOwn(context.worldMap.flags ?? {}, effect.target)
      ) {
        fail(`Flag "${effect.target}" tidak dideklarasikan dalam world map`);
      }
      if (typeof effect.value !== "boolean")
        fail("SET_FLAG membutuhkan value boolean");
      next.world.flags = {
        ...(next.world.flags ?? context.worldMap.flags ?? {}),
        [effect.target]: effect.value,
      };
      return `Flag "${effect.target}" disetel`;
    }
    case "NPC_PRESENCE": {
      if (!game.npcs.some((npc) => npc.id === effect.npcId)) {
        fail(`NPC "${effect.npcId}" tidak dikenal`);
      }
      if (typeof effect.present !== "boolean") {
        fail("NPC_PRESENCE membutuhkan present boolean");
      }
      next.world.npcPresence = {
        ...(next.world.npcPresence ?? {}),
        [effect.npcId]: effect.present ? "present" : "absent",
      };
      refreshActiveCharacters(game, next, context);
      return `Kehadiran NPC "${effect.npcId}" diperbarui`;
    }
    default: {
      const unhandled: never = effect;
      return fail(`Tipe effect tidak dikenal: "${String(unhandled)}"`);
    }
  }
}

export function applyEffects(
  game: GameDefinition,
  state: SessionState,
  effects: ItemEffect[],
  context?: EffectContext,
): ApplyResult {
  const next = structuredClone(state);
  const applied: string[] = [];
  for (const effect of effects) {
    applied.push(applyOne(game, next, effect, context));
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
  context?: EffectContext,
): ApplyResult {
  const item = findItem(game, itemId);
  const owned = state.inventory.find((entry) => entry.itemId === itemId);
  if (!owned || owned.quantity < 1) {
    fail(`${item.name} tidak ada di inventaris`);
  }
  const result = applyEffects(game, state, item.effects, context);
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
  world?: {
    location?: string;
    locationId?: string;
    time?: string;
    scene?: string;
  };
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

function parseRequiredText(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim())
    fail(`${label} harus string tidak kosong`);
  return raw.trim();
}

function parseStringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) fail(`${label} harus array string`);
  const entries: string[] = [];
  for (const value of raw) entries.push(parseRequiredText(value, label));
  return entries;
}
const EFFECT_FIELDS: Record<string, readonly string[]> = {
  ATTRIBUTE_CHANGE: ["type", "target", "operation", "value"],
  RESOURCE_CHANGE: ["type", "target", "operation", "value"],
  RELATIONSHIP_CHANGE: ["type", "target", "npcId", "operation", "value"],
  ADD_ITEM: ["type", "target", "quantity"],
  REMOVE_ITEM: ["type", "target", "quantity"],
  ADD_FACT: ["type", "text", "visibility", "knownBy", "revealableTo"],
  REMOVE_FACT: ["type", "target"],
  DISCOVER_LORE: ["type", "loreId"],
  REVEAL_FACT: ["type", "factId", "npcId"],
  SET_FLAG: ["type", "target", "value"],
  NPC_PRESENCE: ["type", "npcId", "present"],
};

function assertOnlyKeys(
  object: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(object).find((key) => !fields.includes(key));
  if (unexpected) fail(`${label} contains unsupported field "${unexpected}"`);
}

function parseEffect(raw: unknown): ItemEffect {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("Effect harus berupa object");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !Object.hasOwn(EFFECT_FIELDS, type)) {
    fail(`Tipe effect tidak dikenal: "${String(type)}"`);
  }
  assertOnlyKeys(obj, EFFECT_FIELDS[type], `Effect ${type}`);

  switch (type) {
    case "ATTRIBUTE_CHANGE":
    case "RESOURCE_CHANGE":
      return {
        type,
        target: parseRequiredText(obj.target, `${type}.target`),
        operation: parseOperation(obj.operation),
        value: parseValue(obj.value),
      };
    case "RELATIONSHIP_CHANGE":
      return {
        type,
        target: parseRequiredText(obj.target, `${type}.target`),
        npcId:
          obj.npcId === undefined
            ? undefined
            : parseRequiredText(obj.npcId, `${type}.npcId`),
        operation: parseOperation(obj.operation),
        value: parseValue(obj.value),
      };
    case "ADD_ITEM":
    case "REMOVE_ITEM":
      return {
        type,
        target: parseRequiredText(obj.target, `${type}.target`),
        quantity: parseQuantityNumber(obj.quantity),
      };
    case "ADD_FACT": {
      const effect: Extract<ItemEffect, { type: "ADD_FACT" }> = {
        type,
        text: parseRequiredText(obj.text, "ADD_FACT.text"),
      };
      if (obj.visibility !== undefined) {
        if (obj.visibility !== "public" && obj.visibility !== "private") {
          fail("ADD_FACT.visibility harus public atau private");
        }
        effect.visibility = obj.visibility;
      }
      if (obj.knownBy !== undefined)
        effect.knownBy = parseStringList(obj.knownBy, "ADD_FACT.knownBy");
      if (obj.revealableTo !== undefined) {
        effect.revealableTo = parseStringList(
          obj.revealableTo,
          "ADD_FACT.revealableTo",
        );
      }
      return effect;
    }
    case "REMOVE_FACT":
      return {
        type,
        target: parseRequiredText(obj.target, "REMOVE_FACT.target"),
      };
    case "DISCOVER_LORE":
      return {
        type,
        loreId: parseRequiredText(obj.loreId, "DISCOVER_LORE.loreId"),
      };
    case "REVEAL_FACT":
      return {
        type,
        factId: parseRequiredText(obj.factId, "REVEAL_FACT.factId"),
        npcId: parseRequiredText(obj.npcId, "REVEAL_FACT.npcId"),
      };
    case "SET_FLAG":
      if (typeof obj.value !== "boolean") fail("SET_FLAG.value harus boolean");
      return {
        type,
        target: parseRequiredText(obj.target, "SET_FLAG.target"),
        value: obj.value,
      };
    case "NPC_PRESENCE":
      if (typeof obj.present !== "boolean")
        fail("NPC_PRESENCE.present harus boolean");
      return {
        type,
        npcId: parseRequiredText(obj.npcId, "NPC_PRESENCE.npcId"),
        present: obj.present,
      };
    default:
      fail(`Tipe effect tidak dikenal: "${type}"`);
  }
}

export function parseTurnResponse(raw: unknown): TurnResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("Respons AI bukan JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.requiresCheck === true) {
    assertOnlyKeys(
      obj,
      ["requiresCheck", "attribute", "difficulty", "mode", "npcId"],
      "Check request",
    );
    const attribute = obj.attribute;
    const difficulty = obj.difficulty;
    if (typeof attribute !== "string" || !attribute.trim()) {
      fail("Check request membutuhkan attribute string");
    }
    if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) {
      fail("Check request membutuhkan difficulty angka");
    }
    const mode =
      typeof obj.mode === "string" && Object.hasOwn(CHECK_MODES, obj.mode)
        ? (obj.mode as CheckMode)
        : "NORMAL";
    const npcId =
      obj.npcId === undefined ||
      (typeof obj.npcId === "string" && !obj.npcId.trim())
        ? undefined
        : parseRequiredText(obj.npcId, "Check request npcId");
    return {
      type: "check_request",
      params: {
        attributeId: attribute.trim(),
        difficulty,
        mode,
        ...(npcId === undefined ? {} : { npcId }),
      },
    };
  }

  const narrative = obj.narrative;
  assertOnlyKeys(
    obj,
    ["narrative", "effects", "world", "choices"],
    "Narrative response",
  );
  if (typeof narrative !== "string" || !narrative.trim()) {
    fail("Respons AI membutuhkan narrative string");
  }

  const effects: ItemEffect[] = [];
  if (obj.effects !== undefined) {
    if (!Array.isArray(obj.effects)) fail("effects harus array");
    for (const effect of obj.effects) effects.push(parseEffect(effect));
  }

  let world: NarrativeProposal["world"];
  if (obj.world !== undefined && obj.world !== null) {
    if (typeof obj.world !== "object" || Array.isArray(obj.world)) {
      fail("world harus object");
    }
    const rawWorld = obj.world as Record<string, unknown>;
    assertOnlyKeys(
      rawWorld,
      ["location", "locationId", "time", "scene"],
      "world",
    );
    const worldText = (
      key: "location" | "time" | "scene",
    ): string | undefined => {
      const value = rawWorld[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string") fail(`world.${key} harus string`);
      return value.trim() || undefined;
    };
    const location = worldText("location");
    const time = worldText("time");
    const scene = worldText("scene");
    const locationId =
      rawWorld.locationId === undefined
        ? undefined
        : parseRequiredText(rawWorld.locationId, "world.locationId");
    if (location || locationId || time || scene) {
      world = {
        ...(location ? { location } : {}),
        ...(locationId ? { locationId } : {}),
        ...(time ? { time } : {}),
        ...(scene ? { scene } : {}),
      };
    }
  }

  const choices: Choice[] = [];
  if (obj.choices !== undefined) {
    if (!Array.isArray(obj.choices)) fail("choices harus array");
    if (obj.choices.length > 3) fail("choices maksimal berjumlah 3");
    const ids = new Set<string>();
    for (const rawChoice of obj.choices) {
      if (
        rawChoice === null ||
        typeof rawChoice !== "object" ||
        Array.isArray(rawChoice)
      ) {
        fail("Setiap choice harus berupa object");
      }
      const choice = rawChoice as Record<string, unknown>;
      assertOnlyKeys(choice, ["id", "label"], "choice");
      const label = parseRequiredText(choice.label, "choice.label");
      const id = parseRequiredText(choice.id, "choice.id");
      if (ids.has(id)) fail(`choice.id duplikat: "${id}"`);
      ids.add(id);
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
