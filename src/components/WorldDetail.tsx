import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createBackup,
  deleteGame,
  deleteSession,
  duplicateGame,
  exportGameTemplate,
  exportSave,
  listAiProfiles,
  listLoreEntries,
  listLorebooks,
  saveGameTemplate,
  startSavedSession,
  updateSessionMetadata,
  type BackupRecord,
  type PlayerLoreEntry,
  type SessionSummaryRecord,
} from "../api";
import {
  displaySessions,
  latestSession,
  relativeTime,
  type GameEntry,
} from "../library";
import { storyIllustration } from "../illustrations";
import ConfirmDialog from "./ConfirmDialog";
import type { AiProfile } from "../../shared/ai-profile";
import type { AiConfig, LorebookRef, LorePackHeader } from "../types";

interface WorldDetailProps {
  entry?: GameEntry;
  defaultAi: AiConfig;
  defaultProfileId?: string;
  onBack: () => void;
  onEdit: (gameId: string) => void;
  onOpenSettings: () => void;
  onContinue: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}

interface LorebookData {
  header: LorePackHeader;
  entries: PlayerLoreEntry[];
  total: number;
}

const EMPTY_LORE_REFS: LorebookRef[] = [];

function loreRefKey(ref: LorebookRef): string {
  return `${ref.packId}@${ref.version}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "fworld"
  );
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function backupDescription(backup: BackupRecord): string {
  return `Cadangan seluruh database dibuat · ${backup.id} · ${new Intl.NumberFormat("id-ID").format(backup.size)} byte · ${relativeTime(backup.createdAt)}.`;
}

export default function WorldDetail({
  entry,
  defaultAi,
  defaultProfileId,
  onBack,
  onEdit,
  onOpenSettings,
  onContinue,
  onRefresh,
}: WorldDetailProps) {
  const maybeGame = entry?.game.value;
  const loreRefs = maybeGame?.lorebookRefs ?? EMPTY_LORE_REFS;
  const [loreData, setLoreData] = useState<Record<string, LorebookData>>({});
  const [loreErrors, setLoreErrors] = useState<Record<string, string>>({});
  const [loreMissing, setLoreMissing] = useState<Record<string, boolean>>({});
  const [loreLoading, setLoreLoading] = useState(false);
  const [loreRetry, setLoreRetry] = useState(0);
  const [loreMoreLoading, setLoreMoreLoading] = useState<
    Record<string, boolean>
  >({});
  const [profileRecords, setProfileRecords] = useState<AiProfile[] | null>(
    null,
  );
  const [profileLoading, setProfileLoading] = useState(
    defaultProfileId !== undefined,
  );
  const [profileError, setProfileError] = useState("");
  const [profileRetry, setProfileRetry] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [worldNotice, setWorldNotice] = useState("");
  const [worldError, setWorldError] = useState("");
  const [worldDialogNote, setWorldDialogNote] = useState("");
  const [worldDialogNoteRole, setWorldDialogNoteRole] = useState<
    "status" | "alert"
  >("status");
  const [pendingDuplicate, setPendingDuplicate] = useState<
    GameEntry["game"] | null
  >(null);
  const [pendingWorldDelete, setPendingWorldDelete] = useState<
    GameEntry["game"] | null
  >(null);
  const [pendingSessionDelete, setPendingSessionDelete] =
    useState<SessionSummaryRecord | null>(null);
  const [sessionDeleteNote, setSessionDeleteNote] = useState("");
  const [sessionDeleteNoteRole, setSessionDeleteNoteRole] = useState<
    "status" | "alert"
  >("status");
  const [sessionName, setSessionName] = useState("");
  const [sessionCreateError, setSessionCreateError] = useState("");
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>(
    {},
  );
  const [sessionNotices, setSessionNotices] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    const gameId = maybeGame?.id;
    if (!gameId || loreRefs.length === 0) {
      setLoreLoading(false);
      return;
    }

    let active = true;
    setLoreLoading(true);
    void (async () => {
      const headers = new Map<string, LorePackHeader>();
      const wanted = new Set(loreRefs.map(loreRefKey));
      try {
        let offset = 0;
        let total = 1;
        do {
          const page = await listLorebooks({ limit: 100, offset });
          total = page.total;
          for (const header of page.packs) {
            const key = `${header.id}@${header.version}`;
            if (wanted.delete(key)) headers.set(key, header);
          }
          offset += page.packs.length;
          if (page.packs.length === 0) break;
        } while (offset < total && wanted.size > 0);

        if (!active) return;
        await Promise.all(
          loreRefs.map(async (ref) => {
            const key = loreRefKey(ref);
            const header = headers.get(key);
            if (!header) {
              setLoreMissing((current) => ({ ...current, [key]: true }));
              setLoreErrors((current) => ({ ...current, [key]: "" }));
              return;
            }
            try {
              const page = await listLoreEntries(ref, { limit: 50 });
              if (!active) return;
              setLoreData((current) => ({
                ...current,
                [key]: { header, entries: page.entries, total: page.total },
              }));
              setLoreMissing((current) => ({ ...current, [key]: false }));
              setLoreErrors((current) => ({ ...current, [key]: "" }));
            } catch (error) {
              if (!active) return;
              if (error instanceof ApiError && error.status === 404) {
                setLoreMissing((current) => ({ ...current, [key]: true }));
              }
              setLoreErrors((current) => ({
                ...current,
                [key]: errorMessage(error, "Isi lorebook gagal dimuat."),
              }));
            }
          }),
        );
      } catch (error) {
        if (active) {
          const message = errorMessage(error, "Daftar lorebook gagal dimuat.");
          for (const ref of loreRefs) {
            const key = loreRefKey(ref);
            setLoreErrors((current) => ({ ...current, [key]: message }));
          }
        }
      } finally {
        if (active) setLoreLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [maybeGame?.id, loreRefs, loreRetry]);

  useEffect(() => {
    if (defaultProfileId === undefined) {
      setProfileLoading(false);
      setProfileError("");
      return;
    }
    let active = true;
    setProfileLoading(true);
    setProfileError("");
    void listAiProfiles()
      .then((profiles) => {
        if (active) {
          setProfileRecords(profiles);
          setProfileError("");
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setProfileError(errorMessage(error, "Profil AI gagal dimuat."));
        }
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [defaultProfileId, profileRetry]);

  if (!entry || !maybeGame) {
    return (
      <section aria-label="Detail dunia">
        <article className="feature feature-empty">
          <div className="feature-copy">
            <span className="eyebrow">Dunia</span>
            <h2>Dunia tidak ditemukan.</h2>
            <p>Dunia ini mungkin sudah dihapus atau tidak lagi tersedia.</p>
            <button type="button" className="quiet" onClick={onBack}>
              Kembali ke perpustakaan
            </button>
          </div>
        </article>
      </section>
    );
  }

  const savedGame = entry.game;
  const game = savedGame.value;
  const selectedProfile = profileRecords?.find(
    (profile) => profile.id === defaultProfileId,
  );

  const latest = latestSession(entry);
  const sessions = displaySessions(entry);
  const lastActivity = latest?.value.updatedAt ?? game.updatedAt;
  const turnTotal = entry.sessions.reduce(
    (total, session) => total + session.turnCount,
    0,
  );

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyAction) return;
    setBusyAction("new-session");
    setSessionCreateError("");
    try {
      const source =
        defaultProfileId !== undefined
          ? { profileId: defaultProfileId }
          : { ai: defaultAi };
      const session = await startSavedSession(
        savedGame.value.id,
        savedGame.revision,
        source,
        sessionName.trim() || undefined,
      );
      setSessionName("");
      await onRefresh();
      onContinue(session.value.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await onRefresh();
      setSessionCreateError(errorMessage(error, "Sesi baru gagal dibuat."));
    } finally {
      setBusyAction(null);
    }
  }

  async function renameSession(session: SessionSummaryRecord) {
    if (busyAction) return;
    const nextName = renameValue.trim();
    setBusyAction(`rename:${session.value.id}`);
    setSessionErrors((current) => ({ ...current, [session.value.id]: "" }));
    setSessionNotices((current) => ({ ...current, [session.value.id]: "" }));
    try {
      await updateSessionMetadata(session.value.id, {
        name: nextName || null,
      });
      await onRefresh();
      setRenameSessionId(null);
      setSessionNotices((current) => ({
        ...current,
        [session.value.id]: "Nama sesi diperbarui.",
      }));
    } catch (error) {
      setSessionErrors((current) => ({
        ...current,
        [session.value.id]: errorMessage(error, "Nama sesi gagal diperbarui."),
      }));
    } finally {
      setBusyAction(null);
    }
  }

  async function togglePin(session: SessionSummaryRecord) {
    if (busyAction) return;
    setBusyAction(`pin:${session.value.id}`);
    setSessionErrors((current) => ({ ...current, [session.value.id]: "" }));
    setSessionNotices((current) => ({ ...current, [session.value.id]: "" }));
    try {
      const pinned = session.value.pinned !== true;
      await updateSessionMetadata(session.value.id, { pinned });
      await onRefresh();
      setSessionNotices((current) => ({
        ...current,
        [session.value.id]: pinned ? "Sesi disematkan." : "Pin sesi dilepas.",
      }));
    } catch (error) {
      setSessionErrors((current) => ({
        ...current,
        [session.value.id]: errorMessage(error, "Status pin gagal diperbarui."),
      }));
    } finally {
      setBusyAction(null);
    }
  }

  async function exportSession(
    session: SessionSummaryRecord,
    inDeleteDialog = false,
  ) {
    if (busyAction) return;
    setBusyAction(`export-save:${session.value.id}`);
    setSessionErrors((current) => ({ ...current, [session.value.id]: "" }));
    setSessionNotices((current) => ({ ...current, [session.value.id]: "" }));
    if (inDeleteDialog) {
      setSessionDeleteNote("");
      setSessionDeleteNoteRole("status");
    }
    try {
      const bundle = await exportSave(session.value.id);
      downloadJson(
        bundle,
        `fworld-save-${slug(session.value.name || session.value.id)}.json`,
      );
      if (inDeleteDialog) {
        setSessionDeleteNote("Save sesi diekspor. Sesi belum dihapus.");
        setSessionDeleteNoteRole("status");
      } else {
        setSessionNotices((current) => ({
          ...current,
          [session.value.id]: "Save sesi diekspor.",
        }));
      }
    } catch (error) {
      const message = errorMessage(error, "Export save gagal.");
      setSessionErrors((current) => ({
        ...current,
        [session.value.id]: message,
      }));
      if (inDeleteDialog) {
        setSessionDeleteNote(message);
        setSessionDeleteNoteRole("alert");
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteSelectedSession() {
    const session = pendingSessionDelete;
    if (!session || busyAction) return;
    setBusyAction("delete-session");
    setSessionErrors((current) => ({ ...current, [session.value.id]: "" }));
    setSessionNotices((current) => ({ ...current, [session.value.id]: "" }));
    setSessionDeleteNote("");
    try {
      await deleteSession(session.value.id, session.revision);
      await onRefresh();
      setPendingSessionDelete(null);
      setWorldNotice("Sesi dihapus.");
      setWorldError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await onRefresh();
        setPendingSessionDelete(null);
      }
      const message = errorMessage(error, "Sesi gagal dihapus.");
      setSessionErrors((current) => ({
        ...current,
        [session.value.id]: message,
      }));
      setSessionDeleteNote(message);
      setSessionDeleteNoteRole("alert");
    } finally {
      setBusyAction(null);
    }
  }

  async function duplicateWorld() {
    const record = pendingDuplicate;
    if (!record || busyAction) return;
    setBusyAction("duplicate");
    setWorldNotice("");
    setWorldError("");
    try {
      const duplicate = await duplicateGame(record.value.id, record.revision);
      await onRefresh();
      setPendingDuplicate(null);
      onEdit(duplicate.value.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await onRefresh();
        setPendingDuplicate(null);
      }
      setWorldError(errorMessage(error, "Dunia gagal diduplikasi."));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveTemplate() {
    if (busyAction) return;
    setBusyAction("save-template");
    setWorldNotice("");
    setWorldError("");
    try {
      const template = await saveGameTemplate(
        savedGame.value.id,
        savedGame.revision,
      );
      await onRefresh();
      setWorldNotice(`Template "${template.title}" tersimpan.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await onRefresh();
      setWorldError(errorMessage(error, "Template gagal disimpan."));
    } finally {
      setBusyAction(null);
    }
  }

  async function exportTemplate() {
    if (busyAction) return;
    setBusyAction("export-template");
    setWorldNotice("");
    setWorldError("");
    try {
      const bundle = await exportGameTemplate(savedGame.value.id);
      downloadJson(
        bundle,
        `fworld-template-${slug(savedGame.value.title)}.json`,
      );
      setWorldNotice("Template dunia diekspor.");
    } catch (error) {
      setWorldError(errorMessage(error, "Export template gagal."));
    } finally {
      setBusyAction(null);
    }
  }

  async function backupBeforeWorldDelete() {
    if (!pendingWorldDelete || busyAction) return;
    setBusyAction("backup-world");
    setWorldDialogNote("");
    try {
      const backup = await createBackup();
      setWorldDialogNote(
        `${backupDescription(backup)} Cadangan mencakup seluruh database, bukan hanya dunia ini.`,
      );
      setWorldDialogNoteRole("status");
    } catch (error) {
      setWorldDialogNote(errorMessage(error, "Backup seluruh database gagal."));
      setWorldDialogNoteRole("alert");
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteSelectedWorld() {
    const record = pendingWorldDelete;
    if (!record || busyAction) return;
    setBusyAction("delete-world");
    setWorldDialogNote("");
    setWorldError("");
    try {
      await deleteGame(record.value.id, record.revision);
      await onRefresh();
      setPendingWorldDelete(null);
      onBack();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await onRefresh();
        setPendingWorldDelete(null);
      }
      const message = errorMessage(error, "Dunia gagal dihapus.");
      setWorldError(message);
      setWorldDialogNote(message);
      setWorldDialogNoteRole("alert");
    } finally {
      setBusyAction(null);
    }
  }

  async function loadMoreLore(ref: LorebookRef) {
    const key = loreRefKey(ref);
    const current = loreData[key];
    if (
      !current ||
      current.entries.length >= current.total ||
      loreMoreLoading[key]
    ) {
      return;
    }
    setLoreMoreLoading((loading) => ({ ...loading, [key]: true }));
    setLoreErrors((errors) => ({ ...errors, [key]: "" }));
    try {
      const page = await listLoreEntries(ref, {
        limit: 50,
        offset: current.entries.length,
      });
      setLoreData((data) => ({
        ...data,
        [key]: {
          ...current,
          entries: [...current.entries, ...page.entries],
          total: page.total,
        },
      }));
    } catch (error) {
      setLoreErrors((errors) => ({
        ...errors,
        [key]: errorMessage(error, "Entri berikutnya gagal dimuat."),
      }));
    } finally {
      setLoreMoreLoading((loading) => ({ ...loading, [key]: false }));
    }
  }

  return (
    <section aria-label={`Detail dunia ${game.title}`}>
      <nav className="row" aria-label="Jejak navigasi">
        <button type="button" className="quiet" onClick={onBack}>
          Perpustakaan
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{game.title}</span>
      </nav>

      <article className="feature">
        <img src={storyIllustration(game)} width={900} height={600} alt="" />
        <div className="feature-copy">
          <span className="eyebrow">Dunia · {entry.sessions.length} sesi</span>
          <h2>{game.title}</h2>
          <p>
            {game.description?.trim() || "Belum ada deskripsi untuk dunia ini."}
          </p>
          <p className="hint">
            {game.genre?.trim() || "Genre belum diatur"} ·{" "}
            {relativeTime(lastActivity)}
          </p>
          <div className="row">
            {latest && (
              <button
                type="button"
                className="primary"
                onClick={() => onContinue(latest.value.id)}
              >
                Lanjutkan sesi terakhir
              </button>
            )}
            <button
              type="button"
              className="quiet"
              onClick={() => onEdit(game.id)}
            >
              Edit dunia
            </button>
          </div>
        </div>
      </article>

      <section aria-label="Tindakan dunia" className="session-menu">
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setWorldNotice("");
            setWorldError("");
            setPendingDuplicate(savedGame);
          }}
          disabled={busyAction !== null}
        >
          Duplikat dunia
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => void exportTemplate()}
          disabled={busyAction !== null}
        >
          {busyAction === "export-template" ? "Mengekspor…" : "Export template"}
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => void saveTemplate()}
          disabled={busyAction !== null}
        >
          {busyAction === "save-template"
            ? "Menyimpan…"
            : "Simpan sebagai template"}
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setWorldDialogNote("");
            setWorldDialogNoteRole("status");
            setPendingWorldDelete(savedGame);
          }}
          disabled={busyAction !== null}
        >
          Hapus dunia permanen…
        </button>
      </section>
      {worldNotice && (
        <p className="hint" role="status">
          {worldNotice}
        </p>
      )}
      {worldError && (
        <p className="error" role="alert">
          {worldError}
        </p>
      )}

      <section aria-labelledby="world-summary-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Ringkasan</span>
            <h2 id="world-summary-title">Isi dunia.</h2>
          </div>
        </div>
        <dl className="world-details">
          <div>
            <dt>Genre</dt>
            <dd>{game.genre?.trim() || "Belum diatur"}</dd>
          </div>
          <div>
            <dt>Nada</dt>
            <dd>{game.tone?.trim() || "Belum diatur"}</dd>
          </div>
          <div>
            <dt>Bahasa</dt>
            <dd>{game.language?.trim() || "Belum diatur"}</dd>
          </div>
          <div>
            <dt>Tokoh</dt>
            <dd>{game.npcs.length}</dd>
          </div>
          <div>
            <dt>Atribut · sumber daya · item</dt>
            <dd>
              {game.attributes.length} · {game.resources.length} ·{" "}
              {game.items.length}
            </dd>
          </div>
          <div>
            <dt>Sesi tersimpan</dt>
            <dd>{entry.sessions.length}</dd>
          </div>
          <div>
            <dt>Total giliran tersimpan</dt>
            <dd>{turnTotal}</dd>
          </div>
          <div>
            <dt>Aktivitas terakhir</dt>
            <dd>{relativeTime(lastActivity)}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="world-setting-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Latar cerita</span>
            <h2 id="world-setting-title">Dunia dan pembuka.</h2>
          </div>
        </div>
        <article className="feature feature-empty">
          <div className="feature-copy">
            <h3>Latar</h3>
            <p>{game.scenario.setting.trim() || "Latar belum ditulis."}</p>
            <h3>Pembuka</h3>
            <p>
              {game.scenario.startingSituation.trim() ||
                "Situasi pembuka belum ditulis."}
            </p>
          </div>
        </article>
      </section>

      <section aria-labelledby="world-sessions-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Sesi tersimpan</span>
            <h2 id="world-sessions-title">Perjalanan.</h2>
            <p className="hint">
              {entry.sessions.length} sesi · {turnTotal} giliran · pin lebih
              dahulu, lalu sesi terbaru.
            </p>
          </div>
        </div>
        <form className="row" onSubmit={(event) => void createSession(event)}>
          <label className="search">
            Nama sesi (opsional)
            <input
              type="text"
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="Nama sesi"
              disabled={busyAction !== null}
            />
          </label>
          <button
            type="submit"
            className="primary"
            disabled={busyAction !== null}
          >
            {busyAction === "new-session" ? "Membuat sesi…" : "Sesi baru"}
          </button>
        </form>
        {sessionCreateError && (
          <p className="error" role="alert">
            {sessionCreateError}
          </p>
        )}
        {sessions.length === 0 ? (
          <article className="feature feature-empty">
            <div className="feature-copy">
              <p>Belum ada sesi untuk dunia ini.</p>
            </div>
          </article>
        ) : (
          <ul className="fact-list">
            {sessions.map((session) => (
              <li className="fact-row" key={session.value.id}>
                <div className="row">
                  <h3>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => onContinue(session.value.id)}
                    >
                      {session.value.name?.trim() || "Sesi tanpa nama"}
                    </button>
                  </h3>
                  <button
                    type="button"
                    className="quiet"
                    aria-pressed={session.value.pinned === true}
                    onClick={() => void togglePin(session)}
                    disabled={busyAction !== null}
                  >
                    {session.value.pinned ? "Lepas pin" : "Pin sesi"}
                  </button>
                </div>
                {session.excerpt ? (
                  <p>{session.excerpt}</p>
                ) : (
                  <p className="hint">Belum ada kutipan cerita tersimpan.</p>
                )}
                <p className="hint">
                  {session.value.state.world.location ||
                    "Lokasi belum tercatat"}{" "}
                  · {session.turnCount} giliran ·{" "}
                  {relativeTime(session.value.updatedAt)}
                </p>
                {renameSessionId === session.value.id ? (
                  <form
                    className="row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void renameSession(session);
                    }}
                  >
                    <label className="search">
                      Nama sesi
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        autoFocus
                        disabled={busyAction !== null}
                      />
                    </label>
                    <button
                      type="submit"
                      className="quiet"
                      disabled={busyAction !== null}
                    >
                      Simpan nama
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => setRenameSessionId(null)}
                      disabled={busyAction !== null}
                    >
                      Batal
                    </button>
                  </form>
                ) : (
                  <div className="row">
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setRenameSessionId(session.value.id);
                        setRenameValue(session.value.name ?? "");
                      }}
                      disabled={busyAction !== null}
                    >
                      Ganti nama
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => void exportSession(session)}
                      disabled={busyAction !== null}
                    >
                      {busyAction === `export-save:${session.value.id}`
                        ? "Mengekspor…"
                        : "Export save"}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setSessionErrors((current) => ({
                          ...current,
                          [session.value.id]: "",
                        }));
                        setSessionNotices((current) => ({
                          ...current,
                          [session.value.id]: "",
                        }));
                        setSessionDeleteNote("");
                        setSessionDeleteNoteRole("status");
                        setPendingSessionDelete(session);
                      }}
                      disabled={busyAction !== null}
                    >
                      Hapus sesi…
                    </button>
                  </div>
                )}
                {sessionNotices[session.value.id] && (
                  <p className="hint" role="status">
                    {sessionNotices[session.value.id]}
                  </p>
                )}
                {sessionErrors[session.value.id] && (
                  <p className="error" role="alert">
                    {sessionErrors[session.value.id]}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="world-lorebooks-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Referensi dunia</span>
            <h2 id="world-lorebooks-title">Lorebook.</h2>
          </div>
          {loreRefs.length > 0 && (
            <button
              type="button"
              className="quiet"
              onClick={() => setLoreRetry((retry) => retry + 1)}
              disabled={loreLoading}
            >
              {loreLoading ? "Memuat…" : "Muat ulang"}
            </button>
          )}
        </div>
        {loreRefs.length === 0 ? (
          <p className="hint">Dunia ini tidak mengikat lorebook.</p>
        ) : (
          <>
            {loreLoading && (
              <p className="hint" role="status">
                Memuat metadata dan isi lorebook…
              </p>
            )}
            {loreRefs.map((ref) => {
              const key = loreRefKey(ref);
              const data = loreData[key];
              const error = loreErrors[key];
              const missing = loreMissing[key] === true;
              return (
                <article className="feature feature-empty" key={key}>
                  <div className="feature-copy">
                    <h3>{data?.header.name ?? `Lorebook ${ref.packId}`}</h3>
                    {data?.header.description && (
                      <p>{data.header.description}</p>
                    )}
                    {data && (
                      <>
                        <p className="hint">
                          Versi {ref.version} · {data.header.entryCount} entri ·{" "}
                          {data.header.linkCount} tautan
                        </p>
                        {data.total !== data.header.entryCount && (
                          <p className="hint">
                            API melaporkan {data.total} entri pada versi ini.
                          </p>
                        )}
                        <p className="hint">
                          ID pack: <code>{ref.packId}</code>
                        </p>
                      </>
                    )}
                    {missing && (
                      <p className="error" role="alert">
                        Versi lorebook yang dirujuk tidak ditemukan.
                        {data && " Data terakhir tetap ditampilkan."}
                      </p>
                    )}
                    {error && (
                      <p className="error" role="alert">
                        Lorebook gagal dimuat: {error}
                        {data && " Data terakhir tetap ditampilkan."}
                      </p>
                    )}
                    {!data && loreLoading && (
                      <p className="hint" role="status">
                        Memuat lorebook…
                      </p>
                    )}
                    {!data && !loreLoading && (error || missing) && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setLoreRetry((retry) => retry + 1)}
                      >
                        Coba lagi
                      </button>
                    )}
                    {!data && !loreLoading && !error && !missing && (
                      <p className="hint">
                        Belum ada data lorebook yang dimuat.
                      </p>
                    )}
                    {data && data.entries.length === 0 && data.total === 0 && (
                      <p className="hint">
                        Versi lorebook ini tidak memiliki entri.
                      </p>
                    )}
                    {data && data.entries.length > 0 && (
                      <ul className="fact-list">
                        {data.entries.map((lore) => (
                          <li className="fact-row" key={lore.id}>
                            <details>
                              <summary>
                                {lore.name} · {lore.kind}
                              </summary>
                              {lore.summary && <p>{lore.summary}</p>}
                              {lore.body && <p>{lore.body}</p>}
                              <p className="hint">
                                Visibilitas: {lore.visibility}
                                {lore.tags.length > 0 &&
                                  ` · ${lore.tags.join(", ")}`}
                              </p>
                            </details>
                          </li>
                        ))}
                      </ul>
                    )}
                    {data && data.entries.length < data.total && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => void loadMoreLore(ref)}
                        disabled={loreMoreLoading[key] === true}
                      >
                        {loreMoreLoading[key]
                          ? "Memuat entri…"
                          : `Muat entri selanjutnya (${data.entries.length} dari ${data.total})`}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </>
        )}
      </section>

      <section aria-labelledby="world-ai-profile-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Narator</span>
            <h2 id="world-ai-profile-title">Profil AI.</h2>
          </div>
        </div>
        {defaultProfileId !== undefined ? (
          <>
            {selectedProfile && (
              <dl className="world-details">
                <div>
                  <dt>Nama</dt>
                  <dd>{selectedProfile.name}</dd>
                </div>
                <div>
                  <dt>Penyedia</dt>
                  <dd>{selectedProfile.provider}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{selectedProfile.model}</dd>
                </div>
              </dl>
            )}
            {profileLoading && (
              <p className="hint" role="status">
                Memuat profil AI…
              </p>
            )}
            {profileError && (
              <p className="error" role="alert">
                Profil AI gagal dimuat: {profileError}
                {selectedProfile && " Metadata terakhir tetap ditampilkan."}
              </p>
            )}
            {!profileLoading && !profileError && !selectedProfile && (
              <p className="error" role="alert">
                Profil AI bawaan ({defaultProfileId}) tidak ditemukan.
              </p>
            )}
            {!profileLoading && (profileError || !selectedProfile) && (
              <button
                type="button"
                className="quiet"
                onClick={() => setProfileRetry((retry) => retry + 1)}
              >
                Coba lagi
              </button>
            )}
          </>
        ) : (
          <dl className="world-details">
            <div>
              <dt>Sumber</dt>
              <dd>Bawaan global</dd>
            </div>
            <div>
              <dt>Penyedia</dt>
              <dd>{defaultAi.provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{defaultAi.model}</dd>
            </div>
          </dl>
        )}
        <button type="button" className="quiet" onClick={onOpenSettings}>
          Pengaturan profil AI
        </button>
      </section>

      <ConfirmDialog
        open={pendingDuplicate !== null}
        title="Duplikat dunia?"
        message={`Buat salinan "${pendingDuplicate?.value.title ?? ""}"? Definisi dan referensi lorebook disalin; sesi, riwayat pesan, dan progres tidak disalin.`}
        confirmLabel={
          busyAction === "duplicate" ? "Menduplikasi…" : "Duplikat dunia"
        }
        onConfirm={() => void duplicateWorld()}
        onCancel={() => {
          setPendingDuplicate(null);
          setWorldError("");
        }}
        note={pendingDuplicate ? worldError : undefined}
        noteRole="alert"
        confirmDisabled={busyAction !== null}
        cancelDisabled={busyAction !== null}
      />
      <ConfirmDialog
        open={pendingSessionDelete !== null}
        title="Hapus sesi?"
        message={`Hapus sesi "${pendingSessionDelete?.value.name?.trim() || "Sesi tanpa nama"}" beserta riwayatnya secara permanen?`}
        confirmLabel={
          busyAction === "delete-session" ? "Menghapus…" : "Hapus sesi"
        }
        onConfirm={() => void deleteSelectedSession()}
        onCancel={() => setPendingSessionDelete(null)}
        secondaryAction={{
          label:
            pendingSessionDelete &&
            busyAction === `export-save:${pendingSessionDelete.value.id}`
              ? "Mengekspor save…"
              : "Export save",
          onClick: () => {
            if (pendingSessionDelete) {
              void exportSession(pendingSessionDelete, true);
            }
          },
          disabled: busyAction !== null,
        }}
        note={sessionDeleteNote}
        noteRole={sessionDeleteNoteRole}
        confirmDisabled={busyAction !== null}
        cancelDisabled={busyAction !== null}
      />
      <ConfirmDialog
        open={pendingWorldDelete !== null}
        title="Hapus dunia?"
        message={`Hapus "${pendingWorldDelete?.value.title ?? ""}" beserta seluruh sesi, riwayat pesan, dan data run-nya secara permanen? Backup opsional mencakup seluruh database.`}
        confirmLabel={
          busyAction === "delete-world" ? "Menghapus…" : "Hapus permanen"
        }
        onConfirm={() => void deleteSelectedWorld()}
        onCancel={() => {
          setPendingWorldDelete(null);
          setWorldDialogNote("");
        }}
        secondaryAction={{
          label:
            busyAction === "backup-world" ? "Membuat backup…" : "Backup dulu",
          onClick: () => void backupBeforeWorldDelete(),
          disabled: busyAction !== null,
        }}
        note={worldDialogNote}
        noteRole={worldDialogNoteRole}
        confirmDisabled={busyAction !== null}
        cancelDisabled={busyAction !== null}
      />
    </section>
  );
}
