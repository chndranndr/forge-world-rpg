import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { buildInitialState } from "../shared/engine.js";
import {
  createExportBundle,
  validateExportBundle,
} from "../shared/validation.js";
import type {
  ExportBundle,
  GameDefinition,
  GameSession,
  Message,
} from "../shared/types.js";

export { buildInitialState } from "../shared/engine.js";
export {
  ImportError,
  hasDangerousKeysDeep,
  pickGameDefinition,
  validateDefinition,
  validateDefinitionUpdate,
  validatePlayability,
} from "../shared/validation.js";
export {
  acquireWriteLock,
  releaseWriteLock,
  requestPersistence,
} from "../shared/browser-storage.js";
export type {
  PersistenceStatus,
  WriteLockStatus,
} from "../shared/browser-storage.js";
interface FworldDB extends DBSchema {
  games: {
    key: string;
    value: GameDefinition;
  };
  sessions: {
    key: string;
    value: GameSession;
    indexes: { "by-game": string };
  };
  messages: {
    key: string;
    value: Message;
    indexes: { "by-session-seq": [string, number] };
  };
}

const DB_NAME = "fworld";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FworldDB>> | undefined;

export function getDb(): Promise<IDBPDatabase<FworldDB>> {
  dbPromise ??= openDB<FworldDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore("games", { keyPath: "id" });
      const sessions = db.createObjectStore("sessions", { keyPath: "id" });
      sessions.createIndex("by-game", "gameId");
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("by-session-seq", ["sessionId", "sequence"]);
    },
  });
  return dbPromise;
}

export async function saveGame(game: GameDefinition): Promise<void> {
  const db = await getDb();
  await db.put("games", game);
}

export async function getGame(id: string): Promise<GameDefinition | undefined> {
  const db = await getDb();
  return db.get("games", id);
}

export async function listGames(): Promise<GameDefinition[]> {
  const db = await getDb();
  return db.getAll("games");
}

export async function deleteGame(id: string): Promise<void> {
  const sessions = await listSessions(id);
  if (sessions.length > 0) {
    throw new Error("Game masih memiliki session berjalan.");
  }
  const db = await getDb();
  await db.delete("games", id);
}

export async function getSession(id: string): Promise<GameSession | undefined> {
  const db = await getDb();
  return db.get("sessions", id);
}

export async function listSessions(gameId: string): Promise<GameSession[]> {
  const db = await getDb();
  return db.getAllFromIndex("sessions", "by-game", gameId);
}

export async function getHistory(sessionId: string): Promise<Message[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound(
    [sessionId, 0],
    [sessionId, Number.MAX_SAFE_INTEGER],
  );
  return db.getAllFromIndex("messages", "by-session-seq", range);
}

export interface LegacySnapshot {
  format: "fworld-legacy-migration";
  version: 1;
  games: GameDefinition[];
  sessions: GameSession[];
  messages: Message[];
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB read failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB read aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB read failed."));
  });
}

async function openExistingDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) {
    throw new Error("Browser cannot inspect the legacy database safely.");
  }
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === DB_NAME)) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      // The database may have been removed after enumeration. Abort the
      // implicit create rather than changing its version or stores.
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Legacy database could not be opened."),
      );
  });
}

export async function readLegacySnapshot(): Promise<LegacySnapshot> {
  const db = await openExistingDb();
  if (!db) {
    return {
      format: "fworld-legacy-migration",
      version: 1,
      games: [],
      sessions: [],
      messages: [],
    };
  }

  try {
    const tx = db.transaction(["games", "sessions", "messages"], "readonly");
    const done = transactionDone(tx);
    try {
      const [games, sessions, messages] = await Promise.all([
        requestValue(tx.objectStore("games").getAll()),
        requestValue(tx.objectStore("sessions").getAll()),
        requestValue(tx.objectStore("messages").getAll()),
      ]);
      await done;
      return {
        format: "fworld-legacy-migration",
        version: 1,
        games,
        sessions,
        messages,
      };
    } catch (error) {
      await done.catch(() => {});
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function saveTurn(
  session: GameSession,
  messages: Message[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["sessions", "messages"], "readwrite");
  try {
    await tx.objectStore("sessions").put(session);
    for (const message of messages) {
      await tx.objectStore("messages").put(message);
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Transaction sudah berakhir; error asli yang dilempar.
    }
    await tx.done.catch(() => {});
    throw err;
  }
}

export async function createSession(
  game: GameDefinition,
  ai: GameSession["ai"],
): Promise<GameSession> {
  const now = new Date().toISOString();
  const snapshot: GameDefinition = structuredClone(game);
  const session: GameSession = {
    id: crypto.randomUUID(),
    gameId: game.id,
    definitionSnapshot: snapshot,
    state: buildInitialState(snapshot),
    ai,
    nextSequence: 0,
    updatedAt: now,
  };
  const db = await getDb();
  await db.put("sessions", session);
  return session;
}

export async function exportBundle(sessionId: string): Promise<ExportBundle> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session tidak ditemukan.");
  const messages = await getHistory(sessionId);
  return createExportBundle(session, messages, new Date().toISOString());
}

export async function importBundle(
  raw: unknown,
): Promise<{ gameId: string; sessionId: string }> {
  const prepared = validateExportBundle(raw);
  const sessionId = crypto.randomUUID();
  const messages = prepared.messages.map((message) => ({
    ...message,
    id: crypto.randomUUID(),
    sessionId,
  }));
  const gameId = crypto.randomUUID();
  const newGame: GameDefinition = { ...prepared.game, id: gameId };
  const newSession: GameSession = {
    ...prepared.session,
    id: sessionId,
    gameId,
    definitionSnapshot: { ...prepared.game, id: gameId },
    updatedAt: new Date().toISOString(),
  };

  const db = await getDb();
  const tx = db.transaction(["games", "sessions", "messages"], "readwrite");
  await tx.objectStore("games").put(newGame);
  await tx.objectStore("sessions").put(newSession);
  for (const message of messages) {
    await tx.objectStore("messages").put(message);
  }
  await tx.done;
  return { gameId, sessionId };
}
export async function applyDefinitionUpdate(
  newGame: GameDefinition,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["games", "sessions"], "readwrite");
  try {
    await tx.objectStore("games").put(newGame);
    const sessionStore = tx.objectStore("sessions");
    const sessions: GameSession[] = await sessionStore
      .index("by-game")
      .getAll(newGame.id);
    const now = new Date().toISOString();
    for (const session of sessions) {
      session.definitionSnapshot = structuredClone(newGame);
      session.updatedAt = now;
      await sessionStore.put(session);
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Transaction sudah berakhir; error asli yang dilempar.
    }
    await tx.done.catch(() => {});
    throw err;
  }
}

export async function updateSessionAi(
  sessionId: string,
  ai: { provider: "gemini" | "openrouter"; model: string },
): Promise<GameSession> {
  const db = await getDb();
  const session = await db.get("sessions", sessionId);
  if (!session) throw new Error("Session tidak ditemukan.");
  const next: GameSession = {
    ...session,
    ai,
    updatedAt: new Date().toISOString(),
  };
  await db.put("sessions", next);
  return next;
}
