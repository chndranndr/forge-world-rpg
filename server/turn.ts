import { createHash, randomUUID } from "node:crypto";
import { applyEffects, useItem as applyItem } from "../shared/engine.js";
import type { Message, SessionState } from "../shared/types.js";
import { NarratorResponseError, runNarrator } from "./agent.js";
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

function errorForStorage(error: unknown): { code: string; message: string } {
  if (error instanceof NarratorResponseError) {
    return { code: "AI_RESPONSE_INVALID", message: error.message };
  }
  if (error instanceof Error && error.name === "EngineError") {
    return { code: "INVALID_PROPOSAL", message: error.message.slice(0, 500) };
  }
  if (
    error instanceof Error &&
    /key belum dikonfigurasi/i.test(error.message)
  ) {
    return { code: "PROVIDER_NOT_CONFIGURED", message: error.message };
  }
  return {
    code: "RUN_FAILED",
    message:
      "Run gagal. Periksa koneksi, konfigurasi provider, dan log server.",
  };
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
  },
  started: RunRecord,
): Promise<void> {
  if (started.status !== "running") return;
  try {
    const session = db.getSession(input.sessionId);
    if (!session) throw new Error("Session tidak ditemukan.");
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
    const history = db.getHistory(session.id);
    const attempts = new Map<number, string>();
    const outcome = await runNarrator({
      session,
      history,
      kind,
      playerAction: input.work.kind === "turn" ? input.work.input : "",
      providerKey: input.providerKey ?? "",
      searchMemory: async (query, options) => {
        options.signal.throwIfAborted();
        return db
          .searchMemory(session.id, query, options.npcId)
          .map(({ excerpt, ...hit }) => ({ ...hit, text: excerpt }));
      },
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
          usage: event.usage ?? undefined,
          latencyMs: event.latencyMs,
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
      if (!outcome.response.choices.length) {
        throw new Error("Model tidak memberikan pilihan.");
      }
      const result = {
        choices: outcome.response.choices,
        boundRevision: session.revision,
      };
      db.completeReadOnlyRun(input.sessionId, input.requestId, result);
      return;
    }

    if (
      kind === "opening" &&
      (outcome.response.effects.length || outcome.check)
    ) {
      throw new Error(
        "Scene awal tidak boleh mengubah state atau meminta check.",
      );
    }
    const now = new Date().toISOString();
    const turnId = randomUUID();
    const messages: Message[] = [];
    let nextState: SessionState = structuredClone(session.state);
    if (kind === "turn") {
      if (input.work.kind !== "turn")
        throw new Error("Aksi turn tidak tersedia.");
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence,
        role: "PLAYER",
        content: input.work.input,
        createdAt: now,
      });
      const applied = applyEffects(
        session.definitionSnapshot,
        session.state,
        outcome.response.effects,
      );
      nextState = applied.state;
      if (outcome.response.world) {
        nextState.world = {
          ...nextState.world,
          ...outcome.response.world,
        };
      }
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence + 1,
        role: "NARRATOR",
        content: outcome.response.narrative,
        ...(outcome.check ? { check: outcome.check } : {}),
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
          createdAt: now,
        });
      }
    } else {
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        sequence: session.nextSequence,
        role: "NARRATOR",
        content: outcome.response.narrative,
        createdAt: now,
      });
    }

    const updatedSession = {
      ...withoutRevision(session),
      state: nextState,
      nextSequence: session.nextSequence + messages.length,
      updatedAt: now,
    };
    db.commitRun(input.sessionId, input.requestId, {
      state: nextState,
      messages,
      result: {
        session: { value: updatedSession, revision: session.revision + 1 },
        messages,
        choices:
          kind === "turn" || kind === "opening" ? outcome.response.choices : [],
      },
    });
  } catch (error) {
    try {
      const current = db.getRun(input.sessionId, input.requestId);
      if (current?.status === "running") {
        db.failRun(input.sessionId, input.requestId, errorForStorage(error));
      }
    } catch {
      // Preserve the failed run status whenever the database remains writable.
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
  const result = applyItem(session.definitionSnapshot, session.state, itemId);
  const now = new Date().toISOString();
  const message: Message = {
    id: randomUUID(),
    sessionId: session.id,
    turnId: randomUUID(),
    sequence: session.nextSequence,
    role: "SYSTEM_EVENT",
    content: result.applied.length
      ? `${item.name} digunakan. ${result.applied.join(" | ")}`
      : `${item.name} digunakan tanpa efek.`,
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
