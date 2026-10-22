import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listGames, listSessions } from "./api";
import {
  loadAiDefaults,
  storeAiDefaults,
  type AiDefaults,
} from "./ai-defaults";
import GameEditor, { type GameEditorHandle } from "./components/GameEditor";
import CreateWorld from "./components/CreateWorld";
import GameLibrary from "./components/GameLibrary";
import WorldDetail from "./components/WorldDetail";
import NavigationRail, {
  type RailTarget,
  type RailWorld,
} from "./components/NavigationRail";
import SessionView from "./components/SessionView";
import SettingsPanel from "./components/SettingsPanel";
import {
  latestOverall,
  latestSession,
  relativeTime,
  sortByActivity,
  type GameEntry,
} from "./library";
import type { AiConfig, GameDefinition } from "./types";

type View =
  | { kind: "library" }
  | { kind: "settings" }
  | { kind: "session-settings"; sessionId: string; originGameId?: string }
  | { kind: "editor"; gameId: string; originGameId?: string }
  | { kind: "world"; gameId: string }
  | { kind: "create-world" }
  | { kind: "session"; sessionId: string; originGameId?: string };

const TEXT_SIZE_KEY = "fworld-text-size";
type TextSize = "normal" | "large";

const PAGE_HEADINGS: Record<View["kind"], { eyebrow: string; title: string }> =
  {
    library: { eyebrow: "Perpustakaan", title: "Dunia untuk kembali." },
    session: { eyebrow: "Sesi berlangsung", title: "Suara dari cerita." },
    settings: { eyebrow: "Preferensi", title: "Ruangmu, caramu." },
    "session-settings": {
      eyebrow: "Preferensi sesi",
      title: "Ruangmu, caramu.",
    },
    editor: { eyebrow: "Penyuntingan", title: "Rancang duniamu." },
    world: { eyebrow: "Dunia tersimpan", title: "Ruang untuk ceritamu." },
    "create-world": { eyebrow: "Buat dunia", title: "Pilih titik awal." },
  };

function loadTextSize(): TextSize {
  try {
    if (typeof localStorage === "undefined") return "normal";
    return localStorage.getItem(TEXT_SIZE_KEY) === "large" ? "large" : "normal";
  } catch {
    return "normal";
  }
}

function storeTextSize(size: TextSize): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    // Preferensi tampilan tidak kritis; abaikan kegagalan storage.
  }
}

export default function App() {
  const [aiDefaults, setAiDefaults] = useState<AiDefaults>(loadAiDefaults);
  const { provider, models, systemPrompt } = aiDefaults;
  const [view, setView] = useState<View>({ kind: "library" });
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize);
  const [focusMode, setFocusMode] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<GameDefinition | null>(null);
  const [entries, setEntries] = useState<GameEntry[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const editorRef = useRef<GameEditorHandle>(null);
  const libraryRequestId = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.textSize = textSize;
    storeTextSize(textSize);
  }, [textSize]);
  useEffect(() => {
    storeAiDefaults(aiDefaults);
  }, [aiDefaults]);

  const refreshLibrary = useCallback(async () => {
    const requestId = ++libraryRequestId.current;
    setLibraryLoading(true);
    try {
      const games = await listGames();
      const withSessions = await Promise.all(
        games.map(async (game) => ({
          game,
          sessions: await listSessions(game.value.id),
        })),
      );
      if (requestId !== libraryRequestId.current) return;
      setEntries(sortByActivity(withSessions));
      setLibraryError(null);
    } catch (error) {
      if (requestId !== libraryRequestId.current) return;
      setLibraryError(
        error instanceof Error ? error.message : "Backend tidak tersedia.",
      );
    } finally {
      if (requestId === libraryRequestId.current) setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const defaultAi: AiConfig = {
    provider,
    model: models[provider],
    systemPrompt,
  };

  const entriesList = entries ?? [];
  const currentSessionId =
    view.kind === "session" || view.kind === "session-settings"
      ? view.sessionId
      : undefined;
  const focusActive = view.kind === "session" && focusMode;
  const latestSessionId = latestOverall(entriesList)?.session.value.id;
  const activeRail: RailTarget =
    view.kind === "settings"
      ? "settings"
      : view.kind === "session" || view.kind === "session-settings"
        ? "session"
        : "library";

  const recent: RailWorld[] = sortByActivity(entriesList)
    .slice(0, 3)
    .map((entry) => {
      const latest = latestSession(entry);
      const count = entry.sessions.length;
      return {
        gameId: entry.game.value.id,
        title: entry.game.value.title,
        meta: latest
          ? `${count} sesi · ${relativeTime(latest.value.updatedAt)}`
          : `Draft · ${relativeTime(entry.game.value.updatedAt)}`,
        ...(latest ? { sessionId: latest.value.id } : {}),
      };
    });

  function applyView(destination: View) {
    setFocusMode(false);
    const leavingEditor =
      view.kind === "editor" &&
      !(destination.kind === "editor" && destination.gameId === view.gameId);
    const leavingCreation =
      view.kind === "create-world" && destination.kind !== "editor";
    if (leavingEditor || leavingCreation) setPendingDraft(null);
    setView(destination);
    if (
      (view.kind === "session" || view.kind === "session-settings") &&
      (destination.kind === "library" || destination.kind === "world")
    ) {
      void refreshLibrary();
    }
  }

  function requestView(destination: View) {
    const leavingEditor =
      view.kind === "editor" &&
      !(destination.kind === "editor" && destination.gameId === view.gameId);
    if (leavingEditor && editorRef.current) {
      editorRef.current.requestNavigation(() => applyView(destination));
      return;
    }
    applyView(destination);
  }

  function navigate(target: RailTarget) {
    if (target === "library") {
      requestView({ kind: "library" });
      return;
    }
    if (target === "session") {
      const sessionId = currentSessionId ?? latestSessionId;
      const originGameId =
        view.kind === "session" || view.kind === "session-settings"
          ? view.originGameId
          : undefined;
      if (sessionId) {
        requestView({
          kind: "session",
          sessionId,
          ...(originGameId === undefined ? {} : { originGameId }),
        });
      }
      return;
    }
    requestView({ kind: "settings" });
  }

  function openWorld(world: RailWorld) {
    requestView({ kind: "world", gameId: world.gameId });
  }

  const heading = PAGE_HEADINGS[view.kind];
  let headerAction: ReactNode = null;
  if (view.kind === "library") {
    headerAction = (
      <button
        type="button"
        className="quiet"
        onClick={() => requestView({ kind: "settings" })}
      >
        Pengaturan
      </button>
    );
  } else if (view.kind === "session") {
    headerAction = (
      <button
        type="button"
        className="quiet"
        onClick={() =>
          requestView({
            kind: "session-settings",
            sessionId: view.sessionId,
            ...(view.originGameId === undefined
              ? {}
              : { originGameId: view.originGameId }),
          })
        }
      >
        Pengaturan
      </button>
    );
  } else if (view.kind === "session-settings") {
    headerAction = (
      <button
        type="button"
        className="quiet"
        onClick={() =>
          requestView({
            kind: "session",
            sessionId: view.sessionId,
            ...(view.originGameId === undefined
              ? {}
              : { originGameId: view.originGameId }),
          })
        }
      >
        Kembali ke sesi
      </button>
    );
  } else if (view.kind === "settings") {
    headerAction = (
      <button
        type="button"
        className="quiet"
        onClick={() => requestView({ kind: "library" })}
      >
        Perpustakaan
      </button>
    );
  } else if (view.kind === "world" || view.kind === "create-world") {
    headerAction = (
      <button
        type="button"
        className="quiet"
        onClick={() => requestView({ kind: "library" })}
      >
        Perpustakaan
      </button>
    );
  }

  return (
    <>
      {!focusActive && (
        <NavigationRail
          active={activeRail}
          canOpenSession={latestSessionId !== undefined}
          recent={recent}
          onNavigate={navigate}
          onOpenWorld={openWorld}
          hideOnMobile={view.kind === "session"}
        />
      )}
      <main
        className={`main${focusActive ? " focus-mode" : ""}${view.kind === "session" ? " main-session" : ""}`}
      >
        {view.kind !== "session" && (
          <header className="top">
            <div>
              <span className="eyebrow">{heading.eyebrow}</span>
              <h1>{heading.title}</h1>
            </div>
            {headerAction}
          </header>
        )}
        {view.kind === "library" && (
          <GameLibrary
            entries={entries}
            loadError={libraryError}
            loading={libraryLoading}
            onRefresh={refreshLibrary}
            onCreateWorld={() => {
              setPendingDraft(null);
              requestView({ kind: "create-world" });
            }}
            onOpenWorld={(gameId) => requestView({ kind: "world", gameId })}
            onOpenEditor={(gameId) => requestView({ kind: "editor", gameId })}
            onStartSession={(sessionId) =>
              requestView({ kind: "session", sessionId })
            }
          />
        )}
        {view.kind === "world" && (
          <WorldDetail
            entry={entriesList.find(
              (entry) => entry.game.value.id === view.gameId,
            )}
            defaultAi={defaultAi}
            {...(aiDefaults.defaultProfileId === undefined
              ? {}
              : { defaultProfileId: aiDefaults.defaultProfileId })}
            onBack={() => requestView({ kind: "library" })}
            onEdit={(gameId) =>
              requestView({
                kind: "editor",
                gameId,
                originGameId: gameId,
              })
            }
            onOpenSettings={() => requestView({ kind: "settings" })}
            onContinue={(sessionId) =>
              requestView({
                kind: "session",
                sessionId,
                originGameId: view.gameId,
              })
            }
            onRefresh={refreshLibrary}
          />
        )}
        {view.kind === "create-world" && (
          <CreateWorld
            onBack={() => requestView({ kind: "library" })}
            onSelectDraft={(draft) => {
              setPendingDraft(draft);
              requestView({
                kind: "editor",
                gameId: draft.id,
                originGameId: draft.id,
              });
            }}
          />
        )}
        {view.kind === "settings" && (
          <SettingsPanel
            mode="global"
            aiDefaults={aiDefaults}
            onSaveAiDefaults={setAiDefaults}
            textSize={textSize}
            onTextSizeChange={setTextSize}
          />
        )}
        {view.kind === "session-settings" && (
          <SettingsPanel
            key={`session-${view.sessionId}`}
            mode="session"
            sessionId={view.sessionId}
            textSize={textSize}
            onTextSizeChange={setTextSize}
            onReturnToSession={() =>
              requestView({
                kind: "session",
                sessionId: view.sessionId,
                ...(view.originGameId === undefined
                  ? {}
                  : { originGameId: view.originGameId }),
              })
            }
          />
        )}
        {view.kind === "editor" && (
          <GameEditor
            ref={editorRef}
            key={view.gameId}
            gameId={view.gameId}
            initialDraft={pendingDraft}
            defaultAi={defaultAi}
            {...(aiDefaults.defaultProfileId === undefined
              ? {}
              : { defaultProfileId: aiDefaults.defaultProfileId })}
            onBack={() => applyView({ kind: "library" })}
            onOpenSettings={() => applyView({ kind: "settings" })}
            onDraftPersisted={async () => {
              await refreshLibrary();
              setPendingDraft(null);
            }}
            onStarted={(sessionId) => {
              void refreshLibrary();
              applyView({
                kind: "session",
                sessionId,
                ...(view.originGameId === undefined
                  ? {}
                  : { originGameId: view.originGameId }),
              });
            }}
          />
        )}
        {view.kind === "session" && (
          <SessionView
            key={view.sessionId}
            sessionId={view.sessionId}
            onBack={() =>
              applyView(
                view.originGameId
                  ? { kind: "world", gameId: view.originGameId }
                  : { kind: "library" },
              )
            }
            onOpenSettings={() =>
              requestView({
                kind: "session-settings",
                sessionId: view.sessionId,
                ...(view.originGameId === undefined
                  ? {}
                  : { originGameId: view.originGameId }),
              })
            }
            focusMode={focusActive}
            onFocusModeChange={setFocusMode}
            textSize={textSize}
            onTextSizeChange={setTextSize}
          />
        )}
      </main>
    </>
  );
}
