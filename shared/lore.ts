import {
  LOREBOOK_FORMAT,
  LOREBOOK_VERSION,
  type LoreKind,
  type LoreLinkRelation,
  type LorebookPack,
} from "./types.js";

export const MAX_LOREBOOK_BYTES = 8 * 1024 * 1024;
export const MAX_LOREBOOK_ENTRIES = 5_000;
export const MAX_LOREBOOK_LINKS = 20_000;
export const MAX_LORE_SUMMARY_CHARS = 2_000;
export const MAX_LORE_BODY_CHARS = 24_000;

const KINDS: Record<LoreKind, true> = {
  world: true,
  region: true,
  location: true,
  place: true,
  npc: true,
  faction: true,
  history: true,
  monster: true,
  item: true,
  activity: true,
  other: true,
};
const VISIBILITIES: Record<string, true> = {
  public: true,
  narrator: true,
  discovery: true,
};
const RELATIONS: Record<LoreLinkRelation, true> = {
  PARENT_OF: true,
  CONNECTED_TO: true,
  LOCATED_IN: true,
  PRESENT_AT: true,
  RELATED_TO: true,
};
const CANONS: Record<string, true> = {
  "anime-2004": true,
  game: true,
  manhwa: true,
  original: true,
  mixed: true,
};
const PACK_FIELDS = ["format", "version", "pack", "entries", "links"];
const PACK_HEADER_FIELDS = ["id", "version", "name", "description"];
const ENTRY_FIELDS = [
  "id",
  "kind",
  "name",
  "aliases",
  "parentId",
  "summary",
  "body",
  "tags",
  "visibility",
  "metadata",
  "provenance",
];
const METADATA_FIELDS = [
  "actorId",
  "itemId",
  "discoverAt",
  "discoveryKeywords",
  "requiredFlag",
  "blockedByFlag",
];
const PROVENANCE_FIELDS = [
  "sourceId",
  "sourceUrl",
  "license",
  "revision",
  "canon",
  "era",
];
const LINK_FIELDS = ["fromId", "toId", "relation"];
const EXECUTABLE_PROSE =
  /<\s*\/?\s*(?:script|iframe|object|embed|svg|math|form|input|button|style|meta|link)\b|\bon[a-z]{2,}\s*=|javascript\s*:|data\s*:\s*text\/html/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ENTRY_ID =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      problems.push(`${label} has unsupported field "${key}".`);
  }
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_IDENTIFIER.test(value) &&
    !isDangerousKey(value.toLowerCase())
  );
}

function isSafeEntryId(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_ENTRY_ID.test(value)) return false;
  return !value.split(":").some((part) => isDangerousKey(part.toLowerCase()));
}

function checkText(
  value: unknown,
  label: string,
  maxLength: number,
  problems: string[],
  required = true,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim())) {
    problems.push(`${label} must be a non-empty string.`);
    return;
  }
  if (value.length > maxLength)
    problems.push(`${label} exceeds ${maxLength} characters.`);
  if (EXECUTABLE_PROSE.test(value)) {
    problems.push(`${label} contains executable HTML or script content.`);
  }
}

function checkStringList(
  value: unknown,
  label: string,
  maxEntries: number,
  maxLength: number,
  problems: string[],
  identifiers = false,
): void {
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array.`);
    return;
  }
  if (value.length > maxEntries)
    problems.push(`${label} exceeds ${maxEntries} entries.`);
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      problems.push(`${label}[${index}] must be a non-empty string.`);
      return;
    }
    if (entry.length > maxLength)
      problems.push(`${label}[${index}] exceeds ${maxLength} characters.`);
    if (identifiers && !isSafeEntryId(entry)) {
      problems.push(`${label}[${index}] is not a safe namespaced ID.`);
    }
    if (EXECUTABLE_PROSE.test(entry)) {
      problems.push(
        `${label}[${index}] contains executable HTML or script content.`,
      );
    }
    const normalized = entry.trim().toLocaleLowerCase("en-US");
    if (seen.has(normalized)) problems.push(`${label} contains duplicates.`);
    seen.add(normalized);
  });
}

function validateParentGraph(
  entries: unknown[],
  links: unknown[],
  entryIds: Set<string>,
  problems: string[],
): void {
  const children = new Map<string, string[]>();
  const indegree = new Map([...entryIds].map((id) => [id, 0]));
  const entryById = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (
      isObject(entry) &&
      typeof entry.id === "string" &&
      entryIds.has(entry.id)
    ) {
      entryById.set(entry.id, entry);
    }
  }
  const addParentEdge = (parentId: string, childId: string) => {
    const descendants = children.get(parentId) ?? [];
    descendants.push(childId);
    children.set(parentId, descendants);
    indegree.set(childId, (indegree.get(childId) ?? 0) + 1);
  };

  for (const [index, raw] of entries.entries()) {
    if (!isObject(raw) || typeof raw.id !== "string" || !entryIds.has(raw.id))
      continue;
    if (raw.parentId === undefined) continue;
    if (!isSafeEntryId(raw.parentId) || !entryIds.has(raw.parentId)) {
      problems.push(`entries[${index}].parentId references an unknown entry.`);
    } else {
      addParentEdge(raw.parentId, raw.id);
    }
  }
  for (const [index, raw] of links.entries()) {
    if (!isObject(raw) || raw.relation !== "PARENT_OF") continue;
    if (
      typeof raw.fromId !== "string" ||
      typeof raw.toId !== "string" ||
      !entryIds.has(raw.fromId) ||
      !entryIds.has(raw.toId)
    ) {
      continue;
    }
    addParentEdge(raw.fromId, raw.toId);
    const child = entryById.get(raw.toId);
    if (child?.parentId !== undefined && child.parentId !== raw.fromId) {
      problems.push(`links[${index}] conflicts with the child's parentId.`);
    }
  }

  const roots = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < roots.length; cursor += 1) {
    const id = roots[cursor];
    visited += 1;
    for (const child of children.get(id) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) roots.push(child);
    }
  }
  if (visited !== entryIds.size) {
    problems.push("Lorebook parent relationships must not contain cycles.");
  }
}

export class LorebookValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid lorebook pack: ${problems.join(" ")}`);
    this.name = "LorebookValidationError";
  }
}

export function validateLorebookPack(raw: unknown): string[] {
  const problems: string[] = [];
  if (hasDangerousKeysDeep(raw)) {
    return ["Lorebook contains a dangerous key or cyclic object reference."];
  }
  if (!isObject(raw)) return ["Lorebook pack must be an object."];
  checkKeys(raw, PACK_FIELDS, "Lorebook", problems);
  if (raw.format !== LOREBOOK_FORMAT)
    problems.push(`format must be ${LOREBOOK_FORMAT}.`);
  if (raw.version !== LOREBOOK_VERSION)
    problems.push(`format version must be ${LOREBOOK_VERSION}.`);

  const header = raw.pack;
  if (!isObject(header)) {
    problems.push("pack must be an object.");
  } else {
    checkKeys(header, PACK_HEADER_FIELDS, "pack", problems);
    if (!isSafeIdentifier(header.id))
      problems.push("pack.id is unsafe or invalid.");
    if (
      typeof header.version !== "number" ||
      !Number.isSafeInteger(header.version) ||
      header.version < 1
    ) {
      problems.push("pack.version must be a positive safe integer.");
    }
    checkText(header.name, "pack.name", 200, problems);
    checkText(header.description, "pack.description", 2_000, problems, false);
  }

  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  if (!Array.isArray(raw.entries)) problems.push("entries must be an array.");
  if (entries.length > MAX_LOREBOOK_ENTRIES) {
    problems.push(`entries exceeds ${MAX_LOREBOOK_ENTRIES} records.`);
  }
  const entryIds = new Set<string>();
  entries.forEach((value, index) => {
    const label = `entries[${index}]`;
    if (!isObject(value)) {
      problems.push(`${label} must be an object.`);
      return;
    }
    checkKeys(value, ENTRY_FIELDS, label, problems);
    if (!isSafeEntryId(value.id)) {
      problems.push(`${label}.id must be a safe namespaced ID.`);
    } else if (entryIds.has(value.id)) {
      problems.push(`${label}.id duplicates ${value.id}.`);
    } else {
      entryIds.add(value.id);
    }
    if (typeof value.kind !== "string" || !Object.hasOwn(KINDS, value.kind)) {
      problems.push(`${label}.kind is not a supported lore kind.`);
    }
    checkText(value.name, `${label}.name`, 200, problems);
    checkStringList(value.aliases, `${label}.aliases`, 32, 200, problems);
    if (value.parentId !== undefined && !isSafeEntryId(value.parentId)) {
      problems.push(`${label}.parentId must be a safe namespaced ID.`);
    }
    checkText(
      value.summary,
      `${label}.summary`,
      MAX_LORE_SUMMARY_CHARS,
      problems,
    );
    checkText(value.body, `${label}.body`, MAX_LORE_BODY_CHARS, problems);
    checkStringList(value.tags, `${label}.tags`, 32, 100, problems);
    if (
      typeof value.visibility !== "string" ||
      !Object.hasOwn(VISIBILITIES, value.visibility)
    ) {
      problems.push(`${label}.visibility is invalid.`);
    }

    const metadata = value.metadata;
    if (!isObject(metadata)) {
      problems.push(`${label}.metadata must be an object.`);
    } else {
      checkKeys(metadata, METADATA_FIELDS, `${label}.metadata`, problems);
      for (const field of [
        "actorId",
        "itemId",
        "requiredFlag",
        "blockedByFlag",
      ] as const) {
        const id = metadata[field];
        if (id !== undefined && !isSafeIdentifier(id)) {
          problems.push(`${label}.metadata.${field} is unsafe or invalid.`);
        }
      }
      if (metadata.discoverAt !== undefined) {
        checkStringList(
          metadata.discoverAt,
          `${label}.metadata.discoverAt`,
          64,
          160,
          problems,
          true,
        );
      }
      if (metadata.discoveryKeywords !== undefined) {
        checkStringList(
          metadata.discoveryKeywords,
          `${label}.metadata.discoveryKeywords`,
          64,
          120,
          problems,
        );
      }
    }

    const provenance = value.provenance;
    if (!isObject(provenance)) {
      problems.push(`${label}.provenance must be an object.`);
    } else {
      checkKeys(provenance, PROVENANCE_FIELDS, `${label}.provenance`, problems);
      checkText(
        provenance.sourceId,
        `${label}.provenance.sourceId`,
        200,
        problems,
      );
      for (const field of ["license", "revision", "era"] as const) {
        checkText(
          provenance[field],
          `${label}.provenance.${field}`,
          500,
          problems,
          false,
        );
      }
      if (provenance.sourceUrl !== undefined) {
        checkText(
          provenance.sourceUrl,
          `${label}.provenance.sourceUrl`,
          2_048,
          problems,
        );
        if (typeof provenance.sourceUrl === "string") {
          try {
            const url = new URL(provenance.sourceUrl);
            if (
              (url.protocol !== "https:" && url.protocol !== "http:") ||
              url.username ||
              url.password
            ) {
              problems.push(
                `${label}.provenance.sourceUrl must be an HTTP(S) URL without credentials.`,
              );
            }
          } catch {
            problems.push(
              `${label}.provenance.sourceUrl must be an absolute HTTP(S) URL.`,
            );
          }
        }
      }
      if (
        provenance.canon !== undefined &&
        (typeof provenance.canon !== "string" ||
          !Object.hasOwn(CANONS, provenance.canon))
      ) {
        problems.push(`${label}.provenance.canon is invalid.`);
      }
    }
  });

  const links = Array.isArray(raw.links) ? raw.links : [];
  if (!Array.isArray(raw.links)) problems.push("links must be an array.");
  if (links.length > MAX_LOREBOOK_LINKS) {
    problems.push(`links exceeds ${MAX_LOREBOOK_LINKS} records.`);
  }
  const linkKeys = new Set<string>();
  links.forEach((value, index) => {
    const label = `links[${index}]`;
    if (!isObject(value)) {
      problems.push(`${label} must be an object.`);
      return;
    }
    checkKeys(value, LINK_FIELDS, label, problems);
    if (!isSafeEntryId(value.fromId) || !entryIds.has(value.fromId)) {
      problems.push(`${label}.fromId references an unknown or unsafe entry.`);
    }
    if (!isSafeEntryId(value.toId) || !entryIds.has(value.toId)) {
      problems.push(`${label}.toId references an unknown or unsafe entry.`);
    }
    if (value.fromId === value.toId)
      problems.push(`${label} cannot link an entry to itself.`);
    if (
      typeof value.relation !== "string" ||
      !Object.hasOwn(RELATIONS, value.relation)
    ) {
      problems.push(`${label}.relation is invalid.`);
    }
    if (
      typeof value.fromId === "string" &&
      typeof value.toId === "string" &&
      typeof value.relation === "string" &&
      Object.hasOwn(RELATIONS, value.relation)
    ) {
      const [fromId, toId] =
        value.relation === "CONNECTED_TO" && value.fromId > value.toId
          ? [value.toId, value.fromId]
          : [value.fromId, value.toId];
      const key = `${value.relation}\u0000${fromId}\u0000${toId}`;
      if (linkKeys.has(key))
        problems.push(`${label} duplicates an existing link.`);
      linkKeys.add(key);
    }
  });
  validateParentGraph(entries, links, entryIds, problems);

  try {
    const serialized = JSON.stringify(raw);
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).byteLength > MAX_LOREBOOK_BYTES
    ) {
      problems.push(`Lorebook exceeds ${MAX_LOREBOOK_BYTES} bytes.`);
    }
  } catch {
    problems.push("Lorebook must be JSON-serializable.");
  }
  return problems;
}

export function parseLorebookPack(raw: unknown): LorebookPack {
  const problems = validateLorebookPack(raw);
  if (problems.length > 0) throw new LorebookValidationError(problems);
  return structuredClone(raw) as LorebookPack;
}
