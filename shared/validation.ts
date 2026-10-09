import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  PLAYER_ID,
  type CheckRecord,
  type ExportBundle,
  type GameDefinition,
  type GameSession,
  type ItemEffect,
  type Message,
  type SessionState,
} from "./types.js";
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function hasDangerousKeysDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDangerousKeysDeep);
  if (!isObject(value)) return false;
  return Object.keys(value).some(
    (key) => DANGEROUS_KEYS.has(key) || hasDangerousKeysDeep(value[key]),
  );
}
const EFFECT_TYPES: Record<string, true> = {
  ATTRIBUTE_CHANGE: true,
  RESOURCE_CHANGE: true,
  RELATIONSHIP_CHANGE: true,
  ADD_ITEM: true,
  REMOVE_ITEM: true,
  ADD_FACT: true,
  REMOVE_FACT: true,
};

const EFFECT_OPERATIONS: Record<string, true> = {
  ADD: true,
  SUBTRACT: true,
  SET: true,
};

export function validateDefinition(game: GameDefinition): string[] {
  const errors: string[] = [];
  if (typeof game.id !== "string" || !game.id.trim()) {
    errors.push("Game harus memiliki id string tidak kosong.");
  }
  if (typeof game.title !== "string") {
    errors.push("Game harus memiliki title string.");
  }
  if (isObject(game.scenario)) {
    if (typeof game.scenario.setting !== "string")
      errors.push("scenario.setting harus string.");
    if (typeof game.scenario.startingSituation !== "string")
      errors.push("scenario.startingSituation harus string.");
  } else {
    errors.push("Game harus memiliki scenario object.");
  }
  if (!isObject(game.player)) {
    errors.push("Game harus memiliki player object.");
  }
  for (const section of [
    "attributes",
    "resources",
    "relationships",
    "items",
    "npcs",
    "startingInventory",
  ] as const) {
    if (!Array.isArray(game[section])) {
      errors.push(`Bagian ${section} hilang atau bukan array.`);
    }
  }
  if (errors.length > 0) return errors;

  if (typeof game.player.name !== "string")
    errors.push("player.name harus string.");
  if (!isObject(game.player.attributes))
    errors.push("player.attributes harus object.");
  if (!isObject(game.player.resources))
    errors.push("player.resources harus object.");
  if (errors.length > 0) return errors;

  const unique = (ids: string[], label: string) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (typeof id !== "string" || !id.trim())
        errors.push(`${label}[${index}].id kosong.`);
      else if (seen.has(id))
        errors.push(`${label}[${index}].id duplikat: ${id}.`);
      seen.add(id);
    });
    return seen;
  };
  const attributeIds = unique(
    game.attributes.map((a) => a.id),
    "attributes",
  );
  const resourceIds = unique(
    game.resources.map((r) => r.id),
    "resources",
  );
  const relationshipIds = unique(
    game.relationships.map((r) => r.id),
    "relationships",
  );
  const itemIds = unique(
    game.items.map((i) => i.id),
    "items",
  );
  const npcIds = unique(
    game.npcs.map((n) => n.id),
    "npcs",
  );

  for (const attribute of game.attributes) {
    if (typeof attribute.name !== "string")
      errors.push(`attributes "${attribute.id}": name harus string.`);
    if (!Number.isFinite(attribute.min) || !Number.isFinite(attribute.max)) {
      errors.push(`attributes "${attribute.id}": min/max harus angka finite.`);
      continue;
    }
    if (!Number.isFinite(attribute.defaultValue)) {
      errors.push(
        `attributes "${attribute.id}": defaultValue harus angka finite.`,
      );
      continue;
    }
    if (attribute.min > attribute.max)
      errors.push(`attributes "${attribute.id}": min melebihi max.`);
    if (
      attribute.defaultValue < attribute.min ||
      attribute.defaultValue > attribute.max
    ) {
      errors.push(
        `attributes "${attribute.id}": defaultValue di luar rentang.`,
      );
    }
  }
  for (const resource of game.resources) {
    if (typeof resource.name !== "string")
      errors.push(`resources "${resource.id}": name harus string.`);
    if (
      !Number.isFinite(resource.min) ||
      !Number.isFinite(resource.initialValue)
    ) {
      errors.push(
        `resources "${resource.id}": min/initialValue harus angka finite.`,
      );
      continue;
    }
    if (resource.max !== undefined && !Number.isFinite(resource.max)) {
      errors.push(`resources "${resource.id}": max harus angka finite.`);
      continue;
    }
    if (resource.max !== undefined && resource.min > resource.max) {
      errors.push(`resources "${resource.id}": min melebihi max.`);
    }
    if (
      resource.initialValue < resource.min ||
      (resource.max !== undefined && resource.initialValue > resource.max)
    ) {
      errors.push(`resources "${resource.id}": initialValue di luar rentang.`);
    }
  }
  for (const definition of game.relationships) {
    if (typeof definition.name !== "string")
      errors.push(`relationships "${definition.id}": name harus string.`);
    if (
      !Number.isFinite(definition.min) ||
      !Number.isFinite(definition.max) ||
      !Number.isFinite(definition.defaultValue)
    ) {
      errors.push(
        `relationships "${definition.id}": min/max/defaultValue harus angka finite.`,
      );
      continue;
    }
    if (definition.min > definition.max) {
      errors.push(`relationships "${definition.id}": min melebihi max.`);
    }
    if (
      definition.defaultValue < definition.min ||
      definition.defaultValue > definition.max
    ) {
      errors.push(
        `relationships "${definition.id}": defaultValue di luar rentang.`,
      );
    }
  }
  for (const item of game.items) {
    if (typeof item.name !== "string")
      errors.push(`items "${item.id}": name harus string.`);
    if (typeof item.stackable !== "boolean")
      errors.push(`items "${item.id}": stackable harus boolean.`);
    if (typeof item.consumable !== "boolean")
      errors.push(`items "${item.id}": consumable harus boolean.`);
    if (!Array.isArray(item.effects))
      errors.push(`items "${item.id}": effects harus array.`);
    if (!Array.isArray(item.tags))
      errors.push(`items "${item.id}": tags harus array.`);
    if (
      item.maxStack !== undefined &&
      (!Number.isInteger(item.maxStack) || item.maxStack < 1)
    ) {
      errors.push(`items "${item.id}": maxStack harus integer >= 1.`);
    }
    item.effects.forEach((effect, effectIndex) => {
      const spot = `items "${item.id}" effects[${effectIndex}]`;
      if (!isObject(effect) || !(String(effect.type) in EFFECT_TYPES)) {
        errors.push(`${spot}: type effect tidak dikenal.`);
        return;
      }
      if (
        "operation" in effect &&
        (typeof effect.operation !== "string" ||
          !(effect.operation in EFFECT_OPERATIONS))
      ) {
        errors.push(`${spot}: operation harus ADD, SUBTRACT, atau SET.`);
      }
      if ("value" in effect && !Number.isFinite(effect.value)) {
        errors.push(`${spot}: value harus angka finite.`);
      }
      if (effect.type === "RELATIONSHIP_CHANGE") {
        if (typeof effect.npcId !== "string" || !npcIds.has(effect.npcId)) {
          errors.push(
            `${spot}: RELATIONSHIP_CHANGE membutuhkan npcId NPC yang dikenal.`,
          );
        }
      }
      if (effect.type === "ADD_FACT") {
        if (typeof effect.text !== "string" || !effect.text.trim()) {
          errors.push(`${spot}: teks fakta tidak boleh kosong.`);
        }
      }
      if (effect.type === "REMOVE_FACT") {
        if (typeof effect.target !== "string" || !effect.target.trim()) {
          errors.push(`${spot}: target fakta tidak boleh kosong.`);
        }
      }
      if ("target" in effect && effect.type !== "REMOVE_FACT") {
        const pool =
          effect.type === "ATTRIBUTE_CHANGE"
            ? attributeIds
            : effect.type === "RESOURCE_CHANGE"
              ? resourceIds
              : effect.type === "RELATIONSHIP_CHANGE"
                ? relationshipIds
                : itemIds;
        if (typeof effect.target !== "string" || !pool.has(effect.target)) {
          errors.push(
            `${spot}: effect merujuk target tidak dikenal "${String(effect.target)}".`,
          );
        }
      }
      if (
        "quantity" in effect &&
        (!Number.isInteger(effect.quantity) || effect.quantity < 1)
      ) {
        errors.push(`${spot}: quantity harus integer >= 1.`);
      }
    });
  }
  const attributeBounds = new Map(game.attributes.map((a) => [a.id, a]));
  const resourceBounds = new Map(game.resources.map((r) => [r.id, r]));
  const relationshipBounds = new Map(game.relationships.map((r) => [r.id, r]));
  const itemById = new Map(game.items.map((i) => [i.id, i]));
  for (const [key, value] of Object.entries(game.player.attributes)) {
    const definition = attributeBounds.get(key);
    if (!definition) {
      errors.push(
        `player.attributes merujuk attribute tidak dikenal "${key}".`,
      );
      continue;
    }
    if (
      !Number.isFinite(value) ||
      value < definition.min ||
      value > definition.max
    ) {
      errors.push(
        `player.attributes "${key}" harus angka finite dalam rentang ${definition.min} sampai ${definition.max}.`,
      );
    }
  }
  for (const [key, value] of Object.entries(game.player.resources)) {
    const definition = resourceBounds.get(key);
    if (!definition) {
      errors.push(`player.resources merujuk resource tidak dikenal "${key}".`);
      continue;
    }
    if (
      !Number.isFinite(value) ||
      value < definition.min ||
      (definition.max !== undefined && value > definition.max)
    ) {
      errors.push(
        `player.resources "${key}" harus angka finite dalam rentang yang ditentukan.`,
      );
    }
  }
  for (const npc of game.npcs) {
    if (typeof npc.name !== "string")
      errors.push(`npcs "${npc.id}": name harus string.`);
    for (const field of ["personality", "goals", "privateKnowledge"] as const) {
      if (!Array.isArray(npc[field])) {
        errors.push(`npcs "${npc.id}": ${field} harus array.`);
      }
    }
    if (!isObject(npc.initialRelationships)) {
      errors.push(`npcs "${npc.id}": initialRelationships harus object.`);
      continue;
    }
    for (const [key, value] of Object.entries(npc.initialRelationships)) {
      const definition = relationshipBounds.get(key);
      if (!definition) {
        errors.push(`npcs "${npc.id}": relationship tidak dikenal "${key}".`);
        continue;
      }
      if (
        !Number.isFinite(value) ||
        value < definition.min ||
        value > definition.max
      ) {
        errors.push(
          `npcs "${npc.id}": nilai relationship "${key}" di luar rentang.`,
        );
      }
    }
    if (npc.attributes !== undefined) {
      if (!isObject(npc.attributes)) {
        errors.push(`npcs "${npc.id}": attributes harus object.`);
      } else {
        for (const [key, value] of Object.entries(npc.attributes)) {
          const definition = attributeBounds.get(key);
          if (!definition) {
            errors.push(`npcs "${npc.id}": attribute tidak dikenal "${key}".`);
            continue;
          }
          if (
            !Number.isFinite(value) ||
            value < definition.min ||
            value > definition.max
          ) {
            errors.push(
              `npcs "${npc.id}": nilai attribute "${key}" di luar rentang.`,
            );
          }
        }
      }
    }
  }
  game.startingInventory.forEach((entry, index) => {
    const item = itemById.get(entry.itemId);
    if (!item) {
      errors.push(
        `startingInventory[${index}]: item tidak dikenal "${entry.itemId}".`,
      );
    }
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
      errors.push(`startingInventory[${index}]: quantity harus integer >= 1.`);
    } else if (item && !item.stackable && entry.quantity !== 1) {
      errors.push(
        `startingInventory[${index}]: item tidak bisa ditumpuk; quantity harus 1.`,
      );
    }
  });
  return errors;
}

export function validatePlayability(game: GameDefinition): string[] {
  const errors: string[] = [];
  if (typeof game.title !== "string" || !game.title.trim())
    errors.push("title tidak boleh kosong untuk mulai bermain.");
  if (isObject(game.scenario)) {
    if (
      typeof game.scenario.setting !== "string" ||
      !game.scenario.setting.trim()
    )
      errors.push("scenario.setting tidak boleh kosong untuk mulai bermain.");
    if (
      typeof game.scenario.startingSituation !== "string" ||
      !game.scenario.startingSituation.trim()
    )
      errors.push(
        "scenario.startingSituation tidak boleh kosong untuk mulai bermain.",
      );
  }
  if (isObject(game.player)) {
    if (typeof game.player.name !== "string" || !game.player.name.trim())
      errors.push("player.name tidak boleh kosong untuk mulai bermain.");
  }
  return errors;
}
export class ImportError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Import ditolak: ${problems.join(" ")}`);
  }
}

const MESSAGE_ROLES: Record<string, true> = {
  PLAYER: true,
  NPC: true,
  NARRATOR: true,
  SYSTEM_EVENT: true,
};

const CHECK_MODES: Record<string, true> = {
  OFF: true,
  LOW: true,
  NORMAL: true,
  HIGH: true,
};

const CHECK_OUTCOMES: Record<string, true> = {
  FAILURE: true,
  PARTIAL_SUCCESS: true,
  SUCCESS: true,
};

const GAME_FIELDS = [
  "id",
  "title",
  "description",
  "genre",
  "tone",
  "language",
  "scenario",
  "attributes",
  "resources",
  "relationships",
  "items",
  "player",
  "npcs",
  "startingInventory",
  "updatedAt",
] as const;

const SCENARIO_FIELDS = [
  "setting",
  "startingSituation",
  "worldRules",
  "tone",
  "genre",
  "additionalContext",
] as const;

const ATTRIBUTE_FIELDS = [
  "id",
  "name",
  "description",
  "min",
  "max",
  "defaultValue",
] as const;

const RESOURCE_FIELDS = [
  "id",
  "name",
  "description",
  "min",
  "max",
  "initialValue",
] as const;

const RELATIONSHIP_FIELDS = [
  "id",
  "name",
  "description",
  "min",
  "max",
  "defaultValue",
] as const;

const ITEM_FIELDS = [
  "id",
  "name",
  "description",
  "stackable",
  "maxStack",
  "consumable",
  "tags",
] as const;

const PLAYER_FIELDS = [
  "name",
  "description",
  "background",
  "personality",
  "notes",
] as const;

const NPC_FIELDS = [
  "id",
  "name",
  "description",
  "background",
  "role",
  "personality",
  "goals",
  "privateKnowledge",
] as const;

const INVENTORY_ENTRY_FIELDS = ["itemId", "quantity"] as const;

const EFFECT_FIELDS_BY_TYPE: Record<string, readonly string[]> = {
  ATTRIBUTE_CHANGE: ["type", "target", "operation", "value"],
  RESOURCE_CHANGE: ["type", "target", "operation", "value"],
  RELATIONSHIP_CHANGE: ["type", "target", "npcId", "operation", "value"],
  ADD_ITEM: ["type", "target", "quantity"],
  REMOVE_ITEM: ["type", "target", "quantity"],
  ADD_FACT: ["type", "text"],
  REMOVE_FACT: ["type", "target"],
};

function pickFields(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

function pickNumberRecord(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!isObject(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (!DANGEROUS_KEYS.has(key)) result[key] = value as number;
  }
  return result;
}

function pickEffects(raw: unknown): ItemEffect[] {
  if (!Array.isArray(raw)) return [];
  const effects: ItemEffect[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) {
      effects.push(null as unknown as ItemEffect);
      continue;
    }
    const fields =
      typeof entry.type === "string"
        ? EFFECT_FIELDS_BY_TYPE[entry.type]
        : undefined;
    if (fields) {
      effects.push(pickFields(entry, fields) as unknown as ItemEffect);
    } else {
      effects.push({ type: entry.type } as unknown as ItemEffect);
    }
  }
  return effects;
}

export function pickGameDefinition(raw: unknown): GameDefinition {
  if (!isObject(raw)) throw new Error("Game bukan object.");
  const game = pickFields(raw, GAME_FIELDS);
  if (isObject(raw.scenario)) {
    game.scenario = pickFields(raw.scenario, SCENARIO_FIELDS);
  }
  if (Array.isArray(raw.attributes)) {
    game.attributes = raw.attributes
      .filter(isObject)
      .map((entry) => pickFields(entry, ATTRIBUTE_FIELDS));
  }
  if (Array.isArray(raw.resources)) {
    game.resources = raw.resources
      .filter(isObject)
      .map((entry) => pickFields(entry, RESOURCE_FIELDS));
  }
  if (Array.isArray(raw.relationships)) {
    game.relationships = raw.relationships
      .filter(isObject)
      .map((entry) => pickFields(entry, RELATIONSHIP_FIELDS));
  }
  if (Array.isArray(raw.items)) {
    game.items = raw.items.filter(isObject).map((entry) => {
      const item = pickFields(entry, ITEM_FIELDS);
      item.effects = pickEffects(entry.effects);
      if (Array.isArray(entry.tags)) {
        item.tags = entry.tags.filter(
          (tag): tag is string => typeof tag === "string",
        );
      }
      return item;
    });
  }
  if (isObject(raw.player)) {
    const player = pickFields(raw.player, PLAYER_FIELDS);
    player.attributes = pickNumberRecord(raw.player.attributes);
    player.resources = pickNumberRecord(raw.player.resources);
    game.player = player;
  }
  if (Array.isArray(raw.npcs)) {
    game.npcs = raw.npcs.filter(isObject).map((entry) => {
      const npc = pickFields(entry, NPC_FIELDS);
      npc.initialRelationships = pickNumberRecord(entry.initialRelationships);
      if (entry.attributes !== undefined) {
        npc.attributes = pickNumberRecord(entry.attributes);
      }
      for (const field of ["personality", "goals", "privateKnowledge"]) {
        if (Array.isArray(entry[field])) {
          npc[field] = entry[field].filter(
            (value): value is string => typeof value === "string",
          );
        }
      }
      return npc;
    });
  }
  if (Array.isArray(raw.startingInventory)) {
    game.startingInventory = raw.startingInventory
      .filter(isObject)
      .map((entry) => pickFields(entry, INVENTORY_ENTRY_FIELDS));
  }
  return structuredClone(game) as unknown as GameDefinition;
}

function pickSessionState(raw: unknown): SessionState {
  const state = raw as SessionState; // collectSessionProblems memvalidasi shape.
  return {
    attributes: pickNumberRecord(state.attributes),
    resources: pickNumberRecord(state.resources),
    inventory: state.inventory.map((entry) => ({
      itemId: entry.itemId,
      quantity: entry.quantity,
    })),
    relationships: state.relationships.map((rel) => ({
      npcId: rel.npcId,
      values: pickNumberRecord(rel.values),
    })),
    facts: state.facts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      visibility: fact.visibility,
      knownBy: [...fact.knownBy],
      createdAt: fact.createdAt,
      source: fact.source,
    })),
    world: {
      location: state.world.location,
      time: state.world.time,
      scene: state.world.scene,
      activeCharacters: [...state.world.activeCharacters],
    },
  };
}

function pickCheck(raw: unknown): CheckRecord | undefined {
  if (!isObject(raw)) return undefined;
  const check = raw as unknown as CheckRecord;
  return {
    attributeId: check.attributeId,
    difficulty: check.difficulty,
    mode: check.mode,
    score: check.score,
    outcome: check.outcome,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${keys.join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectSessionProblems(
  game: GameDefinition,
  session: GameSession,
  messages: Message[],
): string[] {
  const problems: string[] = [];
  if (
    canonicalJson(pickGameDefinition(session.definitionSnapshot)) !==
    canonicalJson(game)
  ) {
    problems.push("Snapshot session tidak cocok dengan game.");
  }
  const attributeById = new Map(game.attributes.map((a) => [a.id, a]));
  const resourceById = new Map(game.resources.map((r) => [r.id, r]));
  const relationshipById = new Map(game.relationships.map((r) => [r.id, r]));
  const itemById = new Map(game.items.map((i) => [i.id, i]));
  const knownIds = new Set([PLAYER_ID, ...game.npcs.map((npc) => npc.id)]);

  const state = session.state;
  if (!isObject(state.attributes)) {
    problems.push("state.attributes harus object.");
  } else {
    for (const [key, value] of Object.entries(
      state.attributes as Record<string, unknown>,
    )) {
      const def = attributeById.get(key);
      if (!def) {
        problems.push(`state.attributes "${key}" tidak dikenal.`);
      } else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < def.min ||
        value > def.max
      ) {
        problems.push(`state.attributes "${key}" di luar rentang definisi.`);
      }
    }
  }
  if (!isObject(state.resources)) {
    problems.push("state.resources harus object.");
  } else {
    for (const [key, value] of Object.entries(
      state.resources as Record<string, unknown>,
    )) {
      const def = resourceById.get(key);
      if (!def) {
        problems.push(`state.resources "${key}" tidak dikenal.`);
      } else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < def.min ||
        (def.max !== undefined && value > def.max)
      ) {
        problems.push(`state.resources "${key}" di luar rentang definisi.`);
      }
    }
  }
  if (!Array.isArray(state.inventory)) {
    problems.push("state.inventory harus array.");
  } else {
    state.inventory.forEach((entry, index) => {
      const item = itemById.get(entry.itemId);
      if (!item) {
        problems.push(`state.inventory[${index}] item tidak dikenal.`);
      } else if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
        problems.push(`state.inventory[${index}] quantity harus integer >= 1.`);
      } else if (!item.stackable && entry.quantity !== 1) {
        problems.push(
          `state.inventory[${index}] item tidak bisa ditumpuk; quantity harus 1.`,
        );
      }
    });
  }
  if (!Array.isArray(state.relationships)) {
    problems.push("state.relationships harus array.");
  } else {
    state.relationships.forEach((rel, index) => {
      if (!knownIds.has(rel.npcId)) {
        problems.push(`state.relationships[${index}] npcId tidak dikenal.`);
        return;
      }
      if (!isObject(rel.values)) {
        problems.push(`state.relationships[${index}] values harus object.`);
        return;
      }
      for (const [key, value] of Object.entries(
        rel.values as Record<string, unknown>,
      )) {
        const def = relationshipById.get(key);
        if (!def) {
          problems.push(
            `state.relationships[${index}] relasi "${key}" tidak dikenal.`,
          );
        } else if (
          typeof value !== "number" ||
          value < def.min ||
          value > def.max
        ) {
          problems.push(
            `state.relationships[${index}] nilai "${key}" di luar rentang.`,
          );
        }
      }
    });
  }
  if (!Array.isArray(state.facts)) {
    problems.push("state.facts harus array.");
  } else {
    state.facts.forEach((fact, index) => {
      if (!isString(fact.id) || typeof fact.text !== "string") {
        problems.push(`state.facts[${index}] butuh id dan text string.`);
      }
      if (fact.visibility !== "public" && fact.visibility !== "private") {
        problems.push(
          `state.facts[${index}] visibility harus public atau private.`,
        );
      }
      if (!Array.isArray(fact.knownBy)) {
        problems.push(`state.facts[${index}] knownBy harus array.`);
      } else if (fact.knownBy.some((id) => !knownIds.has(id))) {
        problems.push(
          `state.facts[${index}] knownBy merujuk id tidak dikenal.`,
        );
      }
      if (fact.source !== "config" && fact.source !== "story") {
        problems.push(`state.facts[${index}] source harus config atau story.`);
      }
    });
  }
  if (!isObject(state.world)) {
    problems.push("state.world harus object.");
  } else {
    for (const field of ["location", "time", "scene"] as const) {
      if (typeof state.world[field] !== "string") {
        problems.push(`state.world.${field} harus string.`);
      }
    }
    if (!Array.isArray(state.world.activeCharacters)) {
      problems.push("state.world.activeCharacters harus array.");
    } else if (state.world.activeCharacters.some((id) => !knownIds.has(id))) {
      problems.push("state.world.activeCharacters merujuk id tidak dikenal.");
    }
  }

  const sequences = new Set<number>();
  messages.forEach((message, index) => {
    if (message.sessionId !== session.id) {
      problems.push(`Message ${message.id} bukan milik session yang diekspor.`);
    }
    if (typeof message.sequence === "number") {
      if (!Number.isInteger(message.sequence) || message.sequence < 0) {
        problems.push(`messages[${index}] sequence harus integer >= 0.`);
      } else if (sequences.has(message.sequence)) {
        problems.push(`messages[${index}] sequence duplikat.`);
      } else {
        sequences.add(message.sequence);
      }
    }
    if (message.check !== undefined) {
      const check = message.check as CheckRecord;
      if (!isObject(check)) {
        problems.push(`messages[${index}] check harus object.`);
      } else {
        if (!attributeById.has(check.attributeId)) {
          problems.push(`messages[${index}] check.attributeId tidak dikenal.`);
        }
        if (!Number.isInteger(check.difficulty) || check.difficulty < 0) {
          problems.push(
            `messages[${index}] check.difficulty harus integer >= 0.`,
          );
        }
        if (typeof check.mode !== "string" || !(check.mode in CHECK_MODES)) {
          problems.push(`messages[${index}] check.mode tidak dikenal.`);
        }
        if (typeof check.score !== "number" || !Number.isFinite(check.score)) {
          problems.push(`messages[${index}] check.score harus angka finite.`);
        }
        if (
          typeof check.outcome !== "string" ||
          !(check.outcome in CHECK_OUTCOMES)
        ) {
          problems.push(`messages[${index}] check.outcome tidak dikenal.`);
        }
      }
    }
  });
  const expectedNext = messages.reduce(
    (max, message) =>
      typeof message.sequence === "number" && message.sequence >= max
        ? message.sequence + 1
        : max,
    0,
  );
  if (session.nextSequence !== expectedNext) {
    problems.push("nextSequence tidak sesuai urutan messages.");
  }
  return problems;
}

function collectBundleProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(raw)) return ["File bukan JSON object."];
  if (hasDangerousKeysDeep(raw)) {
    return ["File mengandung key berbahaya."];
  }
  if (raw.format !== EXPORT_FORMAT)
    problems.push("Field format tidak dikenal.");
  if (raw.version !== EXPORT_VERSION) {
    problems.push(
      `Versi format tidak didukung (ditemukan ${String(raw.version)}).`,
    );
  }
  const { game, session, messages } = raw;
  if (!isObject(game)) problems.push("Bagian game hilang atau bukan object.");
  if (!isObject(session)) {
    problems.push("Bagian session hilang atau bukan object.");
    return problems;
  }
  if (!Array.isArray(messages))
    problems.push("Bagian messages hilang atau bukan array.");
  if (!isString(session.id) || !isString(session.gameId)) {
    problems.push("Session harus memiliki id dan gameId string.");
  }
  if (!isObject(session.definitionSnapshot)) {
    problems.push("Session harus memiliki definitionSnapshot object.");
  }
  if (!isObject(session.state))
    problems.push("Session harus memiliki state object.");
  if (
    !isObject(session.ai) ||
    (session.ai.provider !== "gemini" && session.ai.provider !== "openrouter")
  ) {
    problems.push("Session harus memiliki ai.provider gemini atau openrouter.");
  }
  if (typeof session.nextSequence !== "number") {
    problems.push("Session harus memiliki nextSequence angka.");
  }
  if (Array.isArray(messages)) {
    messages.forEach((message, index) => {
      if (!isObject(message)) {
        problems.push(`messages[${index}] bukan object.`);
        return;
      }
      if (
        !isString(message.id) ||
        !isString(message.sessionId) ||
        !isString(message.turnId)
      ) {
        problems.push(`messages[${index}] butuh id, sessionId, turnId string.`);
      }
      if (typeof message.sequence !== "number") {
        problems.push(`messages[${index}] butuh sequence angka.`);
      }
      if (
        typeof message.role !== "string" ||
        !(message.role in MESSAGE_ROLES)
      ) {
        problems.push(`messages[${index}] role tidak dikenal.`);
      }
      if (typeof message.content !== "string") {
        problems.push(`messages[${index}] butuh content string.`);
      }
      if (typeof message.createdAt !== "string") {
        problems.push(`messages[${index}] butuh createdAt string.`);
      }
    });
  }
  return problems;
}
// §32: entitas lama tidak boleh dihapus atau diubah batas numeriknya selama
// game masih punya sesi; teks dan entitas baru bebas diubah.
export function validateDefinitionUpdate(
  oldGame: GameDefinition,
  newGame: GameDefinition,
): string[] {
  const errors: string[] = [];
  const blockedChange = (section: string, id: string, field: string): void => {
    errors.push(
      `${section} "${id}": ${field} tidak boleh diubah karena masih ada sesi berjalan.`,
    );
  };

  const checkList = <T extends { id: string }>(
    section: string,
    oldList: readonly T[],
    newList: readonly T[],
    checkBounds: (oldEntity: T, newEntity: T) => void,
  ): void => {
    for (const oldEntity of oldList) {
      const newEntity = newList.find((entry) => entry.id === oldEntity.id);
      if (!newEntity) {
        errors.push(
          `${section} "${oldEntity.id}" tidak boleh dihapus karena masih ada sesi berjalan.`,
        );
        continue;
      }
      checkBounds(oldEntity, newEntity);
    }
  };

  checkList("Atribut", oldGame.attributes, newGame.attributes, (old, next) => {
    if (old.min !== next.min) blockedChange("Atribut", old.id, "min");
    if (old.max !== next.max) blockedChange("Atribut", old.id, "max");
    if (old.defaultValue !== next.defaultValue) {
      blockedChange("Atribut", old.id, "defaultValue");
    }
  });
  checkList(
    "Sumber daya",
    oldGame.resources,
    newGame.resources,
    (old, next) => {
      if (old.min !== next.min) blockedChange("Sumber daya", old.id, "min");
      if (old.max !== next.max) blockedChange("Sumber daya", old.id, "max");
      if (old.initialValue !== next.initialValue) {
        blockedChange("Sumber daya", old.id, "initialValue");
      }
    },
  );
  checkList(
    "Relasi",
    oldGame.relationships,
    newGame.relationships,
    (old, next) => {
      if (old.min !== next.min) blockedChange("Relasi", old.id, "min");
      if (old.max !== next.max) blockedChange("Relasi", old.id, "max");
      if (old.defaultValue !== next.defaultValue) {
        blockedChange("Relasi", old.id, "defaultValue");
      }
    },
  );
  checkList("Item", oldGame.items, newGame.items, (old, next) => {
    if (old.maxStack !== next.maxStack) {
      blockedChange("Item", old.id, "maxStack");
    }
  });
  checkList("NPC", oldGame.npcs, newGame.npcs, () => {});

  return errors;
}
export function createExportBundle(
  session: GameSession,
  messages: Message[],
  exportedAt: string,
): ExportBundle {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    game: pickGameDefinition(session.definitionSnapshot),
    session: {
      id: session.id,
      gameId: session.gameId,
      definitionSnapshot: pickGameDefinition(session.definitionSnapshot),
      state: structuredClone(session.state),
      ai: { provider: session.ai.provider, model: session.ai.model },
      nextSequence: session.nextSequence,
      updatedAt: session.updatedAt,
    },
    messages: messages.map((message) => {
      const next: Message = {
        id: message.id,
        sessionId: message.sessionId,
        turnId: message.turnId,
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      };
      if (message.speakerId !== undefined) next.speakerId = message.speakerId;
      if (message.check !== undefined) next.check = pickCheck(message.check);
      return next;
    }),
  };
}

export function validateExportBundle(raw: unknown): {
  game: GameDefinition;
  session: GameSession;
  messages: Message[];
} {
  const problems = collectBundleProblems(raw);
  if (problems.length > 0) throw new ImportError(problems);
  const bundle = raw as ExportBundle;

  const game = pickGameDefinition(bundle.game);
  const definitionErrors = validateDefinition(game);
  if (definitionErrors.length > 0) throw new ImportError(definitionErrors);

  const sessionProblems = collectSessionProblems(
    game,
    bundle.session,
    bundle.messages,
  );
  if (sessionProblems.length > 0) throw new ImportError(sessionProblems);

  const messages = bundle.messages.map((message) => {
    const next: Message = {
      id: message.id,
      sessionId: message.sessionId,
      turnId: message.turnId,
      sequence: message.sequence,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    };
    if (typeof message.speakerId === "string") {
      next.speakerId = message.speakerId;
    }
    const check = pickCheck(message.check);
    if (check) next.check = check;
    return next;
  });

  return {
    game,
    session: {
      id: bundle.session.id,
      gameId: bundle.session.gameId,
      definitionSnapshot: pickGameDefinition(bundle.session.definitionSnapshot),
      state: pickSessionState(bundle.session.state),
      ai: {
        provider: bundle.session.ai.provider,
        model: bundle.session.ai.model,
      },
      nextSequence: bundle.session.nextSequence,
      updatedAt: bundle.session.updatedAt,
    },
    messages,
  };
}
