import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteGame,
  exportGameTemplate,
  listGames,
  listSessions,
  type GameRecord,
  type SessionRecord,
} from "../api";
import {
  validateDefinition,
  validatePlayability,
} from "../../shared/validation.js";
import { exportTemplate } from "../template";
import type { GameDefinition, ItemDefinition, NpcDefinition } from "../types";
import exampleTemplate from "../../examples/game-template.json";

interface GameLibraryProps {
  onCreateDraft: (game: GameDefinition) => void;
  onOpenEditor: (gameId: string) => void;
  onStartSession: (sessionId: string) => void;
}

interface GameEntry {
  game: GameRecord;
  sessions: SessionRecord[];
}

function seededGame(): GameDefinition {
  const example = exampleTemplate.game;
  return {
    id: crypto.randomUUID(),
    title: example.title,
    description: example.description,
    genre: example.genre,
    tone: example.tone,
    language: example.language,
    scenario: { ...example.scenario },
    attributes: structuredClone(example.attributes),
    resources: structuredClone(example.resources),
    relationships: structuredClone(example.relationships),
    items: structuredClone(example.items) as ItemDefinition[],
    player: structuredClone(example.player),
    npcs: structuredClone(example.npcs) as unknown as NpcDefinition[],
    startingInventory: structuredClone(example.startingInventory),
    updatedAt: new Date().toISOString(),
  };
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

export default function GameLibrary({
  onCreateDraft,
  onOpenEditor,
  onStartSession,
}: GameLibraryProps) {
  const [entries, setEntries] = useState<GameEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [exportNotes, setExportNotes] = useState<Record<string, string>>({});
  const [exportErrors, setExportErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    try {
      const games = await listGames();
      games.sort((a, b) => (a.value.updatedAt < b.value.updatedAt ? 1 : -1));
      const withSessions = await Promise.all(
        games.map(async (game) => ({
          game,
          sessions: await listSessions(game.value.id),
        })),
      );
      setEntries(withSessions);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Backend tidak tersedia.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  function statusOf(game: GameDefinition, sessions: SessionRecord[]): string {
    if (sessions.length > 0) return "Aktif";
    return validateDefinition(game).length === 0 &&
      validatePlayability(game).length === 0
      ? "Siap"
      : "Draft";
  }

  async function handleDelete(record: GameRecord) {
    const gameId = record.value.id;
    setBusy(true);
    try {
      await deleteGame(gameId, record.revision);
      setDeleteErrors((current) => ({ ...current, [gameId]: "" }));
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await refresh();
      setDeleteErrors((current) => ({
        ...current,
        [gameId]:
          error instanceof Error ? error.message : "Game gagal dihapus.",
      }));
    } finally {
      setBusy(false);
    }
  }

  if (!entries) {
    return (
      <section aria-label="Perpustakaan game">
        <p role={loadError ? "alert" : "status"}>
          {loadError ?? "Memuat perpustakaan…"}
        </p>
        {loadError && <button onClick={() => void refresh()}>Coba lagi</button>}
        <button
          type="button"
          className="primary"
          onClick={() => onCreateDraft(seededGame())}
        >
          Buat draft game
        </button>
      </section>
    );
  }

  const query = search.trim().toLowerCase();
  const visible = entries.filter(
    ({ game }) => !query || game.value.title.toLowerCase().includes(query),
  );
  const latestOverall = entries
    .flatMap(({ game, sessions }) =>
      sessions.map((session) => ({ game, session })),
    )
    .sort((a, b) =>
      a.session.value.updatedAt < b.session.value.updatedAt ? 1 : -1,
    )[0];

  return (
    <section aria-label="Perpustakaan game">
      <p className="eyebrow">Perpustakaan ceritamu</p>
      <h2 className="hero">Dunia untuk kembali.</h2>
      <p className="intro-line">Lanjutkan ceritamu, atau mulai yang baru.</p>
      {loadError && (
        <p className="error" role="alert">
          Backend tidak dapat dimuat: {loadError}{" "}
          <button onClick={() => void refresh()}>Coba lagi</button>
        </p>
      )}

      {latestOverall && (
        <>
          <h2>Lanjutkan bermain</h2>
          <article className="card featured">
            <h3>{latestOverall.game.value.title}</h3>
            <p className="hint">
              Diperbarui {latestOverall.session.value.updatedAt}
            </p>
            <button
              type="button"
              className="primary wide"
              onClick={() => onStartSession(latestOverall.session.value.id)}
            >
              Lanjutkan cerita →
            </button>
          </article>
        </>
      )}

      <div className="section-head">
        <h2>Dunia kamu</h2>
        <span className="hint">{entries.length} game</span>
      </div>
      <button
        type="button"
        className="primary wide"
        onClick={() => onCreateDraft(seededGame())}
      >
        Buat game baru
      </button>
      <p className="hint">
        Game baru dibuat terisi contoh cerita lengkap (atribut, sumber daya,
        relasi, item, NPC, inventaris) sebagai bahan contoh; semua bagian bebas
        diedit atau dihapus.
      </p>
      {entries.length > 0 && (
        <label>
          Cari
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari judul game…"
          />
        </label>
      )}
      {entries.length === 0 && <p>Belum ada game. Buat satu untuk memulai.</p>}
      {entries.length > 0 && visible.length === 0 && (
        <p>Tidak ada game yang cocok dengan pencarian.</p>
      )}
      <div className="library-list">
        {visible.map(({ game: record, sessions: sessionRecords }) => {
          const game = record.value;
          const sessions = sessionRecords.map((entry) => entry.value);
          const sorted = [...sessions].sort((a, b) =>
            a.updatedAt < b.updatedAt ? 1 : -1,
          );
          const latest = sorted[0];
          const status = statusOf(game, sessionRecords);
          return (
            <article key={game.id} className="card">
              <h3>{game.title}</h3>
              <p className="hint">
                {status} · {game.genre || "(tanpa genre)"} · Diperbarui:{" "}
                {game.updatedAt}
              </p>
              {latest && (
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onStartSession(latest.id)}
                  >
                    Lanjutkan sesi terbaru
                  </button>
                </div>
              )}
              <div className="row">
                <button type="button" onClick={() => onOpenEditor(game.id)}>
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
                  onClick={() => void handleDelete(record)}
                  disabled={busy}
                >
                  Hapus
                </button>
              </div>
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
              {sorted.length > 1 && (
                <ul className="session-list">
                  {sorted.slice(1).map((session) => (
                    <li key={session.id}>
                      <span>
                        Sesi {session.id.slice(0, 8)} ({session.updatedAt})
                      </span>
                      <button
                        type="button"
                        onClick={() => onStartSession(session.id)}
                      >
                        Lanjutkan
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
