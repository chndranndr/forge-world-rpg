import { useRef, useState } from "react";
import {
  ApiError,
  createAiProfile,
  saveAiProfileCredential,
  testAiConnection,
  updateAiProfile,
} from "../api";
import { DEFAULT_MODELS } from "../llm";
import type { AiProfile, AiProfileInput } from "../../shared/ai-profile";
import {
  DEFAULT_NARRATOR_SYSTEM_PROMPT,
  MAX_NARRATOR_SYSTEM_PROMPT_CHARS,
} from "../../shared/narrator-prompt";

const PROVIDER_LABELS: Record<AiProfileInput["provider"], string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
  custom: "OpenAI-compatible",
};

interface AiProfilesPanelProps {
  profiles: AiProfile[];
  loadError: string | null;
  onSaved: (profile: AiProfile) => void;
  reloadProfiles: () => Promise<AiProfile[]>;
  defaultProfileId?: string;
}

interface ProfileDraft {
  name: string;
  provider: AiProfileInput["provider"];
  model: string;
  systemPrompt: string;
  baseURL: string;
}

function draftFrom(profile: AiProfile): ProfileDraft {
  return {
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    baseURL: profile.provider === "custom" ? profile.baseURL : "",
  };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : fallback;
}

export default function AiProfilesPanel({
  profiles,
  loadError,
  onSaved,
  reloadProfiles,
  defaultProfileId,
}: AiProfilesPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const requestRef = useRef(0);

  const selected =
    selectedId === null
      ? null
      : (profiles.find((profile) => profile.id === selectedId) ?? null);
  const metadataDirty =
    draft !== null &&
    (selected === null ||
      draft.name !== selected.name ||
      draft.provider !== selected.provider ||
      draft.model !== selected.model ||
      draft.systemPrompt !== selected.systemPrompt ||
      (draft.provider === "custom" &&
        draft.baseURL !==
          (selected.provider === "custom" ? selected.baseURL : "")));
  const keyLocked = metadataDirty || selectedId === null || revision === null;

  function resetFeedback(): void {
    setFormError(null);
    setNote(null);
    setKeyNote(null);
    setTestNote(null);
  }

  function discardDraftIfNeeded(): boolean {
    if (!metadataDirty) return true;
    return window.confirm(
      "Draft profil belum disimpan. Buang draft dan lanjutkan?",
    );
  }

  function selectProfile(id: string): void {
    if (id === selectedId) return;
    if (!discardDraftIfNeeded()) return;
    const profile = profiles.find((entry) => entry.id === id);
    if (!profile) return;
    requestRef.current += 1;
    resetFeedback();
    setPasswordDraft("");
    setSelectedId(id);
    setDraft(draftFrom(profile));
    setRevision(profile.revision);
  }

  function startNewProfile(): void {
    if (!discardDraftIfNeeded()) return;
    requestRef.current += 1;
    resetFeedback();
    setPasswordDraft("");
    setSelectedId(null);
    setRevision(null);
    setDraft({
      name: "",
      provider: "gemini",
      model: DEFAULT_MODELS.gemini,
      systemPrompt: DEFAULT_NARRATOR_SYSTEM_PROMPT,
      baseURL: "",
    });
  }

  function updateDraft(update: (current: ProfileDraft) => ProfileDraft): void {
    setDraft((current) => (current ? update(current) : current));
    resetFeedback();
  }

  function draftInput(): AiProfileInput | null {
    if (!draft) return null;
    const name = draft.name.trim();
    const model = draft.model.trim();
    if (!name || name.length > 100) {
      setFormError("Nama profil harus 1-100 karakter.");
      return null;
    }
    if (!model || model.length > 200) {
      setFormError("Model profil harus 1-200 karakter.");
      return null;
    }
    if (!draft.systemPrompt.trim()) {
      setFormError("System prompt narrator tidak boleh kosong.");
      return null;
    }
    if (draft.systemPrompt.length > MAX_NARRATOR_SYSTEM_PROMPT_CHARS) {
      setFormError(
        `System prompt narrator melebihi batas ${MAX_NARRATOR_SYSTEM_PROMPT_CHARS} karakter.`,
      );
      return null;
    }
    if (draft.provider === "custom") {
      const baseURL = draft.baseURL.trim();
      if (!baseURL) {
        setFormError("Base URL wajib diisi untuk provider custom.");
        return null;
      }
      return {
        name,
        provider: "custom",
        model,
        systemPrompt: draft.systemPrompt,
        baseURL,
      };
    }
    return {
      name,
      provider: draft.provider,
      model,
      systemPrompt: draft.systemPrompt,
    };
  }

  async function handleSaveProfile(): Promise<void> {
    const input = draftInput();
    if (!input) return;
    setSaveBusy(true);
    setFormError(null);
    setNote(null);
    const request = ++requestRef.current;
    try {
      if (selectedId === null || revision === null) {
        const created = await createAiProfile(input);
        if (request !== requestRef.current) return;
        onSaved(created);
        setSelectedId(created.id);
        setDraft(draftFrom(created));
        setRevision(created.revision);
        setPasswordDraft("");
        setNote("Profil AI dibuat.");
      } else {
        const updated = await updateAiProfile(selectedId, revision, input);
        if (request !== requestRef.current) return;
        onSaved(updated);
        setDraft(draftFrom(updated));
        setRevision(updated.revision);
        setNote("Profil AI disimpan.");
      }
    } catch (error) {
      if (request !== requestRef.current) return;
      if (error instanceof ApiError && error.status === 409) {
        const latest = await reloadProfiles().catch(() => null);
        if (latest && selectedId !== null) {
          const current = latest.find((profile) => profile.id === selectedId);
          if (current) setRevision(current.revision);
        }
        setFormError(
          "Konflik revision: data tersimpan dimuat ulang; draft lokal dipertahankan. Tinjau lalu simpan lagi.",
        );
      } else {
        setFormError(
          `Simpan profil gagal: ${errorText(error, "Backend tidak tersedia.")}`,
        );
      }
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleSaveKey(apiKey: string): Promise<void> {
    if (selectedId === null || revision === null || metadataDirty) return;
    setKeyBusy(true);
    setKeyNote(null);
    setTestNote(null);
    const request = ++requestRef.current;
    try {
      const result = await saveAiProfileCredential(
        selectedId,
        revision,
        apiKey,
      );
      if (request !== requestRef.current) return;
      if (selected) {
        onSaved({
          ...selected,
          credentialConfigured: result.credentialConfigured,
        });
      }
      setPasswordDraft("");
      setKeyNote(
        result.credentialConfigured
          ? "API key profil tersimpan di backend lokal."
          : "API key profil dihapus; request berjalan tanpa Authorization.",
      );
    } catch (error) {
      if (request !== requestRef.current) return;
      if (error instanceof ApiError && error.status === 409) {
        const latest = await reloadProfiles().catch(() => null);
        if (latest && selectedId !== null) {
          const current = latest.find((profile) => profile.id === selectedId);
          if (current) {
            setRevision(current.revision);
            setKeyNote(
              "Revision profil berubah; data tersimpan dimuat ulang. Simpan key lagi.",
            );
            return;
          }
        }
      }
      setKeyNote(
        `Simpan API key gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleTest(): Promise<void> {
    if (selectedId === null || keyLocked) return;
    setTestBusy(true);
    setTestNote(null);
    const request = ++requestRef.current;
    try {
      const result = await testAiConnection({ profileId: selectedId });
      if (request !== requestRef.current) return;
      setTestNote(result.message);
    } catch (error) {
      if (request !== requestRef.current) return;
      setTestNote(
        `Uji koneksi gagal: ${errorText(error, "Backend tidak tersedia.")}`,
      );
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <section aria-label="Profil AI" className="settings-section">
      <h2>Profil AI</h2>
      <p className="hint">
        Profil menyimpan provider, model, dan prompt narrator; API key tersimpan
        terpisah di backend dan tidak pernah dimuat kembali ke form. Sesi
        menyimpan snapshot saat profil diterapkan, jadi mengedit profil tidak
        mengubah sesi yang sedang berjalan sampai profil diterapkan ulang.
      </p>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {profiles.length === 0 && !draft && (
        <p className="hint">Belum ada profil AI.</p>
      )}
      <div className="profile-picker">
        <div
          className="profile-list"
          role="group"
          aria-label="Profil tersimpan"
        >
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className="profile-list-item"
              aria-pressed={selectedId === profile.id}
              disabled={loadError !== null}
              onClick={() => selectProfile(profile.id)}
            >
              <span className="profile-list-name">{profile.name}</span>
              <span className="profile-list-meta">
                {PROVIDER_LABELS[profile.provider]} · {profile.model}
              </span>
              {defaultProfileId === profile.id && (
                <span className="profile-list-default">Default</span>
              )}
            </button>
          ))}
        </div>
        <button type="button" onClick={startNewProfile}>
          Buat profil
        </button>
      </div>
      {draft && (
        <form onSubmit={(event) => event.preventDefault()}>
          <label>
            Nama profil
            <input
              type="text"
              maxLength={100}
              value={draft.name}
              disabled={saveBusy}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Provider
            <select
              value={draft.provider}
              disabled={saveBusy}
              onChange={(event) => {
                const provider = event.target
                  .value as AiProfileInput["provider"];
                updateDraft((current) => ({
                  ...current,
                  provider,
                  model:
                    provider === "custom"
                      ? ""
                      : current.provider === provider
                        ? current.model
                        : DEFAULT_MODELS[provider],
                }));
              }}
            >
              <option value="gemini">{PROVIDER_LABELS.gemini}</option>
              <option value="openrouter">{PROVIDER_LABELS.openrouter}</option>
              <option value="custom">{PROVIDER_LABELS.custom}</option>
            </select>
          </label>
          {draft.provider === "custom" && (
            <label>
              Base URL
              <input
                type="url"
                maxLength={2048}
                placeholder="https://api.example.com/v1"
                value={draft.baseURL}
                disabled={saveBusy}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    baseURL: event.target.value,
                  }))
                }
              />
            </label>
          )}
          <label>
            ID model
            <input
              type="text"
              maxLength={200}
              value={draft.model}
              disabled={saveBusy}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  model: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Narrator system prompt
            <textarea
              rows={10}
              maxLength={MAX_NARRATOR_SYSTEM_PROMPT_CHARS}
              spellCheck={false}
              value={draft.systemPrompt}
              disabled={saveBusy}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  systemPrompt: event.target.value,
                }))
              }
            />
          </label>
          <div className="row">
            <button
              type="button"
              onClick={() => void handleSaveProfile()}
              disabled={saveBusy}
            >
              {saveBusy ? "Menyimpan profil…" : "Simpan profil"}
            </button>
            <button
              type="button"
              disabled={saveBusy}
              onClick={() => {
                if (selected) {
                  setDraft(draftFrom(selected));
                  resetFeedback();
                } else {
                  startNewProfile();
                }
              }}
            >
              {selected ? "Batalkan draft profil" : "Reset form"}
            </button>
          </div>
        </form>
      )}
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {selected && selectedId !== null && (
        <div className="profile-credential">
          <p role="status">
            API key:{" "}
            {selected.credentialConfigured
              ? "tersedia"
              : selected.provider === "custom"
                ? "tidak ada (request tanpa Authorization)"
                : "belum dikonfigurasi"}
          </p>
          <label>
            API key {PROVIDER_LABELS[selected.provider]}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              value={passwordDraft}
              disabled={keyLocked || keyBusy}
              placeholder={
                selected.credentialConfigured
                  ? "Masukkan key baru untuk mengganti"
                  : "Tempel API key"
              }
              onChange={(event) => {
                setPasswordDraft(event.target.value);
                setKeyNote(null);
              }}
            />
          </label>
          <div className="row">
            <button
              type="button"
              onClick={() => void handleSaveKey(passwordDraft.trim())}
              disabled={keyLocked || keyBusy || !passwordDraft.trim()}
            >
              {keyBusy ? "Menyimpan key…" : "Simpan API key"}
            </button>
            <button
              type="button"
              onClick={() => void handleSaveKey("")}
              disabled={keyLocked || keyBusy || !selected.credentialConfigured}
            >
              Hapus API key
            </button>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={keyLocked || testBusy || keyBusy}
            >
              {testBusy ? "Menguji…" : "Uji koneksi profil"}
            </button>
          </div>
          {metadataDirty && (
            <p className="hint">
              Simpan profil dulu sebelum menyimpan atau menguji API key.
            </p>
          )}
          <p className="hint">
            Mengubah provider atau Base URL membuat identitas credential baru;
            isi API key untuk identitas itu. Sesi lama tetap memakai konfigurasi
            sebelumnya. Dua profil pada endpoint sama tetap memakai key
            masing-masing.
          </p>
          {keyNote && <p role="status">{keyNote}</p>}
          {testNote && <p role="status">{testNote}</p>}
        </div>
      )}
    </section>
  );
}
