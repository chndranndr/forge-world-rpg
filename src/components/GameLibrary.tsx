import { useRef, useState } from "react";
import {
  ApiError,
  createBackup,
  deleteGame,
  exportGameTemplate,
  type BackupRecord,
  type GameRecord,
} from "../api";
import {
  validateDefinition,
  validatePlayability,
} from "../../shared/validation.js";
import { exportTemplate } from "../template";
import ConfirmDialog from "./ConfirmDialog";
import {
  latestOverall,
  latestSession,
  relativeTime,
  sortByActivity,
  sortedSessions,
  type GameEntry,
} from "../library";
import type { GameDefinition } from "../types";
import { storyIllustration } from "../illustrations";

interface GameLibraryProps {
  entries: GameEntry[] | null;
  loading: boolean;
  loadError: string | null;
  onRefresh: () => Promise<void>;
  onCreateWorld: () => void;
  onOpenWorld: (gameId: string) => void;
  onOpenEditor: (gameId: string) => void;
  onStartSession: (sessionId: string) => void;
}

function downloadTemplate(bundle: unknown, title: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const slug = title.trim().replace(/\s+/g, "-").toLowerCase() || "template";
  link.href = url;
  link.download = `fworld-template-${slug}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function statusOf(game: GameDefinition, sessionCount: number): string {
  if (sessionCount > 0) return "Aktif";
  return validateDefinition(game).length === 0 &&
    validatePlayability(game).length === 0
    ? "Siap"
    : "Draft";
}

export default function GameLibrary({
  entries,
  loadError,
  loading,
  onRefresh,
  onCreateWorld,
  onOpenWorld,
  onOpenEditor,
  onStartSession,
}: GameLibraryProps) {
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [exportNotes, setExportNotes] = useState<Record<string, string>>({});
  const [exportErrors, setExportErrors] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<"backup" | "delete" | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<GameRecord | null>(null);
  const [deleteDialogNote, setDeleteDialogNote] = useState("");
  const [deleteDialogNoteRole, setDeleteDialogNoteRole] = useState<
    "status" | "alert"
  >("status");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  async function handleExportTemplate(record: GameRecord) {
    const game = record.value;
    try {
      let bundle;
      let note = "";
      try {
        bundle = await exportGameTemplate(game.id);
      } catch (error) {
        const offline =
          error instanceof TypeError ||
          (error instanceof ApiError && error.status >= 500);
        if (!offline) throw error;
        bundle = exportTemplate(game);
        note =
          "Backend tidak terjangkau; template dibuat dari data yang telah dimuat.";
      }
      downloadTemplate(bundle, game.title);
      setExportNotes((current) => ({ ...current, [game.id]: note }));
      setExportErrors((current) => ({ ...current, [game.id]: "" }));
    } catch (error) {
      setExportErrors((current) => ({
        ...current,
        [game.id]:
          error instanceof Error ? error.message : "Export template gagal.",
      }));
    }
  }

  function requestDelete(record: GameRecord) {
    setPendingDelete(record);
    setDeleteDialogNote("");
    setDeleteDialogNoteRole("status");
  }

  function backupDescription(backup: BackupRecord): string {
    return `Cadangan seluruh database dibuat · ${backup.id} · ${new Intl.NumberFormat("id-ID").format(backup.size)} byte · ${relativeTime(backup.createdAt)}.`;
  }

  async function backupBeforeDelete() {
    if (!pendingDelete || busyAction !== null) return;
    setBusyAction("backup");
    setDeleteDialogNote("");
    try {
      const backup = await createBackup();
      setDeleteDialogNote(
        `${backupDescription(backup)} Cadangan mencakup seluruh database, bukan hanya dunia ini.`,
      );
      setDeleteDialogNoteRole("status");
    } catch (error) {
      setDeleteDialogNote(
        error instanceof Error
          ? error.message
          : "Backup seluruh database gagal.",
      );
      setDeleteDialogNoteRole("alert");
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmDelete() {
    const record = pendingDelete;
    if (!record || busyAction !== null) return;
    const gameId = record.value.id;
    setBusyAction("delete");
    setDeleteDialogNote("");
    try {
      await deleteGame(gameId, record.revision);
      setDeleteErrors((current) => ({ ...current, [gameId]: "" }));
      await onRefresh();
      setPendingDelete(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await onRefresh();
        setPendingDelete(null);
      }
      const message =
        error instanceof Error ? error.message : "Game gagal dihapus.";
      setDeleteErrors((current) => ({ ...current, [gameId]: message }));
      setDeleteDialogNote(message);
      setDeleteDialogNoteRole("alert");
    } finally {
      setBusyAction(null);
    }
  }

  function clearSearch() {
    setSearch("");
    searchInputRef.current?.focus();
  }

  const query = search.trim().toLowerCase();
  const sortedEntries = sortByActivity(entries ?? []);
  const visible = sortedEntries.filter(({ game }) => {
    if (!query) return true;
    const candidate = game.value;
    return [candidate.title, candidate.genre ?? "", candidate.description ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const featured = latestOverall(entries ?? []);
  const featuredGame = featured?.game ?? sortedEntries[0]?.game;
  const featuredSession = featured?.session;
  const featuredState = featuredSession?.value.state;
  const featuredMeta = featuredSession
    ? [
        featuredGame?.value.genre,
        featuredState?.world.location,
        featuredState?.world.scene,
      ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" · ") || "Sesi tersimpan."
    : featuredGame
      ? [
          featuredGame.value.genre,
          statusOf(featuredGame.value, 0),
          relativeTime(featuredGame.value.updatedAt),
        ]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join(" · ")
      : "";

  return (
    <section aria-label="Perpustakaan game">
      {loadError && (
        <p className="error" role="alert">
          {entries
            ? "Perpustakaan tidak dapat diperbarui: "
            : "Backend tidak dapat dimuat: "}
          {loadError}{" "}
          {entries && <span>Data terakhir tetap ditampilkan. </span>}
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={loading}
          >
            {loading ? "Mencoba lagi…" : "Coba lagi"}
          </button>
        </p>
      )}

      {loading && (
        <p className="library-loading" role="status">
          {entries
            ? "Memperbarui perpustakaan…"
            : loadError
              ? "Mencoba lagi…"
              : "Memuat perpustakaan…"}
        </p>
      )}

      {entries && entries.length === 0 && (
        <article className="feature feature-empty">
          <div className="feature-copy">
            <span className="eyebrow">Mulai</span>
            <h2>Dunia pertamamu.</h2>
            <p>
              Mulai dari template contoh, lalu ubah latar, karakter, dan cara
              dunia bekerja.
            </p>
            <button type="button" className="primary" onClick={onCreateWorld}>
              Buat dunia
            </button>
          </div>
        </article>
      )}

      {entries && entries.length > 0 && featuredGame && (
        <>
          <article
            className="feature"
            aria-label={
              featuredSession
                ? "Lanjutkan cerita"
                : `Dunia ${featuredGame.value.title}`
            }
          >
            <img
              src={storyIllustration(featuredGame.value)}
              width={900}
              height={600}
              alt=""
            />
            <div className="feature-copy">
              <span className="eyebrow">
                {featuredSession ? "Sedang dibuka" : "Dunia tersimpan"}
              </span>
              <h2>{featuredGame.value.title}</h2>
              <p>{featuredMeta}</p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (featuredSession) onStartSession(featuredSession.value.id);
                  else onOpenWorld(featuredGame.value.id);
                }}
              >
                {featuredSession ? "Lanjutkan cerita" : "Buka dunia"}
              </button>
            </div>
          </article>

          <div className="section-head">
            <div>
              <span className="eyebrow">Dunia kamu</span>
              <h2>Perjalanan yang tersimpan.</h2>
              <p className="hint" role="status" aria-live="polite">
                {query
                  ? `${visible.length} dari ${sortedEntries.length} dunia`
                  : `${sortedEntries.length} dunia`}
              </p>
            </div>
            <div className="library-tools">
              <label className="search">
                <span className="sr">Cari dunia</span>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Cari dunia…"
                />
              </label>
              {query && visible.length > 0 && (
                <button
                  type="button"
                  className="quiet"
                  aria-label="Hapus pencarian"
                  onClick={clearSearch}
                >
                  Hapus pencarian
                </button>
              )}
              <button type="button" className="quiet" onClick={onCreateWorld}>
                Dunia baru
              </button>
            </div>
          </div>

          {visible.length === 0 && (
            <div className="empty">
              <p role="status" aria-live="polite">
                Tidak ada dunia yang cocok dengan pencarian.
              </p>
              {query && (
                <button type="button" className="quiet" onClick={clearSearch}>
                  Hapus pencarian
                </button>
              )}
            </div>
          )}

          <div className="world-grid">
            {visible.map((entry) => {
              const record = entry.game;
              const game = record.value;
              const sessions = sortedSessions(entry);
              const latest = latestSession(entry);
              const olderSessions = sessions.slice(1);
              return (
                <article key={game.id} className="world">
                  <button
                    type="button"
                    className="world-hit"
                    aria-label={`Buka dunia ${game.title}`}
                    onClick={() => onOpenWorld(game.id)}
                  />
                  <img
                    src={storyIllustration(game)}
                    width={900}
                    height={600}
                    alt=""
                    loading="lazy"
                  />
                  <h3>{game.title}</h3>
                  <p>
                    {statusOf(game, entry.sessions.length)} ·{" "}
                    {game.genre || "Tanpa genre"} ·{" "}
                    {relativeTime(latest?.value.updatedAt ?? game.updatedAt)}
                  </p>
                  <details className="world-menu">
                    <summary aria-label={`Menu ${game.title}`}>⋮</summary>
                    <div className="world-menu-content">
                      <button
                        type="button"
                        onClick={() => onOpenEditor(game.id)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleExportTemplate(record)}
                      >
                        Export template
                      </button>
                      <button
                        type="button"
                        onClick={() => requestDelete(record)}
                        disabled={busyAction !== null}
                      >
                        Hapus
                      </button>
                    </div>
                  </details>
                  {olderSessions.length > 0 && (
                    <details className="world-sessions">
                      <summary>{sessions.length} sesi</summary>
                      <ul>
                        {olderSessions.map((session) => (
                          <li key={session.value.id}>
                            <button
                              type="button"
                              onClick={() => onStartSession(session.value.id)}
                            >
                              Sesi · {relativeTime(session.value.updatedAt)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {exportNotes[game.id] && (
                    <p className="hint" role="status">
                      {exportNotes[game.id]}
                    </p>
                  )}
                  {exportErrors[game.id] && (
                    <p className="error" role="alert">
                      {exportErrors[game.id]}
                    </p>
                  )}
                  {deleteErrors[game.id] && (
                    <p className="error" role="alert">
                      {deleteErrors[game.id]}
                    </p>
                  )}
                </article>
              );
            })}
          </div>

          <p className="footer-note">
            Dunia dan progres tersimpan di backend lokal. Gunakan menu kartu
            untuk mengedit, mengekspor, atau menghapus cerita.
          </p>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Hapus dunia?"
        message={`Hapus "${pendingDelete?.value.title ?? ""}" beserta seluruh sesi, riwayat pesan, dan data run-nya secara permanen? Backup opsional mencakup seluruh database.`}
        confirmLabel={busyAction === "delete" ? "Menghapus…" : "Hapus permanen"}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteDialogNote("");
        }}
        secondaryAction={{
          label: busyAction === "backup" ? "Membuat backup…" : "Backup dulu",
          onClick: () => void backupBeforeDelete(),
          disabled: busyAction !== null,
        }}
        note={deleteDialogNote}
        noteRole={deleteDialogNoteRole}
        confirmDisabled={busyAction !== null}
        cancelDisabled={busyAction !== null}
      />
    </section>
  );
}
