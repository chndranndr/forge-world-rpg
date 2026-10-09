import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  beginOpening,
  exportSave,
  getRun,
  getSession,
  importSave,
  listMessages,
  requestChoices,
  submitTurn,
  updateSessionAi,
  useItem,
  type RunRecord,
  type SessionRecord,
} from "../api";
import { DEFAULT_MODELS, type ProviderId } from "../llm";
import type { Choice } from "../../shared/engine.js";
import {
  PLAYER_ID,
  type GameDefinition,
  type ItemDefinition,
  type ItemEffect,
  type Message,
} from "../types";

interface SessionViewProps {
  sessionId: string;
  onBack: () => void;
  onOpenSettings: () => void;
}

type RunKind = "opening" | "turn" | "choices" | "item";

interface BoundChoices {
  list: Choice[];
  boundRevision: number;
}

interface StoredRun {
  kind: RunKind;
  requestId: string;
  expectedRevision: number;
  input?: string;
  itemId?: string;
}

const RUN_KINDS: RunKind[] = ["opening", "turn", "choices", "item"];

function runStorageKey(sessionId: string, kind: RunKind): string {
  return `fworld:run:${encodeURIComponent(sessionId)}:${kind}`;
}

function choicesStorageKey(sessionId: string): string {
  return `fworld:choices:${encodeURIComponent(sessionId)}`;
}

function readCachedChoices(sessionId: string): BoundChoices | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(choicesStorageKey(sessionId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<BoundChoices>;
    if (
      !Number.isSafeInteger(value.boundRevision) ||
      !Array.isArray(value.list) ||
      value.list.length !== 3 ||
      !value.list.every(
        (choice) =>
          choice &&
          typeof choice.id === "string" &&
          typeof choice.label === "string" &&
          choice.label.trim(),
      )
    ) {
      return null;
    }
    return {
      list: value.list,
      boundRevision: value.boundRevision as number,
    };
  } catch {
    return null;
  }
}

function readPendingRun(sessionId: string): StoredRun | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    for (const kind of RUN_KINDS) {
      const raw = sessionStorage.getItem(runStorageKey(sessionId, kind));
      if (!raw) continue;
      const stored = JSON.parse(raw) as Partial<StoredRun>;
      if (
        stored.kind === kind &&
        typeof stored.requestId === "string" &&
        typeof stored.expectedRevision === "number"
      ) {
        return stored as StoredRun;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function savePendingRun(sessionId: string, run: StoredRun): void {
  if (typeof sessionStorage === "undefined") {
    throw new Error("Session storage tidak tersedia untuk menyimpan ID run.");
  }
  sessionStorage.setItem(
    runStorageKey(sessionId, run.kind),
    JSON.stringify(run),
  );
}

function clearPendingRun(sessionId: string, run: StoredRun): void {
  try {
    sessionStorage.removeItem(runStorageKey(sessionId, run.kind));
  } catch {
    // Status terminal sudah diketahui; storage bisa dibersihkan saat sesi berikutnya.
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const ROLE_LABELS: Record<Message["role"], string> = {
  PLAYER: "Pemain",
  NARRATOR: "Narator",
  NPC: "NPC",
  SYSTEM_EVENT: "Sistem",
};

type Panel = "story" | "player" | "inventory" | "people" | "facts";

const PANEL_LABELS: Record<Panel, string> = {
  story: "Story",
  player: "Player",
  inventory: "Inventory",
  people: "People",
  facts: "Facts",
};

function effectLabel(effect: ItemEffect): string {
  switch (effect.type) {
    case "ATTRIBUTE_CHANGE":
    case "RESOURCE_CHANGE":
    case "RELATIONSHIP_CHANGE":
      return `${effect.target} ${effect.operation} ${effect.value}`;
    case "ADD_ITEM":
    case "REMOVE_ITEM":
      return `${effect.type === "ADD_ITEM" ? "+" : "-"}${effect.quantity} ${effect.target}`;
    case "ADD_FACT":
      return `catat fakta: ${effect.text}`;
    case "REMOVE_FACT":
      return `hapus fakta ${effect.target}`;
  }
}

function itemStatus(item: ItemDefinition, quantity: number): string {
  if (quantity <= 0) return "Habis";
  return item.consumable ? "Consumable" : "Permanent";
}

export default function SessionView({
  sessionId,
  onBack,
  onOpenSettings,
}: SessionViewProps) {
  const [record, setRecord] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("story");
  const [choices, setChoices] = useState<BoundChoices | null>(() =>
    readCachedChoices(sessionId),
  );
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<StoredRun | null>(() =>
    readPendingRun(sessionId),
  );
  const [retryAction, setRetryAction] = useState<StoredRun | null>(null);
  const busyRef = useRef(false);
  const resumedRef = useRef(false);
  const requestedChoicesRef = useRef(new Set<string>());

  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedSession, history] = await Promise.all([
        getSession(sessionId),
        listMessages(sessionId),
      ]);
      setRecord(loadedSession);
      setMessages(history.messages);
      setNextBeforeSequence(history.nextBeforeSequence);
      setLoadError(null);
      return loadedSession;
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Session gagal dimuat.",
      );
      throw error;
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  async function loadOlderMessages() {
    if (nextBeforeSequence === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listMessages(sessionId, {
        beforeSequence: nextBeforeSequence,
      });
      setMessages((current) => [...page.messages, ...current]);
      setNextBeforeSequence(page.nextBeforeSequence);
    } catch (error) {
      setError(errorText(error, "Riwayat sebelumnya gagal dimuat."));
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const session = record?.value;

  const callRun = useCallback(
    (run: StoredRun): Promise<RunRecord> => {
      switch (run.kind) {
        case "opening":
          return beginOpening(sessionId, run.requestId, run.expectedRevision);
        case "turn":
          return submitTurn(
            sessionId,
            run.requestId,
            run.expectedRevision,
            run.input ?? "",
          );
        case "choices":
          return requestChoices(sessionId, run.requestId, run.expectedRevision);
        case "item":
          return useItem(
            sessionId,
            run.itemId ?? "",
            run.requestId,
            run.expectedRevision,
          );
      }
    },
    [sessionId],
  );

  const executeRun = useCallback(
    async (stored: StoredRun, resume: boolean): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setPendingRun(stored);
      setError(null);
      setSavedNote(null);
      try {
        savePendingRun(sessionId, stored);
      } catch (error) {
        setPendingRun(null);
        setError(errorText(error, "Request ID tidak dapat disimpan."));
        busyRef.current = false;
        setBusy(false);
        return false;
      }
      let run: RunRecord;
      try {
        if (resume) {
          try {
            run = await getRun(sessionId, stored.requestId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404)
              throw error;
            run = await callRun(stored);
          }
        } else {
          run = await callRun(stored);
        }
        while (run.status === "running") {
          await new Promise((resolve) => window.setTimeout(resolve, 700));
          run = await getRun(sessionId, stored.requestId);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          clearPendingRun(sessionId, stored);
          setPendingRun(null);
          setChoices(null);
          await load().catch(() => {});
          setError(
            `Data berubah di backend. Data terbaru dimuat ulang: ${error.message}`,
          );
        } else {
          setPendingRun(stored);
          setError(
            `Status run belum diketahui. ID yang sama tetap disimpan: ${error instanceof Error ? error.message : "Backend tidak tersedia."}`,
          );
        }
        busyRef.current = false;
        setBusy(false);
        return false;
      }

      clearPendingRun(sessionId, stored);
      setPendingRun(null);
      setRetryAction(null);
      let latest: SessionRecord | null = null;
      try {
        latest = await load();
      } catch (error) {
        setError(
          `Run selesai (${run.status}), tetapi data terbaru gagal dimuat: ${error instanceof Error ? error.message : "backend tidak tersedia."}`,
        );
        busyRef.current = false;
        setBusy(false);
        return run.status === "succeeded";
      }
      if (run.status !== "succeeded") {
        setChoices(null);
        setError(run.error?.message ?? `Run ${run.status}.`);
        if (stored.kind !== "item") {
          setRetryAction({
            ...stored,
            requestId: crypto.randomUUID(),
            expectedRevision: latest.revision,
          });
        }
        busyRef.current = false;
        setBusy(false);
        return false;
      }
      if (stored.kind === "choices") {
        const boundRevision = run.result?.boundRevision;
        const nextChoices = run.result?.choices ?? [];
        if (
          boundRevision === undefined ||
          boundRevision !== latest.revision ||
          nextChoices.length !== 3
        ) {
          setChoices(null);
          setError(
            boundRevision !== undefined && boundRevision !== latest.revision
              ? "Pilihan dibuang karena sesi berubah saat dibuat."
              : "AI belum menghasilkan tepat 3 pilihan. Coba lagi.",
          );
          setRetryAction({
            ...stored,
            requestId: crypto.randomUUID(),
            expectedRevision: latest.revision,
          });
          busyRef.current = false;
          setBusy(false);
          return false;
        }
        setChoices({ list: nextChoices, boundRevision });
        setSavedNote("Pilihan diperbarui untuk revision ini.");
      } else {
        const nextChoices = run.result?.choices ?? [];
        setChoices(
          nextChoices.length === 3
            ? { list: nextChoices, boundRevision: latest.revision }
            : null,
        );
        setSavedNote(
          stored.kind === "opening"
            ? "Scene awal tersimpan."
            : stored.kind === "item"
              ? "Item digunakan."
              : "Turn tersimpan.",
        );
      }
      busyRef.current = false;
      setBusy(false);
      return true;
    },
    [callRun, load, sessionId],
  );

  useEffect(() => {
    if (resumedRef.current || !pendingRun) return;
    resumedRef.current = true;
    void executeRun(pendingRun, true);
  }, [executeRun, pendingRun]);

  useEffect(() => {
    if (record && choices && choices.boundRevision !== record.revision)
      setChoices(null);
  }, [choices, record?.revision]);

  useEffect(() => {
    try {
      if (choices) {
        sessionStorage.setItem(
          choicesStorageKey(sessionId),
          JSON.stringify(choices),
        );
      } else {
        sessionStorage.removeItem(choicesStorageKey(sessionId));
      }
    } catch {
      // Suggestions remain available in memory when browser storage is unavailable.
    }
  }, [choices, sessionId]);

  useEffect(() => {
    if (!record || record.value.id !== sessionId || messages.length === 0)
      return;
    if (
      choices?.boundRevision === record.revision &&
      choices.list.length === 3
    ) {
      return;
    }
    if (pendingRun || busyRef.current) return;

    const requestKey = `${sessionId}:${record.revision}`;
    if (requestedChoicesRef.current.has(requestKey)) return;
    requestedChoicesRef.current.add(requestKey);
    void executeRun(
      {
        kind: "choices",
        requestId: crypto.randomUUID(),
        expectedRevision: record.revision,
      },
      false,
    );
  }, [choices, executeRun, messages.length, pendingRun, record, sessionId]);

  if (!session || !record) {
    return (
      <section className="card">
        <p role={loadError ? "alert" : "status"}>
          {loadError ?? (loading ? "Memuat sesi…" : "Session tidak ditemukan.")}
        </p>
        {loadError && (
          <button type="button" onClick={() => void load().catch(() => {})}>
            Coba lagi
          </button>
        )}
        <button type="button" onClick={onBack}>
          Kembali
        </button>
      </section>
    );
  }

  const def: GameDefinition = session.definitionSnapshot;
  const state = session.state;
  const sessionRevision = record.revision;

  async function startRun(
    kind: RunKind,
    data: { input?: string; itemId?: string; expectedRevision?: number },
  ) {
    if (busyRef.current || pendingRun) return false;
    const stored: StoredRun = {
      kind,
      requestId: crypto.randomUUID(),
      expectedRevision: data.expectedRevision ?? sessionRevision,
      ...(data.input === undefined ? {} : { input: data.input }),
      ...(data.itemId === undefined ? {} : { itemId: data.itemId }),
    };
    return executeRun(stored, false);
  }

  async function handleAiChange(provider: ProviderId, model: string) {
    if (!session) return;
    if (
      busyRef.current ||
      pendingRun ||
      (provider === session.ai.provider && model === session.ai.model)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateSessionAi(sessionId, sessionRevision, {
        provider,
        model,
      });
      setRecord(next);
      setChoices(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setChoices(null);
        await load().catch(() => {});
      }
      setError(errorText(error, "Pengaturan AI gagal disimpan."));
    } finally {
      setBusy(false);
    }
  }

  function handleOpening() {
    return startRun("opening", {});
  }

  async function sendAction(action: string, expectedRevision?: number) {
    if (!action.trim() || busyRef.current) return;
    const succeeded = await startRun("turn", {
      input: action.trim(),
      expectedRevision,
    });
    if (succeeded) setInput("");
  }

  function handleUseItem(itemId: string) {
    if (busyRef.current) return;
    return startRun("item", { itemId });
  }

  async function handleExport() {
    setError(null);
    try {
      const bundle = await exportSave(sessionId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fworld-save-${def.title.replace(/\s+/g, "-").toLowerCase()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export gagal.");
    }
  }

  async function handleImport(file: File) {
    setError(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      await importSave(parsed);
      onBack();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await load().catch(() => {});
      }
      setError(err instanceof Error ? err.message : "Import gagal.");
    }
  }

  async function handleRetry() {
    if (pendingRun) {
      await executeRun(pendingRun, true);
    } else if (retryAction) {
      const action = retryAction;
      setRetryAction(null);
      await executeRun(action, false);
    }
  }

  const activeChoices =
    choices &&
    choices.boundRevision === record.revision &&
    choices.list.length === 3
      ? choices.list
      : [];

  const visibleFacts = state.facts.filter(
    (fact) => fact.visibility === "public" || fact.knownBy.includes(PLAYER_ID),
  );

  const lastCheck = [...messages].reverse().find((message) => message.check);

  return (
    <div>
      <p className="eyebrow">
        {def.title} · {session.ai.model}
      </p>

      {error && (
        <p className="error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}

      {panel === "story" && (
        <div className="session-main">
          <section className="card" aria-label="Pengaturan AI session">
            <h2>Model session</h2>
            <p className="hint">
              Provider dan model berlaku mulai turn berikutnya. Credential
              disimpan di backend; status dan tes koneksi ada di Settings.
            </p>
            <label>
              Provider
              <select
                value={session.ai.provider}
                disabled={busy}
                onChange={(event) => {
                  const provider = event.target.value as ProviderId;
                  void handleAiChange(provider, DEFAULT_MODELS[provider]);
                }}
              >
                <option value="gemini">Gemini</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </label>
            <label>
              Model ID
              <input
                type="text"
                defaultValue={session.ai.model}
                key={`${session.ai.provider}-model`}
                disabled={busy}
                onBlur={(event) =>
                  void handleAiChange(
                    session.ai.provider,
                    event.target.value.trim() ||
                      DEFAULT_MODELS[session.ai.provider],
                  )
                }
              />
            </label>
          </section>

          <section className="card" aria-label="Metadata cerita">
            <h2>{def.title}</h2>
            <p className="hint">
              Lokasi: {state.world.location || "(belum ditentukan)"} · Waktu:{" "}
              {state.world.time || "(belum ditentukan)"}
            </p>
            <p className="hint">Scene: {state.world.scene || "(belum ada)"}</p>
            <p className="hint">
              Turn committed:{" "}
              {new Set(messages.map((message) => message.turnId)).size}
            </p>
          </section>

          {messages.length === 0 && (
            <section className="card">
              <p>Belum ada scene. Buka scene awal terlebih dahulu.</p>
              <button
                type="button"
                className="primary"
                onClick={() => void handleOpening()}
                disabled={busy}
              >
                {busy ? "Memuat scene…" : "Buka scene awal"}
              </button>
            </section>
          )}

          <section aria-label="History percakapan" className="message-list">
            {nextBeforeSequence !== null && (
              <button
                type="button"
                onClick={() => void loadOlderMessages()}
                disabled={loadingOlder}
              >
                {loadingOlder ? "Memuat riwayat…" : "Muat riwayat sebelumnya"}
              </button>
            )}
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message message-${message.role}`}
              >
                <header>
                  {ROLE_LABELS[message.role]}
                  {message.speakerId ? ` (${message.speakerId})` : ""}
                </header>
                <p>{message.content}</p>
                {message.check && (
                  <p className="check-badge">
                    Check {message.check.attributeId}: skor{" "}
                    {message.check.score}/{message.check.difficulty} —{" "}
                    {message.check.outcome} ({message.check.mode})
                  </p>
                )}
              </article>
            ))}
          </section>

          {error && (pendingRun || retryAction) && !busy && (
            <button type="button" onClick={() => void handleRetry()}>
              {pendingRun ? "Periksa status run lagi" : "Coba lagi"}
            </button>
          )}
          {savedNote && !busy && <p role="status">{savedNote}</p>}

          {messages.length > 0 && (
            <section className="card" aria-label="Pilihan aksi">
              <h2>3 pilihan aksi</h2>
              <p className="hint">
                Pilih salah satu, atau tulis tindakan sendiri di bawah.
              </p>
              {activeChoices.length !== 3 && (
                <p className="hint">
                  {busy ? "Menyiapkan 3 pilihan…" : "3 pilihan belum tersedia."}
                </p>
              )}
              <ul className="choices-list">
                {activeChoices.map((choice) => (
                  <li key={choice.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void sendAction(choice.label, choices?.boundRevision)
                      }
                    >
                      {choice.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendAction(input);
            }}
            className="chat-form composer"
          >
            <label>
              Aksi bebas
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={busy || messages.length === 0}
                placeholder="Tulis tindakan atau dialog…"
                rows={3}
              />
            </label>
            <button
              type="submit"
              className="primary"
              disabled={busy || messages.length === 0}
            >
              {busy ? "Memproses…" : "Kirim aksi"}
            </button>
          </form>
        </div>
      )}

      {panel === "player" && (
        <section className="card" aria-label="Profil pemain">
          <h2>{def.player.name || "(tanpa nama)"}</h2>
          {def.player.description && <p>{def.player.description}</p>}
          {def.player.background && (
            <p className="hint">Latar belakang: {def.player.background}</p>
          )}
          {def.player.personality && (
            <p className="hint">Kepribadian: {def.player.personality}</p>
          )}
          {def.player.notes && (
            <p className="hint">Catatan: {def.player.notes}</p>
          )}

          <h3>Atribut</h3>
          {def.attributes.length === 0 && (
            <p className="hint">Tidak ada atribut.</p>
          )}
          <ul>
            {def.attributes.map((attribute) => (
              <li key={attribute.id}>
                {attribute.name}:{" "}
                {state.attributes[attribute.id] ?? attribute.defaultValue} (
                {attribute.min}–{attribute.max})
              </li>
            ))}
          </ul>

          <h3>Sumber daya</h3>
          {def.resources.length === 0 && (
            <p className="hint">Tidak ada sumber daya.</p>
          )}
          <ul>
            {def.resources.map((resource) => (
              <li key={resource.id}>
                {resource.name}:{" "}
                {state.resources[resource.id] ?? resource.initialValue}
                {resource.max !== undefined ? ` / ${resource.max}` : ""}
              </li>
            ))}
          </ul>

          <h3>Check terakhir</h3>
          {lastCheck && lastCheck.check ? (
            <p className="check-badge">
              Check {lastCheck.check.attributeId}: skor {lastCheck.check.score}/
              {lastCheck.check.difficulty} — {lastCheck.check.outcome} (
              {lastCheck.check.mode})
            </p>
          ) : (
            <p className="hint">Belum ada check.</p>
          )}
        </section>
      )}

      {panel === "inventory" && (
        <section className="card" aria-label="Inventaris">
          <h2>Inventaris</h2>
          {state.inventory.length === 0 && (
            <p className="hint">Inventaris kosong.</p>
          )}
          {state.inventory.map((entry) => {
            const item = def.items.find(
              (candidate) => candidate.id === entry.itemId,
            );
            if (!item) return null;
            return (
              <article key={entry.itemId} className="entity">
                <div className="row">
                  <h3>
                    {item.name} ×{entry.quantity}
                  </h3>
                  <span className="hint">
                    {itemStatus(item, entry.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleUseItem(entry.itemId)}
                    disabled={busy}
                  >
                    Pakai
                  </button>
                </div>
                {item.description && <p>{item.description}</p>}
                {item.tags.length > 0 && (
                  <p className="hint">Tag: {item.tags.join(", ")}</p>
                )}
                {item.effects.length > 0 && (
                  <ul className="hint">
                    {item.effects.map((effect, index) => (
                      <li key={index}>{effectLabel(effect)}</li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </section>
      )}

      {panel === "people" && (
        <section className="card" aria-label="Karakter">
          <h2>Karakter</h2>
          {state.relationships.length === 0 && (
            <p className="hint">Belum ada NPC terdaftar.</p>
          )}
          {state.relationships.map((entry) => {
            const npc = def.npcs.find(
              (candidate) => candidate.id === entry.npcId,
            );
            if (!npc) return null;
            const active = state.world.activeCharacters.includes(npc.id);
            return (
              <article key={entry.npcId} className="entity">
                <div className="row">
                  <h3>{npc.name}</h3>
                  <span className="hint">
                    {active ? "Aktif" : "Tidak aktif"}
                  </span>
                </div>
                {npc.description && <p>{npc.description}</p>}
                {npc.role && <p className="hint">Peran: {npc.role}</p>}
                {npc.personality.length > 0 && (
                  <p className="hint">Sifat: {npc.personality.join(", ")}</p>
                )}
                {npc.goals.length > 0 && (
                  <p className="hint">Tujuan: {npc.goals.join("; ")}</p>
                )}
                <ul>
                  {def.relationships.map((rel) => (
                    <li key={rel.id}>
                      {rel.name}: {entry.values[rel.id] ?? rel.defaultValue} (
                      {rel.min}–{rel.max})
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>
      )}

      {panel === "facts" && (
        <section className="card" aria-label="Dunia dan fakta">
          <h2>Dunia</h2>
          <ul>
            <li>Lokasi: {state.world.location || "(belum ditentukan)"}</li>
            <li>Waktu: {state.world.time || "(belum ditentukan)"}</li>
            <li>Scene: {state.world.scene || "(belum ada)"}</li>
            <li>
              Karakter aktif:{" "}
              {state.world.activeCharacters.join(", ") || "(belum ada)"}
            </li>
          </ul>

          <h3>Fakta yang diketahui pemain</h3>
          {visibleFacts.length === 0 && (
            <p className="hint">Belum ada fakta.</p>
          )}
          <ul>
            {visibleFacts.map((fact) => (
              <li key={fact.id}>
                {fact.text}{" "}
                <span className="hint">
                  ({fact.visibility}
                  {fact.knownBy.length > 0
                    ? `, diketahui: ${fact.knownBy.join(", ")}`
                    : ""}
                  )
                </span>
              </li>
            ))}
          </ul>

          <h3>History lengkap</h3>
          {messages.length === 0 && <p className="hint">Belum ada history.</p>}
          <ol className="message-list">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`message message-${message.role}`}
              >
                <header>
                  #{message.sequence} {ROLE_LABELS[message.role]}
                </header>
                <p>{message.content}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="row session-menu">
        <button type="button" onClick={() => void handleExport()}>
          Export save
        </button>
        <label className="button">
          Import save
          <input
            type="file"
            accept="application/json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImport(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <nav className="bottom-nav" aria-label="Panel sesi">
        <button type="button" onClick={onBack}>
          Kembali
        </button>
        {(Object.keys(PANEL_LABELS) as Panel[]).map((name) => (
          <button
            key={name}
            type="button"
            aria-current={panel === name ? "page" : undefined}
            onClick={() => setPanel(name)}
          >
            {PANEL_LABELS[name]}
          </button>
        ))}
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </nav>
    </div>
  );
}
