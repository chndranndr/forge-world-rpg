import { createHash, randomUUID } from "node:crypto";
import { useItem as applyItem } from "../shared/engine.js";
import type { Message, SessionState } from "../shared/types.js";
import { runNarrator } from "./agent.js";
import { NarratorContextError, narratorParticipants } from "./agent/context.js";
import { ContextCacheError } from "./agent/gemini-cache.js";
import type { GeminiContextCache } from "./agent/gemini-cache.js";
import { loadNarratorKnowledge } from "./agent/knowledge.js";
import { NarratorResponseError } from "./agent/runtime.js";
import type { GameDatabase, RunKind, RunRecord, StoredSession } from "./db.js";

type NarratorKind = "turn" | "opening" | "choices";
type Work =
  | { kind: "turn"; input: string }
  | { kind: "opening" }
  | { kind: "choices" }
  | { kind: "item_use"; itemId: string };

const activeRuns = new Map<string, Promise<void>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashInput(
  kind: RunKind,
  expectedRevision: number,
  work: Work,
): string {
  return createHash("sha256")
    .update(canonical({ kind, expectedRevision, work }))
    .digest("hex");
}

interface StoredRunFailure {
  code: string;
  message: string;
  detail?: string;
  textSample?: string;
  responseBody?: string;
  errorName?: string;
  causeCode?: string;
  statusCode?: number;
}

// Provider errors are the only way to diagnose parse failures, so their text
// is stored, but API keys must never end up in the database or a backup.
const CREDENTIAL_PATTERN =
  /(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

function scrubbed(value: string, limit: number): string {
  return value.replace(CREDENTIAL_PATTERN, "[redacted]").slice(0, limit);
}

function errorForStorage(error: unknown): StoredRunFailure {
  if (error instanceof NarratorResponseError) {
    return {
      code: "AI_RESPONSE_INVALID",
      message: error.message,
      ...(error.detail ? { detail: error.detail.slice(0, 1_000) } : {}),
      ...(error.textSample ? { textSample: error.textSample } : {}),
    };
  }
  if (error instanceof NarratorContextError) {
    return { code: "CONTEXT_TOO_LARGE", message: error.message };
  }
  if (error instanceof ContextCacheError) {
    return { code: "CONTEXT_CACHE_UNAVAILABLE", message: error.message };
  }
  if (
    error instanceof Error &&
    (error.name === "EngineError" || error.name === "WorldError")
  ) {
    return { code: "INVALID_PROPOSAL", message: error.message.slice(0, 500) };
  }
  if (
    error instanceof Error &&
    /key belum dikonfigurasi/i.test(error.message)
  ) {
    return { code: "PROVIDER_NOT_CONFIGURED", message: error.message };
  }
  if (error instanceof Error && /profil ai/i.test(error.message)) {
    return { code: "AI_PROFILE_REQUIRED", message: error.message };
  }
  const message = error instanceof Error ? scrubbed(error.message, 300) : "";
  const body =
    error instanceof Error &&
    "responseBody" in error &&
    typeof error.responseBody === "string"
      ? scrubbed(error.responseBody, 800)
      : undefined;
  const details = {
    ...(message ? { detail: message } : {}),
    ...(body ? { responseBody: body } : {}),
    ...safeFailureDetails(error),
  };
  if (details.errorName === "AI_APICallError" && details.statusCode === 503) {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      message:
        "Provider AI sedang kelebihan beban atau tidak tersedia sementara (HTTP 503). Tunggu sebentar lalu coba lagi; jika tetap gagal, ganti model atau profil AI.",
      ...details,
    };
  }
  if (
    /PROHIBITED_CONTENT|blocked (?:the )?request|content policy/i.test(
      `${message} ${body}`,
    )
  ) {
    return {
      code: "AI_CONTENT_BLOCKED",
      message:
        "Provider menolak permintaan karena kebijakan konten. Ganti model atau profil AI, atau kurangi detail adegan, lalu coba lagi.",
      ...details,
    };
  }
  return {
    code: "RUN_FAILED",
    message:
      "Run gagal. Periksa koneksi, konfigurasi provider, dan log server.",
    ...details,
  };
}

function safeFailureDetails(error: unknown): {
  errorName: string;
  causeCode?: string;
  statusCode?: number;
} {
  const details: {
    errorName: string;
    causeCode?: string;
    statusCode?: number;
  } = {
    errorName:
      error instanceof Error && /^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
        ? error.name
        : error instanceof Error
          ? "Error"
          : typeof error,
  };
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
  ) {
    details.causeCode = error.code;
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 100 &&
    error.statusCode <= 599
  ) {
    details.statusCode = error.statusCode;
  }
  return details;
}

function publishRun(run: RunRecord): RunRecord {
  return run;
}

function withoutRevision<T extends { revision: number }>(
  record: T,
): Omit<T, "revision"> {
  const { revision: _revision, ...value } = record;
  return value;
}

export function startSessionRun(
  db: GameDatabase,
  input: {
    sessionId: string;
    requestId: string;
    expectedRevision: number;
    work: Work;
    providerKey?: string;
    providerBaseURL?: string;
    contextCache?: GeminiContextCache;
  },
): RunRecord {
  const kind = input.work.kind;
  const existing = db.getRun(input.sessionId, input.requestId);
  if (existing) {
    const started = db.startRun({
      sessionId: input.sessionId,
      requestId: input.requestId,
      inputHash: hashInput(kind, input.expectedRevision, input.work),
      expectedRevision: input.expectedRevision,
      kind,
    });
    if (started.status === "running") {
      const key = `${input.sessionId}:${input.requestId}`;
      const task = activeRuns.get(key);
      if (task) void task;
    }
    return publishRun(started);
  }

  const started = db.startRun({
    sessionId: input.sessionId,
    requestId: input.requestId,
    inputHash: hashInput(kind, input.expectedRevision, input.work),
    expectedRevision: input.expectedRevision,
    kind,
  });
  const key = `${input.sessionId}:${input.requestId}`;
  const task = runStarted(db, input, started);
  activeRuns.set(key, task);
  void task.finally(() => {
    if (activeRuns.get(key) === task) activeRuns.delete(key);
  });
  return publishRun(started);
}

async function runStarted(
  db: GameDatabase,
  input: {
    sessionId: string;
    requestId: string;
    expectedRevision: number;
    work: Work;
    providerKey?: string;
    providerBaseURL?: string;
    contextCache?: GeminiContextCache;
  },
  started: RunRecord,
): Promise<void> {
  if (started.status !== "running") return;
  let failureSession: StoredSession | undefined;
  try {
    const session = db.getSession(input.sessionId);
    if (!session) throw new Error("Session tidak ditemukan.");
    failureSession = session;
    let nextState: SessionState = session.state;
    if (session.revision !== input.expectedRevision) {
      throw new Error("Revision session berubah sebelum run dimulai.");
    }
    if (input.work.kind === "opening" && session.nextSequence !== 0) {
      throw new Error("Scene awal sudah dibuat.");
    }

    if (input.work.kind === "item_use") {
      await commitItem(db, session, input.requestId, input.work.itemId);
      return;
    }

    const kind: NarratorKind = input.work.kind;
    const playerAction = input.work.kind === "turn" ? input.work.input : "";
    const knowledge = loadNarratorKnowledge({
      db,
      session,
      kind,
      playerAction,
    });
    const worldMap = knowledge.worldMap;
    const movement = knowledge.movement;
    const attempts = new Map<number, string>();
    const outcome = await runNarrator({
      session,
      history: knowledge.history,
      kind,
      playerAction,
      providerKey: input.providerKey ?? "",
      ...(input.providerBaseURL === undefined
        ? {}
        : { providerBaseURL: input.providerBaseURL }),
      ...(worldMap ? { worldMap } : {}),
      ...(movement ? { movement } : {}),
      lore: knowledge.lore,
      storySummaries: knowledge.storySummaries,
      effectContext: {
        ...(worldMap ? { worldMap } : {}),
        loreEntries: knowledge.lore,
        playerAction,
      },
      ...(input.contextCache
        ? {
            contextCache: {
              client: input.contextCache,
              databaseScope: db,
            },
          }
        : {}),
      estimateTokens: (chars, provider, model) =>
        db.estimateTokens(chars, provider, model),
      onContext: (telemetry) =>
        db.saveContextTelemetry(session.id, input.requestId, telemetry),
      searchMemory: knowledge.searchMemory,
      onAttemptStart: async (event) => {
        const record = db.startAiRequest({
          sessionId: session.id,
          requestId: input.requestId,
          kind,
          attempt: event.step,
          provider: event.provider,
          model: event.model,
        });
        attempts.set(event.step, record.id);
      },
      onAttemptFinish: async (event) => {
        const id = attempts.get(event.step);
        if (!id) return;
        attempts.delete(event.step);
        db.finishAiRequest(id, {
          status: event.status === "succeeded" ? "succeeded" : "failed",
          usage: event.usage
            ? {
                ...event.usage,
                cachedInputTokens: event.cachedInputTokens,
                reasoningTokens: event.reasoningTokens,
              }
            : undefined,
          latencyMs: event.latencyMs,
          finishReason: event.finishReason,
        });
      },
    });

    if (outcome.response.type !== "narrative") {
      throw new Error("Narrator tidak menyelesaikan respons cerita.");
    }
    if (kind === "choices") {
      if (outcome.response.effects.length || outcome.check) {
        throw new Error(
          "Pembuatan pilihan tidak boleh mengubah state atau check.",
        );
      }
      const result = {
        choices: outcome.response.choices,
        boundRevision: session.revision,
      };
      db.completeReadOnlyRun(input.sessionId, input.requestId, result);
      return;
    }

    const now = new Date().toISOString();
    const turnId = randomUUID();
    const messages: Message[] = [];
    let nextDefinitionSnapshot = session.definitionSnapshot;
    if (kind === "turn") {
      if (input.work.kind !== "turn" || !movement) {
        throw new Error("Aksi turn atau movement candidate tidak tersedia.");
      }
      const applied = outcome.application;
      if (!applied) {
        throw new Error("Narrator did not validate turn effects.");
      }
      nextState = applied.state;
      nextDefinitionSnapshot = applied.definition ?? session.definitionSnapshot;
      const existingNpcIds = new Set(
        session.definitionSnapshot.npcs.map(({ id }) => id),
      );
      const encounteredNpcIds = nextDefinitionSnapshot.npcs
        .filter(
          ({ id }) =>
            !existingNpcIds.has(id) &&
            nextState.world.activeCharacters.includes(id),
        )
        .map(({ id }) => id);
      let joinedPresenceNpcIds: string[] = [];
      if (nextState.world.locationId === knowledge.sceneLocationId) {
        const finalSession = {
          ...session,
          definitionSnapshot: nextDefinitionSnapshot,
          state: nextState,
        };
        const finalParticipants = narratorParticipants(finalSession, worldMap);
        joinedPresenceNpcIds = outcome.response.effects.flatMap((effect) =>
          effect.type === "NPC_PRESENCE" &&
          effect.present &&
          finalParticipants.includes(effect.npcId)
            ? [effect.npcId]
            : [],
        );
      }
      const recipients = [
        ...new Set([
          ...narratorParticipants(session, worldMap),
          ...(knowledge.principalNpcId ? [knowledge.principalNpcId] : []),
          ...encounteredNpcIds,
          ...joinedPresenceNpcIds,
        ]),
      ];
      const messageScope = {
        visibility: "private" as const,
        knownBy: recipients,
      };
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence,
        role: "PLAYER",
        content: input.work.input,
        ...messageScope,
        createdAt: now,
      });
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence + 1,
        role: "NARRATOR",
        content: outcome.response.narrative,
        ...(outcome.check ? { check: outcome.check } : {}),
        ...messageScope,
        createdAt: now,
      });
      if (applied.applied.length) {
        messages.push({
          id: randomUUID(),
          sessionId: session.id,
          turnId,
          sequence: session.nextSequence + 2,
          role: "SYSTEM_EVENT",
          content: applied.applied.join(" | "),
          ...messageScope,
          createdAt: now,
        });
      }
    } else {
      const recipients = narratorParticipants(session, worldMap);
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence,
        role: "NARRATOR",
        content: outcome.response.narrative,
        visibility: "private",
        knownBy: recipients,
        createdAt: now,
      });
    }

    const updatedSession = {
      ...withoutRevision(session),
      definitionSnapshot: nextDefinitionSnapshot,
      state: nextState,
      nextSequence: session.nextSequence + messages.length,
      updatedAt: now,
    };
    db.commitRun(input.sessionId, input.requestId, {
      state: nextState,
      messages,
      ...(nextDefinitionSnapshot === session.definitionSnapshot
        ? {}
        : { definitionSnapshot: nextDefinitionSnapshot }),
      result: {
        session: { value: updatedSession, revision: session.revision + 1 },
        messages,
        choices:
          kind === "turn" || kind === "opening" ? outcome.response.choices : [],
      },
    });
  } catch (error) {
    const failure = errorForStorage(error);
    if (
      failure.code === "RUN_FAILED" ||
      failure.code === "AI_PROVIDER_UNAVAILABLE" ||
      error instanceof NarratorResponseError
    ) {
      console.error("[fworld] run gagal", {
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: input.work.kind,
        ...(failureSession
          ? {
              provider: failureSession.ai.provider,
              model: failureSession.ai.model,
            }
          : {}),
        code: failure.code,
        ...(error instanceof NarratorResponseError && failure.detail
          ? { detail: failure.detail }
          : {}),
        ...safeFailureDetails(error),
      });
    }
    try {
      const current = db.getRun(input.sessionId, input.requestId);
      if (current?.status === "running") {
        db.failRun(input.sessionId, input.requestId, failure);
      }
    } catch (persistenceError) {
      console.error("[fworld] run failure persistence failed", {
        sessionId: input.sessionId,
        requestId: input.requestId,
        kind: input.work.kind,
        ...safeFailureDetails(persistenceError),
      });
    }
  }
}

async function commitItem(
  db: GameDatabase,
  session: StoredSession,
  requestId: string,
  itemId: string,
): Promise<void> {
  const item = session.definitionSnapshot.items.find(
    (entry) => entry.id === itemId,
  );
  if (!item) throw new Error(`Item "${itemId}" tidak dikenal.`);
  const worldMap = db.getWorldMap(session);
  const loreRefs =
    session.lorebookRefs ?? session.definitionSnapshot.lorebookRefs ?? [];
  const loreEntries = item.effects.flatMap((effect) => {
    if (effect.type !== "DISCOVER_LORE") return [];
    const entry = db.getLoreEntry(loreRefs, effect.loreId);
    return entry ? [entry] : [];
  });
  const result = applyItem(session.definitionSnapshot, session.state, itemId, {
    ...(worldMap ? { worldMap } : {}),
    loreEntries,
    playerAction: `use ${item.name}`,
  });
  const now = new Date().toISOString();
  const recipients = narratorParticipants(
    { ...session, state: result.state },
    worldMap,
  );
  const message: Message = {
    id: randomUUID(),
    sessionId: session.id,
    turnId: randomUUID(),
    sequence: session.nextSequence,
    role: "SYSTEM_EVENT",
    content: result.applied.length
      ? `${item.name} digunakan. ${result.applied.join(" | ")}`
      : `${item.name} digunakan tanpa efek.`,
    visibility: "private",
    knownBy: recipients,
    createdAt: now,
  };
  const updatedSession = {
    ...withoutRevision(session),
    state: result.state,
    nextSequence: session.nextSequence + 1,
    updatedAt: now,
  };
  db.commitRun(session.id, requestId, {
    state: result.state,
    messages: [message],
    result: {
      session: { value: updatedSession, revision: session.revision + 1 },
      messages: [message],
      choices: [],
    },
  });
}

export function getSessionRun(
  db: GameDatabase,
  sessionId: string,
  requestId: string,
): RunRecord | undefined {
  return db.getRun(sessionId, requestId);
}
