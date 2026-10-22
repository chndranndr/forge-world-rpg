import type {
  LoreEntry,
  Message,
  StorySummary,
  WorldMap,
} from "../../shared/types.js";
import { resolveMovement } from "../../shared/world.js";
import type { MovementCandidate } from "../../shared/world.js";
import type { GameDatabase, StoredSession } from "../db.js";
import { selectPrincipalNpc } from "./context.js";
import type { NarratorRunKind } from "./context.js";

export interface MemoryHit {
  kind: "fact" | "message";
  id: string;
  text: string;
  source?: "config" | "story";
  visibility?: "public" | "private";
  knownBy?: string[];
  turnId?: string;
  sequence?: number;
  role?: Message["role"];
  speakerId?: string;
  createdAt: string;
}

export interface MemorySearchOptions {
  npcId?: string;
  limit: number;
  maxChars: number;
  signal: AbortSignal;
}

export type MemorySearch = (
  query: string,
  options: MemorySearchOptions,
) => Promise<MemoryHit[]>;

export interface NarratorKnowledge {
  history: Message[];
  worldMap?: WorldMap;
  movement?: MovementCandidate;
  principalNpcId?: string;
  lore: LoreEntry[];
  storySummaries: StorySummary[];
  searchMemory: MemorySearch;
}

export function loadNarratorKnowledge(input: {
  db: GameDatabase;
  session: StoredSession;
  kind: NarratorRunKind;
  playerAction: string;
}): NarratorKnowledge {
  const { db, session, kind, playerAction } = input;
  const worldMap = db.getWorldMap(session);
  const movement =
    kind === "turn"
      ? resolveMovement(worldMap, session.state.world, playerAction)
      : undefined;
  const principalNpcId =
    kind === "turn"
      ? selectPrincipalNpc(session, playerAction, worldMap)
      : undefined;
  const history = db.getRecentHistory(session.id, 24, principalNpcId);
  const loreRefs =
    session.lorebookRefs ?? session.definitionSnapshot.lorebookRefs ?? [];
  const locationId =
    movement?.kind === "allowed"
      ? movement.toId
      : session.state.world.locationId;
  const discoveredLoreIds = session.state.world.discoveredLoreIds ?? [];
  const asksHistory =
    /\b(?:history|historical|past|sejarah|masa lalu|latar belakang)\b/iu.test(
      playerAction,
    );
  const loreOptions = {
    ...(worldMap && locationId ? { locationId } : {}),
    ...(kind === "turn" && playerAction ? { query: playerAction } : {}),
    discoveredLoreIds,
    limit: kind === "turn" ? 18 : 10,
  };
  const retrievedLore = loreRefs.length
    ? kind === "turn" && worldMap
      ? db.retrieveLoreForTurn(loreRefs, loreOptions)
      : db.retrieveLore(loreRefs, { ...loreOptions, narrator: true })
    : [];
  const loreEntries = retrievedLore.filter(
    (entry) =>
      (asksHistory || entry.kind !== "history") &&
      (entry.visibility !== "discovery" ||
        discoveredLoreIds.includes(entry.id) ||
        !entry.metadata.actorId ||
        entry.metadata.actorId === principalNpcId),
  );
  const storySummaries =
    kind === "opening"
      ? []
      : db.getStorySummaries(session.id, {
          ...(principalNpcId ? { npcId: principalNpcId } : {}),
          ...(kind === "turn" && playerAction ? { query: playerAction } : {}),
          limit: 8,
        });
  const searchMemory: MemorySearch = async (query, options) => {
    options.signal.throwIfAborted();
    return db
      .searchMemory(session.id, query, options.npcId)
      .map(({ excerpt, ...hit }) => ({ ...hit, text: excerpt }));
  };
  return {
    history,
    ...(worldMap ? { worldMap } : {}),
    ...(movement ? { movement } : {}),
    ...(principalNpcId ? { principalNpcId } : {}),
    lore: loreEntries,
    storySummaries,
    searchMemory,
  };
}
