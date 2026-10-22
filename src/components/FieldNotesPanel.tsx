import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export const FIELD_NOTE_CATEGORIES = [
  { id: "player", label: "Kamu" },
  { id: "people", label: "Hadir" },
  { id: "inventory", label: "Tas" },
  { id: "facts", label: "Dunia" },
] as const;

export type FieldNoteCategory = (typeof FIELD_NOTE_CATEGORIES)[number]["id"];

interface FieldNotesPanelProps {
  open: boolean;
  onClose: () => void;
  category: FieldNoteCategory;
  onCategoryChange: (category: FieldNoteCategory) => void;
  sections: Record<FieldNoteCategory, ReactNode>;
}

export default function FieldNotesPanel({
  open,
  onClose,
  category,
  onCategoryChange,
  sections,
}: FieldNotesPanelProps) {
  const [compact, setCompact] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1199px)").matches,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!compact) {
      if (dialog.open) dialog.close();
      if (open) onClose();
      const returnFocus = returnFocusRef.current;
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocusRef.current = null;
      return;
    }
    if (open && !dialog.open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.showModal();
      closeButtonRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      const returnFocus = returnFocusRef.current;
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocusRef.current = null;
    }
  }, [compact, open, onClose]);

  function handleTabKey(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleCategoryKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const offset =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : event.key === "Home"
            ? -index
            : event.key === "End"
              ? FIELD_NOTE_CATEGORIES.length - 1 - index
              : 0;
    if (offset === 0) return;
    event.preventDefault();
    const nextIndex =
      (index + offset + FIELD_NOTE_CATEGORIES.length) %
      FIELD_NOTE_CATEGORIES.length;
    onCategoryChange(FIELD_NOTE_CATEGORIES[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  function renderMobileTabs() {
    return (
      <div
        className="notes-categories"
        role="tablist"
        aria-label="Kategori catatan"
      >
        {FIELD_NOTE_CATEGORIES.map((entry, index) => (
          <button
            key={entry.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`${id}-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={category === entry.id}
            aria-controls={`${id}-panel-${entry.id}`}
            tabIndex={category === entry.id ? 0 : -1}
            onClick={() => onCategoryChange(entry.id)}
            onKeyDown={(event) => handleCategoryKeyDown(event, index)}
          >
            {entry.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <>
      <aside
        className="notes notes-desktop"
        aria-labelledby={`${id}-desktop-title`}
      >
        <span className="eyebrow">Catatan lapangan</span>
        <h2 id={`${id}-desktop-title`}>Catatan</h2>
        <div className="notes-groups">
          {FIELD_NOTE_CATEGORIES.map((entry, index) => (
            <details key={entry.id} className="notes-group" open={index === 0}>
              <summary>{entry.label}</summary>
              <div className="notes-content">{sections[entry.id]}</div>
            </details>
          ))}
        </div>
      </aside>
      <dialog
        ref={dialogRef}
        className="notes-dialog"
        aria-labelledby={`${id}-mobile-title`}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onKeyDown={handleTabKey}
      >
        <div className="notes-sheet">
          <header className="notes-sheet-head">
            <div>
              <span className="eyebrow">Catatan lapangan</span>
              <h2 id={`${id}-mobile-title`}>Catatan</h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="quiet"
              aria-label="Tutup catatan"
              onClick={onClose}
            >
              Tutup
            </button>
          </header>
          {renderMobileTabs()}
          {FIELD_NOTE_CATEGORIES.map((entry) => (
            <section
              key={entry.id}
              id={`${id}-panel-${entry.id}`}
              className="notes-content"
              role="tabpanel"
              aria-labelledby={`${id}-tab-${entry.id}`}
              tabIndex={0}
              hidden={category !== entry.id}
            >
              {sections[entry.id]}
            </section>
          ))}
          <footer className="notes-sheet-foot">
            <button type="button" className="quiet" onClick={onClose}>
              Kembali ke cerita
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
