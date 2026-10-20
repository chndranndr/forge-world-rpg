import {
  PLAYER_ID,
  type WorldLocation,
  type WorldMap,
  type WorldState,
} from "./types.js";

const MAP_FIELDS = ["locations", "connections", "flags"];
const LOCATION_FIELDS = [
  "id",
  "name",
  "aliases",
  "summary",
  "parentId",
  "npcIds",
  "requiredFlag",
];
const CONNECTION_FIELDS = ["fromId", "toId", "blockedByFlag"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRAVEL_INTENT =
  /\b(?:pergi|berangkat|menuju|pindah|tiba|travel|go|head|move|walk|arrive)\b/giu;
const ORIGIN_PREPOSITION = /(?:\bfrom|\bdari)\s*$/iu;

export type MovementCandidate =
  | { kind: "legacy" }
  | { kind: "none" }
  | { kind: "allowed"; fromId: string; toId: string }
  | { kind: "blocked"; fromId?: string; toId: string; reason: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "unknown"; fromId?: string; reason: string };

export class WorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function hasDangerousKeysDeep(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return true;
    seen.add(value);
    const found = value.some((entry) => hasDangerousKeysDeep(entry, seen));
    seen.delete(value);
    return found;
  }
  if (!isObject(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const found = Object.keys(value).some(
    (key) => isDangerousKey(key) || hasDangerousKeysDeep(value[key], seen),
  );
  seen.delete(value);
  return found;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_ID.test(value) &&
    !isDangerousKey(value.toLowerCase())
  );
}

function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}_]$/u.test(value);
}

interface LocationMention {
  location: WorldLocation;
  start: number;
  end: number;
  aliasLength: number;
}

function mentionsIn(map: WorldMap, text: string): LocationMention[] {
  const normalized = normalizeAlias(text);
  const mentions: LocationMention[] = [];
  for (const location of map.locations) {
    const aliases = new Set(
      [location.id, location.name, ...location.aliases].map(normalizeAlias),
    );
    for (const alias of aliases) {
      if (!alias) continue;
      let offset = 0;
      while (offset < normalized.length) {
        const start = normalized.indexOf(alias, offset);
        if (start < 0) break;
        const end = start + alias.length;
        if (
          !isWordCharacter(normalized[start - 1]) &&
          !isWordCharacter(normalized[end])
        ) {
          mentions.push({ location, start, end, aliasLength: alias.length });
        }
        offset = start + 1;
      }
    }
  }
  return mentions;
}

function uniqueLongestMentions(mentions: LocationMention[]): LocationMention[] {
  if (mentions.length === 0) return [];
  const longest = Math.max(...mentions.map(({ aliasLength }) => aliasLength));
  const ids = new Set<string>();
  return mentions
    .filter((mention) => mention.aliasLength === longest)
    .filter((mention) => {
      if (ids.has(mention.location.id)) return false;
      ids.add(mention.location.id);
      return true;
    });
}

function validateStringList(
  value: unknown,
  label: string,
  errors: string[],
  options: { max: number; ids?: boolean; maxLength?: number },
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  if (value.length > options.max) errors.push(`${label} has too many entries.`);
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== "string" ||
      !entry.trim() ||
      entry.length > (options.maxLength ?? 200)
    ) {
      errors.push(`${label}[${index}] must be a bounded non-empty string.`);
      continue;
    }
    if (options.ids && !isSafeId(entry))
      errors.push(`${label}[${index}] is an unsafe ID.`);
    const normalized = normalizeAlias(entry);
    if (seen.has(normalized)) errors.push(`${label} contains duplicates.`);
    seen.add(normalized);
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function validateWorldMap(map: unknown, npcIds?: string[]): string[] {
  const errors: string[] = [];
  if (hasDangerousKeysDeep(map))
    return ["World map contains a dangerous key or cycle."];
  if (!isObject(map)) return ["worldMap must be an object."];
  if (!hasOnlyKeys(map, MAP_FIELDS))
    errors.push("worldMap contains unsupported fields.");
  if (!Array.isArray(map.locations))
    errors.push("worldMap.locations must be an array.");
  if (!Array.isArray(map.connections))
    errors.push("worldMap.connections must be an array.");
  if (map.flags !== undefined && !isObject(map.flags))
    errors.push("worldMap.flags must be an object.");
  if (
    errors.length > 0 &&
    (!Array.isArray(map.locations) || !Array.isArray(map.connections))
  ) {
    return errors;
  }

  const locations = Array.isArray(map.locations) ? map.locations : [];
  const connections = Array.isArray(map.connections) ? map.connections : [];
  if (locations.length === 0)
    errors.push("worldMap.locations must contain at least one location.");
  if (locations.length > 10_000)
    errors.push("worldMap.locations exceeds 10000 entries.");
  if (connections.length > 20_000)
    errors.push("worldMap.connections exceeds 20000 entries.");
  const flags = isObject(map.flags) ? map.flags : {};
  const flagIds = new Set<string>();
  for (const [id, value] of Object.entries(flags)) {
    if (!isSafeId(id)) errors.push(`worldMap.flags key "${id}" is unsafe.`);
    if (typeof value !== "boolean")
      errors.push(`worldMap.flags[${id}] must be boolean.`);
    flagIds.add(id);
  }

  const knownNpcIds = npcIds ? new Set(npcIds) : undefined;
  const locationIds = new Set<string>();
  const parents = new Map<string, string>();
  locations.forEach((value, index) => {
    const label = `worldMap.locations[${index}]`;
    if (!isObject(value)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (!hasOnlyKeys(value, LOCATION_FIELDS))
      errors.push(`${label} contains unsupported fields.`);
    if (!isSafeId(value.id)) {
      errors.push(`${label}.id is unsafe or invalid.`);
    } else if (locationIds.has(value.id)) {
      errors.push(`${label}.id duplicates ${value.id}.`);
    } else {
      locationIds.add(value.id);
    }
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 200
    ) {
      errors.push(`${label}.name must be a bounded non-empty string.`);
    }
    validateStringList(value.aliases, `${label}.aliases`, errors, { max: 64 });
    if (
      value.summary !== undefined &&
      (typeof value.summary !== "string" || value.summary.length > 2_000)
    ) {
      errors.push(
        `${label}.summary must be a string no longer than 2000 characters.`,
      );
    }
    if (value.parentId !== undefined) {
      if (!isSafeId(value.parentId))
        errors.push(`${label}.parentId is unsafe.`);
      else if (isSafeId(value.id)) parents.set(value.id, value.parentId);
    }
    const locationNpcIds = validateStringList(
      value.npcIds,
      `${label}.npcIds`,
      errors,
      {
        max: 1_000,
        ids: true,
        maxLength: 128,
      },
    );
    for (const npcId of locationNpcIds) {
      if (knownNpcIds && !knownNpcIds.has(npcId)) {
        errors.push(`${label}.npcIds references unknown NPC "${npcId}".`);
      }
    }
    if (value.requiredFlag !== undefined) {
      if (!isSafeId(value.requiredFlag))
        errors.push(`${label}.requiredFlag is unsafe.`);
      else if (!flagIds.has(value.requiredFlag))
        errors.push(`${label}.requiredFlag is not declared in worldMap.flags.`);
    }
  });

  for (const [index, value] of locations.entries()) {
    if (!isObject(value) || typeof value.id !== "string") continue;
    if (value.parentId === undefined) continue;
    if (!isSafeId(value.parentId) || !locationIds.has(value.parentId)) {
      errors.push(
        `worldMap.locations[${index}].parentId references an unknown location.`,
      );
    }
  }
  const parentChildren = new Map<string, string[]>();
  const parentIndegree = new Map([...locationIds].map((id) => [id, 0]));
  for (const [childId, parentId] of parents) {
    const children = parentChildren.get(parentId) ?? [];
    children.push(childId);
    parentChildren.set(parentId, children);
    parentIndegree.set(childId, (parentIndegree.get(childId) ?? 0) + 1);
  }
  const roots = [...parentIndegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < roots.length; cursor += 1) {
    const id = roots[cursor];
    visited += 1;
    for (const child of parentChildren.get(id) ?? []) {
      const degree = (parentIndegree.get(child) ?? 0) - 1;
      parentIndegree.set(child, degree);
      if (degree === 0) roots.push(child);
    }
  }
  if (visited !== locationIds.size)
    errors.push("worldMap location parents must not contain cycles.");

  const edges = new Set<string>();
  connections.forEach((value, index) => {
    const label = `worldMap.connections[${index}]`;
    if (!isObject(value)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (!hasOnlyKeys(value, CONNECTION_FIELDS))
      errors.push(`${label} contains unsupported fields.`);
    if (!isSafeId(value.fromId) || !locationIds.has(value.fromId)) {
      errors.push(`${label}.fromId references an unknown location.`);
    }
    if (!isSafeId(value.toId) || !locationIds.has(value.toId)) {
      errors.push(`${label}.toId references an unknown location.`);
    }
    if (value.fromId === value.toId)
      errors.push(`${label} cannot connect a location to itself.`);
    if (value.blockedByFlag !== undefined) {
      if (!isSafeId(value.blockedByFlag))
        errors.push(`${label}.blockedByFlag is unsafe.`);
      else if (!flagIds.has(value.blockedByFlag))
        errors.push(
          `${label}.blockedByFlag is not declared in worldMap.flags.`,
        );
    }
    if (typeof value.fromId === "string" && typeof value.toId === "string") {
      const pair = [value.fromId, value.toId].sort();
      const key = `${pair[0]}\u0000${pair[1]}`;
      if (edges.has(key))
        errors.push(`${label} duplicates an undirected connection.`);
      edges.add(key);
    }
  });
  return errors;
}

export function parseWorldMap(raw: unknown, npcIds?: string[]): WorldMap {
  const problems = validateWorldMap(raw, npcIds);
  if (problems.length > 0) throw new WorldError(problems.join(" "));
  return structuredClone(raw) as WorldMap;
}

export function resolveLocation(
  map: WorldMap,
  input: string,
):
  | { kind: "found"; location: WorldLocation }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "unknown" } {
  const normalized = normalizeAlias(input);
  const exact = map.locations.filter((location) =>
    [location.id, location.name, ...location.aliases].some(
      (alias) => normalizeAlias(alias) === normalized,
    ),
  );
  const exactIds = [...new Set(exact.map(({ id }) => id))];
  if (exactIds.length === 1) {
    const location = map.locations.find(({ id }) => id === exactIds[0]);
    if (location) return { kind: "found", location };
  }
  if (exactIds.length > 1) return { kind: "ambiguous", ids: exactIds.sort() };

  const matches = uniqueLongestMentions(mentionsIn(map, input));
  if (matches.length === 1)
    return { kind: "found", location: matches[0].location };
  if (matches.length > 1)
    return {
      kind: "ambiguous",
      ids: matches.map(({ location }) => location.id).sort(),
    };
  return { kind: "unknown" };
}

export function resolveMovement(
  map: WorldMap | undefined,
  world: WorldState,
  action: string,
): MovementCandidate {
  if (!map) return { kind: "legacy" };
  TRAVEL_INTENT.lastIndex = 0;
  const intents = [...action.matchAll(TRAVEL_INTENT)];
  if (intents.length === 0) return { kind: "none" };
  const intent = intents.at(-1);
  if (!intent || intent.index === undefined) return { kind: "none" };
  const prefix = action.slice(0, intent.index);
  const lastClauseBoundary = [
    ...prefix.matchAll(
      /[.!?;]|\b(?:but|however|yet|instead|tapi|tetapi|namun|melainkan)\b/giu,
    ),
  ].at(-1);
  const clausePrefix = prefix.slice(
    lastClauseBoundary
      ? lastClauseBoundary.index + lastClauseBoundary[0].length
      : 0,
  );
  if (
    /(?:\bnot|\bnever|\bwon't|\bcannot|\bcan't|\bdon't|\bdont|\btidak|\bnggak|\bgak|\bjangan|\bbatal)\s+(?:jadi\s+)?(?:[\s\S]*\b(?:want|wish|plan|intend|mau|ingin)\b(?:[\s\S]*\bto\b)?)?\s*$/iu.test(
      clausePrefix,
    )
  ) {
    return { kind: "none" };
  }
  const suffix = normalizeAlias(action.slice(intent.index + intent[0].length));
  const targetMentions = mentionsIn(map, suffix).filter(
    (mention) => !ORIGIN_PREPOSITION.test(suffix.slice(0, mention.start)),
  );
  if (targetMentions.length === 0) {
    return {
      kind: "unknown",
      fromId: world.locationId,
      reason: "Travel action has no known destination.",
    };
  }
  const firstStart = Math.min(...targetMentions.map(({ start }) => start));
  const target = uniqueLongestMentions(
    targetMentions.filter(({ start }) => start === firstStart),
  );
  if (target.length > 1)
    return {
      kind: "ambiguous",
      ids: target.map(({ location }) => location.id).sort(),
    };
  const toId = target[0].location.id;
  const fromId = world.locationId;
  if (!fromId || !map.locations.some((location) => location.id === fromId)) {
    return {
      kind: "unknown",
      fromId,
      reason: "Current location is not known in the world map.",
    };
  }
  if (toId === fromId) return { kind: "none" };
  const destination = target[0].location;
  if (
    destination.requiredFlag &&
    world.flags?.[destination.requiredFlag] !== true
  ) {
    return {
      kind: "blocked",
      fromId,
      toId,
      reason: `Required flag "${destination.requiredFlag}" is not set.`,
    };
  }
  const connection = map.connections.find(
    (edge) =>
      (edge.fromId === fromId && edge.toId === toId) ||
      (edge.fromId === toId && edge.toId === fromId),
  );
  if (!connection) {
    return {
      kind: "unknown",
      fromId,
      reason: `No direct connection from ${fromId} to ${toId}.`,
    };
  }
  if (
    connection.blockedByFlag &&
    world.flags?.[connection.blockedByFlag] === true
  ) {
    return {
      kind: "blocked",
      fromId,
      toId,
      reason: `Travel is blocked by flag "${connection.blockedByFlag}".`,
    };
  }
  return { kind: "allowed", fromId, toId };
}

export function sceneParticipants(
  map: WorldMap | undefined,
  locationId: string | undefined,
  npcPresence: WorldState["npcPresence"],
  knownNpcIds: string[],
): string[] {
  if (!map) {
    const present: string[] = [];
    for (let index = knownNpcIds.length - 1; index >= 0; index -= 1) {
      const npcId = knownNpcIds[index];
      const presence = npcPresence?.[npcId];
      if (
        presence === "present" ||
        (typeof presence === "object" && presence.present !== false)
      ) {
        present.push(npcId);
      }
    }
    const presentIds = new Set(present);
    return [
      PLAYER_ID,
      ...present,
      ...knownNpcIds.filter((npcId) => !presentIds.has(npcId)),
    ];
  }
  const known = new Set(knownNpcIds);
  const location = map.locations.find((entry) => entry.id === locationId);
  const scoped: string[] = [];
  for (let index = knownNpcIds.length - 1; index >= 0; index -= 1) {
    const npcId = knownNpcIds[index];
    const presence = npcPresence?.[npcId];
    if (
      typeof presence === "object" &&
      presence.present !== false &&
      presence.locationId === locationId
    ) {
      scoped.push(npcId);
    }
  }
  const explicitlyPresent = knownNpcIds.filter(
    (npcId) => npcPresence?.[npcId] === "present",
  );
  const mapped = (location?.npcIds ?? []).filter(
    (npcId) => known.has(npcId) && npcPresence?.[npcId] === undefined,
  );
  const participants = new Set([...scoped, ...explicitlyPresent, ...mapped]);
  return [PLAYER_ID, ...[...participants].slice(0, 6)];
}

export function applyWorldProposal(
  map: WorldMap | undefined,
  prior: WorldState,
  candidate: MovementCandidate,
  proposal: {
    location?: string;
    locationId?: string;
    time?: string;
    scene?: string;
  },
  knownNpcIds: string[],
): WorldState {
  const next: WorldState = {
    ...prior,
    activeCharacters: [...prior.activeCharacters],
    ...(proposal.time === undefined ? {} : { time: proposal.time }),
    ...(proposal.scene === undefined ? {} : { scene: proposal.scene }),
  };
  if (!map) {
    if (proposal.location !== undefined) next.location = proposal.location;
    return next;
  }
  if (candidate.kind !== "allowed") return next;
  if (
    candidate.fromId !== prior.locationId ||
    !map.locations.some(({ id }) => id === candidate.fromId)
  ) {
    throw new WorldError(
      "Movement candidate does not match a mapped current location.",
    );
  }
  const destination = map.locations.find(({ id }) => id === candidate.toId);
  if (!destination) {
    throw new WorldError(
      `Movement destination "${candidate.toId}" is missing from the pinned world map.`,
    );
  }

  next.locationId = destination.id;
  next.location = destination.name;
  next.activeCharacters = sceneParticipants(
    map,
    destination.id,
    prior.npcPresence,
    knownNpcIds,
  );
  return next;
}
