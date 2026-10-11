import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ApiError,
  createGame,
  getGame,
  listSessions,
  startSession,
  updateGame,
} from "../api";
import {
  ImportError,
  validateDefinition,
  validateDefinitionUpdate,
  validatePlayability,
} from "../../shared/validation.js";
import {
  exportTemplate,
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  type TemplateDraft,
} from "../template";
import type {
  AiConfig,
  EffectOperation,
  GameDefinition,
  ItemDefinition,
  ItemEffect,
  NpcDefinition,
} from "../types";
import exampleTemplate from "../../examples/game-template.json";
interface GameEditorProps {
  gameId: string;
  initialDraft?: GameDefinition | null;
  defaultAi: AiConfig;
  onBack: () => void;
  onOpenSettings: () => void;
  onDraftPersisted: () => void;
  onStarted: (sessionId: string) => void;
}

const EFFECT_TYPES: ItemEffect["type"][] = [
  "ATTRIBUTE_CHANGE",
  "RESOURCE_CHANGE",
  "RELATIONSHIP_CHANGE",
  "ADD_ITEM",
  "REMOVE_ITEM",
  "ADD_FACT",
  "REMOVE_FACT",
];

const OPERATIONS: EffectOperation[] = ["ADD", "SUBTRACT", "SET"];

function defaultEffect(
  type: ItemEffect["type"],
  game: GameDefinition,
): ItemEffect {
  switch (type) {
    case "ATTRIBUTE_CHANGE":
      return {
        type,
        target: game.attributes[0]?.id ?? "",
        operation: "ADD",
        value: 0,
      };
    case "RESOURCE_CHANGE":
      return {
        type,
        target: game.resources[0]?.id ?? "",
        operation: "ADD",
        value: 0,
      };
    case "RELATIONSHIP_CHANGE":
      return {
        type,
        target: game.relationships[0]?.id ?? "",
        operation: "ADD",
        value: 0,
      };
    case "ADD_ITEM":
    case "REMOVE_ITEM":
      return { type, target: game.items[0]?.id ?? "", quantity: 1 };
    case "ADD_FACT":
      return { type, text: "" };
    case "REMOVE_FACT":
      return { type, target: "" };
  }
}

function replaceIn<T>(list: T[], index: number, entry: T): T[] {
  const next = [...list];
  next[index] = entry;
  return next;
}

export default function GameEditor({
  gameId,
  initialDraft,
  defaultAi,
  onBack,
  onOpenSettings,
  onDraftPersisted,
  onStarted,
}: GameEditorProps) {
  const [draft, setDraft] = useState<GameDefinition | null>(null);
  const [original, setOriginal] = useState<GameDefinition | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Nilai input numerik/berbaris disimpan sebagai teks mentah; angka di draft
  // hanya berubah kalau teks bisa di-parse.
  const [raws, setRaws] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [pendingExit, setPendingExit] = useState<"back" | "settings" | null>(
    null,
  );
  const [templateReview, setTemplateReview] = useState<{
    draft: TemplateDraft;
    ai?: AiConfig;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const discardDialogRef = useRef<HTMLDialogElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialDraft && initialDraft.id === gameId) {
      setDraft(structuredClone(initialDraft));
      setOriginal(structuredClone(initialDraft));
      setRevision(null);
      setMissing(false);
      setLoadError(null);
      return;
    }
    let active = true;
    void (async () => {
      const game = await getGame(gameId);
      if (!active) return;
      setDraft(structuredClone(game.value));
      setOriginal(structuredClone(game.value));
      setRevision(game.revision);
      setMissing(false);
      setLoadError(null);
    })().catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 404) setMissing(true);
      else
        setLoadError(
          error instanceof Error ? error.message : "Game gagal dimuat.",
        );
    });
    return () => {
      active = false;
    };
  }, [gameId, initialDraft]);

  const current = draft;
  if (missing) {
    return (
      <section className="card">
        <p>Game tidak ditemukan.</p>
        <button type="button" onClick={onBack}>
          Kembali
        </button>
      </section>
    );
  }
  if (!current || !original) {
    return (
      <section aria-live="polite">
        <p role={loadError ? "alert" : "status"}>
          {loadError ?? "Memuat editor…"}
        </p>
        {loadError && (
          <button type="button" onClick={() => window.location.reload()}>
            Coba lagi
          </button>
        )}
        <button type="button" onClick={onBack}>
          Kembali
        </button>
      </section>
    );
  }

  const patch = (partial: Partial<GameDefinition>) => {
    setDraft((d) => (d ? { ...d, ...partial } : d));
    setTouched(true);
  };

  const patchFn = (updater: (d: GameDefinition) => Partial<GameDefinition>) => {
    setDraft((d) => (d ? { ...d, ...updater(d) } : d));
    setTouched(true);
  };

  const patchAttribute = (
    index: number,
    partial: Partial<GameDefinition["attributes"][number]>,
  ) =>
    patch({
      attributes: replaceIn(current.attributes, index, {
        ...current.attributes[index],
        ...partial,
      }),
    });

  const patchResource = (
    index: number,
    partial: Partial<GameDefinition["resources"][number]>,
  ) =>
    patch({
      resources: replaceIn(current.resources, index, {
        ...current.resources[index],
        ...partial,
      }),
    });

  const patchRelationship = (
    index: number,
    partial: Partial<GameDefinition["relationships"][number]>,
  ) =>
    patch({
      relationships: replaceIn(current.relationships, index, {
        ...current.relationships[index],
        ...partial,
      }),
    });

  const patchItem = (index: number, partial: Partial<ItemDefinition>) =>
    patch({
      items: replaceIn(current.items, index, {
        ...current.items[index],
        ...partial,
      }),
    });

  const patchNpc = (index: number, partial: Partial<NpcDefinition>) =>
    patch({
      npcs: replaceIn(current.npcs, index, {
        ...current.npcs[index],
        ...partial,
      }),
    });

  // Input numerik: teks mentah di state; kosong = hapus (opsional) atau
  // pertahankan angka lama (wajib); tak ter-parse = pertahankan angka lama.
  const bindNumber = (
    key: string,
    value: number | undefined,
    apply: (parsed: number | undefined) => void,
    optional = false,
  ) => ({
    value: raws[key] ?? (value === undefined ? "" : String(value)),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const text = event.target.value;
      setRaws((prev) => ({ ...prev, [key]: text }));
      if (text.trim() === "") {
        if (optional) apply(undefined);
        return;
      }
      const parsed = Number(text);
      if (Number.isFinite(parsed)) apply(parsed);
    },
  });

  const bindLines = (
    key: string,
    value: string[],
    apply: (lines: string[]) => void,
  ) => ({
    value: raws[key] ?? value.join("\n"),
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
      const text = event.target.value;
      setRaws((prev) => ({ ...prev, [key]: text }));
      apply(
        text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
    },
  });

  const savedIds = {
    attributes: new Set(original.attributes.map((entry) => entry.id)),
    resources: new Set(original.resources.map((entry) => entry.id)),
    relationships: new Set(original.relationships.map((entry) => entry.id)),
    items: new Set(original.items.map((entry) => entry.id)),
    npcs: new Set(original.npcs.map((entry) => entry.id)),
  };

  const handleSave = async (): Promise<boolean> => {
    setWorking(true);
    setSaveNote(null);
    try {
      const next = { ...current, updatedAt: new Date().toISOString() };
      const sessions = revision === null ? [] : await listSessions(gameId);
      const allErrors = [...validateDefinition(next)];
      if (sessions.length > 0) {
        allErrors.push(...validateDefinitionUpdate(original, next));
      }
      if (allErrors.length > 0) {
        setErrors(allErrors);
        return false;
      }
      const saved =
        revision === null
          ? await createGame(next)
          : await updateGame(gameId, revision, next);
      setDraft(structuredClone(saved.value));
      setOriginal(structuredClone(saved.value));
      setRevision(saved.revision);
      setErrors([]);
      setSaveNote("Definisi tersimpan.");
      setTouched(false);
      onDraftPersisted();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await getGame(gameId);
          setOriginal(structuredClone(latest.value));
          setRevision(latest.revision);
          setSaveNote(
            "Versi server dimuat ulang. Draft lokal tetap tersimpan di editor; tinjau sebelum menyimpan lagi.",
          );
        } catch {
          setSaveNote(error.message);
        }
        return false;
      }
      setSaveNote(
        error instanceof Error ? error.message : "Gagal menyimpan definisi.",
      );
      return false;
    } finally {
      setWorking(false);
    }
  };

  const handleStart = async () => {
    setWorking(true);
    setSaveNote(null);
    try {
      const definitionErrors = [
        ...validateDefinition(current),
        ...validatePlayability(current),
      ];
      const sessions = revision === null ? [] : await listSessions(gameId);
      const updateErrors =
        sessions.length > 0 ? validateDefinitionUpdate(original, current) : [];
      const allErrors = [...definitionErrors, ...updateErrors];
      if (allErrors.length > 0) {
        setErrors(allErrors);
        return;
      }
      setErrors([]);
      const result = await startSession(
        current,
        revision ?? undefined,
        defaultAi,
      );
      onStarted(result.session.value.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await getGame(gameId);
          setOriginal(structuredClone(latest.value));
          setRevision(latest.revision);
          setSaveNote(
            "Versi server dimuat ulang. Draft lokal tetap tersimpan; tinjau sebelum mencoba lagi.",
          );
        } catch {
          setSaveNote(error.message);
        }
      }
      setErrors([
        error instanceof Error ? error.message : "Gagal memulai permainan.",
      ]);
    } finally {
      setWorking(false);
    }
  };

  const playable =
    validateDefinition(current).length === 0 &&
    validatePlayability(current).length === 0;

  const requestExit = (target: "back" | "settings") => {
    if (touched) {
      setPendingExit(target);
      discardDialogRef.current?.showModal();
      return;
    }
    if (target === "back") onBack();
    else onOpenSettings();
  };

  const handleBack = () => requestExit("back");

  const handleOpenSettings = () => requestExit("settings");

  const handleExportTemplate = () => {
    try {
      const bundle = exportTemplate(current);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const slug =
        current.title.trim().replace(/\s+/g, "-").toLowerCase() || "template";
      link.href = url;
      link.download = `fworld-template-${slug}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setSaveNote("Template diekspor dari draft saat ini (tanpa menyimpan).");
    } catch (err) {
      setSaveNote(
        err instanceof Error ? err.message : "Export template gagal.",
      );
    }
  };

  const handleLoadExample = () => {
    try {
      setTemplateReview(parseTemplate(exampleTemplate));
      setImportError(null);
    } catch (err) {
      setImportError(
        err instanceof ImportError
          ? err.problems.join(" ")
          : "Contoh gagal dimuat.",
      );
    }
  };

  const handleImportTemplate = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    if (file.size > MAX_TEMPLATE_BYTES) {
      setImportError("File melebihi batas 2 MB.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = parseTemplate(parsed);
      setTemplateReview(result);
    } catch (err) {
      if (err instanceof ImportError) {
        setImportError(err.problems.join(" "));
      } else {
        setImportError(err instanceof Error ? err.message : "Import gagal.");
      }
    }
  };

  const applyTemplateReview = () => {
    if (!templateReview) return;
    const draftNow = current;
    setDraft({
      ...draftNow,
      ...structuredClone(templateReview.draft),
    });
    setTouched(true);
    setTemplateReview(null);
    setSaveNote("Template diterapkan ke draft; belum disimpan.");
  };

  return (
    <div className="editor">
      <div className="row">
        <button
          type="button"
          ref={backButtonRef}
          onClick={handleBack}
          disabled={working}
        >
          Kembali
        </button>
        <span className={playable ? "badge badge-ready" : "badge badge-draft"}>
          {playable ? "Siap dimainkan" : "Draft"}
        </span>
        <button type="button" onClick={handleExportTemplate} disabled={working}>
          Export JSON template
        </button>
        <label className="button">
          Import JSON template
          <input
            type="file"
            accept="application/json"
            className="visually-hidden"
            onChange={(event) => void handleImportTemplate(event)}
          />
        </label>
        <button type="button" onClick={handleLoadExample} disabled={working}>
          Muat contoh
        </button>
        <button type="button" onClick={handleOpenSettings} disabled={working}>
          Settings
        </button>
      </div>
      <div className="intro editor-intro">
        <p className="eyebrow">Rancang ceritamu</p>
        <h2>{revision === null ? "Buat duniamu" : "Edit duniamu"}</h2>
        <p>Atur latar, karakter, dan cara dunia bekerja.</p>
      </div>
      {importError && (
        <p className="error" role="alert">
          {importError}
        </p>
      )}
      {saveNote && <p role="status">{saveNote}</p>}
      {errors.length > 0 && (
        <ul className="error-list" role="alert">
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <details className="card" open>
        <summary>Ringkasan</summary>
        <label>
          Judul
          <input
            value={current.title}
            onChange={(event) => patch({ title: event.target.value })}
          />
        </label>
        <label>
          Deskripsi
          <textarea
            value={current.description ?? ""}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </label>
        <label>
          Genre
          <input
            value={current.genre ?? ""}
            onChange={(event) => patch({ genre: event.target.value })}
          />
        </label>
        <label>
          Nuansa
          <input
            value={current.tone ?? ""}
            onChange={(event) => patch({ tone: event.target.value })}
          />
        </label>
        <label>
          Bahasa
          <input
            value={current.language ?? ""}
            onChange={(event) => patch({ language: event.target.value })}
          />
        </label>
      </details>

      <details className="card" open>
        <summary>Skenario</summary>
        <label>
          Latar
          <textarea
            value={current.scenario.setting}
            onChange={(event) =>
              patch({
                scenario: { ...current.scenario, setting: event.target.value },
              })
            }
          />
        </label>
        <label>
          Situasi awal
          <textarea
            value={current.scenario.startingSituation}
            onChange={(event) =>
              patch({
                scenario: {
                  ...current.scenario,
                  startingSituation: event.target.value,
                },
              })
            }
          />
        </label>
        <label>
          Aturan dunia
          <textarea
            value={current.scenario.worldRules ?? ""}
            onChange={(event) =>
              patch({
                scenario: {
                  ...current.scenario,
                  worldRules: event.target.value,
                },
              })
            }
          />
        </label>
        <label>
          Nuansa
          <input
            value={current.scenario.tone ?? ""}
            onChange={(event) =>
              patch({
                scenario: { ...current.scenario, tone: event.target.value },
              })
            }
          />
        </label>
        <label>
          Genre
          <input
            value={current.scenario.genre ?? ""}
            onChange={(event) =>
              patch({
                scenario: { ...current.scenario, genre: event.target.value },
              })
            }
          />
        </label>
        <label>
          Konteks tambahan
          <textarea
            value={current.scenario.additionalContext ?? ""}
            onChange={(event) =>
              patch({
                scenario: {
                  ...current.scenario,
                  additionalContext: event.target.value,
                },
              })
            }
          />
        </label>
      </details>

      <details className="card">
        <summary>Pemain</summary>
        <label>
          Nama
          <input
            value={current.player.name}
            onChange={(event) =>
              patch({ player: { ...current.player, name: event.target.value } })
            }
          />
        </label>
        <label>
          Deskripsi
          <textarea
            value={current.player.description ?? ""}
            onChange={(event) =>
              patch({
                player: { ...current.player, description: event.target.value },
              })
            }
          />
        </label>
        <label>
          Latar belakang
          <textarea
            value={current.player.background ?? ""}
            onChange={(event) =>
              patch({
                player: { ...current.player, background: event.target.value },
              })
            }
          />
        </label>
        <label>
          Kepribadian
          <textarea
            value={current.player.personality ?? ""}
            onChange={(event) =>
              patch({
                player: {
                  ...current.player,
                  personality: event.target.value,
                },
              })
            }
          />
        </label>
        <label>
          Catatan
          <textarea
            value={current.player.notes ?? ""}
            onChange={(event) =>
              patch({
                player: { ...current.player, notes: event.target.value },
              })
            }
          />
        </label>
        {current.attributes.map((attribute) => (
          <label key={attribute.id}>
            {attribute.name || attribute.id} (kosong = nilai default)
            <input
              {...bindNumber(
                `player:attr:${attribute.id}`,
                current.player.attributes[attribute.id],
                (parsed) => {
                  const attributes = { ...current.player.attributes };
                  if (parsed === undefined) delete attributes[attribute.id];
                  else attributes[attribute.id] = parsed;
                  patch({ player: { ...current.player, attributes } });
                },
                true,
              )}
            />
          </label>
        ))}
        {current.resources.map((resource) => (
          <label key={resource.id}>
            {resource.name || resource.id} (kosong = nilai awal)
            <input
              {...bindNumber(
                `player:res:${resource.id}`,
                current.player.resources[resource.id],
                (parsed) => {
                  const resources = { ...current.player.resources };
                  if (parsed === undefined) delete resources[resource.id];
                  else resources[resource.id] = parsed;
                  patch({ player: { ...current.player, resources } });
                },
                true,
              )}
            />
          </label>
        ))}
      </details>

      <details className="card">
        <summary>Atribut</summary>
        {current.attributes.map((attribute, index) => (
          <div className="entity" key={`attr-${index}`}>
            <label>
              Id
              <input
                value={attribute.id}
                readOnly={savedIds.attributes.has(attribute.id)}
                onChange={(event) =>
                  patchAttribute(index, { id: event.target.value })
                }
              />
            </label>
            <label>
              Nama
              <input
                value={attribute.name}
                onChange={(event) =>
                  patchAttribute(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              Deskripsi
              <input
                value={attribute.description ?? ""}
                onChange={(event) =>
                  patchAttribute(index, { description: event.target.value })
                }
              />
            </label>
            <div className="row">
              <label>
                Min
                <input
                  {...bindNumber(
                    `attr:${attribute.id}:min`,
                    attribute.min,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchAttribute(index, { min: parsed });
                    },
                  )}
                />
              </label>
              <label>
                Max
                <input
                  {...bindNumber(
                    `attr:${attribute.id}:max`,
                    attribute.max,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchAttribute(index, { max: parsed });
                    },
                  )}
                />
              </label>
              <label>
                Nilai default
                <input
                  {...bindNumber(
                    `attr:${attribute.id}:default`,
                    attribute.defaultValue,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchAttribute(index, { defaultValue: parsed });
                    },
                  )}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  attributes: d.attributes.filter((_, i) => i !== index),
                }))
              }
            >
              Hapus atribut
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              attributes: [
                ...d.attributes,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  min: 0,
                  max: 10,
                  defaultValue: 0,
                },
              ],
            }))
          }
        >
          Tambah atribut
        </button>
      </details>

      <details className="card">
        <summary>Sumber daya</summary>
        {current.resources.map((resource, index) => (
          <div className="entity" key={`res-${index}`}>
            <label>
              Id
              <input
                value={resource.id}
                readOnly={savedIds.resources.has(resource.id)}
                onChange={(event) =>
                  patchResource(index, { id: event.target.value })
                }
              />
            </label>
            <label>
              Nama
              <input
                value={resource.name}
                onChange={(event) =>
                  patchResource(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              Deskripsi
              <input
                value={resource.description ?? ""}
                onChange={(event) =>
                  patchResource(index, { description: event.target.value })
                }
              />
            </label>
            <div className="row">
              <label>
                Min
                <input
                  {...bindNumber(
                    `res:${resource.id}:min`,
                    resource.min,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchResource(index, { min: parsed });
                    },
                  )}
                />
              </label>
              <label>
                Max (kosong = tak terbatas)
                <input
                  {...bindNumber(
                    `res:${resource.id}:max`,
                    resource.max,
                    (parsed) => {
                      const next = { ...resource };
                      if (parsed === undefined) delete next.max;
                      else next.max = parsed;
                      patch({
                        resources: replaceIn(current.resources, index, next),
                      });
                    },
                    true,
                  )}
                />
              </label>
              <label>
                Nilai awal
                <input
                  {...bindNumber(
                    `res:${resource.id}:initial`,
                    resource.initialValue,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchResource(index, { initialValue: parsed });
                    },
                  )}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  resources: d.resources.filter((_, i) => i !== index),
                }))
              }
            >
              Hapus sumber daya
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              resources: [
                ...d.resources,
                { id: crypto.randomUUID(), name: "", min: 0, initialValue: 0 },
              ],
            }))
          }
        >
          Tambah sumber daya
        </button>
      </details>

      <details className="card">
        <summary>Relasi</summary>
        {current.relationships.map((relationship, index) => (
          <div className="entity" key={`rel-${index}`}>
            <label>
              Id
              <input
                value={relationship.id}
                readOnly={savedIds.relationships.has(relationship.id)}
                onChange={(event) =>
                  patchRelationship(index, { id: event.target.value })
                }
              />
            </label>
            <label>
              Nama
              <input
                value={relationship.name}
                onChange={(event) =>
                  patchRelationship(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              Deskripsi
              <input
                value={relationship.description ?? ""}
                onChange={(event) =>
                  patchRelationship(index, { description: event.target.value })
                }
              />
            </label>
            <div className="row">
              <label>
                Min
                <input
                  {...bindNumber(
                    `rel:${relationship.id}:min`,
                    relationship.min,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchRelationship(index, { min: parsed });
                    },
                  )}
                />
              </label>
              <label>
                Max
                <input
                  {...bindNumber(
                    `rel:${relationship.id}:max`,
                    relationship.max,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchRelationship(index, { max: parsed });
                    },
                  )}
                />
              </label>
              <label>
                Nilai default
                <input
                  {...bindNumber(
                    `rel:${relationship.id}:default`,
                    relationship.defaultValue,
                    (parsed) => {
                      if (parsed !== undefined)
                        patchRelationship(index, { defaultValue: parsed });
                    },
                  )}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  relationships: d.relationships.filter((_, i) => i !== index),
                }))
              }
            >
              Hapus relasi
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              relationships: [
                ...d.relationships,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  min: -10,
                  max: 10,
                  defaultValue: 0,
                },
              ],
            }))
          }
        >
          Tambah relasi
        </button>
      </details>

      <details className="card">
        <summary>Item</summary>
        {current.items.map((item, index) => (
          <div className="entity" key={`item-${index}`}>
            <label>
              Id
              <input
                value={item.id}
                readOnly={savedIds.items.has(item.id)}
                onChange={(event) =>
                  patchItem(index, { id: event.target.value })
                }
              />
            </label>
            <label>
              Nama
              <input
                value={item.name}
                onChange={(event) =>
                  patchItem(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              Deskripsi
              <textarea
                value={item.description ?? ""}
                onChange={(event) =>
                  patchItem(index, { description: event.target.value })
                }
              />
            </label>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={item.stackable}
                  onChange={(event) =>
                    patchItem(index, { stackable: event.target.checked })
                  }
                />
                Bisa ditumpuk
              </label>
              <label>
                Max tumpukan
                <input
                  {...bindNumber(
                    `item:${item.id}:maxStack`,
                    item.maxStack,
                    (parsed) => {
                      const next = { ...item };
                      if (parsed === undefined) delete next.maxStack;
                      else next.maxStack = parsed;
                      patch({ items: replaceIn(current.items, index, next) });
                    },
                    true,
                  )}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={item.consumable}
                  onChange={(event) =>
                    patchItem(index, { consumable: event.target.checked })
                  }
                />
                Bisa dikonsumsi
              </label>
            </div>
            <label>
              Tag (pisahkan dengan koma)
              <input
                value={raws[`item:${item.id}:tags`] ?? item.tags.join(", ")}
                onChange={(event) => {
                  const text = event.target.value;
                  setRaws((prev) => ({
                    ...prev,
                    [`item:${item.id}:tags`]: text,
                  }));
                  patchItem(index, {
                    tags: text
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter((tag) => tag.length > 0),
                  });
                }}
              />
            </label>

            <h4>Efek</h4>
            {item.effects.map((effect, effectIndex) => (
              <div className="entity" key={effectIndex}>
                <div className="row">
                  <label>
                    Tipe
                    <select
                      value={effect.type}
                      onChange={(event) =>
                        patchItem(index, {
                          effects: replaceIn(
                            item.effects,
                            effectIndex,
                            defaultEffect(
                              event.target.value as ItemEffect["type"],
                              current,
                            ),
                          ),
                        })
                      }
                    >
                      {EFFECT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>

                  {(effect.type === "ATTRIBUTE_CHANGE" ||
                    effect.type === "RESOURCE_CHANGE" ||
                    effect.type === "RELATIONSHIP_CHANGE" ||
                    effect.type === "ADD_ITEM" ||
                    effect.type === "REMOVE_ITEM") && (
                    <label>
                      Target
                      <select
                        value={effect.target}
                        onChange={(event) =>
                          patchItem(index, {
                            effects: replaceIn(item.effects, effectIndex, {
                              ...effect,
                              target: event.target.value,
                            }),
                          })
                        }
                      >
                        <option value="">— pilih target —</option>
                        {(
                          (effect.type === "ATTRIBUTE_CHANGE"
                            ? current.attributes
                            : effect.type === "RESOURCE_CHANGE"
                              ? current.resources
                              : effect.type === "RELATIONSHIP_CHANGE"
                                ? current.relationships
                                : current.items) as Array<{
                            id: string;
                            name: string;
                          }>
                        ).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name || option.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {effect.type === "RELATIONSHIP_CHANGE" && (
                    <label>
                      NPC
                      <select
                        value={effect.npcId ?? ""}
                        onChange={(event) =>
                          patchItem(index, {
                            effects: replaceIn(item.effects, effectIndex, {
                              ...effect,
                              npcId: event.target.value || undefined,
                            }),
                          })
                        }
                      >
                        <option value="">— belum dipilih —</option>
                        {current.npcs.map((npc) => (
                          <option key={npc.id} value={npc.id}>
                            {npc.name || npc.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {(effect.type === "ATTRIBUTE_CHANGE" ||
                    effect.type === "RESOURCE_CHANGE" ||
                    effect.type === "RELATIONSHIP_CHANGE") && (
                    <>
                      <label>
                        Operasi
                        <select
                          value={effect.operation}
                          onChange={(event) =>
                            patchItem(index, {
                              effects: replaceIn(item.effects, effectIndex, {
                                ...effect,
                                operation: event.target
                                  .value as EffectOperation,
                              }),
                            })
                          }
                        >
                          {OPERATIONS.map((operation) => (
                            <option key={operation} value={operation}>
                              {operation}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Nilai
                        <input
                          {...bindNumber(
                            `item:${item.id}:fx:${effectIndex}:value`,
                            effect.value,
                            (parsed) => {
                              if (parsed === undefined) return;
                              patchItem(index, {
                                effects: replaceIn(item.effects, effectIndex, {
                                  ...effect,
                                  value: parsed,
                                }),
                              });
                            },
                          )}
                        />
                      </label>
                    </>
                  )}

                  {(effect.type === "ADD_ITEM" ||
                    effect.type === "REMOVE_ITEM") && (
                    <label>
                      Jumlah
                      <input
                        {...bindNumber(
                          `item:${item.id}:fx:${effectIndex}:quantity`,
                          effect.quantity,
                          (parsed) => {
                            if (parsed === undefined) return;
                            patchItem(index, {
                              effects: replaceIn(item.effects, effectIndex, {
                                ...effect,
                                quantity: parsed,
                              }),
                            });
                          },
                        )}
                      />
                    </label>
                  )}

                  {effect.type === "ADD_FACT" && (
                    <label>
                      Fakta yang ditambahkan
                      <input
                        value={effect.text}
                        onChange={(event) =>
                          patchItem(index, {
                            effects: replaceIn(item.effects, effectIndex, {
                              ...effect,
                              text: event.target.value,
                            }),
                          })
                        }
                      />
                    </label>
                  )}

                  {effect.type === "REMOVE_FACT" && (
                    <label>
                      Teks fakta yang dihapus
                      <input
                        value={effect.target}
                        onChange={(event) =>
                          patchItem(index, {
                            effects: replaceIn(item.effects, effectIndex, {
                              ...effect,
                              target: event.target.value,
                            }),
                          })
                        }
                      />
                    </label>
                  )}

                  <button
                    type="button"
                    disabled={working}
                    onClick={() =>
                      patchFn((d) => ({
                        items: replaceIn(d.items, index, {
                          ...d.items[index],
                          effects: d.items[index].effects.filter(
                            (_, i) => i !== effectIndex,
                          ),
                        }),
                      }))
                    }
                  >
                    Hapus efek
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  items: replaceIn(d.items, index, {
                    ...d.items[index],
                    effects: [
                      ...d.items[index].effects,
                      defaultEffect("ATTRIBUTE_CHANGE", d),
                    ],
                  }),
                }))
              }
            >
              Tambah efek
            </button>

            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  items: d.items.filter((_, i) => i !== index),
                }))
              }
            >
              Hapus item
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              items: [
                ...d.items,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  stackable: true,
                  maxStack: 1,
                  consumable: false,
                  effects: [],
                  tags: [],
                },
              ],
            }))
          }
        >
          Tambah item
        </button>
      </details>

      <details className="card">
        <summary>Inventaris awal</summary>
        {current.startingInventory.map((entry, index) => (
          <div className="row" key={`${entry.itemId}-${index}`}>
            <label>
              Item
              <select
                value={entry.itemId}
                onChange={(event) =>
                  patch({
                    startingInventory: replaceIn(
                      current.startingInventory,
                      index,
                      { ...entry, itemId: event.target.value },
                    ),
                  })
                }
              >
                <option value="">— pilih item —</option>
                {current.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kuantitas
              <input
                {...bindNumber(
                  `inv:${entry.itemId}:quantity`,
                  entry.quantity,
                  (parsed) => {
                    if (parsed === undefined) return;
                    patch({
                      startingInventory: replaceIn(
                        current.startingInventory,
                        index,
                        { ...entry, quantity: parsed },
                      ),
                    });
                  },
                )}
              />
            </label>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  startingInventory: d.startingInventory.filter(
                    (_, i) => i !== index,
                  ),
                }))
              }
            >
              Hapus
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              startingInventory: [
                ...d.startingInventory,
                { itemId: d.items[0]?.id ?? "", quantity: 1 },
              ],
            }))
          }
        >
          Tambah entri
        </button>
      </details>

      <details className="card">
        <summary>NPC</summary>
        {current.npcs.map((npc, index) => (
          <div className="entity" key={`npc-${index}`}>
            <label>
              Id
              <input
                value={npc.id}
                readOnly={savedIds.npcs.has(npc.id)}
                onChange={(event) =>
                  patchNpc(index, { id: event.target.value })
                }
              />
            </label>
            <label>
              Nama
              <input
                value={npc.name}
                onChange={(event) =>
                  patchNpc(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              Deskripsi
              <input
                value={npc.description ?? ""}
                onChange={(event) =>
                  patchNpc(index, { description: event.target.value })
                }
              />
            </label>
            <label>
              Latar belakang
              <textarea
                value={npc.background ?? ""}
                onChange={(event) =>
                  patchNpc(index, { background: event.target.value })
                }
              />
            </label>
            <label>
              Peran
              <input
                value={npc.role ?? ""}
                onChange={(event) =>
                  patchNpc(index, { role: event.target.value })
                }
              />
            </label>
            <label>
              Kepribadian (satu per baris)
              <textarea
                {...bindLines(
                  `npc:${npc.id}:personality`,
                  npc.personality,
                  (lines) => patchNpc(index, { personality: lines }),
                )}
              />
            </label>
            <label>
              Tujuan (satu per baris)
              <textarea
                {...bindLines(`npc:${npc.id}:goals`, npc.goals, (lines) =>
                  patchNpc(index, { goals: lines }),
                )}
              />
            </label>
            <label>
              Pengetahuan rahasia (satu per baris)
              <textarea
                {...bindLines(
                  `npc:${npc.id}:privateKnowledge`,
                  npc.privateKnowledge,
                  (lines) => patchNpc(index, { privateKnowledge: lines }),
                )}
              />
            </label>
            {current.relationships.map((relationship) => (
              <label key={relationship.id}>
                Relasi awal: {relationship.name || relationship.id} (kosong =
                nilai default)
                <input
                  {...bindNumber(
                    `npc:${npc.id}:rel:${relationship.id}`,
                    npc.initialRelationships[relationship.id],
                    (parsed) => {
                      const initialRelationships = {
                        ...npc.initialRelationships,
                      };
                      if (parsed === undefined)
                        delete initialRelationships[relationship.id];
                      else initialRelationships[relationship.id] = parsed;
                      patchNpc(index, { initialRelationships });
                    },
                    true,
                  )}
                />
              </label>
            ))}
            {current.attributes.map((attribute) => (
              <label key={attribute.id}>
                Atribut NPC: {attribute.name || attribute.id} (opsional)
                <input
                  {...bindNumber(
                    `npc:${npc.id}:attr:${attribute.id}`,
                    npc.attributes?.[attribute.id],
                    (parsed) => {
                      const attributes = { ...npc.attributes };
                      if (parsed === undefined) delete attributes[attribute.id];
                      else attributes[attribute.id] = parsed;
                      patchNpc(index, { attributes });
                    },
                    true,
                  )}
                />
              </label>
            ))}
            <button
              type="button"
              disabled={working}
              onClick={() =>
                patchFn((d) => ({
                  npcs: d.npcs.filter((_, i) => i !== index),
                }))
              }
            >
              Hapus NPC
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={working}
          onClick={() =>
            patchFn((d) => ({
              npcs: [
                ...d.npcs,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  personality: [],
                  goals: [],
                  privateKnowledge: [],
                  initialRelationships: {},
                },
              ],
            }))
          }
        >
          Tambah NPC
        </button>
      </details>

      <div className="sticky-actions">
        <button type="button" onClick={handleSave} disabled={working}>
          Simpan
        </button>
        <button
          type="button"
          className="primary"
          onClick={handleStart}
          disabled={working}
        >
          Mulai Permainan
        </button>
      </div>

      {templateReview && (
        <section
          className="card"
          role="alertdialog"
          aria-label="Review template"
        >
          <h2>Review template sebelum diterapkan</h2>
          <p>
            Judul: <strong>{templateReview.draft.title || "(kosong)"}</strong>
          </p>
          <p className="hint">
            {templateReview.draft.attributes.length} atribut ·{" "}
            {templateReview.draft.resources.length} sumber daya ·{" "}
            {templateReview.draft.relationships.length} relasi ·{" "}
            {templateReview.draft.items.length} item ·{" "}
            {templateReview.draft.npcs.length} NPC ·{" "}
            {templateReview.draft.startingInventory.length} inventaris awal
            {templateReview.ai
              ? " · Pengaturan AI template akan diabaikan; default Settings digunakan."
              : ""}
          </p>
          {touched && (
            <p className="error">
              Draft saat ini sudah diedit. Menerapkan template akan mengganti
              seluruh isi draft yang belum disimpan.
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={applyTemplateReview}
            >
              Terapkan ke draft
            </button>
            <button type="button" onClick={() => setTemplateReview(null)}>
              Batal
            </button>
          </div>
        </section>
      )}

      <dialog
        ref={discardDialogRef}
        onClose={() => backButtonRef.current?.focus()}
      >
        <h2>Perubahan belum disimpan</h2>
        <p>Ada perubahan pada draft yang belum disimpan. Apa yang dilakukan?</p>
        <div className="row">
          <button
            type="button"
            onClick={async () => {
              const saved = await handleSave();
              discardDialogRef.current?.close();
              if (saved) {
                if (pendingExit === "settings") onOpenSettings();
                else onBack();
              }
            }}
          >
            Simpan & keluar
          </button>
          <button
            type="button"
            onClick={() => {
              discardDialogRef.current?.close();
              if (pendingExit === "settings") onOpenSettings();
              else onBack();
            }}
          >
            Buang perubahan
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingExit(null);
              discardDialogRef.current?.close();
            }}
          >
            Tetap mengedit
          </button>
        </div>
      </dialog>
    </div>
  );
}
