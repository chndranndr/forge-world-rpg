import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  ApiError,
  applySessionAiProfile,
  createBackup,
  getAiSettings,
  getHealth,
  getSession,
  getSessionAiProfile,
  importSave,
  listAiProfiles,
  listBackups,
  migrateLegacy,
  readLegacyMigration,
  restoreBackup,
  saveAiCredential,
  testAiConnection,
  updateSessionAi,
  type BackupRecord,
  type SessionAiProfileInfo,
} from "../api";
import { acquireWriteLock, readLegacySnapshot, releaseWriteLock } from "../db";
import { DEFAULT_MODELS, type ProviderId } from "../llm";
import type { AiConfig } from "../types";
import type { AiDefaults } from "../ai-defaults";
import type { AiProfile } from "../../shared/ai-profile";
import AiProfilesPanel from "./AiProfilesPanel";
import ConfirmDialog from "./ConfirmDialog";
import { TextSizeControl, type DataStatus } from "./SettingsPrimitives";
import {
  DEFAULT_NARRATOR_SYSTEM_PROMPT,
  MAX_NARRATOR_SYSTEM_PROMPT_CHARS,
  normalizeNarratorSystemPrompt,
} from "../../shared/narrator-prompt";

interface CommonSettingsPanelProps {
  textSize: "normal" | "large";
  onTextSizeChange: (size: "normal" | "large") => void;
}

type SettingsPanelProps = CommonSettingsPanelProps &
  (
    | {
        mode: "global";
        aiDefaults: AiDefaults;
        onSaveAiDefaults: (defaults: AiDefaults) => void;
      }
    | {
        mode: "session";
        sessionId: string;
        onReturnToSession: () => void;
      }
  );
const SETTINGS_TABS = [
  { id: "ai", label: "AI" },
  { id: "profiles", label: "Profil AI" },
  { id: "appearance", label: "Tampilan" },
  { id: "recovery", label: "Data & pemulihan" },
  { id: "backend", label: "Tentang backend" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function stableJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(sort(value));
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

export default function SettingsPanel(props: SettingsPanelProps) {
  const { textSize, onTextSizeChange } = props;
  const [backendStatus, setBackendStatus] = useState<DataStatus>("checking");
  const [backendHealth, setBackendHealth] = useState<{
    status: "ok";
    schemaVersion: number;
    nodeVersion: string;
  } | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Record<
    "gemini" | "openrouter",
    boolean
  > | null>(null);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<
    Record<"gemini" | "openrouter", string>
  >({ gemini: "", openrouter: "" });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialNote, setCredentialNote] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [sessionProfileId, setSessionProfileId] = useState("");
  const [sessionProfileInfo, setSessionProfileInfo] =
    useState<SessionAiProfileInfo | null>(null);
  const [sessionProfileBusy, setSessionProfileBusy] = useState(false);
  const [sessionProfileError, setSessionProfileError] = useState<string | null>(
    null,
  );
  const [sessionProfileNote, setSessionProfileNote] = useState<string | null>(
    null,
  );
  const [testState, setTestState] = useState<"idle" | "busy">("idle");
  const [testNote, setTestNote] = useState<string | null>(null);
  const testRequestRef = useRef(0);
  const [activeTab, setActiveTab] = useState<SettingsTab>("ai");
  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    ai: null,
    profiles: null,
    appearance: null,
    recovery: null,
    backend: null,
  });
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [backupList, setBackupList] = useState<BackupRecord[]>([]);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [diagnosticNote, setDiagnosticNote] = useState<string | null>(null);
  const [legacyCounts, setLegacyCounts] = useState<{
    games: number;
    sessions: number;
    messages: number;
  } | null>(null);
  const [legacyNote, setLegacyNote] = useState<string | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [sessionAiDraft, setSessionAiDraft] = useState<AiConfig | null>(null);
  const [persistedSessionAi, setPersistedSessionAi] = useState<AiConfig | null>(
    null,
  );
  const [sessionRevision, setSessionRevision] = useState<number | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionSaveError, setSessionSaveError] = useState<string | null>(null);
  const [sessionSaveNote, setSessionSaveNote] = useState<string | null>(null);
  const [sessionSaveBusy, setSessionSaveBusy] = useState(false);
  const [globalAiDraft, setGlobalAiDraft] = useState<AiDefaults | null>(() =>
    props.mode === "global" ? props.aiDefaults : null,
  );
  const [globalAiSaveError, setGlobalAiSaveError] = useState<string | null>(
    null,
  );
  const [globalAiSaveNote, setGlobalAiSaveNote] = useState<string | null>(null);
  const sessionId = props.mode === "session" ? props.sessionId : null;
  const aiDraft =
    props.mode === "global"
      ? globalAiDraft
        ? {
            provider: globalAiDraft.provider,
            model: globalAiDraft.models[globalAiDraft.provider],
            systemPrompt: globalAiDraft.systemPrompt,
          }
        : null
      : sessionAiDraft;
  const selectedProvider =
    aiDraft?.provider ??
    (props.mode === "global" ? props.aiDefaults.provider : "gemini");
  const showManualAiFields =
    props.mode === "session" ||
    globalAiDraft === null ||
    globalAiDraft.defaultProfileId === undefined;
  const selectedDefaultProfile =
    props.mode === "global" && globalAiDraft?.defaultProfileId !== undefined
      ? (profiles.find(
          (profile) => profile.id === globalAiDraft.defaultProfileId,
        ) ?? null)
      : null;
  const sessionAiDirty =
    props.mode === "session" &&
    sessionAiDraft !== null &&
    persistedSessionAi !== null &&
    (sessionAiDraft.provider !== persistedSessionAi.provider ||
      sessionAiDraft.model !== persistedSessionAi.model ||
      sessionAiDraft.systemPrompt !== persistedSessionAi.systemPrompt);
  const globalAiDirty =
    props.mode === "global" &&
    globalAiDraft !== null &&
    stableJson(globalAiDraft) !== stableJson(props.aiDefaults);
  const apiStatus =
    backendHealth?.status ??
    (backendStatus === "checking" ? "checking" : "unavailable");
  const diagnosticLine = [
    `origin=${window.location.origin}`,
    `api=${apiStatus}`,
    `schema=${backendHealth?.schemaVersion ?? "unavailable"}`,
    `node=${backendHealth?.nodeVersion ?? "unavailable"}`,
  ].join(" ");

  function selectSettingsTab(tab: SettingsTab): void {
    setActiveTab(tab);
    tabRefs.current[tab]?.focus();
  }

  function handleSettingsTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    current: SettingsTab,
  ): void {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.id === current);
    let next: SettingsTab | undefined;
    if (event.key === "Home") next = "ai";
    else if (event.key === "End") next = "backend";
    else if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = SETTINGS_TABS[(currentIndex + 1) % SETTINGS_TABS.length]?.id;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next =
        SETTINGS_TABS[
          (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
        ]?.id;
    if (!next) return;
    event.preventDefault();
    selectSettingsTab(next);
  }

  const refreshBackups = useCallback(async () => {
    try {
      setBackupList(await listBackups());
      setBackupError(null);
    } catch (error) {
      setBackupError(errorText(error, "Daftar backup tidak dapat dimuat."));
    }
  }, []);

  const loadProfiles = useCallback(async (): Promise<AiProfile[]> => {
    try {
      const list = await listAiProfiles();
      setProfiles(list);
      setProfilesError(null);
      return list;
    } catch (error) {
      setProfilesError(
        errorText(error, "Daftar profil AI tidak dapat dimuat."),
      );
      return [];
    }
  }, []);

  const upsertProfile = useCallback((profile: AiProfile) => {
    setProfiles((current) => {
      const index = current.findIndex((entry) => entry.id === profile.id);
      if (index === -1) {
        return [...current, profile].sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        );
      }
      const next = [...current];
      next[index] = profile;
      return next;
    });
  }, []);

  const refreshSessionProfileInfo = useCallback(async (id: string) => {
    try {
      setSessionProfileInfo(await getSessionAiProfile(id));
    } catch (error) {
      setSessionProfileInfo(null);
      setSessionProfileError(
        errorText(error, "Info profil sesi tidak dapat dimuat."),
      );
    }
  }, []);

  const refreshLegacyCounts = useCallback(async () => {
    try {
      const snapshot = await readLegacySnapshot();
      setLegacyCounts({
        games: snapshot.games.length,
        sessions: snapshot.sessions.length,
        messages: snapshot.messages.length,
      });
    } catch (error) {
      setLegacyNote(
        errorText(error, "Data IndexedDB lama tidak dapat dibaca."),
      );
    }
  }, []);

  useEffect(() => {
    void getHealth()
      .then((health) => {
        setBackendHealth(health);
        setBackendStatus("ready");
        setBackendError(null);
      })
      .catch((error: unknown) => {
        setBackendHealth(null);
        setBackendStatus("unavailable");
        setBackendError(errorText(error, "API backend lokal tidak tersedia."));
      });
    void getAiSettings()
      .then((settings) => {
        setConfigured({
          gemini: settings.providers.gemini.configured,
          openrouter: settings.providers.openrouter.configured,
        });
        setAiSettingsError(null);
      })
      .catch((error: unknown) => {
        setConfigured(null);
        setAiSettingsError(
          errorText(error, "Status provider tidak dapat dimuat."),
        );
      });
    void refreshBackups();
    void refreshLegacyCounts();
    void loadProfiles();
  }, [refreshBackups, refreshLegacyCounts, loadProfiles]);
  useEffect(() => {
    if (sessionId === null) return;
    let active = true;
    setSessionAiDraft(null);
    setPersistedSessionAi(null);
    setSessionRevision(null);
    setSessionLoadError(null);
    setSessionSaveError(null);
    setSessionSaveNote(null);
    setSessionProfileId("");
    setSessionProfileInfo(null);
    setSessionProfileError(null);
    setSessionProfileNote(null);
    void getSession(sessionId)
      .then((record) => {
        if (!active) return;
        const ai = {
          ...record.value.ai,
          systemPrompt: normalizeNarratorSystemPrompt(
            record.value.ai.systemPrompt,
          ),
        };
        setSessionAiDraft(ai);
        setPersistedSessionAi(ai);
        setSessionRevision(record.revision);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSessionLoadError(
          errorText(error, "Konfigurasi AI sesi gagal dimuat."),
        );
      });
    void getSessionAiProfile(sessionId)
      .then((info) => {
        if (active) setSessionProfileInfo(info);
      })
      .catch(() => {
        if (active) setSessionProfileInfo(null);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    testRequestRef.current += 1;
    setTestNote(null);
  }, [
    aiDraft?.provider,
    aiDraft?.model,
    aiDraft?.systemPrompt,
    sessionProfileId,
    credentialDrafts,
  ]);

  async function handleTest() {
    if (!aiDraft) return;
    if (!aiDraft.model.trim()) {
      setTestNote("Model wajib diisi sebelum menguji koneksi.");
      return;
    }
    setTestState("busy");
    setTestNote(null);
    const request = ++testRequestRef.current;
    try {
      const result = await testAiConnection({
        provider: aiDraft.provider,
        model: aiDraft.model.trim(),
        ...(sessionId === null ? {} : { sessionId }),
      });
      if (request !== testRequestRef.current) return;
      setTestNote(result.message);
    } catch (error) {
      if (request !== testRequestRef.current) return;
      setTestNote(
        `Uji koneksi gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setTestState("idle");
    }
  }
  async function handleCopyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticLine);
      setDiagnosticNote("Baris diagnostik disalin.");
    } catch {
      setDiagnosticNote(
        "Tidak dapat menyalin otomatis. Pilih dan salin baris di atas.",
      );
    }
  }

  function updateGlobalAiDraft(
    update: (current: AiDefaults) => AiDefaults,
  ): void {
    setGlobalAiDraft((current) => (current ? update(current) : current));
    setGlobalAiSaveError(null);
    setGlobalAiSaveNote(null);
  }

  function handleSaveGlobalAi(): void {
    if (props.mode !== "global" || !globalAiDraft) return;
    setGlobalAiSaveError(null);
    setGlobalAiSaveNote(null);
    const defaultProfileId = globalAiDraft.defaultProfileId;
    try {
      if (defaultProfileId !== undefined) {
        if (!profiles.some((profile) => profile.id === defaultProfileId)) {
          setGlobalAiSaveError(
            "Profil default tidak ditemukan. Pilih profil lain, lalu simpan lagi.",
          );
          return;
        }
        props.onSaveAiDefaults({ ...globalAiDraft, defaultProfileId });
        setGlobalAiSaveNote("Pengaturan AI default disimpan.");
        return;
      }
      const provider = globalAiDraft.provider;
      if (provider === "custom") {
        setGlobalAiSaveError(
          "Provider custom hanya tersedia melalui profil AI. Pilih profil default atau provider manual lain.",
        );
        return;
      }
      const saved: AiDefaults = {
        ...globalAiDraft,
        models: {
          ...globalAiDraft.models,
          [provider]:
            globalAiDraft.models[provider].trim() || DEFAULT_MODELS[provider],
        },
        systemPrompt: normalizeNarratorSystemPrompt(globalAiDraft.systemPrompt),
      };
      props.onSaveAiDefaults(saved);
      setGlobalAiDraft(saved);
      setGlobalAiSaveNote("Pengaturan AI default disimpan.");
    } catch (error) {
      setGlobalAiSaveError(
        `Simpan pengaturan AI gagal: ${errorText(error, "Prompt tidak valid.")}`,
      );
    }
  }

  async function handleApplySessionProfile() {
    if (props.mode !== "session" || !sessionProfileId) return;
    const { sessionId } = props;
    if (sessionRevision === null) return;
    setSessionProfileBusy(true);
    setSessionProfileError(null);
    setSessionProfileNote(null);
    try {
      const saved = await applySessionAiProfile(
        sessionId,
        sessionRevision,
        sessionProfileId,
      );
      setSessionAiDraft(saved.value.ai);
      setPersistedSessionAi(saved.value.ai);
      setSessionRevision(saved.revision);
      setSessionSaveError(null);
      setSessionSaveNote(null);
      setTestNote(null);
      setSessionProfileNote("Profil diterapkan ke sesi.");
      void refreshSessionProfileInfo(sessionId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (error.code === "RUN_IN_PROGRESS") {
          setSessionProfileError(
            "Run sedang berjalan. Tunggu hingga selesai, lalu terapkan lagi.",
          );
          return;
        }
        try {
          const latest = await getSession(sessionId);
          setPersistedSessionAi(latest.value.ai);
          setSessionRevision(latest.revision);
          setSessionProfileError(
            "Konflik revision: konfigurasi terbaru dimuat; draft lokal tetap tersedia. Tinjau lalu terapkan lagi.",
          );
        } catch (refreshError) {
          setSessionProfileError(
            `Konflik revision; draft lokal dipertahankan. ${errorText(refreshError, "Konfigurasi terbaru gagal dimuat.")}`,
          );
        }
      } else {
        setSessionProfileError(
          `Terapkan profil gagal: ${errorText(error, "Backend tidak tersedia.")}`,
        );
      }
    } finally {
      setSessionProfileBusy(false);
    }
  }

  function handleCancelSessionAi(): void {
    setSessionAiDraft(persistedSessionAi ? { ...persistedSessionAi } : null);
    setSessionSaveError(null);
    setSessionSaveNote(null);
    setSessionProfileError(null);
    setSessionProfileNote(null);
    setTestNote(null);
  }

  async function handleSaveSessionAi() {
    if (props.mode !== "session" || !sessionAiDraft || sessionRevision === null)
      return;
    const { sessionId } = props;
    const ai = {
      provider: sessionAiDraft.provider,
      model:
        sessionAiDraft.model.trim() || DEFAULT_MODELS[sessionAiDraft.provider],
      systemPrompt:
        sessionAiDraft.systemPrompt ?? DEFAULT_NARRATOR_SYSTEM_PROMPT,
    };
    setSessionSaveBusy(true);
    setSessionSaveError(null);
    setSessionSaveNote(null);
    try {
      const saved = await updateSessionAi(sessionId, sessionRevision, ai);
      setSessionAiDraft(saved.value.ai);
      setPersistedSessionAi(saved.value.ai);
      setSessionRevision(saved.revision);
      setSessionSaveNote("Pengaturan AI sesi disimpan.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (error.code === "RUN_IN_PROGRESS") {
          setSessionSaveError(
            "Run sedang berjalan. Tunggu hingga selesai, lalu simpan lagi.",
          );
          return;
        }
        try {
          const latest = await getSession(sessionId);
          setPersistedSessionAi(latest.value.ai);
          setSessionRevision(latest.revision);
          setSessionSaveError(
            "Konflik revision: konfigurasi terbaru dimuat; draft lokal tetap tersedia. Tinjau lalu simpan lagi.",
          );
        } catch (refreshError) {
          setSessionSaveError(
            `Konflik revision; draft lokal dipertahankan. ${errorText(refreshError, "Konfigurasi terbaru gagal dimuat.")}`,
          );
        }
      } else {
        setSessionSaveError(
          `Simpan pengaturan AI sesi gagal: ${errorText(error, "Backend tidak tersedia.")}`,
        );
      }
    } finally {
      setSessionSaveBusy(false);
    }
  }

  async function handleSaveCredential() {
    const provider = selectedProvider;
    if (provider === "custom") return;
    const apiKey = credentialDrafts[provider].trim();
    if (!apiKey) return;
    setCredentialBusy(true);
    setCredentialNote(null);
    try {
      const result = await saveAiCredential(provider, apiKey);
      setConfigured((current) => ({
        gemini: current?.gemini ?? false,
        openrouter: current?.openrouter ?? false,
        [provider]: result.configured,
      }));
      setCredentialDrafts((current) => ({ ...current, [provider]: "" }));
      setCredentialNote("API key tersimpan di backend lokal.");
    } catch (error) {
      setCredentialNote(
        `Simpan API key gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setCredentialBusy(false);
    }
  }

  async function handleImportSave(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSaveNote(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const ids = await importSave(parsed);
      setSaveNote(
        `Pemulihan save berhasil sebagai salinan baru (${ids.gameId.slice(0, 8)}).`,
      );
    } catch (error) {
      setSaveNote(
        `Pemulihan save gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    }
  }

  async function handleCreateBackup() {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const backup = await createBackup();
      setBackupNote(
        `Backup dibuat ${new Date(backup.createdAt).toLocaleString()}.`,
      );
      await refreshBackups();
    } catch (error) {
      setBackupNote(
        `Backup gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreBackup() {
    if (!restoreTarget) return;
    setBackupBusy(true);
    setBackupNote(null);
    setRestoreError(null);
    try {
      await restoreBackup(restoreTarget.id);
      window.location.reload();
    } catch (error) {
      const message = `Restore backup gagal: ${errorText(error, "Backend tidak tersedia.")}`;
      setBackupNote(message);
      setRestoreError(message);
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleDownloadLegacy() {
    setLegacyBusy(true);
    try {
      const snapshot = await readLegacySnapshot();
      setLegacyCounts({
        games: snapshot.games.length,
        sessions: snapshot.sessions.length,
        messages: snapshot.messages.length,
      });
      downloadJson(snapshot, "fworld-legacy-migration.json");
      setLegacyNote(
        "Semua store IndexedDB diunduh. Database lama tidak diubah.",
      );
    } catch (error) {
      setLegacyNote(errorText(error, "Export data lama gagal."));
    } finally {
      setLegacyBusy(false);
    }
  }

  async function handleMigrateLegacy() {
    setLegacyBusy(true);
    setLegacyNote(null);
    let lockStatus: Awaited<ReturnType<typeof acquireWriteLock>> =
      "unsupported";
    try {
      lockStatus = await acquireWriteLock();
      if (lockStatus !== "granted") {
        setLegacyNote(
          lockStatus === "unsupported"
            ? "Browser tidak mendukung Web Locks; unduh data dapat dilakukan, transfer dinonaktifkan."
            : "Transfer migrasi lain sedang berlangsung di tab berbeda.",
        );
        return;
      }
      const payload = await readLegacySnapshot();
      setLegacyCounts({
        games: payload.games.length,
        sessions: payload.sessions.length,
        messages: payload.messages.length,
      });
      const receipt = await migrateLegacy(payload);
      const readback = await readLegacyMigration(receipt.fingerprint);
      if (stableJson(payload) !== stableJson(readback)) {
        throw new Error(
          "Verifikasi gagal: data hasil baca ulang tidak cocok penuh dengan IndexedDB.",
        );
      }
      setLegacyNote(
        `Migrasi terverifikasi: ${receipt.counts.games} game, ${receipt.counts.sessions} sesi, ${receipt.counts.messages} pesan. IndexedDB lama tetap utuh.`,
      );
    } catch (error) {
      setLegacyNote(
        `Migrasi gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      if (lockStatus === "granted") releaseWriteLock();
      setLegacyBusy(false);
    }
  }

  return (
    <div className="settings-page">
      {props.mode === "session" && (
        <button
          type="button"
          className="quiet settings-return"
          onClick={props.onReturnToSession}
        >
          ← Kembali ke sesi
        </button>
      )}
      <p className="settings-lead">
        Kelola pilihan AI, tampilan cerita, dan salinan data lokal.
      </p>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Pengaturan">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element;
              }}
              id={`settings-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className="settings-tab"
              onClick={() => selectSettingsTab(tab.id)}
              onKeyDown={(event) => handleSettingsTabKeyDown(event, tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="settings-panels">
          <section
            id="settings-panel-ai"
            role="tabpanel"
            aria-labelledby="settings-tab-ai"
            tabIndex={0}
            hidden={activeTab !== "ai"}
          >
            <section aria-label="Pengaturan AI" className="settings-section">
              <h2>Pengaturan AI</h2>
              <p className="hint">
                API key dikirim ke backend lokal dan disimpan di file .env yang
                diabaikan Git, lalu diprioritaskan atas key environment untuk
                provider tersebut. Nilainya tidak ditampilkan kembali atau
                disimpan di save game.{" "}
                {props.mode === "global"
                  ? "Provider dan model menjadi default untuk sesi baru; sesi aktif menyimpan pilihannya sendiri. Perubahan berlaku setelah disimpan."
                  : "Perubahan provider dan model berlaku untuk sesi ini setelah disimpan; default sesi baru tetap terpisah."}
              </p>
              {sessionLoadError && (
                <p className="error" role="alert">
                  Gagal memuat konfigurasi AI sesi: {sessionLoadError}
                </p>
              )}
              {props.mode === "session" && !aiDraft && !sessionLoadError && (
                <p role="status">Memuat konfigurasi AI sesi…</p>
              )}
              {aiSettingsError && (
                <p className="error" role="alert">
                  {aiSettingsError}
                </p>
              )}
              {props.mode === "global" && globalAiDraft && (
                <label>
                  Profil default sesi baru
                  <select
                    value={globalAiDraft.defaultProfileId ?? ""}
                    disabled={profilesError !== null}
                    onChange={(event) =>
                      updateGlobalAiDraft((current) => ({
                        ...current,
                        defaultProfileId:
                          event.target.value === ""
                            ? undefined
                            : event.target.value,
                      }))
                    }
                  >
                    <option value="">Tanpa profil (manual)</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {props.mode === "global" &&
                globalAiDraft?.defaultProfileId !== undefined && (
                  <div className="hint" role="status">
                    {selectedDefaultProfile ? (
                      <>
                        Sesi baru memakai profil{" "}
                        <strong>{selectedDefaultProfile.name}</strong> ·{" "}
                        {selectedDefaultProfile.provider} · model{" "}
                        {selectedDefaultProfile.model}. Field manual di bawah
                        tetap tersimpan untuk dipakai saat memilih Tanpa profil.
                        Perubahan profil berlaku pada sesi baru tanpa Save ulang
                        default.
                      </>
                    ) : (
                      "Profil default tidak ditemukan atau belum dimuat. Pilih profil lain, lalu simpan lagi."
                    )}
                  </div>
                )}
              <ul aria-label="Status provider">
                {(["gemini", "openrouter"] as const).map((id) => (
                  <li key={id}>
                    {id === "gemini" ? "Gemini" : "OpenRouter"}:{" "}
                    {configured
                      ? configured[id]
                        ? "credential tersedia"
                        : "belum dikonfigurasi"
                      : "status belum diketahui"}
                  </li>
                ))}
              </ul>
              <form onSubmit={(event) => event.preventDefault()}>
                {aiDraft && (
                  <>
                    {showManualAiFields && (
                      <>
                        <label>
                          {props.mode === "global"
                            ? "Provider default"
                            : "Provider sesi"}
                          <select
                            value={aiDraft.provider}
                            disabled={sessionSaveBusy}
                            onChange={(event) => {
                              const next = event.target.value as ProviderId;
                              if (props.mode === "global") {
                                updateGlobalAiDraft((current) => ({
                                  ...current,
                                  provider: next,
                                }));
                              } else {
                                setSessionAiDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        provider: next,
                                        model:
                                          next === "custom"
                                            ? current.model
                                            : DEFAULT_MODELS[next],
                                      }
                                    : current,
                                );
                                setSessionSaveError(null);
                                setSessionSaveNote(null);
                              }
                              setTestNote(null);
                            }}
                          >
                            {aiDraft.provider === "custom" && (
                              <option value="custom">
                                OpenAI-compatible (profil)
                              </option>
                            )}
                            <option value="gemini">Gemini</option>
                            <option value="openrouter">OpenRouter</option>
                          </select>
                        </label>
                        <label>
                          ID model
                          <input
                            type="text"
                            value={aiDraft.model}
                            maxLength={200}
                            disabled={sessionSaveBusy}
                            onChange={(event) => {
                              if (props.mode === "global") {
                                updateGlobalAiDraft((current) => ({
                                  ...current,
                                  models: {
                                    ...current.models,
                                    [current.provider]: event.target.value,
                                  },
                                }));
                              } else {
                                setSessionAiDraft((current) =>
                                  current
                                    ? { ...current, model: event.target.value }
                                    : current,
                                );
                                setSessionSaveError(null);
                                setSessionSaveNote(null);
                              }
                              setTestNote(null);
                            }}
                          />
                        </label>
                        <label>
                          Narrator system prompt
                          <textarea
                            id="narrator-system-prompt"
                            rows={12}
                            maxLength={MAX_NARRATOR_SYSTEM_PROMPT_CHARS}
                            spellCheck={false}
                            aria-describedby="narrator-system-prompt-help narrator-system-prompt-count"
                            value={
                              aiDraft.systemPrompt ??
                              DEFAULT_NARRATOR_SYSTEM_PROMPT
                            }
                            disabled={sessionSaveBusy}
                            onChange={(event) => {
                              if (props.mode === "global") {
                                updateGlobalAiDraft((current) => ({
                                  ...current,
                                  systemPrompt: event.target.value,
                                }));
                              } else {
                                setSessionAiDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        systemPrompt: event.target.value,
                                      }
                                    : current,
                                );
                                setSessionSaveError(null);
                                setSessionSaveNote(null);
                              }
                            }}
                          />
                        </label>
                        <div className="row">
                          <button
                            type="button"
                            onClick={() => {
                              if (props.mode === "global") {
                                updateGlobalAiDraft((current) => ({
                                  ...current,
                                  systemPrompt: DEFAULT_NARRATOR_SYSTEM_PROMPT,
                                }));
                              } else {
                                setSessionAiDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        systemPrompt:
                                          DEFAULT_NARRATOR_SYSTEM_PROMPT,
                                      }
                                    : current,
                                );
                                setSessionSaveError(null);
                                setSessionSaveNote(null);
                              }
                            }}
                            disabled={sessionSaveBusy}
                          >
                            Pulihkan prompt bawaan
                          </button>
                          <span id="narrator-system-prompt-count">
                            {aiDraft.systemPrompt?.length ?? 0} /{" "}
                            {MAX_NARRATOR_SYSTEM_PROMPT_CHARS} karakter
                          </span>
                        </div>
                        <p className="hint" id="narrator-system-prompt-help">
                          Teks ini sepenuhnya menggantikan prompt narrator
                          bawaan. Perubahan dapat memengaruhi perilaku narrator;
                          engine dan API tetap memvalidasi perubahan state
                          secara deterministik.
                        </p>
                      </>
                    )}
                    {props.mode === "global" && (
                      <button
                        type="button"
                        onClick={handleSaveGlobalAi}
                        disabled={
                          !globalAiDirty ||
                          (globalAiDraft?.defaultProfileId === undefined &&
                            (!globalAiDraft?.systemPrompt.trim() ||
                              (globalAiDraft?.systemPrompt.length ?? 0) >
                                MAX_NARRATOR_SYSTEM_PROMPT_CHARS))
                        }
                      >
                        Simpan pengaturan AI
                      </button>
                    )}
                  </>
                )}
                {selectedProvider !== "custom" && (
                  <>
                    <label>
                      API key{" "}
                      {selectedProvider === "gemini" ? "Gemini" : "OpenRouter"}
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={512}
                        value={credentialDrafts[selectedProvider]}
                        placeholder={
                          configured?.[selectedProvider]
                            ? "Masukkan key baru untuk mengganti"
                            : "Tempel API key"
                        }
                        disabled={!aiDraft}
                        onChange={(event) => {
                          setCredentialDrafts((current) => ({
                            ...current,
                            [selectedProvider]: event.target.value,
                          }));
                          setCredentialNote(null);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleSaveCredential()}
                      disabled={
                        !aiDraft ||
                        credentialBusy ||
                        !credentialDrafts[selectedProvider].trim()
                      }
                    >
                      {credentialBusy
                        ? "Menyimpan API key…"
                        : configured?.[selectedProvider]
                          ? "Ganti API key"
                          : "Simpan API key"}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={testState === "busy" || !aiDraft}
                >
                  {testState === "busy"
                    ? "Menguji koneksi…"
                    : "Uji koneksi server"}
                </button>
                {props.mode === "session" && (
                  <button
                    type="button"
                    onClick={() => void handleSaveSessionAi()}
                    disabled={
                      !aiDraft ||
                      sessionRevision === null ||
                      sessionSaveBusy ||
                      !sessionAiDraft?.systemPrompt?.trim() ||
                      (sessionAiDraft?.systemPrompt?.length ?? 0) >
                        MAX_NARRATOR_SYSTEM_PROMPT_CHARS ||
                      !sessionAiDirty
                    }
                  >
                    {sessionSaveBusy
                      ? "Menyimpan pengaturan sesi…"
                      : "Simpan pengaturan sesi"}
                  </button>
                )}
              </form>
              {credentialNote && <p role="status">{credentialNote}</p>}
              {testNote && <p role="status">{testNote}</p>}
              {globalAiSaveError && (
                <p className="error" role="alert">
                  {globalAiSaveError}
                </p>
              )}
              {globalAiSaveNote && <p role="status">{globalAiSaveNote}</p>}
              {sessionSaveError && (
                <p className="error" role="alert">
                  {sessionSaveError}
                </p>
              )}
              {sessionSaveNote && <p role="status">{sessionSaveNote}</p>}
              <button
                type="button"
                className="settings-link"
                onClick={() => selectSettingsTab("profiles")}
              >
                Kelola profil AI →
              </button>
            </section>
          </section>
          <section
            id="settings-panel-profiles"
            role="tabpanel"
            aria-labelledby="settings-tab-profiles"
            tabIndex={0}
            hidden={activeTab !== "profiles"}
          >
            {props.mode === "session" && (
              <div className="session-profile">
                <h3>Profil AI sesi</h3>
                <label>
                  Terapkan profil ke sesi
                  <select
                    value={sessionProfileId}
                    disabled={
                      sessionSaveBusy ||
                      sessionProfileBusy ||
                      profilesError !== null
                    }
                    onChange={(event) => {
                      setSessionProfileId(event.target.value);
                      setSessionProfileError(null);
                      setSessionProfileNote(null);
                    }}
                  >
                    <option value="">Pilih profil…</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row">
                  <button
                    type="button"
                    onClick={() => void handleApplySessionProfile()}
                    disabled={
                      !sessionProfileId ||
                      sessionAiDirty ||
                      sessionSaveBusy ||
                      sessionProfileBusy ||
                      sessionRevision === null
                    }
                  >
                    {sessionProfileBusy ? "Menerapkan…" : "Terapkan profil"}
                  </button>
                  {sessionAiDirty && (
                    <button
                      type="button"
                      onClick={handleCancelSessionAi}
                      disabled={sessionSaveBusy || sessionProfileBusy}
                    >
                      Batalkan perubahan AI sesi
                    </button>
                  )}
                </div>
                {sessionAiDirty && (
                  <p className="hint">
                    Simpan atau batalkan perubahan AI sesi dulu sebelum
                    menerapkan profil.
                  </p>
                )}
                {sessionProfileInfo && (
                  <p role="status">
                    Sesi terikat profil{" "}
                    {profiles.find(
                      (profile) => profile.id === sessionProfileInfo.profileId,
                    )?.name ?? "(tidak ditemukan)"}
                    {sessionProfileInfo.baseURL
                      ? ` · endpoint ${sessionProfileInfo.baseURL}`
                      : ""}{" "}
                    · API key{" "}
                    {sessionProfileInfo.credentialConfigured
                      ? "tersedia"
                      : "belum tersedia"}
                  </p>
                )}
                <p className="hint">
                  Snapshot sesi tidak berubah saat profil diedit; gunakan
                  Terapkan profil untuk memakai konfigurasi terbaru. Field
                  model/prompt manual di atas mengganti snapshot sesi dengan
                  credential yang tetap sama.
                </p>
                {sessionProfileError && (
                  <p className="error" role="alert">
                    {sessionProfileError}
                  </p>
                )}
                {sessionProfileNote && (
                  <p role="status">{sessionProfileNote}</p>
                )}
              </div>
            )}
            <AiProfilesPanel
              {...(props.mode === "global" &&
              props.aiDefaults.defaultProfileId !== undefined
                ? { defaultProfileId: props.aiDefaults.defaultProfileId }
                : {})}
              profiles={profiles}
              loadError={profilesError}
              onSaved={upsertProfile}
              reloadProfiles={loadProfiles}
            />
            <button
              type="button"
              className="settings-link"
              onClick={() => selectSettingsTab("ai")}
            >
              ← Pengaturan AI
            </button>
          </section>
          <section
            id="settings-panel-appearance"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
            tabIndex={0}
            hidden={activeTab !== "appearance"}
          >
            <section aria-label="Tampilan" className="settings-section">
              <h2>Tampilan</h2>
              <p className="hint">
                Pilihan ini langsung diterapkan dan disimpan di browser.
              </p>
              <TextSizeControl value={textSize} onChange={onTextSizeChange} />
              <div className="settings-story-sample narration">
                <p className="story-prose">
                  Hujan mereda di luar jendela. Di meja, secarik peta menunggu
                  disentuh.
                </p>
              </div>
            </section>
          </section>
          <section
            id="settings-panel-recovery"
            role="tabpanel"
            aria-labelledby="settings-tab-recovery"
            tabIndex={0}
            hidden={activeTab !== "recovery"}
          >
            <section aria-label="Impor save" className="settings-section">
              <h2>Impor save</h2>
              <p className="hint">
                File save yang didukung diimpor sebagai salinan baru dengan ID
                baru; dunia dan sesi tersimpan tidak tertimpa.
              </p>
              <label className="button">
                Pilih file save
                <input
                  type="file"
                  accept="application/json"
                  className="visually-hidden"
                  onChange={(event) => void handleImportSave(event)}
                />
              </label>
              {saveNote && <p role="status">{saveNote}</p>}
            </section>

            <section aria-label="Backup data" className="settings-section">
              <h2>Backup data</h2>
              <p className="hint">
                Backup memuat database aktif, termasuk dunia, sesi, riwayat, dan
                metadata. Kredensial API tidak disertakan dan tetap tersimpan
                terpisah di backend.
              </p>
              <button
                type="button"
                onClick={() => void handleCreateBackup()}
                disabled={backupBusy}
              >
                {backupBusy ? "Memproses…" : "Buat backup"}
              </button>
              {backupError && (
                <p className="error" role="alert">
                  {backupError}
                </p>
              )}
              {backupNote && <p role="status">{backupNote}</p>}
              {backupList.length === 0 ? (
                <p className="hint">Belum ada backup.</p>
              ) : (
                <ul className="backup-list">
                  {backupList.map((backup) => (
                    <li key={backup.id}>
                      {new Date(backup.createdAt).toLocaleString()} ·{" "}
                      {Math.ceil(backup.size / 1024)} KB
                      <button
                        type="button"
                        onClick={() => {
                          setRestoreTarget(backup);
                          setRestoreError(null);
                          setBackupNote(null);
                        }}
                        disabled={backupBusy}
                      >
                        Pulihkan
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              aria-label="Migrasi data lama"
              className="settings-section"
            >
              <h2>Migrasi data IndexedDB</h2>
              <p className="hint">
                Baca dan verifikasi seluruh store games, sessions, messages.
                Transfer memakai Web Lock dan IndexedDB lama tetap utuh.
              </p>
              {legacyCounts && (
                <p role="status">
                  {legacyCounts.games} game · {legacyCounts.sessions} sesi ·{" "}
                  {legacyCounts.messages} pesan
                </p>
              )}
              <div className="row">
                <button
                  type="button"
                  onClick={() => void handleDownloadLegacy()}
                  disabled={legacyBusy}
                >
                  Unduh data lama
                </button>
                <button
                  type="button"
                  onClick={() => void handleMigrateLegacy()}
                  disabled={legacyBusy || !navigator.locks?.request}
                >
                  Transfer & verifikasi
                </button>
              </div>
              {!navigator.locks?.request && (
                <p className="hint">
                  Web Locks tidak tersedia; unduh tetap aktif, transfer tidak
                  dapat dilakukan.
                </p>
              )}
              {legacyNote && (
                <p
                  className={
                    legacyNote.includes("gagal") ||
                    legacyNote.includes("tidak cocok")
                      ? "error"
                      : "hint"
                  }
                  role="status"
                >
                  {legacyNote}
                </p>
              )}
            </section>
            <button
              type="button"
              className="settings-link"
              onClick={() => selectSettingsTab("backend")}
            >
              Tentang backend dan diagnosis →
            </button>
          </section>
          <section
            id="settings-panel-backend"
            role="tabpanel"
            aria-labelledby="settings-tab-backend"
            tabIndex={0}
            hidden={activeTab !== "backend"}
          >
            <section aria-label="Tentang backend" className="settings-section">
              <h2>Tentang backend</h2>
              <p className="hint">
                Status berikut berasal dari endpoint lokal <code>/health</code>.
              </p>
              <dl className="settings-diagnostics">
                <div>
                  <dt>Origin aplikasi lokal</dt>
                  <dd>
                    <code>{window.location.origin}</code>
                  </dd>
                </div>
                <div>
                  <dt>Status API</dt>
                  <dd
                    role="status"
                    className={
                      backendStatus === "unavailable"
                        ? "status status-error"
                        : "status"
                    }
                  >
                    {apiStatus}
                  </dd>
                </div>
                <div>
                  <dt>Versi skema</dt>
                  <dd>{backendHealth?.schemaVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt>Versi Node.js</dt>
                  <dd>{backendHealth?.nodeVersion ?? "—"}</dd>
                </div>
              </dl>
              {backendError && (
                <p className="error" role="alert">
                  API backend lokal tidak tersedia: {backendError}
                </p>
              )}
              <label className="settings-diagnostic-label">
                Baris diagnostik tanpa rahasia
                <code className="settings-diagnostic-line">
                  {diagnosticLine}
                </code>
              </label>
              <button
                type="button"
                onClick={() => void handleCopyDiagnostics()}
              >
                Salin baris diagnostik
              </button>
              {diagnosticNote && <p role="status">{diagnosticNote}</p>}
            </section>
            <button
              type="button"
              className="settings-link"
              onClick={() => selectSettingsTab("recovery")}
            >
              ← Data & pemulihan
            </button>
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Ganti database dengan backup?"
        message={
          restoreTarget
            ? `Memulihkan backup ${new Date(restoreTarget.createdAt).toLocaleString()} akan mengganti seluruh database SQLite aktif: semua dunia, sesi, riwayat, dan metadata database akan digantikan oleh isi backup. Kredensial API tidak disertakan dan tetap tersimpan terpisah di backend. Aplikasi akan dimuat ulang setelah restore berhasil.`
            : ""
        }
        confirmLabel="Ganti seluruh database"
        onConfirm={() => void handleRestoreBackup()}
        onCancel={() => {
          if (!backupBusy) {
            setRestoreTarget(null);
            setRestoreError(null);
          }
        }}
        {...(restoreError === null ? {} : { note: restoreError })}
        noteRole="alert"
        confirmDisabled={backupBusy || restoreTarget === null}
        cancelDisabled={backupBusy}
      />
    </div>
  );
}
