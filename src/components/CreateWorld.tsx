import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSavedTemplate,
  listSavedTemplates,
  type SavedTemplateRecord,
} from "../api";
import { createUuid } from "../../shared/uuid";
import type { GameDefinition } from "../types";
import exampleTemplate from "../../examples/game-template.json";
import {
  buildBlankDraft,
  buildBuiltinDraft,
  buildSavedTemplateDraft,
} from "../world-drafts";

interface CreateWorldProps {
  onBack: () => void;
  onSelectDraft: (draft: GameDefinition) => void;
}

type DraftChoice =
  { kind: "builtin" } | { kind: "blank" } | { kind: "saved"; id: string };

export default function CreateWorld({
  onBack,
  onSelectDraft,
}: CreateWorldProps) {
  const [selected, setSelected] = useState<DraftChoice>({ kind: "builtin" });
  const [savedTemplates, setSavedTemplates] = useState<
    SavedTemplateRecord[] | null
  >(null);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const [usingChoice, setUsingChoice] = useState(false);
  const listRequestId = useRef(0);
  const useRequestId = useRef(0);

  const loadTemplates = useCallback(async () => {
    const requestId = ++listRequestId.current;
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const records = await listSavedTemplates();
      if (requestId !== listRequestId.current) return;
      setSavedTemplates(records);
    } catch (error) {
      if (requestId !== listRequestId.current) return;
      setTemplatesError(
        error instanceof Error
          ? error.message
          : "Template tersimpan tidak dapat dimuat.",
      );
    } finally {
      if (requestId === listRequestId.current) setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    return () => {
      listRequestId.current += 1;
      useRequestId.current += 1;
    };
  }, [loadTemplates]);

  function choose(choice: DraftChoice) {
    setSelected(choice);
    setUseError(null);
  }
  function handleBack() {
    useRequestId.current += 1;
    onBack();
  }

  async function useSelectedChoice() {
    if (usingChoice) return;
    const requestId = ++useRequestId.current;
    setUsingChoice(true);
    setUseError(null);
    try {
      let draft: GameDefinition;
      if (selected.kind === "blank") {
        draft = buildBlankDraft({
          id: createUuid(),
          updatedAt: new Date().toISOString(),
        });
      } else if (selected.kind === "builtin") {
        draft = buildBuiltinDraft(exampleTemplate, {
          id: createUuid(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        const bundle = await getSavedTemplate(selected.id);
        if (requestId !== useRequestId.current) return;
        draft = buildSavedTemplateDraft(bundle, () => ({
          id: createUuid(),
          updatedAt: new Date().toISOString(),
        }));
      }
      if (requestId === useRequestId.current) onSelectDraft(draft);
    } catch (error) {
      if (requestId === useRequestId.current) {
        setUseError(
          error instanceof Error
            ? error.message
            : "Draft tidak dapat dibuat dari pilihan ini.",
        );
      }
    } finally {
      if (requestId === useRequestId.current) setUsingChoice(false);
    }
  }

  const example = exampleTemplate.game;
  const exampleMeta = `${example.npcs.length} tokoh · ${
    "worldMap" in example ? "peta dunia tersedia" : "tanpa peta khusus"
  }`;

  return (
    <section aria-label="Buat dunia">
      <nav className="row" aria-label="Jejak navigasi">
        <button type="button" className="quiet" onClick={handleBack}>
          Perpustakaan
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Buat dunia</span>
      </nav>

      <div className="section-head">
        <div>
          <span className="eyebrow">Pilih titik awal</span>
          <h2>Mulai dari dunia yang siap disunting.</h2>
          <p className="hint">
            Pilihan menjadi draft di editor. Belum ada data yang disimpan.
          </p>
        </div>
      </div>

      <div className="world-grid" role="group" aria-label="Pilihan draft">
        <article className="world">
          <button
            type="button"
            className="world-hit"
            aria-label={`Pilih contoh ${example.title}`}
            aria-pressed={selected.kind === "builtin"}
            disabled={usingChoice}
            onClick={() => choose({ kind: "builtin" })}
          />
          <span className="eyebrow">Contoh dari repositori</span>
          <h3>{example.title}</h3>
          <p>{example.description}</p>
          <p className="hint">
            {exampleMeta}
            {selected.kind === "builtin" ? " · Dipilih" : ""}
          </p>
        </article>

        <article className="world">
          <button
            type="button"
            className="world-hit"
            aria-label="Pilih dunia kosong"
            aria-pressed={selected.kind === "blank"}
            disabled={usingChoice}
            onClick={() => choose({ kind: "blank" })}
          />
          <span className="eyebrow">Mulai dari awal</span>
          <h3>Dunia kosong</h3>
          <p>
            Tulis latar, situasi pembuka, dan nama pemain sendiri di editor.
          </p>
          <p className="hint">
            Katalog, tokoh, dan inventaris awal kosong
            {selected.kind === "blank" ? " · Dipilih" : ""}
          </p>
        </article>

        <div className="world">
          <span className="eyebrow">Template tersimpan</span>
          <h3>Gunakan kembali sebuah template.</h3>
          {templatesLoading && (
            <p role="status" aria-live="polite">
              Memuat template tersimpan…
            </p>
          )}
          {templatesError && (
            <div className="error" role="alert">
              Template tersimpan tidak dapat dimuat: {templatesError}{" "}
              {savedTemplates !== null && (
                <span>Daftar terakhir yang dimuat tetap ditampilkan. </span>
              )}
              <button
                type="button"
                className="quiet"
                onClick={() => void loadTemplates()}
                disabled={templatesLoading}
              >
                {templatesLoading ? "Mencoba lagi…" : "Coba lagi"}
              </button>
            </div>
          )}
          {savedTemplates?.length === 0 && !templatesLoading && (
            <p className="hint">
              Belum ada template tersimpan. Template akan muncul di sini saat
              tersedia.
            </p>
          )}
          {savedTemplates && savedTemplates.length > 0 && (
            <ul>
              {savedTemplates.map((template) => {
                const isSelected =
                  selected.kind === "saved" && selected.id === template.id;
                return (
                  <li key={template.id}>
                    <button
                      type="button"
                      className="quiet"
                      aria-pressed={isSelected}
                      disabled={usingChoice}
                      onClick={() => choose({ kind: "saved", id: template.id })}
                    >
                      {template.title}
                      {isSelected ? " · Dipilih" : ""}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {useError && (
        <p className="error" role="alert">
          {useError}
        </p>
      )}

      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => void useSelectedChoice()}
          disabled={usingChoice}
        >
          {usingChoice ? "Menyiapkan draft…" : "Gunakan pilihan & buka editor"}
        </button>
        <button type="button" className="quiet" onClick={handleBack}>
          Batal
        </button>
      </div>

      <p className="footer-note">
        Draft baru disimpan saat kamu memilih Simpan di editor.
      </p>
    </section>
  );
}
