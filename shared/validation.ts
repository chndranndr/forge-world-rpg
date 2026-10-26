import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  EXPORT_VERSION_WITH_LORE,
  PLAYER_ID,
  type CheckRecord,
  type ExportBundle,
  type GameDefinition,
  type GameSession,
  type ItemEffect,
  type LoreDependency,
  type Message,
  type SessionState,
} from "./types.js";
import { sceneParticipants, validateWorldMap } from "./world.js";
import { normalizeNarratorSystemPrompt } from "./narrator-prompt.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateOptionalTextFields(
  value: unknown,
  fields: readonly string[],
  label: string,
): string[] {
  if (!isObject(value)) return [];
  return fields.flatMap((field) =>
    value[field] !== undefined && typeof value[field] !== "string"
      ? [`${label}.${field} harus string.`]
      : [],
  );
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
  DISCOVER_LORE: true,
  REVEAL_FACT: true,
  SET_FLAG: true,
  NPC_PRESENCE: true,
};

const EFFECT_OPERATIONS: Record<string, true> = {
  ADD: true,
  SUBTRACT: true,
  SET: true,
};

const AGE_RATINGS: Record<string, true> = {
  "all-ages": true,
  "teen-13-plus": true,
  "adult-18-plus": true,
};
const RELATIONSHIP_STANCES: Record<string, true> = {
  friendly: true,
  neutral: true,
  wary: true,
  hostile: true,
};
const NARRATOR_STYLES: Record<string, true> = {
  "cinematic-second-person": true,
  "literary-third-person": true,
  "concise-second-person": true,
};
const SCENARIO_TEMPOS: Record<string, true> = {
  slow: true,
  medium: true,
  fast: true,
};
const TURN_LENGTHS: Record<string, true> = {
  short: true,
  medium: true,
  long: true,
};
const POINTS_OF_VIEW: Record<string, true> = {
  "second-person": true,
  "limited-third-person": true,
};
const PLAYER_PRONOUNS: Record<string, true> = {
  neutral: true,
  masculine: true,
  feminine: true,
};

function hasAllowedValue(
  value: unknown,
  allowed: Record<string, true>,
): boolean {
  return typeof value === "string" && Object.hasOwn(allowed, value);
}
const MAX_LOREBOOK_REFS = 8;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LORE_ID =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateLorebookRefs(raw: unknown, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${label} must be an array.`];
  const errors: string[] = [];
  if (raw.length > MAX_LOREBOOK_REFS) {
    errors.push(`${label} exceeds ${MAX_LOREBOOK_REFS} references.`);
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    if (!isObject(value)) {
      errors.push(`${label}[${index}] must be an object.`);
      return;
    }
    if (
      typeof value.packId !== "string" ||
      !SAFE_REFERENCE_ID.test(value.packId) ||
      DANGEROUS_KEYS.has(value.packId.toLowerCase())
    ) {
      errors.push(`${label}[${index}].packId is unsafe or invalid.`);
    }
    if (
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1
    ) {
      errors.push(
        `${label}[${index}].version must be a positive safe integer.`,
      );
    }
    if (typeof value.packId === "string" && typeof value.version === "number") {
      const key = `${value.packId}\\u0000${value.version}`;
      if (seen.has(key))
        errors.push(`${label} contains a duplicate reference.`);
      seen.add(key);
    }
    if (
      Object.keys(value).some((key) => key !== "packId" && key !== "version")
    ) {
      errors.push(`${label}[${index}] contains unsupported fields.`);
    }
  });
  return errors;
}
function isSafeReferenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_REFERENCE_ID.test(value) &&
    !DANGEROUS_KEYS.has(value.toLowerCase())
  );
}

function sameLorebookRefs(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string[] | undefined => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => !isObject(entry))) {
      return undefined;
    }
    return value
      .map((entry) => `${String(entry.packId)}\\u0000${String(entry.version)}`)
      .sort();
  };
  const leftKeys = normalize(left);
  const rightKeys = normalize(right);
  return (
    leftKeys !== undefined &&
    rightKeys !== undefined &&
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
  );
}

export function validateDefinition(game: GameDefinition): string[] {
  const errors: string[] = [];
  if (hasDangerousKeysDeep(game)) {
    errors.push("Game mengandung key berbahaya.");
  }
  if (typeof game.id !== "string" || !game.id.trim()) {
    errors.push("Game harus memiliki id string tidak kosong.");
  }
  if (typeof game.title !== "string") {
    errors.push("Game harus memiliki title string.");
  }
  if (
    game.ageRating !== undefined &&
    !hasAllowedValue(game.ageRating, AGE_RATINGS)
  ) {
    errors.push("ageRating tidak dikenal.");
  }
  if (
    game.relationshipParties !== undefined &&
    !Array.isArray(game.relationshipParties)
  ) {
    errors.push("relationshipParties harus array.");
  }
  if (isObject(game.scenario)) {
    if (typeof game.scenario.setting !== "string")
      errors.push("scenario.setting harus string.");
    if (typeof game.scenario.startingSituation !== "string")
      errors.push("scenario.startingSituation harus string.");
    errors.push(
      ...validateOptionalTextFields(
        game.scenario,
        ["trigger", "contentLimits"],
        "scenario",
      ),
    );
    for (const [field, value, allowed] of [
      ["narratorStyle", game.scenario.narratorStyle, NARRATOR_STYLES],
      ["tempo", game.scenario.tempo, SCENARIO_TEMPOS],
      ["turnLength", game.scenario.turnLength, TURN_LENGTHS],
      ["pointOfView", game.scenario.pointOfView, POINTS_OF_VIEW],
    ] as const) {
      if (value !== undefined && !hasAllowedValue(value, allowed)) {
        errors.push(`scenario.${field} tidak dikenal.`);
      }
    }
  } else {
    errors.push("Game harus memiliki scenario object.");
  }
  if (!isObject(game.player)) {
    errors.push("Game harus memiliki player object.");
  } else {
    errors.push(
      ...validateOptionalTextFields(
        game.player,
        ["role", "age", "goal", "fear"],
        "player",
      ),
    );
    if (
      game.player.pronoun !== undefined &&
      !hasAllowedValue(game.player.pronoun, PLAYER_PRONOUNS)
    ) {
      errors.push("player.pronoun tidak dikenal.");
    }
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
  if (game.relationshipParties !== undefined) {
    const partyIds = new Set<string>();
    const partyNames = new Set<string>();
    game.relationshipParties.forEach((party, index) => {
      if (!isObject(party)) {
        errors.push(`relationshipParties[${index}] harus object.`);
        return;
      }
      if (typeof party.id !== "string" || !party.id.trim()) {
        errors.push(`relationshipParties[${index}].id kosong.`);
      } else if (partyIds.has(party.id)) {
        errors.push(`relationshipParties[${index}].id duplikat: ${party.id}.`);
      } else {
        partyIds.add(party.id);
      }
      if (typeof party.name !== "string" || !party.name.trim()) {
        errors.push(
          `relationshipParties[${index}].name harus string tidak kosong.`,
        );
      } else {
        const normalizedName = party.name
          .normalize("NFKC")
          .trim()
          .replace(/\s+/gu, " ")
          .toLowerCase();
        if (partyNames.has(normalizedName)) {
          errors.push(`relationshipParties[${index}].name duplikat.`);
        } else {
          partyNames.add(normalizedName);
        }
      }
      if (typeof party.type !== "string" || !party.type.trim()) {
        errors.push(
          `relationshipParties[${index}].type harus string tidak kosong.`,
        );
      }
      if (!hasAllowedValue(party.initialStance, RELATIONSHIP_STANCES)) {
        errors.push(
          `relationshipParties[${index}].initialStance tidak dikenal.`,
        );
      }
      errors.push(
        ...validateOptionalTextFields(
          party,
          ["secret"],
          `relationshipParties[${index}]`,
        ),
      );
    });
  }
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
  errors.push(...validateLorebookRefs(game.lorebookRefs, "lorebookRefs"));
  const hasLoreRefs =
    Array.isArray(game.lorebookRefs) && game.lorebookRefs.length > 0;
  if (game.worldMap !== undefined) {
    errors.push(...validateWorldMap(game.worldMap, [...npcIds]));
  }
  if (game.startingLocationId !== undefined) {
    if (!isSafeReferenceId(game.startingLocationId)) {
      errors.push("startingLocationId is unsafe or invalid.");
    } else if (game.worldMap === undefined && !hasLoreRefs) {
      errors.push(
        "startingLocationId requires a worldMap or bound lorebookRefs.",
      );
    } else if (
      isObject(game.worldMap) &&
      Array.isArray(game.worldMap.locations) &&
      !game.worldMap.locations.some(
        (location) =>
          isObject(location) && location.id === game.startingLocationId,
      ) &&
      !hasLoreRefs
    ) {
      errors.push("startingLocationId is not present in worldMap.");
    }
  } else if (
    isObject(game.worldMap) &&
    Array.isArray(game.worldMap.locations) &&
    game.worldMap.locations.length > 0 &&
    !hasLoreRefs
  ) {
    errors.push("A standalone worldMap requires startingLocationId.");
  }

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
    if (typeof item.name !== "string") {
      errors.push(`items "${item.id}": name harus string.`);
    }
    if (typeof item.stackable !== "boolean") {
      errors.push(`items "${item.id}": stackable harus boolean.`);
    }
    if (typeof item.consumable !== "boolean") {
      errors.push(`items "${item.id}": consumable harus boolean.`);
    }
    if (!Array.isArray(item.effects)) {
      errors.push(`items "${item.id}": effects harus array.`);
    }
    if (!Array.isArray(item.tags)) {
      errors.push(`items "${item.id}": tags harus array.`);
    }
    if (
      item.maxStack !== undefined &&
      (!Number.isInteger(item.maxStack) || item.maxStack < 1)
    ) {
      errors.push(`items "${item.id}": maxStack harus integer >= 1.`);
    }
    if (!Array.isArray(item.effects)) continue;
    item.effects.forEach((effect, effectIndex) => {
      const spot = `items "${item.id}" effects[${effectIndex}]`;
      if (
        !isObject(effect) ||
        typeof effect.type !== "string" ||
        !Object.hasOwn(EFFECT_TYPES, effect.type)
      ) {
        errors.push(`${spot}: type effect tidak dikenal.`);
        return;
      }
      const type = effect.type;
      const allowedEffectFields = EFFECT_FIELDS_BY_TYPE[type];
      if (
        Object.keys(effect).some(
          (field) => !allowedEffectFields.includes(field),
        )
      ) {
        errors.push(`${spot}: effect contains unsupported fields.`);
      }
      if (
        type === "ATTRIBUTE_CHANGE" ||
        type === "RESOURCE_CHANGE" ||
        type === "RELATIONSHIP_CHANGE"
      ) {
        if (
          typeof effect.operation !== "string" ||
          !Object.hasOwn(EFFECT_OPERATIONS, effect.operation)
        ) {
          errors.push(`${spot}: operation harus ADD, SUBTRACT, atau SET.`);
        }
        if (
          typeof effect.value !== "number" ||
          !Number.isFinite(effect.value)
        ) {
          errors.push(`${spot}: value harus angka finite.`);
        }
      }
      if (type === "RELATIONSHIP_CHANGE" && !npcIds.has(String(effect.npcId))) {
        errors.push(
          `${spot}: RELATIONSHIP_CHANGE membutuhkan npcId NPC yang dikenal.`,
        );
      }
      if (
        type === "ATTRIBUTE_CHANGE" ||
        type === "RESOURCE_CHANGE" ||
        type === "RELATIONSHIP_CHANGE" ||
        type === "ADD_ITEM" ||
        type === "REMOVE_ITEM"
      ) {
        const pool =
          type === "ATTRIBUTE_CHANGE"
            ? attributeIds
            : type === "RESOURCE_CHANGE"
              ? resourceIds
              : type === "RELATIONSHIP_CHANGE"
                ? relationshipIds
                : itemIds;
        if (typeof effect.target !== "string" || !pool.has(effect.target)) {
          errors.push(
            `${spot}: effect merujuk target tidak dikenal "${String(effect.target)}".`,
          );
        }
      }
      if (type === "ADD_ITEM" || type === "REMOVE_ITEM") {
        if (!Number.isInteger(effect.quantity) || Number(effect.quantity) < 1) {
          errors.push(`${spot}: quantity harus integer >= 1.`);
        }
      }
      if (type === "ADD_FACT") {
        if (typeof effect.text !== "string" || !effect.text.trim()) {
          errors.push(`${spot}: teks fakta tidak boleh kosong.`);
        }
        if (
          effect.visibility !== undefined &&
          effect.visibility !== "public" &&
          effect.visibility !== "private"
        ) {
          errors.push(`${spot}: visibility harus public atau private.`);
        }
        for (const field of ["knownBy", "revealableTo"] as const) {
          const recipients = effect[field];
          if (
            recipients !== undefined &&
            (!Array.isArray(recipients) ||
              recipients.some(
                (id) =>
                  typeof id !== "string" ||
                  (id !== PLAYER_ID && !npcIds.has(id)),
              ))
          ) {
            errors.push(`${spot}: ${field} merujuk penerima tidak dikenal.`);
          }
        }
      }
      if (
        type === "REMOVE_FACT" &&
        (typeof effect.target !== "string" || !effect.target.trim())
      ) {
        errors.push(`${spot}: target fakta tidak boleh kosong.`);
      }
      if (type === "DISCOVER_LORE") {
        if (
          typeof effect.loreId !== "string" ||
          !SAFE_LORE_ID.test(effect.loreId)
        ) {
          errors.push(`${spot}: loreId harus berupa ID namespaced yang aman.`);
        }
        if (!hasLoreRefs)
          errors.push(`${spot}: DISCOVER_LORE membutuhkan lorebookRefs.`);
      }
      if (type === "REVEAL_FACT") {
        if (typeof effect.factId !== "string" || !effect.factId.trim()) {
          errors.push(`${spot}: factId tidak boleh kosong.`);
        }
        if (
          typeof effect.npcId !== "string" ||
          (effect.npcId !== PLAYER_ID && !npcIds.has(effect.npcId))
        ) {
          errors.push(
            `${spot}: REVEAL_FACT membutuhkan penerima yang dikenal.`,
          );
        }
      }
      if (type === "SET_FLAG") {
        if (typeof effect.target !== "string" || !effect.target.trim()) {
          errors.push(`${spot}: target flag tidak boleh kosong.`);
        } else if (
          !isObject(game.worldMap?.flags) ||
          !Object.hasOwn(game.worldMap.flags, effect.target)
        ) {
          errors.push(`${spot}: flag "${effect.target}" tidak dideklarasikan.`);
        }
        if (typeof effect.value !== "boolean") {
          errors.push(`${spot}: SET_FLAG value harus boolean.`);
        }
      }
      if (
        type === "NPC_PRESENCE" &&
        (typeof effect.npcId !== "string" || !npcIds.has(effect.npcId))
      ) {
        errors.push(`${spot}: NPC_PRESENCE membutuhkan NPC yang dikenal.`);
      }
      if (type === "NPC_PRESENCE" && typeof effect.present !== "boolean") {
        errors.push(`${spot}: NPC_PRESENCE present harus boolean.`);
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
    errors.push(
      ...validateOptionalTextFields(npc, ["voice"], `npcs "${npc.id}"`),
    );
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
    errors.push(
      ...validateOptionalTextFields(
        entry,
        ["owner", "place"],
        `startingInventory[${index}]`,
      ),
    );
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
  "ageRating",
  "scenario",
  "attributes",
  "resources",
  "relationshipParties",
  "relationships",
  "items",
  "player",
  "npcs",
  "startingInventory",
  "worldMap",
  "startingLocationId",
  "lorebookRefs",
  "updatedAt",
] as const;

const SCENARIO_FIELDS = [
  "setting",
  "startingSituation",
  "worldRules",
  "tone",
  "genre",
  "additionalContext",
  "trigger",
  "narratorStyle",
  "tempo",
  "turnLength",
  "pointOfView",
  "contentLimits",
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
  "role",
  "pronoun",
  "age",
  "goal",
  "fear",
] as const;

const NPC_FIELDS = [
  "id",
  "name",
  "description",
  "background",
  "voice",
  "role",
  "personality",
  "goals",
  "privateKnowledge",
] as const;

const INVENTORY_ENTRY_FIELDS = [
  "itemId",
  "quantity",
  "owner",
  "place",
] as const;

const EFFECT_FIELDS_BY_TYPE: Record<string, readonly string[]> = {
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
function pickWorldMap(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const map = pickFields(raw, ["locations", "connections", "flags"]);
  if (Array.isArray(raw.locations)) {
    map.locations = raw.locations.map((location) =>
      isObject(location)
        ? pickFields(location, [
            "id",
            "name",
            "aliases",
            "summary",
            "parentId",
            "npcIds",
            "requiredFlag",
          ])
        : location,
    );
  }
  if (Array.isArray(raw.connections)) {
    map.connections = raw.connections.map((connection) =>
      isObject(connection)
        ? pickFields(connection, ["fromId", "toId", "blockedByFlag"])
        : connection,
    );
  }
  if (isObject(raw.flags)) map.flags = raw.flags;
  return map;
}

function pickLorebookRefs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((ref) =>
    isObject(ref) ? pickFields(ref, ["packId", "version"]) : ref,
  );
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
  if ("worldMap" in raw) game.worldMap = pickWorldMap(raw.worldMap);
  if ("lorebookRefs" in raw) {
    game.lorebookRefs = pickLorebookRefs(raw.lorebookRefs);
  }
  if (Array.isArray(raw.relationshipParties)) {
    game.relationshipParties = raw.relationshipParties.map((party) =>
      isObject(party)
        ? pickFields(party, ["id", "name", "type", "initialStance", "secret"])
        : party,
    );
  }
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
  const world: SessionState["world"] = {
    location: state.world.location,
    time: state.world.time,
    scene: state.world.scene,
    activeCharacters: [...state.world.activeCharacters],
  };
  if (state.world.locationId !== undefined) {
    world.locationId = state.world.locationId;
  }
  if (state.world.flags !== undefined) {
    world.flags = structuredClone(state.world.flags);
  }
  if (state.world.discoveredLoreIds !== undefined) {
    world.discoveredLoreIds = [...state.world.discoveredLoreIds];
  }
  if (state.world.npcPresence !== undefined) {
    world.npcPresence = structuredClone(state.world.npcPresence);
  }
  return {
    attributes: pickNumberRecord(state.attributes),
    resources: pickNumberRecord(state.resources),
    inventory: state.inventory.map((entry) => ({
      itemId: entry.itemId,
      quantity: entry.quantity,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      ...(entry.place === undefined ? {} : { place: entry.place }),
    })),
    relationships: state.relationships.map((rel) => ({
      npcId: rel.npcId,
      values: pickNumberRecord(rel.values),
    })),
    facts: state.facts.map((fact) => {
      const next = {
        id: fact.id,
        text: fact.text,
        visibility: fact.visibility,
        knownBy: [...fact.knownBy],
        createdAt: fact.createdAt,
        source: fact.source,
      };
      if (fact.revealableTo !== undefined) {
        return { ...next, revealableTo: [...fact.revealableTo] };
      }
      return next;
    }),
    world,
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
    session.name !== undefined &&
    (typeof session.name !== "string" ||
      !session.name.trim() ||
      session.name !== session.name.trim() ||
      session.name.length > 256)
  ) {
    problems.push(
      "Session name harus string trimmed sepanjang 1–256 karakter.",
    );
  }
  if (session.pinned !== undefined && typeof session.pinned !== "boolean") {
    problems.push("Session pinned harus boolean.");
  }
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
  problems.push(
    ...validateLorebookRefs(session.lorebookRefs, "session.lorebookRefs"),
  );
  if (!sameLorebookRefs(session.lorebookRefs, game.lorebookRefs)) {
    problems.push(
      "Session lorebookRefs do not match its immutable definition snapshot.",
    );
  }
  if (game.worldMap !== undefined && session.worldMap === undefined) {
    problems.push("Session is missing its pinned worldMap projection.");
  }
  if (session.worldMap !== undefined) {
    problems.push(
      ...validateWorldMap(
        session.worldMap,
        game.npcs.map((npc) => npc.id),
      ),
    );
  }
  const worldMap = session.worldMap ?? game.worldMap;

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
      if (!isObject(entry) || typeof entry.itemId !== "string") {
        problems.push(
          `state.inventory[${index}] harus memiliki itemId string.`,
        );
        return;
      }
      const item = itemById.get(entry.itemId);
      if (!item) {
        problems.push(`state.inventory[${index}] item tidak dikenal.`);
      } else if (
        typeof entry.quantity !== "number" ||
        !Number.isInteger(entry.quantity) ||
        entry.quantity < 1
      ) {
        problems.push(`state.inventory[${index}] quantity harus integer >= 1.`);
      } else if (!item.stackable && entry.quantity !== 1) {
        problems.push(
          `state.inventory[${index}] item tidak bisa ditumpuk; quantity harus 1.`,
        );
      }
      problems.push(
        ...validateOptionalTextFields(
          entry,
          ["owner", "place"],
          `state.inventory[${index}]`,
        ),
      );
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
      if (!isObject(fact)) {
        problems.push(`state.facts[${index}] harus object.`);
        return;
      }
      if (!isString(fact.id) || typeof fact.text !== "string") {
        problems.push(`state.facts[${index}] butuh id dan text string.`);
      }
      if (fact.visibility !== "public" && fact.visibility !== "private") {
        problems.push(
          `state.facts[${index}] visibility harus public atau private.`,
        );
      }
      for (const field of ["knownBy", "revealableTo"] as const) {
        const recipients = fact[field];
        if (field === "revealableTo" && recipients === undefined) continue;
        if (!Array.isArray(recipients)) {
          problems.push(`state.facts[${index}] ${field} harus array.`);
        } else if (
          recipients.some((id) => typeof id !== "string" || !knownIds.has(id))
        ) {
          problems.push(
            `state.facts[${index}] ${field} merujuk id tidak dikenal.`,
          );
        }
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
    } else {
      if (state.world.activeCharacters.some((id) => !knownIds.has(id))) {
        problems.push("state.world.activeCharacters merujuk id tidak dikenal.");
      }
      if (
        new Set(state.world.activeCharacters).size !==
        state.world.activeCharacters.length
      ) {
        problems.push(
          "state.world.activeCharacters must not contain duplicates.",
        );
      }
      if (worldMap) {
        const locationId = state.world.locationId;
        if (
          typeof locationId !== "string" ||
          !worldMap.locations.some((location) => location.id === locationId)
        ) {
          problems.push(
            "state.world.locationId must identify a pinned map location.",
          );
        } else {
          const location = worldMap.locations.find(
            (entry) => entry.id === locationId,
          );
          if (
            typeof state.world.location === "string" &&
            location &&
            state.world.location !== location.name
          ) {
            problems.push(
              "state.world.location must match the pinned location name.",
            );
          }
          const presence = isObject(state.world.npcPresence)
            ? (state.world
                .npcPresence as GameSession["state"]["world"]["npcPresence"])
            : undefined;
          const expectedParticipants = sceneParticipants(
            worldMap,
            locationId,
            presence,
            game.npcs.map((npc) => npc.id),
          );
          if (
            state.world.activeCharacters.length > 7 ||
            new Set(state.world.activeCharacters).size !==
              state.world.activeCharacters.length ||
            expectedParticipants.some(
              (id) => !state.world.activeCharacters.includes(id),
            ) ||
            state.world.activeCharacters.some(
              (id) => !expectedParticipants.includes(id),
            )
          ) {
            problems.push(
              "state.world.activeCharacters must match the player and current location presence (maximum six NPCs).",
            );
          }
        }
      } else if (state.world.locationId !== undefined) {
        problems.push("state.world.locationId requires a pinned worldMap.");
      }
    }
    if (state.world.flags !== undefined) {
      if (!isObject(state.world.flags)) {
        problems.push("state.world.flags must be an object.");
      } else {
        const declaredFlags = new Set(Object.keys(worldMap?.flags ?? {}));
        for (const [id, value] of Object.entries(state.world.flags)) {
          if (!declaredFlags.has(id)) {
            problems.push(
              `state.world.flags contains undeclared flag "${id}".`,
            );
          }
          if (typeof value !== "boolean") {
            problems.push(`state.world.flags[${id}] must be boolean.`);
          }
        }
      }
    }
    if (state.world.discoveredLoreIds !== undefined) {
      if (!Array.isArray(state.world.discoveredLoreIds)) {
        problems.push("state.world.discoveredLoreIds must be an array.");
      } else {
        const discovered = new Set<string>();
        for (const id of state.world.discoveredLoreIds) {
          if (typeof id !== "string" || !SAFE_LORE_ID.test(id)) {
            problems.push(
              "state.world.discoveredLoreIds contains an invalid lore ID.",
            );
          } else if (discovered.has(id)) {
            problems.push(`state.world.discoveredLoreIds duplicates "${id}".`);
          }
          if (typeof id === "string") discovered.add(id);
        }
      }
    }
    if (state.world.npcPresence !== undefined) {
      if (!isObject(state.world.npcPresence)) {
        problems.push("state.world.npcPresence must be an object.");
      } else {
        for (const [npcId, presence] of Object.entries(
          state.world.npcPresence,
        )) {
          if (!knownIds.has(npcId) || npcId === PLAYER_ID) {
            problems.push(
              `state.world.npcPresence references unknown NPC "${npcId}".`,
            );
          }
          if (presence === "present" || presence === "absent") continue;
          if (!isObject(presence)) {
            problems.push(
              `state.world.npcPresence[${npcId}] must be present, absent, or a scoped presence.`,
            );
            continue;
          }
          if (
            Object.keys(presence).some(
              (key) => key !== "locationId" && key !== "present",
            ) ||
            typeof presence.locationId !== "string" ||
            (presence.present !== undefined &&
              typeof presence.present !== "boolean")
          ) {
            problems.push(
              `state.world.npcPresence[${npcId}] scoped presence is malformed.`,
            );
            continue;
          }
          if (
            !worldMap?.locations.some(
              (location) => location.id === presence.locationId,
            )
          ) {
            problems.push(
              `state.world.npcPresence[${npcId}] locationId must identify a pinned map location.`,
            );
          }
        }
      }
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
    if (
      message.visibility !== undefined &&
      message.visibility !== "public" &&
      message.visibility !== "private"
    ) {
      problems.push(`messages[${index}] visibility must be public or private.`);
    }
    if (message.knownBy !== undefined) {
      if (!Array.isArray(message.knownBy)) {
        problems.push(`messages[${index}] knownBy must be an array.`);
      } else if (
        message.knownBy.some(
          (id) => typeof id !== "string" || !knownIds.has(id),
        )
      ) {
        problems.push(
          `messages[${index}] knownBy references an unknown actor.`,
        );
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
  if (
    raw.version !== EXPORT_VERSION &&
    raw.version !== EXPORT_VERSION_WITH_LORE
  ) {
    problems.push(
      `Versi format tidak didukung (ditemukan ${String(raw.version)}).`,
    );
  }
  const { game, session } = raw;
  const version = raw.version;
  const gameRefs =
    isObject(game) && Array.isArray(game.lorebookRefs) ? game.lorebookRefs : [];
  if (version === EXPORT_VERSION && "loreDependencies" in raw) {
    problems.push("v1 bundles must not contain loreDependencies.");
  }
  if (version === EXPORT_VERSION_WITH_LORE) {
    if (!Array.isArray(raw.loreDependencies)) {
      problems.push("v2 bundles require an explicit loreDependencies array.");
    } else {
      if (raw.loreDependencies.length > MAX_LOREBOOK_REFS) {
        problems.push("v2 loreDependencies exceeds the reference limit.");
      }
      const dependencyKeys = new Set<string>();
      for (const [index, dependency] of raw.loreDependencies.entries()) {
        if (!isObject(dependency)) {
          problems.push(`loreDependencies[${index}] must be an object.`);
          continue;
        }
        if (
          Object.keys(dependency).some(
            (key) => !["packId", "version", "digest"].includes(key),
          )
        ) {
          problems.push(
            `loreDependencies[${index}] contains unsupported fields.`,
          );
        }
        const { packId, version: packVersion, digest } = dependency;
        if (
          typeof packId !== "string" ||
          !SAFE_REFERENCE_ID.test(packId) ||
          typeof packVersion !== "number" ||
          !Number.isSafeInteger(packVersion) ||
          packVersion < 1 ||
          typeof digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(digest)
        ) {
          problems.push(`loreDependencies[${index}] is invalid.`);
          continue;
        }
        const key = `${packId}\\u0000${packVersion}`;
        if (dependencyKeys.has(key)) {
          problems.push(
            `loreDependencies duplicates ${packId}@${packVersion}.`,
          );
        }
        dependencyKeys.add(key);
      }
      const refs = new Set(
        gameRefs.flatMap((ref) =>
          isObject(ref) &&
          typeof ref.packId === "string" &&
          typeof ref.version === "number"
            ? [`${ref.packId}\\u0000${ref.version}`]
            : [],
        ),
      );
      if (
        refs.size !== dependencyKeys.size ||
        [...refs].some((key) => !dependencyKeys.has(key))
      ) {
        problems.push(
          "v2 loreDependencies must exactly match game.lorebookRefs.",
        );
      }
      if (refs.size === 0) {
        problems.push("No-lore bundles must use save format v1.");
      }
    }
  }
  if (
    version === EXPORT_VERSION &&
    (gameRefs.length > 0 ||
      (isObject(session) &&
        ((Array.isArray(session.lorebookRefs) &&
          session.lorebookRefs.length > 0) ||
          (isObject(session.definitionSnapshot) &&
            Array.isArray(session.definitionSnapshot.lorebookRefs) &&
            session.definitionSnapshot.lorebookRefs.length > 0))))
  ) {
    problems.push("v1 bundles cannot contain lore-bound session dependencies.");
  }
  problems.push(...collectSessionDataProblems(raw));
  return problems;
}

function collectSessionDataProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
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
    (session.ai.provider !== "gemini" &&
      session.ai.provider !== "openrouter" &&
      session.ai.provider !== "custom")
  ) {
    problems.push(
      "Session harus memiliki ai.provider gemini, openrouter, atau custom.",
    );
  }
  if (isObject(session.ai)) {
    try {
      normalizeNarratorSystemPrompt(session.ai.systemPrompt);
    } catch (error) {
      problems.push(
        error instanceof Error
          ? error.message
          : "System prompt narrator tidak valid.",
      );
    }
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
  loreDependencies?: LoreDependency[],
): ExportBundle {
  const game = pickGameDefinition(session.definitionSnapshot);
  const refs = game.lorebookRefs ?? [];
  const base: Pick<
    ExportBundle,
    "format" | "exportedAt" | "game" | "session" | "messages"
  > = {
    format: EXPORT_FORMAT,
    exportedAt,
    game,
    session: {
      id: session.id,
      gameId: session.gameId,
      definitionSnapshot: pickGameDefinition(session.definitionSnapshot),
      state: pickSessionState(session.state),
      ai: {
        provider: session.ai.provider,
        model: session.ai.model,
        systemPrompt: normalizeNarratorSystemPrompt(session.ai.systemPrompt),
      },
      nextSequence: session.nextSequence,
      updatedAt: session.updatedAt,
      ...(session.name === undefined ? {} : { name: session.name }),
      ...(session.pinned === undefined ? {} : { pinned: session.pinned }),
      ...(session.worldMap === undefined
        ? {}
        : { worldMap: structuredClone(session.worldMap) }),
      ...(session.lorebookRefs === undefined
        ? {}
        : { lorebookRefs: structuredClone(session.lorebookRefs) }),
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
      if (message.visibility !== undefined)
        next.visibility = message.visibility;
      if (message.knownBy !== undefined) next.knownBy = [...message.knownBy];
      if (message.check !== undefined) next.check = pickCheck(message.check);
      return next;
    }),
  };
  if (refs.length > 0) {
    const bundle: ExportBundle = {
      ...base,
      version: EXPORT_VERSION_WITH_LORE,
      loreDependencies: structuredClone(loreDependencies ?? []),
    };
    const problems = collectBundleProblems(bundle);
    if (problems.length > 0) throw new ImportError(problems);
    return bundle;
  }
  if (loreDependencies?.length) {
    throw new ImportError(["No-lore exports must use save format v1."]);
  }
  return { ...base, version: EXPORT_VERSION };
}

export function validateExportBundle(raw: unknown): {
  game: GameDefinition;
  session: GameSession;
  messages: Message[];
  loreDependencies?: LoreDependency[];
} {
  const problems = collectBundleProblems(raw);
  if (problems.length > 0) throw new ImportError(problems);
  const bundle = raw as ExportBundle;
  return {
    ...normalizeValidatedSessionData(bundle),
    ...(bundle.version === EXPORT_VERSION_WITH_LORE
      ? { loreDependencies: structuredClone(bundle.loreDependencies) }
      : {}),
  };
}

type SessionValidationData = Pick<
  ExportBundle,
  "game" | "session" | "messages"
>;

function normalizeValidatedSessionData(
  data: SessionValidationData,
): SessionValidationData {
  const game = pickGameDefinition(data.game);
  const definitionErrors = validateDefinition(game);
  if (definitionErrors.length > 0) throw new ImportError(definitionErrors);

  const sessionProblems = collectSessionProblems(
    game,
    data.session,
    data.messages,
  );
  if (sessionProblems.length > 0) throw new ImportError(sessionProblems);

  const messages = data.messages.map((message) => {
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
    if (message.visibility !== undefined) next.visibility = message.visibility;
    if (message.knownBy !== undefined) next.knownBy = [...message.knownBy];
    const check = pickCheck(message.check);
    if (check) next.check = check;
    return next;
  });

  return {
    game,
    session: {
      id: data.session.id,
      gameId: data.session.gameId,
      definitionSnapshot: pickGameDefinition(data.session.definitionSnapshot),
      state: pickSessionState(data.session.state),
      ai: {
        provider: data.session.ai.provider,
        model: data.session.ai.model,
        systemPrompt: normalizeNarratorSystemPrompt(
          data.session.ai.systemPrompt,
        ),
      },
      nextSequence: data.session.nextSequence,
      updatedAt: data.session.updatedAt,
      ...(data.session.name === undefined ? {} : { name: data.session.name }),
      ...(data.session.pinned === undefined
        ? {}
        : { pinned: data.session.pinned }),
      ...(data.session.worldMap === undefined
        ? {}
        : { worldMap: structuredClone(data.session.worldMap) }),
      ...(data.session.lorebookRefs === undefined
        ? {}
        : { lorebookRefs: structuredClone(data.session.lorebookRefs) }),
    },
    messages,
  };
}

export function validateSessionSnapshot(raw: unknown): SessionValidationData {
  if (!isObject(raw)) throw new ImportError(["File bukan JSON object."]);
  if (hasDangerousKeysDeep(raw)) {
    throw new ImportError(["File mengandung key berbahaya."]);
  }
  const problems = collectSessionDataProblems(raw);
  if (problems.length > 0) throw new ImportError(problems);
  return normalizeValidatedSessionData(raw as SessionValidationData);
}
