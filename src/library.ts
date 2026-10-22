import type { GameRecord, SessionSummaryRecord } from "./api";
import type { GameDefinition } from "./types";

export interface GameEntry {
  game: GameRecord;
  sessions: SessionSummaryRecord[];
}

export function displaySessions(entry: GameEntry): SessionSummaryRecord[] {
  return [...entry.sessions].sort((a, b) => {
    const pinOrder =
      Number(b.value.pinned === true) - Number(a.value.pinned === true);
    if (pinOrder) return pinOrder;
    if (a.value.updatedAt !== b.value.updatedAt) {
      return a.value.updatedAt < b.value.updatedAt ? 1 : -1;
    }
    return a.value.id.localeCompare(b.value.id);
  });
}

export function sortedSessions(entry: GameEntry): SessionSummaryRecord[] {
  return [...entry.sessions].sort((a, b) =>
    a.value.updatedAt < b.value.updatedAt ? 1 : -1,
  );
}

export function latestSession(
  entry: GameEntry,
): SessionSummaryRecord | undefined {
  return sortedSessions(entry)[0];
}

export function lastActivity(entry: GameEntry): string {
  return latestSession(entry)?.value.updatedAt ?? entry.game.value.updatedAt;
}

export function sortByActivity(entries: GameEntry[]): GameEntry[] {
  return [...entries].sort((a, b) =>
    lastActivity(a) < lastActivity(b) ? 1 : -1,
  );
}

export function latestOverall(
  entries: GameEntry[],
): { game: GameRecord; session: SessionSummaryRecord } | undefined {
  return entries
    .flatMap((entry) => {
      const session = latestSession(entry);
      return session ? [{ game: entry.game, session }] : [];
    })
    .sort((a, b) =>
      a.session.value.updatedAt < b.session.value.updatedAt ? 1 : -1,
    )[0];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const dateFormatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" });

export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diff = now - time;
  if (diff < MINUTE) return "baru saja";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} menit lalu`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} jam lalu`;
  if (diff < 2 * DAY) return "kemarin";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} hari lalu`;
  return dateFormatter.format(new Date(time));
}

const COVER_IDS = [
  "coast",
  "lantern",
  "archive",
  "desert",
  "mountain",
  "rain",
] as const;

export type CoverId = (typeof COVER_IDS)[number];

function coverIdForText(text: string): CoverId | undefined {
  if (
    text.includes("fantasi") ||
    text.includes("fantasy") ||
    text.includes("forest") ||
    text.includes("hutan") ||
    text.includes("lentera") ||
    text.includes("lantern")
  ) {
    return "lantern";
  }
  if (
    text.includes("drama") ||
    text.includes("archive") ||
    text.includes("arsip")
  ) {
    return "archive";
  }
  if (
    text.includes("misteri") ||
    text.includes("mystery") ||
    text.includes("coast") ||
    text.includes("pesisir") ||
    text.includes("pantai")
  ) {
    return "coast";
  }
  if (
    text.includes("mountain") ||
    text.includes("gunung") ||
    text.includes("pegunungan")
  ) {
    return "mountain";
  }
  if (
    text.includes("desert") ||
    text.includes("gurun") ||
    text.includes("pasir")
  ) {
    return "desert";
  }
  if (text.includes("rain") || text.includes("hujan")) return "rain";
  return undefined;
}

export function coverIdFor(
  game: Pick<GameDefinition, "genre" | "title">,
): CoverId {
  const genreCover = coverIdForText((game.genre ?? "").toLocaleLowerCase("id"));
  if (genreCover !== undefined) return genreCover;

  const titleCover = coverIdForText(game.title.toLocaleLowerCase("id"));
  if (titleCover !== undefined) return titleCover;

  let hash = 7;
  for (const character of game.title) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 9973;
  }
  return COVER_IDS[hash % COVER_IDS.length];
}
