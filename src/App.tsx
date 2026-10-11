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
  | { kind: "session-settings"; sessionId: string }
  | { kind: "editor"; gameId: string }
  | { kind: "session"; sessionId: string };

const TEXT_SIZE_KEY = "fworld-text-size";
const AI_DEFAULTS_KEY = "fworld-ai-defaults";
type TextSize = "normal" | "large";
type AiDefaults = {
  provider: ProviderId;
  models: Record<ProviderId, string>;
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

function defaultAiDefaults(): AiDefaults {
  return { provider: "gemini", models: { ...DEFAULT_MODELS } };
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "gemini" || value === "openrouter";
}

function isStoredModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200;
}

function loadAiDefaults(): AiDefaults {
  try {
    if (typeof localStorage === "undefined") return defaultAiDefaults();
    const raw = localStorage.getItem(AI_DEFAULTS_KEY);
    if (!raw) return defaultAiDefaults();
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("provider" in value) ||
      !isProviderId(value.provider) ||
      !("models" in value)
    ) {
      return defaultAiDefaults();
    }
    const models = value.models;
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models) ||
      !("gemini" in models) ||
      !isStoredModel(models.gemini) ||
      !("openrouter" in models) ||
      !isStoredModel(models.openrouter)
    ) {
      return defaultAiDefaults();
    }
    return {
      provider: value.provider,
      models: {
        gemini: models.gemini,
        openrouter: models.openrouter,
      },
    };
  } catch {
    return defaultAiDefaults();
  }
}

function storeAiDefaults(value: AiDefaults): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(AI_DEFAULTS_KEY, JSON.stringify(value));
  } catch {
    // Provider/model preferences are optional; never block story use on storage failure.
  }
}

export default function App() {
  const [aiDefaults, setAiDefaults] = useState(loadAiDefaults);
  const { provider, models } = aiDefaults;
  const [view, setView] = useState<View>({ kind: "library" });
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize);
  const [pendingDraft, setPendingDraft] = useState<GameDefinition | null>(null);

  useEffect(() => {
    document.documentElement.dataset.textSize = textSize;
    storeTextSize(textSize);
  }, [textSize]);
  useEffect(() => {
    storeAiDefaults(aiDefaults);
  }, [aiDefaults]);

  const defaultAi: AiConfig = { provider, model: models[provider] };

  return (
    <>
      <header className="app-header">
        <h1 className="brand">
          <span aria-hidden="true">♧</span> Fworld
        </h1>
        {(view.kind === "library" || view.kind === "session") && (
          <button
            type="button"
            className="header-settings"
            aria-label="Pengaturan"
            onClick={() =>
              setView(
                view.kind === "session"
                  ? { kind: "session-settings", sessionId: view.sessionId }
                  : { kind: "settings" },
              )
            }
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
            mode="global"
            provider={provider}
            models={models}
            textSize={textSize}
            onProviderChange={(nextProvider) =>
              setAiDefaults((current) => ({
                ...current,
                provider: nextProvider,
              }))
            }
            onModelChange={(model) =>
              setAiDefaults((current) => ({
                ...current,
                models: { ...current.models, [current.provider]: model },
              }))
            }
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
              setView({ kind: "session", sessionId: view.sessionId })
            }
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
