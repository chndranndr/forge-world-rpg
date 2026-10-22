import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  beginOpening,
  exportSave,
  getRun,
  getSession,
  getSessionWorld,
  importSave,
  listMessages,
  requestChoices,
  submitTurn,
  useItem,
  type PlayerItemEffect,
  type RunRecord,
  type SessionSummaryRecord,
  type SessionWorldView,
} from "../api";
import { StoryMarkdown } from "./StoryMarkdown";
import { latestSceneMessages, messageAuthor } from "../session-view-model";
import FieldNotesPanel, { type FieldNoteCategory } from "./FieldNotesPanel";
import { createUuid } from "../../shared/uuid";
import type { Choice } from "../../shared/engine.js";
import { type ItemDefinition, type Message } from "../types";

const StoryMessageBody = memo(function StoryMessageBody({
  message,
}: {
  message: Pick<Message, "role" | "content">;
}) {
  return message.role === "NARRATOR" || message.role === "NPC" ? (
    <StoryMarkdown content={message.content} />
  ) : (
    <p>{message.content}</p>
  );
});

interface SessionViewProps {
  sessionId: string;
  onBack: () => void;
  onOpenSettings: () => void;
  focusMode: boolean;
  onFocusModeChange: (focusMode: boolean) => void;
  textSize: "normal" | "large";
  onTextSizeChange: (size: "normal" | "large") => void;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChoice(value: unknown): value is Choice {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    value.id.trim() !== "" &&
    typeof value.label === "string" &&
    value.label.trim() !== "" &&
    Object.keys(value).every((key) => key === "id" || key === "label")
  );
}

function isChoiceList(value: unknown): value is Choice[] {
  return Array.isArray(value) && value.length <= 3 && value.every(isChoice);
}

function readCachedChoices(sessionId: string): BoundChoices | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(choicesStorageKey(sessionId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isObject(value) ||
      typeof value.boundRevision !== "number" ||
      !Number.isSafeInteger(value.boundRevision) ||
      !isChoiceList(value.list)
    ) {
      return null;
    }
    return { list: value.list, boundRevision: value.boundRevision };
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
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : fallback;
}

function effectLabel(effect: PlayerItemEffect): string {
  switch (effect.type) {
    case "ATTRIBUTE_CHANGE":
    case "RESOURCE_CHANGE":
    case "RELATIONSHIP_CHANGE":
      return `${effect.target} ${effect.operation} ${effect.value}`;
    case "ADD_ITEM":
    case "REMOVE_ITEM":
      return `${effect.type === "ADD_ITEM" ? "+" : "-"}${effect.quantity} ${effect.target}`;
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
  focusMode,
  onFocusModeChange,
  textSize,
  onTextSizeChange,
}: SessionViewProps) {
  const [record, setRecord] = useState<SessionSummaryRecord | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [worldView, setWorldView] = useState<SessionWorldView | null>(null);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notesCategory, setNotesCategory] =
    useState<FieldNoteCategory>("player");
  const [notesOpen, setNotesOpen] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
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
  const wasFocusModeRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const focusExitRef = useRef<HTMLButtonElement>(null);
  const overflowRef = useRef<HTMLDetailsElement>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!focusMode || notesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFocusModeChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode, notesOpen, onFocusModeChange]);
  useEffect(() => {
    if (focusMode && !wasFocusModeRef.current) focusExitRef.current?.focus();
    if (!focusMode && wasFocusModeRef.current) focusToggleRef.current?.focus();
    wasFocusModeRef.current = focusMode;
  }, [focusMode]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () =>
      setKeyboardOpen(viewport.height < window.innerHeight - 160);
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  function createRunRequestId(): string | null {
    try {
      return createUuid();
    } catch {
      setError(
        "Browser ini tidak mendukung pembuatan ID aman. Gunakan browser terbaru.",
      );
      return null;
    }
  }

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
      try {
        setWorldView(await getSessionWorld(sessionId));
        setWorldError(null);
      } catch (error) {
        setWorldView(null);
        setWorldError(errorText(error, "Data dunia sesi gagal dimuat."));
      }
      return loadedSession;
    } catch (error) {
      setLoadError(errorText(error, "Session gagal dimuat."));
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
            `Data berubah di backend. Data terbaru dimuat ulang: ${errorText(error, "Konflik data.")}`,
          );
        } else {
          setPendingRun(stored);
          setError(
            `Status run belum diketahui. ID yang sama tetap disimpan: ${errorText(error, "Backend tidak tersedia.")}`,
          );
        }
        busyRef.current = false;
        setBusy(false);
        return false;
      }

      clearPendingRun(sessionId, stored);
      setPendingRun(null);
      setRetryAction(null);
      let latest: SessionSummaryRecord | null = null;
      try {
        latest = await load();
      } catch (error) {
        setError(
          `Run selesai (${run.status}), tetapi data terbaru gagal dimuat: ${errorText(error, "Backend tidak tersedia.")}`,
        );
        busyRef.current = false;
        setBusy(false);
        return run.status === "succeeded";
      }
      if (run.status !== "succeeded") {
        setChoices(null);
        setError(
          run.error
            ? `${run.error.code}: ${run.error.message}`
            : `Run ${run.status}.`,
        );
        if (stored.kind !== "item") {
          const requestId = createRunRequestId();
          if (requestId) {
            setRetryAction({
              ...stored,
              requestId,
              expectedRevision: latest.revision,
            });
          }
        }
        busyRef.current = false;
        setBusy(false);
        return false;
      }
      if (stored.kind === "choices") {
        const boundRevision = run.result?.boundRevision;
        const nextChoices: unknown = run.result?.choices ?? [];
        if (
          boundRevision === undefined ||
          boundRevision !== latest.revision ||
          !isChoiceList(nextChoices)
        ) {
          setChoices(null);
          setError(
            boundRevision !== undefined && boundRevision !== latest.revision
              ? "Pilihan dibuang karena sesi berubah saat dibuat."
              : "Respons saran aksi tidak valid. Silakan minta saran lagi.",
          );
          busyRef.current = false;
          setBusy(false);
          return false;
        }
        setChoices({ list: nextChoices, boundRevision });
        setShowChoices(true);
        setSavedNote(
          nextChoices.length
            ? "Saran aksi diperbarui untuk revisi ini."
            : "Belum ada saran aksi untuk revisi ini.",
        );
      } else {
        const nextChoices: unknown = run.result?.choices ?? [];
        if (isChoiceList(nextChoices)) {
          setChoices({ list: nextChoices, boundRevision: latest.revision });
          setShowChoices(nextChoices.length > 0);
        } else {
          setChoices(null);
          setError(
            "Respons saran aksi tidak valid. Minta saran secara manual.",
          );
        }
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

  if (!session || !record) {
    return (
      <section className="session-panel">
        <p role={loadError ? "alert" : "status"}>
          {loadError ?? (loading ? "Memuat sesi…" : "Session tidak ditemukan.")}
        </p>
        {loadError && (
          <button type="button" onClick={() => void load().catch(() => {})}>
            Coba lagi
          </button>
        )}
        <button type="button" onClick={onBack}>
          ← Perpustakaan
        </button>
      </section>
    );
  }

  const def = session.definitionSnapshot;
  const state = session.state;
  const sessionRevision = record.revision;

  async function startRun(
    kind: RunKind,
    data: { input?: string; itemId?: string; expectedRevision?: number },
  ) {
    if (busyRef.current || pendingRun) return false;
    const requestId = createRunRequestId();
    if (!requestId) return false;
    const stored: StoredRun = {
      kind,
      requestId,
      expectedRevision: data.expectedRevision ?? sessionRevision,
      ...(data.input === undefined ? {} : { input: data.input }),
      ...(data.itemId === undefined ? {} : { itemId: data.itemId }),
    };
    return executeRun(stored, false);
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
      setError(errorText(err, "Export gagal."));
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
      setError(errorText(err, "Import gagal."));
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
  function closeOverflow() {
    if (overflowRef.current) overflowRef.current.open = false;
  }

  function openOverflow() {
    if (!overflowRef.current) return;
    overflowRef.current.open = true;
    overflowRef.current.querySelector("summary")?.focus();
  }

  function scrollToStory() {
    storyRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }

  function revealChoices() {
    setShowChoices(true);
    window.requestAnimationFrame(() =>
      suggestionsRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      }),
    );
  }

  const choicesAvailable =
    choices !== null && choices.boundRevision === record.revision;
  const activeChoices = choicesAvailable ? choices.list : [];

  const lastCheck = [...messages].reverse().find((message) => message.check);
  const turnCount = record.turnCount;
  const { narration: latestNarrator, dialogue: latestNpc } =
    latestSceneMessages(messages);
  const latestTurnId = latestNarrator?.turnId ?? latestNpc?.turnId ?? null;
  const latestMessages = latestTurnId
    ? messages.filter((message) => message.turnId === latestTurnId)
    : [];
  const npcNames = Object.fromEntries(
    def.npcs.map((npc) => [npc.id, npc.name]),
  );
  const locationLabel =
    worldView?.location?.name ??
    state.world.location ??
    "Lokasi belum ditentukan";
  const sessionTitle = def.title || "Sesi tanpa judul";
  const noteSections = {
    player: (
      <section className="notes-category" aria-label="Profil pemain">
        <div className="person-head">
          <div className="avatar" aria-hidden="true">
            {def.player.name.trim().slice(0, 1).toUpperCase() || "?"}
          </div>
          <div className="person-copy">
            <h3>{def.player.name || "(tanpa nama)"}</h3>
            {def.player.description && (
              <p className="hint">{def.player.description}</p>
            )}
          </div>
        </div>
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
        <div className="stat-list">
          {def.attributes.map((attribute) => {
            const value =
              state.attributes[attribute.id] ?? attribute.defaultValue;
            return (
              <div key={attribute.id} className="stat-row">
                <div className="row">
                  <span>{attribute.name}</span>
                  <strong>
                    {value} ({attribute.min}–{attribute.max})
                  </strong>
                </div>
                <meter
                  min={attribute.min}
                  max={attribute.max}
                  value={value}
                  aria-label={`${attribute.name}: ${value} (${attribute.min}–${attribute.max})`}
                />
                {attribute.description && (
                  <p className="hint">{attribute.description}</p>
                )}
              </div>
            );
          })}
        </div>
        <h3>Sumber daya</h3>
        {def.resources.length === 0 && (
          <p className="hint">Tidak ada sumber daya.</p>
        )}
        <div className="stat-list">
          {def.resources.map((resource) => {
            const value = state.resources[resource.id] ?? resource.initialValue;
            return (
              <div key={resource.id} className="stat-row">
                <div className="row">
                  <span>{resource.name}</span>
                  <strong>
                    {value}
                    {resource.max !== undefined ? ` / ${resource.max}` : ""}
                  </strong>
                </div>
                {resource.max !== undefined && (
                  <meter
                    min={resource.min}
                    max={resource.max}
                    value={value}
                    aria-label={`${resource.name}: ${value} / ${resource.max}`}
                  />
                )}
                {resource.description && (
                  <p className="hint">{resource.description}</p>
                )}
              </div>
            );
          })}
        </div>
        <h3>Check terakhir</h3>
        {lastCheck?.check ? (
          <p className="check-badge">
            Check {lastCheck.check.attributeId}: skor {lastCheck.check.score}/
            {lastCheck.check.difficulty} — {lastCheck.check.outcome} (
            {lastCheck.check.mode})
          </p>
        ) : (
          <p className="hint">Belum ada check.</p>
        )}
      </section>
    ),
    people: (
      <section className="notes-category" aria-label="Karakter sekitar">
        <h3>Orang di sekitar</h3>
        {(worldView?.people.length ?? 0) === 0 && (
          <p className="hint">Tidak ada karakter yang hadir di lokasi ini.</p>
        )}
        {worldView?.people.map((person) => (
          <article key={person.id} className="person-row">
            <div className="person-head">
              <div className="avatar" aria-hidden="true">
                {person.name.trim().slice(0, 1).toUpperCase() || "?"}
              </div>
              <div className="person-copy">
                <h3>{person.name}</h3>
                {person.role && <p className="hint">Peran: {person.role}</p>}
              </div>
            </div>
            {person.description && <p>{person.description}</p>}
            {person.relationships.length > 0 && (
              <div className="stat-list">
                {person.relationships.map((relationship) => (
                  <div key={relationship.id} className="stat-row">
                    <div className="row">
                      <span>{relationship.name}</span>
                      <strong>
                        {relationship.value} ({relationship.min}–
                        {relationship.max})
                      </strong>
                    </div>
                    <meter
                      min={relationship.min}
                      max={relationship.max}
                      value={relationship.value}
                      aria-label={`${relationship.name}: ${relationship.value} (${relationship.min}–${relationship.max})`}
                    />
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </section>
    ),
    inventory: (
      <section className="notes-category" aria-label="Inventaris">
        <h3>Tas</h3>
        <p className="hint">
          {state.inventory.reduce((total, entry) => total + entry.quantity, 0)}{" "}
          item dibawa
        </p>
        {state.inventory.length === 0 && (
          <p className="hint">Inventaris kosong.</p>
        )}
        {state.inventory.map((entry) => {
          const item = def.items.find(
            (candidate) => candidate.id === entry.itemId,
          );
          if (!item) return null;
          return (
            <details key={entry.itemId} className="inventory-row">
              <summary>
                <span>
                  {item.name} ×{entry.quantity}
                </span>
                <span className="hint">{itemStatus(item, entry.quantity)}</span>
              </summary>
              <div className="inventory-detail">
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
                <button
                  type="button"
                  onClick={() => void handleUseItem(entry.itemId)}
                  disabled={busy}
                >
                  Pakai
                </button>
              </div>
            </details>
          );
        })}
      </section>
    ),
    facts: (
      <section className="notes-category" aria-label="Dunia dan fakta">
        <h3>Dunia</h3>
        {worldError && (
          <p className="error" role="alert">
            {worldError}
          </p>
        )}
        <dl className="world-details">
          <div>
            <dt>Lokasi</dt>
            <dd>{locationLabel}</dd>
          </div>
          {worldView?.location?.summary && (
            <div>
              <dt>Deskripsi</dt>
              <dd>{worldView.location.summary}</dd>
            </div>
          )}
          <div>
            <dt>Waktu</dt>
            <dd>{state.world.time || "(belum ditentukan)"}</dd>
          </div>
          <div>
            <dt>Scene</dt>
            <dd>{state.world.scene || "(belum ada)"}</dd>
          </div>
        </dl>
        <h3>Lokasi yang diketahui</h3>
        {(worldView?.locations.length ?? 0) === 0 ? (
          <p className="hint">Belum ada lokasi lain yang diketahui.</p>
        ) : (
          <ul className="fact-list">
            {worldView?.locations.map((location) => (
              <li key={location.id} className="fact-row">
                <strong>{location.name}</strong>
                {location.summary && <p className="hint">{location.summary}</p>}
              </li>
            ))}
          </ul>
        )}
        <h3>Fakta yang diketahui pemain</h3>
        {(worldView?.facts.length ?? 0) === 0 ? (
          <p className="hint">Belum ada fakta.</p>
        ) : (
          <ul className="fact-list">
            {worldView?.facts.map((fact) => (
              <li key={fact.id} className="fact-row">
                {fact.text}
              </li>
            ))}
          </ul>
        )}
        <h3>Aktivitas di sekitar</h3>
        {(worldView?.activities.length ?? 0) === 0 ? (
          <p className="hint">Belum ada aktivitas yang relevan.</p>
        ) : (
          <ul className="fact-list">
            {worldView?.activities.map((entry) => (
              <li key={entry.id} className="fact-row">
                <strong>{entry.name}</strong>
                {entry.summary && <p>{entry.summary}</p>}
              </li>
            ))}
          </ul>
        )}
        <h3>Penemuan</h3>
        {(worldView?.discoveries.length ?? 0) === 0 ? (
          <p className="hint">Belum ada penemuan.</p>
        ) : (
          <ul className="fact-list">
            {worldView?.discoveries.map((entry) => (
              <li key={entry.id} className="fact-row">
                <strong>{entry.name}</strong>
                {entry.summary && <p>{entry.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
  };

  return (
    <div className="session-view">
      <header className="session-header">
        <div className="session-header-main">
          <button type="button" className="quiet session-back" onClick={onBack}>
            Kembali
          </button>
          <div className="session-heading">
            <h1>{sessionTitle}</h1>
            <p>
              {record.value.name ? `${record.value.name} · ` : ""}
              {locationLabel}
            </p>
          </div>
          <div className="session-header-actions">
            <button
              type="button"
              className="quiet session-focus-toggle"
              aria-pressed={focusMode}
              onClick={() => onFocusModeChange(true)}
            >
              Mode fokus
            </button>
            <button
              type="button"
              className="quiet session-text-size"
              aria-pressed={textSize === "large"}
              onClick={() =>
                onTextSizeChange(textSize === "large" ? "normal" : "large")
              }
            >
              Teks {textSize === "large" ? "besar" : "normal"}
            </button>
            <button
              type="button"
              className="quiet session-notes-trigger"
              onClick={() => setNotesOpen(true)}
            >
              Catatan
            </button>
            <details className="session-overflow" ref={overflowRef}>
              <summary ref={focusToggleRef} aria-label="Menu sesi">
                Lainnya
              </summary>
              <div className="session-overflow-content">
                <button
                  type="button"
                  onClick={() => {
                    closeOverflow();
                    onFocusModeChange(true);
                  }}
                >
                  Mode fokus
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeOverflow();
                    onOpenSettings();
                  }}
                >
                  Pengaturan sesi
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeOverflow();
                    void handleExport();
                  }}
                >
                  Ekspor save
                </button>
                <label className="session-import">
                  Impor save
                  <input
                    type="file"
                    accept="application/json"
                    className="visually-hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleImport(file);
                      event.target.value = "";
                      closeOverflow();
                    }}
                  />
                </label>
              </div>
            </details>
          </div>
        </div>
        <button
          ref={focusExitRef}
          type="button"
          className="quiet session-focus-exit"
          onClick={() => onFocusModeChange(false)}
        >
          Keluar fokus
        </button>
      </header>

      <div className="session-scene-strip" aria-label="Kondisi adegan">
        <span>
          {locationLabel} · {state.world.time || "Waktu belum ditentukan"}
        </span>
        <span>Giliran {turnCount}</span>
      </div>

      <div className="session-layout">
        <main className="session-main">
          <div className="session-story" ref={storyRef}>
            <article className="scene">
              {messages.length === 0 ? (
                <>
                  {state.world.scene ? (
                    <div className="narration">
                      <StoryMarkdown content={state.world.scene} />
                    </div>
                  ) : (
                    <p className="session-empty-copy">
                      Cerita dimulai saat kamu membuka adegan pertama.
                    </p>
                  )}
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleOpening()}
                    disabled={busy}
                  >
                    {busy ? "Memulai adegan…" : "Buka adegan pertama"}
                  </button>
                </>
              ) : (
                <div className="scene-messages">
                  {latestMessages.map((message) => {
                    if (message.role === "PLAYER") {
                      return (
                        <div
                          key={message.id}
                          className="scene-player"
                          aria-label="Aksi pemain"
                        >
                          <span>KAMU</span>
                          <p>{message.content}</p>
                        </div>
                      );
                    }
                    if (message.role === "NARRATOR") {
                      return (
                        <div key={message.id} className="narration">
                          <StoryMarkdown content={message.content} />
                        </div>
                      );
                    }
                    if (message.role === "NPC") {
                      return (
                        <div key={message.id} className="dialogue">
                          <span className="scene-speaker">
                            {messageAuthor(message, npcNames)}
                          </span>
                          <StoryMarkdown content={message.content} />
                        </div>
                      );
                    }
                    return (
                      <p key={message.id} className="scene-system">
                        {message.content}
                      </p>
                    );
                  })}
                </div>
              )}
            </article>
          </div>

          {messages.length > 0 && (
            <section
              ref={suggestionsRef}
              className="suggestions"
              aria-label="Saran aksi"
              hidden={!showChoices}
            >
              <h2>Pilihan aksi</h2>
              {activeChoices.length > 0 ? (
                <ol className="suggestion-list">
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
                </ol>
              ) : (
                <p className="meta">
                  {choicesAvailable
                    ? "Belum ada saran aksi untuk revisi ini."
                    : "Saran aksi dibuat hanya saat diminta."}
                </p>
              )}
              <div className="suggestion-actions">
                <button
                  type="button"
                  onClick={() => void startRun("choices", {})}
                  disabled={busy || pendingRun !== null}
                >
                  {busy && pendingRun?.kind === "choices"
                    ? "Meminta saran…"
                    : "Sarankan aksi"}
                </button>
              </div>
            </section>
          )}

          {error && (
            <div className="session-error" role="alert">
              <p tabIndex={-1} ref={errorRef}>
                {error}
              </p>
              {(pendingRun || retryAction) && !busy && (
                <button type="button" onClick={() => void handleRetry()}>
                  {pendingRun ? "Periksa status run lagi" : "Coba lagi"}
                </button>
              )}
            </div>
          )}
          {savedNote && !busy && (
            <p className="session-status" role="status">
              {savedNote}
            </p>
          )}
          {busy && (
            <p className="session-busy" role="status">
              Narator sedang menulis
            </p>
          )}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendAction(input);
            }}
          >
            <label className="sr" htmlFor="action-input">
              Aksi bebas
            </label>
            <textarea
              id="action-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void sendAction(input);
                }
              }}
              disabled={busy || messages.length === 0}
              placeholder="Tulis aksi atau dialog"
              rows={2}
            />
            <div className="composer-footer">
              <p>Enter untuk kirim · Shift+Enter untuk baris baru</p>
              {messages.length > 0 && (
                <button
                  type="button"
                  className="quiet composer-choices-toggle"
                  aria-expanded={showChoices}
                  onClick={() => {
                    if (showChoices) setShowChoices(false);
                    else revealChoices();
                  }}
                >
                  {showChoices ? "Sembunyikan pilihan" : "Pilihan aksi"}
                </button>
              )}
              <button
                type="submit"
                className="primary"
                disabled={busy || messages.length === 0 || !input.trim()}
              >
                Kirim
              </button>
            </div>
          </form>

          <details className="story-history">
            <summary>Riwayat cerita</summary>
            {nextBeforeSequence !== null && (
              <button
                type="button"
                className="history-load-more"
                onClick={() => void loadOlderMessages()}
                disabled={loadingOlder}
              >
                {loadingOlder ? "Memuat riwayat…" : "Muat riwayat sebelumnya"}
              </button>
            )}
            <ol className="message-list">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={`message message-${message.role}`}
                >
                  <header>
                    #{message.sequence} {messageAuthor(message, npcNames)}
                  </header>
                  <StoryMessageBody message={message} />
                  {message.check && (
                    <p className="check-badge">
                      Check {message.check.attributeId}: skor{" "}
                      {message.check.score}/{message.check.difficulty} —{" "}
                      {message.check.outcome} ({message.check.mode})
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </main>

        <FieldNotesPanel
          open={notesOpen}
          category={notesCategory}
          onCategoryChange={setNotesCategory}
          onClose={() => setNotesOpen(false)}
          sections={noteSections}
        />
      </div>

      <nav
        className={`session-dock${keyboardOpen ? " keyboard-open" : ""}`}
        aria-label="Kontrol sesi"
      >
        <button type="button" aria-current="location" onClick={scrollToStory}>
          Cerita
        </button>
        <button type="button" onClick={() => setNotesOpen(true)}>
          Catatan
        </button>
        <button
          type="button"
          aria-expanded={showChoices}
          disabled={messages.length === 0}
          onClick={revealChoices}
        >
          Pilihan
        </button>
        <button type="button" onClick={openOverflow}>
          Lainnya
        </button>
      </nav>
    </div>
  );
}
