import { useEffect, useState } from "react";
import { DEFAULT_MODELS, type ProviderId } from "./llm";
import GameEditor from "./components/GameEditor";
import GameLibrary from "./components/GameLibrary";
import SessionView from "./components/SessionView";
import SettingsPanel from "./components/SettingsPanel";
import type { AiConfig, GameDefinition } from "./types";

type View =
  | { kind: "library" }
  | { kind: "settings" }
  | { kind: "editor"; gameId: string }
  | { kind: "session"; sessionId: string };

const TEXT_SIZE_KEY = "fworld-text-size";
type TextSize = "normal" | "large";

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
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [models, setModels] =
    useState<Record<ProviderId, string>>(DEFAULT_MODELS);
  const [view, setView] = useState<View>({ kind: "library" });
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize);
  const [pendingDraft, setPendingDraft] = useState<GameDefinition | null>(null);

  useEffect(() => {
    document.documentElement.dataset.textSize = textSize;
    storeTextSize(textSize);
  }, [textSize]);

  const defaultAi: AiConfig = { provider, model: models[provider] };

  return (
    <>
      <header className="app-header">
        <h1 className="brand">
          <span aria-hidden="true">♧</span> Fworld
        </h1>
        {view.kind !== "editor" && (
          <button
            type="button"
            className="header-settings"
            aria-label="Pengaturan"
            onClick={() => setView({ kind: "settings" })}
          >
            <span aria-hidden="true">⚙</span>
          </button>
        )}
      </header>
      <main>
        {view.kind === "library" && (
          <GameLibrary
            onCreateDraft={(game) => {
              setPendingDraft(game);
              setView({ kind: "editor", gameId: game.id });
            }}
            onOpenEditor={(gameId) => setView({ kind: "editor", gameId })}
            onStartSession={(sessionId) =>
              setView({ kind: "session", sessionId })
            }
          />
        )}
        {view.kind === "settings" && (
          <SettingsPanel
            provider={provider}
            models={models}
            textSize={textSize}
            onProviderChange={(next) => setProvider(next)}
            onModelChange={(model) =>
              setModels({ ...models, [provider]: model })
            }
            onTextSizeChange={setTextSize}
          />
        )}
        {view.kind === "editor" && (
          <GameEditor
            key={view.gameId}
            gameId={view.gameId}
            initialDraft={pendingDraft}
            defaultAi={defaultAi}
            onBack={() => {
              setPendingDraft(null);
              setView({ kind: "library" });
            }}
            onOpenSettings={() => {
              setPendingDraft(null);
              setView({ kind: "settings" });
            }}
            onDraftPersisted={() => setPendingDraft(null)}
            onStarted={(sessionId) => {
              setPendingDraft(null);
              setView({ kind: "session", sessionId });
            }}
          />
        )}
        {view.kind === "session" && (
          <SessionView
            key={view.sessionId}
            sessionId={view.sessionId}
            onBack={() => setView({ kind: "library" })}
          />
        )}
      </main>
      {(view.kind === "library" || view.kind === "settings") && (
        <nav className="bottom-nav" aria-label="Navigasi utama">
          <button
            type="button"
            aria-current={view.kind === "library" ? "page" : undefined}
            onClick={() => {
              setPendingDraft(null);
              setView({ kind: "library" });
            }}
          >
            <span className="nav-icon" aria-hidden="true">
              ≣
            </span>
            Library
          </button>
          <button
            type="button"
            aria-current={view.kind === "settings" ? "page" : undefined}
            onClick={() => {
              setPendingDraft(null);
              setView({ kind: "settings" });
            }}
          >
            <span className="nav-icon" aria-hidden="true">
              ⚙
            </span>
            Settings
          </button>
        </nav>
      )}
    </>
  );
}
