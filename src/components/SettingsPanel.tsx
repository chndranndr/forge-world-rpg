import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  ApiError,
  createBackup,
  getAiSettings,
  getHealth,
  getSession,
  importSave,
  listBackups,
  migrateLegacy,
  readLegacyMigration,
  restoreBackup,
  saveAiCredential,
  testAiConnection,
  updateSessionAi,
  type BackupRecord,
} from "../api";
import { acquireWriteLock, readLegacySnapshot, releaseWriteLock } from "../db";
import { DEFAULT_MODELS, type ProviderId } from "../llm";
import type { AiConfig } from "../types";
interface CommonSettingsPanelProps {
  textSize: "normal" | "large";
  onTextSizeChange: (size: "normal" | "large") => void;
}

type SettingsPanelProps = CommonSettingsPanelProps &
  (
    | {
        mode: "global";
        provider: ProviderId;
        models: Record<ProviderId, string>;
        onProviderChange: (provider: ProviderId) => void;
        onModelChange: (model: string) => void;
      }
    | {
        mode: "session";
        sessionId: string;
        onReturnToSession: () => void;
      }
  );

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
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Record<
    ProviderId,
    boolean
  > | null>(null);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<
    Record<ProviderId, string>
  >({ gemini: "", openrouter: "" });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialNote, setCredentialNote] = useState<string | null>(null);
  const [testState, setTestState] = useState<"idle" | "busy">("idle");
  const [testNote, setTestNote] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [backupList, setBackupList] = useState<BackupRecord[]>([]);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
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
  const sessionId = props.mode === "session" ? props.sessionId : null;
  const aiDraft =
    props.mode === "global"
      ? { provider: props.provider, model: props.models[props.provider] }
      : sessionAiDraft;
  const selectedProvider =
    aiDraft?.provider ?? (props.mode === "global" ? props.provider : "gemini");
  const sessionAiDirty =
    props.mode === "session" &&
    sessionAiDraft !== null &&
    persistedSessionAi !== null &&
    (sessionAiDraft.provider !== persistedSessionAi.provider ||
      sessionAiDraft.model !== persistedSessionAi.model);

  const refreshBackups = useCallback(async () => {
    try {
      setBackupList(await listBackups());
      setBackupError(null);
    } catch (error) {
      setBackupError(errorText(error, "Daftar backup tidak dapat dimuat."));
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
        setBackendStatus(
          `Siap · Node ${health.nodeVersion} · schema ${health.schemaVersion}`,
        );
        setBackendError(null);
      })
      .catch((error: unknown) => {
        setBackendStatus(null);
        setBackendError(errorText(error, "Backend tidak tersedia."));
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
  }, [refreshBackups, refreshLegacyCounts]);
  useEffect(() => {
    if (sessionId === null) return;
    let active = true;
    setSessionAiDraft(null);
    setPersistedSessionAi(null);
    setSessionRevision(null);
    setSessionLoadError(null);
    setSessionSaveError(null);
    setSessionSaveNote(null);
    void getSession(sessionId)
      .then((record) => {
        if (!active) return;
        const ai = { ...record.value.ai };
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
    return () => {
      active = false;
    };
  }, [sessionId]);

  async function handleTest() {
    if (!aiDraft) return;
    setTestState("busy");
    setTestNote(null);
    try {
      const result = await testAiConnection({
        provider: aiDraft.provider,
        model: aiDraft.model.trim(),
      });
      setTestNote(result.message);
    } catch (error) {
      setTestNote(
        `Uji koneksi gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setTestState("idle");
    }
  }

  async function handleSaveSessionAi() {
    if (props.mode !== "session" || !sessionAiDraft || sessionRevision === null)
      return;
    const { sessionId } = props;
    const ai = {
      provider: sessionAiDraft.provider,
      model:
        sessionAiDraft.model.trim() || DEFAULT_MODELS[sessionAiDraft.provider],
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
        `Restore save berhasil sebagai salinan baru (${ids.gameId.slice(0, 8)}).`,
      );
    } catch (error) {
      setSaveNote(
        `Restore save gagal: ${errorText(error, "Backend tidak tersedia.")}`,
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

  async function handleRestoreBackup(id: string) {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      await restoreBackup(id);
      setBackupNote("Backup berhasil dipulihkan.");
      await refreshBackups();
    } catch (error) {
      setBackupNote(
        `Restore backup gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
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
    <div className="panel settings-page">
      {props.mode === "session" && (
        <button type="button" onClick={props.onReturnToSession}>
          ← Kembali ke sesi
        </button>
      )}
      <h2 className="settings-page-title">Settings</h2>
      <section aria-label="Status backend" aria-live="polite">
        <h2>Backend lokal</h2>
        {backendStatus && <p role="status">{backendStatus}</p>}
        {backendError && (
          <p className="error" role="alert">
            Backend tidak tersedia: {backendError}
          </p>
        )}
      </section>

      <section aria-label="Pengaturan AI" className="settings-section">
        <h2>Pengaturan AI</h2>
        <p className="hint">
          API key dikirim ke backend lokal dan disimpan di file .env yang
          diabaikan Git, lalu diprioritaskan atas key environment untuk provider
          tersebut. Nilainya tidak ditampilkan kembali atau disimpan di save
          game.{" "}
          {props.mode === "global"
            ? "Provider dan model menjadi default untuk sesi baru; sesi aktif menyimpan pilihannya sendiri."
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
        <ul aria-label="Status provider">
          {(["gemini", "openrouter"] as ProviderId[]).map((id) => (
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
              <label>
                {props.mode === "global" ? "Provider default" : "Provider sesi"}
                <select
                  value={aiDraft.provider}
                  disabled={sessionSaveBusy}
                  onChange={(event) => {
                    const next = event.target.value as ProviderId;
                    if (props.mode === "global") {
                      props.onProviderChange(next);
                    } else {
                      setSessionAiDraft((current) =>
                        current
                          ? {
                              ...current,
                              provider: next,
                              model: DEFAULT_MODELS[next],
                            }
                          : current,
                      );
                      setSessionSaveError(null);
                      setSessionSaveNote(null);
                    }
                    setTestNote(null);
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
                  value={aiDraft.model}
                  maxLength={200}
                  disabled={sessionSaveBusy}
                  onChange={(event) => {
                    if (props.mode === "global") {
                      props.onModelChange(event.target.value);
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
            </>
          )}
          <label>
            API key {selectedProvider === "gemini" ? "Gemini" : "OpenRouter"}
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
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testState === "busy" || !aiDraft}
          >
            {testState === "busy" ? "Menguji koneksi…" : "Uji koneksi server"}
          </button>
          {props.mode === "session" && (
            <button
              type="button"
              onClick={() => void handleSaveSessionAi()}
              disabled={
                !aiDraft ||
                sessionRevision === null ||
                sessionSaveBusy ||
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
        {sessionSaveError && (
          <p className="error" role="alert">
            {sessionSaveError}
          </p>
        )}
        {sessionSaveNote && <p role="status">{sessionSaveNote}</p>}
      </section>

      <section aria-label="Tampilan" className="settings-section">
        <h2>Tampilan</h2>
        <div className="radio-row" role="radiogroup" aria-label="Ukuran teks">
          <label>
            <input
              type="radio"
              name="text-size"
              checked={textSize === "normal"}
              onChange={() => onTextSizeChange("normal")}
            />
            Normal
          </label>
          <label>
            <input
              type="radio"
              name="text-size"
              checked={textSize === "large"}
              onChange={() => onTextSizeChange("large")}
            />
            Besar
          </label>
        </div>
      </section>

      <section aria-label="Restore save" className="settings-section">
        <h2>Restore save</h2>
        <p className="hint">
          File fworld-save versi 1 direstore sebagai salinan dengan IDs baru;
          data lama tidak tertimpa.
        </p>
        <label className="button">
          Pilih file restore
          <input
            type="file"
            accept="application/json"
            className="visually-hidden"
            onChange={(event) => void handleImportSave(event)}
          />
        </label>
        {saveNote && <p role="status">{saveNote}</p>}
      </section>

      <section aria-label="Backup backend" className="settings-section">
        <h2>Backup backend</h2>
        <p className="hint">
          Backup dibuat dan dipulihkan melalui backend lokal.
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
          <ul>
            {backupList.map((backup) => (
              <li key={backup.id}>
                {new Date(backup.createdAt).toLocaleString()} ·{" "}
                {Math.ceil(backup.size / 1024)} KB
                <button
                  type="button"
                  onClick={() => void handleRestoreBackup(backup.id)}
                  disabled={backupBusy}
                >
                  Pulihkan
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Migrasi data lama" className="settings-section">
        <h2>Migrasi data IndexedDB</h2>
        <p className="hint">
          Baca dan verifikasi seluruh store games, sessions, messages. Transfer
          memakai Web Lock dan IndexedDB lama tetap utuh.
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
            Web Locks tidak tersedia; unduh tetap aktif, transfer tidak dapat
            dilakukan.
          </p>
        )}
        {legacyNote && (
          <p
            className={
              legacyNote.includes("gagal") || legacyNote.includes("tidak cocok")
                ? "error"
                : "hint"
            }
            role="status"
          >
            {legacyNote}
          </p>
        )}
      </section>
    </div>
  );
}
