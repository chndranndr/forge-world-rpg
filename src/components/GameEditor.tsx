import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ApiError,
  createGame,
  exportLorebook,
  getGame,
  getSavedTemplate,
  importLorebook,
  listAiProfiles,
  listLorebooks,
  listLoreEntries,
  listLoreLinks,
  listSavedTemplates,
  listSessions,
  previewLore,
  startSavedSession,
  updateGame,
  type LorebookImportResult,
  type LorebookList,
  type LoreEntryPage,
  type LoreLinkPage,
  type LorePreview,
  type SavedTemplateRecord,
  type SessionSummaryRecord,
} from "../api";
import {
  ImportError,
  validateDefinition,
  validateDefinitionUpdate,
  validatePlayability,
} from "../../shared/validation.js";
import {
  applyTemplateDraft,
  exportTemplate,
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  type TemplateDraft,
} from "../template";
import {
  LorebookValidationError,
  MAX_LOREBOOK_BYTES,
  parseLorebookPack,
} from "../../shared/lore.js";
import { parseWorldMap } from "../../shared/world.js";
import type {
  AiConfig,
  EffectOperation,
  FactVisibility,
  GameDefinition,
  ItemDefinition,
  ItemEffect,
  LoreKind,
  LorebookRef,
  NpcDefinition,
} from "../types";
import { PLAYER_ID } from "../../shared/types";
import exampleTemplate from "../../examples/game-template.json";
import evolvingStoryLorebook from "../../examples/lorebook-evolving-story.json?raw";
import evolvingStoryGame from "../../examples/lorebook-evolving-game.json?raw";
import evolvingStoryGuide from "../../examples/lorebook-evolving-guide.md?raw";
import { createUuid } from "../../shared/uuid";
import { storyIllustration } from "../illustrations";

export interface GameEditorHandle {
  requestNavigation(navigate: () => void): void;
}

interface GameEditorProps {
  gameId: string;
  initialDraft?: GameDefinition | null;
  defaultAi: AiConfig;
  defaultProfileId?: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onDraftPersisted: () => void | Promise<void>;
  onStarted: (sessionId: string) => void;
}

const EFFECT_TYPES = [
  "ATTRIBUTE_CHANGE",
  "RESOURCE_CHANGE",
  "RELATIONSHIP_CHANGE",
  "ADD_ITEM",
  "REMOVE_ITEM",
  "ADD_FACT",
  "REMOVE_FACT",
  "DISCOVER_LORE",
  "REVEAL_FACT",
  "SET_FLAG",
  "NPC_PRESENCE",
] as const satisfies readonly ItemEffect["type"][];
type EditableItemEffectType = (typeof EFFECT_TYPES)[number];

const OPERATIONS: EffectOperation[] = ["ADD", "SUBTRACT", "SET"];
const LORE_KINDS: LoreKind[] = [
  "world",
  "region",
  "location",
  "place",
  "npc",
  "faction",
  "history",
  "monster",
  "item",
  "activity",
  "other",
];
const AGE_RATINGS = [
  { value: "all-ages", label: "Semua usia" },
  { value: "teen-13-plus", label: "Remaja 13+" },
  { value: "adult-18-plus", label: "Dewasa 18+" },
] as const;
const NARRATOR_STYLES = [
  { value: "cinematic-second-person", label: "Sinematis, orang kedua" },
  { value: "literary-third-person", label: "Literer, orang ketiga" },
  { value: "concise-second-person", label: "Ringkas, orang kedua" },
] as const;
const SCENARIO_TEMPOS = [
  { value: "slow", label: "Lambat" },
  { value: "medium", label: "Sedang" },
  { value: "fast", label: "Cepat" },
] as const;
const TURN_LENGTHS = [
  { value: "short", label: "Singkat" },
  { value: "medium", label: "Sedang" },
  { value: "long", label: "Panjang" },
] as const;
const POINTS_OF_VIEW = [
  { value: "second-person", label: "Orang kedua" },
  { value: "limited-third-person", label: "Orang ketiga terbatas" },
] as const;
const PLAYER_PRONOUNS = [
  { value: "neutral", label: "Netral" },
  { value: "masculine", label: "Maskulin" },
  { value: "feminine", label: "Feminin" },
] as const;
const RELATIONSHIP_STANCES = [
  { value: "friendly", label: "Ramah" },
  { value: "neutral", label: "Netral" },
  { value: "wary", label: "Waspada" },
  { value: "hostile", label: "Bermusuhan" },
] as const;
const FACT_VISIBILITIES = [
  { value: "public", label: "Publik" },
  { value: "private", label: "Rahasia" },
] as const satisfies readonly { value: FactVisibility; label: string }[];
const EDITABLE_COLLECTIONS = [
  "attributes",
  "resources",
  "relationships",
  "relationshipParties",
  "items",
  "npcs",
] as const;
type EditableCollection = (typeof EDITABLE_COLLECTIONS)[number];
const EDITOR_SECTION_GROUPS = [
  { id: "story", label: "Dasar cerita" },
  { id: "world", label: "Isi dunia" },
  { id: "rules", label: "Aturan permainan" },
  { id: "review", label: "Tinjau" },
] as const;
const EDITOR_SECTIONS = [
  { id: "summary", label: "Ringkasan", group: "story" },
  { id: "scenario", label: "Skenario", group: "story" },
  { id: "player", label: "Pemain", group: "story" },
  { id: "worldmap", label: "Peta dunia", group: "world" },
  { id: "npcs", label: "NPC", group: "world" },
  { id: "items", label: "Item", group: "world" },
  { id: "inventory", label: "Inventaris awal", group: "world" },
  { id: "lorebook", label: "Lorebook", group: "world" },
  { id: "attributes", label: "Atribut", group: "rules" },
  { id: "resources", label: "Sumber daya", group: "rules" },
  { id: "relationships", label: "Relasi", group: "rules" },
  { id: "preview", label: "Pratinjau", group: "review" },
] as const;
type EditorSectionId = (typeof EDITOR_SECTIONS)[number]["id"];

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : fallback;
}

function downloadText(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function defaultEffect(
  type: EditableItemEffectType,
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
        npcId: game.npcs[0]?.id ?? "",
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
    case "DISCOVER_LORE":
      return { type, loreId: "" };
    case "REVEAL_FACT":
      return { type, factId: "", npcId: PLAYER_ID };
    case "SET_FLAG":
      return {
        type,
        target: Object.keys(game.worldMap?.flags ?? {})[0] ?? "",
        value: false,
      };
    case "NPC_PRESENCE":
      return { type, npcId: game.npcs[0]?.id ?? "", present: true };
  }
}

function replaceIn<T>(list: T[], index: number, entry: T): T[] {
  const next = [...list];
  next[index] = entry;
  return next;
}

function optionalText<T extends object>(
  source: T,
  key: string,
  text: string,
): T {
  const next = { ...source };
  if (text === "") Reflect.deleteProperty(next, key);
  else Reflect.set(next, key, text);
  return next;
}

function duplicateAfter<T extends { id: string }>(
  list: T[],
  index: number,
  id: string,
): T[] {
  return [
    ...list.slice(0, index + 1),
    { ...structuredClone(list[index]), id },
    ...list.slice(index + 1),
  ];
}

function moveById<T extends { id: string }>(
  list: T[],
  id: string,
  direction: "up" | "down",
): T[] {
  const index = list.findIndex((entry) => entry.id === id);
  const target = index + (direction === "up" ? -1 : 1);
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export default forwardRef<GameEditorHandle, GameEditorProps>(
  function GameEditor(
    {
      gameId,
      initialDraft,
      defaultAi,
      defaultProfileId,
      onBack,
      onOpenSettings,
      onDraftPersisted,
      onStarted,
    }: GameEditorProps,
    ref,
  ) {
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
    const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
    const [templateReview, setTemplateReview] = useState<{
      draft: TemplateDraft;
      ai?: AiConfig;
    } | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [lorebookOffset, setLorebookOffset] = useState(0);
    const [lorebookPage, setLorebookPage] = useState<LorebookList | null>(null);
    const [lorebookLoading, setLorebookLoading] = useState(false);
    const [loreEntriesOffset, setLoreEntriesOffset] = useState(0);
    const [loreEntriesPage, setLoreEntriesPage] =
      useState<LoreEntryPage | null>(null);
    const [loreEntriesLoading, setLoreEntriesLoading] = useState(false);
    const [loreRef, setLoreRef] = useState<LorebookRef | null>(null);
    const [loreQuery, setLoreQuery] = useState("");
    const [loreKind, setLoreKind] = useState<LoreKind | "">("");
    const [loreError, setLoreError] = useState<string | null>(null);
    const [loreReload, setLoreReload] = useState(0);
    const [loreImportError, setLoreImportError] = useState<string | null>(null);
    const [loreImportStage, setLoreImportStage] = useState<{
      status: "dry-run" | "published";
      fileName: string;
      result: LorebookImportResult;
    } | null>(null);
    const [lorePreview, setLorePreview] = useState<LorePreview | null>(null);
    const [lorePreviewLocationId, setLorePreviewLocationId] = useState<
      string | null
    >(null);
    const [lorePreviewQuery, setLorePreviewQuery] = useState("");
    const [lorePreviewError, setLorePreviewError] = useState<string | null>(
      null,
    );
    const [loreWorking, setLoreWorking] = useState(false);
    const [loreLinksFor, setLoreLinksFor] = useState<string | null>(null);
    const [loreLinkPage, setLoreLinkPage] = useState<LoreLinkPage | null>(null);
    const [loreLinkOffset, setLoreLinkOffset] = useState(0);
    const [worldMapError, setWorldMapError] = useState<string | null>(null);
    const [rawIssues, setRawIssues] = useState<Record<string, string>>({});
    const [activeSection, setActiveSection] =
      useState<EditorSectionId>("summary");
    const [fieldSearch, setFieldSearch] = useState("");
    const [sessionsCount, setSessionsCount] = useState<number | null>(null);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsError, setSessionsError] = useState<string | null>(null);
    const [sessionsRetry, setSessionsRetry] = useState(0);
    const [savedTemplates, setSavedTemplates] = useState<
      SavedTemplateRecord[] | null
    >(null);
    const [templatesLoading, setTemplatesLoading] = useState(true);
    const [templatesError, setTemplatesError] = useState<string | null>(null);
    const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(
      null,
    );
    const [profileName, setProfileName] = useState<string | null>(null);
    const [profileError, setProfileError] = useState<string | null>(null);
    const [profileRetry, setProfileRetry] = useState(0);
    const [entitiesExpanded, setEntitiesExpanded] = useState(true);
    const [issueFocusVersion, setIssueFocusVersion] = useState(0);
    const [readinessOpen, setReadinessOpen] = useState(false);
    const [sectionSheetOpen, setSectionSheetOpen] = useState(false);
    const [previewAsideOpen, setPreviewAsideOpen] = useState(true);
    const sectionPanelRefs = useRef<
      Partial<Record<EditorSectionId, HTMLElement | null>>
    >({});
    const sectionDialogRef = useRef<HTMLDialogElement>(null);
    const sectionButtonRef = useRef<HTMLButtonElement>(null);
    const previewDialogRef = useRef<HTMLDialogElement>(null);
    const previewReturnSection = useRef<EditorSectionId>("summary");
    const dirtyRef = useRef(false);
    const pendingIssueFocusRef = useRef<{
      section: EditorSectionId;
      fieldKey?: string;
      collection?: string;
      entityId?: string;
      entityIndex?: number;
      effectIndex?: number;
      inventoryIndex?: number;
      fieldName?: string;
    } | null>(null);
    const reorderFocusRef = useRef<{
      collection: EditableCollection;
      id: string;
    } | null>(null);
    const inventoryReorderFocusRef = useRef<number | null>(null);
    const stagedLoreFile = useRef<File | null>(null);
    const discardDialogRef = useRef<HTMLDialogElement>(null);
    const backButtonRef = useRef<HTMLButtonElement>(null);
    const saveShortcutRef = useRef<(() => Promise<boolean>) | null>(null);
    const requestExit = (navigate: () => void) => {
      if (dirtyRef.current) {
        const dialog = discardDialogRef.current;
        if (!dialog?.open) {
          setPendingExit(() => navigate);
          dialog?.showModal();
        }
        return;
      }
      navigate();
    };

    useImperativeHandle(ref, () => ({ requestNavigation: requestExit }), [
      requestExit,
    ]);

    useEffect(() => {
      const handleShortcut = (event: KeyboardEvent) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s" &&
          !event.altKey
        ) {
          event.preventDefault();
          void saveShortcutRef.current?.();
        }
      };
      window.addEventListener("keydown", handleShortcut);
      return () => window.removeEventListener("keydown", handleShortcut);
    }, []);
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
    useEffect(() => {
      if (revision === null) {
        setSessionsCount(null);
        setSessionsError(null);
        setSessionsLoading(false);
        return;
      }
      let active = true;
      setSessionsCount(null);
      setSessionsError(null);
      setSessionsLoading(true);
      void listSessions(gameId)
        .then((sessions) => {
          if (active) setSessionsCount(sessions.length);
        })
        .catch((error: unknown) => {
          if (active)
            setSessionsError(
              describeError(error, "Jumlah sesi dunia tidak dapat dimuat."),
            );
        })
        .finally(() => {
          if (active) setSessionsLoading(false);
        });
      return () => {
        active = false;
      };
    }, [gameId, revision, sessionsRetry]);

    useEffect(() => {
      let active = true;
      setTemplatesLoading(true);
      setTemplatesError(null);
      void listSavedTemplates()
        .then((templates) => {
          if (active) setSavedTemplates(templates);
        })
        .catch((error: unknown) => {
          if (active)
            setTemplatesError(
              describeError(error, "Template tersimpan tidak dapat dimuat."),
            );
        })
        .finally(() => {
          if (active) setTemplatesLoading(false);
        });
      return () => {
        active = false;
      };
    }, []);

    useEffect(() => {
      if (defaultProfileId === undefined) {
        setProfileName(null);
        setProfileError(null);
        return;
      }
      let active = true;
      setProfileError(null);
      void listAiProfiles()
        .then((profiles) => {
          if (!active) return;
          const selected = profiles.find(
            (profile) => profile.id === defaultProfileId,
          );
          setProfileName(selected?.name ?? null);
          setProfileError(
            selected ? null : "Profil AI default tidak ditemukan.",
          );
        })
        .catch((error: unknown) => {
          if (active) {
            setProfileName(null);
            setProfileError(
              describeError(error, "Nama profil AI tidak dapat dimuat."),
            );
          }
        });
      return () => {
        active = false;
      };
    }, [defaultProfileId, profileRetry]);

    useEffect(() => {
      let active = true;
      setLorebookLoading(true);
      void listLorebooks({ limit: 20, offset: lorebookOffset })
        .then((page) => {
          if (!active) return;
          setLorebookPage(page);
          setLoreError(null);
        })
        .catch((error: unknown) => {
          if (active)
            setLoreError(describeError(error, "Lorebook gagal dimuat."));
        })
        .finally(() => {
          if (active) setLorebookLoading(false);
        });
      return () => {
        active = false;
      };
    }, [lorebookOffset, loreReload]);

    useEffect(() => {
      if (!loreRef) {
        setLoreEntriesPage(null);
        return;
      }
      let active = true;
      setLoreEntriesLoading(true);
      setLoreEntriesPage(null);
      setLoreLinkPage(null);
      setLoreLinksFor(null);
      const query = loreQuery.trim();
      void listLoreEntries(loreRef, {
        limit: 20,
        offset: loreEntriesOffset,
        ...(query ? { query } : {}),
        ...(loreKind ? { kind: loreKind } : {}),
      })
        .then((page) => {
          if (!active) return;
          setLoreEntriesPage(page);
          setLoreError(null);
        })
        .catch((error: unknown) => {
          if (active)
            setLoreError(describeError(error, "Entri lore gagal dimuat."));
        })
        .finally(() => {
          if (active) setLoreEntriesLoading(false);
        });
      return () => {
        active = false;
      };
    }, [loreRef, loreQuery, loreKind, loreEntriesOffset, loreReload]);

    useEffect(() => {
      if (!loreRef || !loreLinksFor) {
        setLoreLinkPage(null);
        return;
      }
      let active = true;
      setLoreLinkPage(null);
      void listLoreLinks(loreRef, loreLinksFor, {
        limit: 20,
        offset: loreLinkOffset,
      })
        .then((page) => {
          if (active) {
            setLoreLinkPage(page);
            setLoreError(null);
          }
        })
        .catch((error: unknown) => {
          if (active)
            setLoreError(describeError(error, "Tautan lore gagal dimuat."));
        });
      return () => {
        active = false;
      };
    }, [loreRef, loreLinksFor, loreLinkOffset, loreReload]);

    const current = draft;

    useEffect(() => {
      const panel = sectionPanelRefs.current[activeSection];
      if (!panel) return;
      const query = fieldSearch.trim().toLocaleLowerCase();
      for (const label of panel.querySelectorAll<HTMLLabelElement>("label")) {
        const matches =
          !query ||
          (label.textContent ?? "").toLocaleLowerCase().includes(query);
        label.hidden = !matches;
        if (matches && query) {
          for (
            let parent = label.parentElement;
            parent && parent !== panel;
            parent = parent.parentElement
          ) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
          }
        }
      }
    }, [
      activeSection,
      fieldSearch,
      draft,
      raws,
      lorebookPage,
      loreEntriesPage,
    ]);
    useEffect(() => {
      if (!draft) return;
      const fieldKeys = new Set(
        Object.values(sectionPanelRefs.current).flatMap((panel) =>
          Array.from(
            panel?.querySelectorAll<HTMLElement>("[data-field-key]") ?? [],
          ).map((field) => field.dataset.fieldKey ?? ""),
        ),
      );
      const keepCurrentFields = (values: Record<string, string>) => {
        const next = Object.fromEntries(
          Object.entries(values).filter(([key]) => fieldKeys.has(key)),
        );
        return Object.keys(next).length === Object.keys(values).length
          ? values
          : next;
      };
      setRawIssues(keepCurrentFields);
      setRaws(keepCurrentFields);
    }, [draft]);

    useEffect(() => {
      const pending = pendingIssueFocusRef.current;
      if (!pending || pending.section !== activeSection) return;
      const focus = () => {
        const panel = sectionPanelRefs.current[pending.section];
        if (!panel) return;
        const fields = Array.from(
          panel.querySelectorAll<HTMLElement>("[data-field-key]"),
        );
        let target = pending.fieldKey
          ? fields.find((field) => field.dataset.fieldKey === pending.fieldKey)
          : undefined;
        if (!target && pending.effectIndex !== undefined) {
          const effect = Array.from(
            panel.querySelectorAll<HTMLElement>("[data-effect-index]"),
          ).find(
            (field) =>
              field.dataset.effectIndex === String(pending.effectIndex) &&
              (!pending.entityId ||
                field
                  .closest("[data-entity-id]")
                  ?.getAttribute("data-entity-id") === pending.entityId),
          );
          target = effect;
        }
        if (!target && pending.entityId) {
          target = Array.from(
            panel.querySelectorAll<HTMLElement>("[data-entity-id]"),
          ).find(
            (field) =>
              field.dataset.entityId === pending.entityId &&
              (!pending.collection ||
                field.dataset.entityType === pending.collection),
          );
        }
        if (!target && pending.entityIndex !== undefined) {
          target = Array.from(
            panel.querySelectorAll<HTMLElement>("[data-entity-index]"),
          ).find(
            (field) =>
              field.dataset.entityIndex === String(pending.entityIndex) &&
              (!pending.collection ||
                field.dataset.entityType === pending.collection),
          );
        }
        if (pending.fieldName) {
          const row =
            target?.closest<HTMLElement>("[data-entity-index]") ??
            (target?.matches("[data-entity-index]") ? target : undefined);
          const field = row?.querySelector<HTMLElement>(
            `[data-field-name="${pending.fieldName}"]`,
          );
          if (field) target = field;
        }
        if (!target && pending.inventoryIndex !== undefined) {
          target = Array.from(
            panel.querySelectorAll<HTMLElement>("[data-inventory-index]"),
          ).find(
            (field) =>
              field.dataset.inventoryIndex === String(pending.inventoryIndex),
          );
        }
        if (!target) {
          target =
            panel.querySelector<HTMLElement>("[data-field-key]") ?? undefined;
        }
        for (
          let detail = target?.closest("details");
          detail;
          detail = detail.parentElement?.closest("details") ?? null
        ) {
          detail.open = true;
        }
        const control = target?.matches(
          "input, textarea, select, button, [tabindex]",
        )
          ? target
          : (target?.querySelector<HTMLElement>("input, textarea, select") ??
            target?.querySelector<HTMLElement>("button"));
        control?.focus();
        pendingIssueFocusRef.current = null;
      };
      focus();
    }, [activeSection, draft, issueFocusVersion]);

    useEffect(() => {
      const pending = reorderFocusRef.current;
      if (!pending) return;
      const focus = () => {
        const section =
          pending.collection === "relationshipParties"
            ? "relationships"
            : pending.collection;
        const panel = sectionPanelRefs.current[section];
        const row = Array.from(
          panel?.querySelectorAll<HTMLElement>("[data-entity-id]") ?? [],
        ).find(
          (field) =>
            field.dataset.entityId === pending.id &&
            field.dataset.entityType === pending.collection,
        );
        (
          row?.querySelector<HTMLElement>(".editor-entity-summary") ?? row
        )?.focus();
        reorderFocusRef.current = null;
      };
      focus();
    }, [draft]);

    useEffect(() => {
      const index = inventoryReorderFocusRef.current;
      if (index === null) return;
      const focus = () => {
        sectionPanelRefs.current.inventory
          ?.querySelector<HTMLElement>(
            `[data-inventory-index="${index}"] [data-field-key]`,
          )
          ?.focus();
        inventoryReorderFocusRef.current = null;
      };
      focus();
    }, [draft]);

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
      setErrors([]);
    };

    const patchFn = (
      updater: (d: GameDefinition) => Partial<GameDefinition>,
    ) => {
      setDraft((d) => (d ? { ...d, ...updater(d) } : d));
      setErrors([]);
    };

    const handleWorldMapText = (text: string) => {
      setRaws((prev) => ({ ...prev, worldMap: text }));
      if (!text.trim()) {
        setWorldMapError(null);
        setDraft((d) => {
          if (!d) return d;
          const next = { ...d };
          delete next.worldMap;
          delete next.startingLocationId;
          return next;
        });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        const worldMap = parseWorldMap(
          parsed,
          current.npcs.map((npc) => npc.id),
        );
        setWorldMapError(null);
        setDraft((d) => (d ? { ...d, worldMap } : d));
      } catch (error) {
        setWorldMapError(describeError(error, "World map JSON tidak valid."));
      }
    };

    const handleLorebookFile = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      stagedLoreFile.current = null;
      setLoreImportStage(null);
      setLoreImportError(null);
      if (file.size > MAX_LOREBOOK_BYTES) {
        setLoreImportError("File lorebook melebihi batas 8 MiB.");
        return;
      }
      setLoreWorking(true);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const pack = parseLorebookPack(parsed);
        const result = await importLorebook(pack, true);
        stagedLoreFile.current = file;
        setLoreImportStage({
          status: "dry-run",
          fileName: file.name,
          result,
        });
      } catch (error) {
        setLoreImportError(
          error instanceof LorebookValidationError
            ? error.problems.join(" ")
            : describeError(error, "Lorebook gagal divalidasi."),
        );
      } finally {
        setLoreWorking(false);
      }
    };

    const handlePublishLorebook = async () => {
      const file = stagedLoreFile.current;
      if (!file || loreImportStage?.status !== "dry-run") return;
      setLoreWorking(true);
      setLoreImportError(null);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const result = await importLorebook(parseLorebookPack(parsed), false);
        setLoreImportStage({
          status: "published",
          fileName: file.name,
          result,
        });
        stagedLoreFile.current = null;
        setLoreRef({ packId: result.pack.id, version: result.pack.version });
        setLoreEntriesOffset(0);
        setLorebookOffset(0);
        setLoreReload((value) => value + 1);
      } catch (error) {
        setLoreImportError(
          error instanceof LorebookValidationError
            ? error.problems.join(" ")
            : describeError(error, "Lorebook gagal diterbitkan."),
        );
      } finally {
        setLoreWorking(false);
      }
    };

    const handlePreviewLore = async () => {
      setLorePreviewError(null);
      if (worldMapError) {
        setLorePreviewError(
          `Perbaiki world map sebelum preview: ${worldMapError}`,
        );
        return;
      }
      setLoreWorking(true);
      const locationId = (
        lorePreviewLocationId ?? current.startingLocationId
      )?.trim();
      try {
        setLorePreview(
          await previewLore(current, {
            ...(locationId ? { locationId } : {}),
            ...(lorePreviewQuery.trim()
              ? { query: lorePreviewQuery.trim() }
              : {}),
          }),
        );
      } catch (error) {
        setLorePreview(null);
        setLorePreviewError(describeError(error, "Preview lore gagal."));
      } finally {
        setLoreWorking(false);
      }
    };

    const downloadEvolvingAsset = (
      content: string,
      filename: string,
      mimeType: string,
    ) => {
      setLoreError(null);
      try {
        downloadText(content, filename, mimeType);
      } catch (error) {
        setLoreError(describeError(error, "Unduhan contoh gagal."));
      }
    };

    const handleExportLorebook = async () => {
      if (!loreRef) return;
      setLoreError(null);
      try {
        const pack = await exportLorebook(loreRef);
        downloadText(
          JSON.stringify(pack, null, 2),
          `lorebook-${loreRef.packId}-v${loreRef.version}.json`,
          "application/json",
        );
      } catch (error) {
        setLoreError(describeError(error, "Ekspor lorebook gagal."));
      }
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
    const updateFactRecipients = (
      itemIndex: number,
      effectIndex: number,
      field: "knownBy" | "revealableTo",
      actorId: string,
      checked: boolean,
    ) => {
      const item = current.items[itemIndex];
      const effect = item?.effects[effectIndex];
      if (!item || !effect || effect.type !== "ADD_FACT") return;
      const recipients = new Set(effect[field] ?? []);
      if (checked) recipients.add(actorId);
      else recipients.delete(actorId);
      const next = { ...effect };
      if (recipients.size > 0) next[field] = [...recipients];
      else delete next[field];
      patchItem(itemIndex, {
        effects: replaceIn(item.effects, effectIndex, next),
      });
    };
    const moveEntity = (
      collection: EditableCollection,
      id: string,
      direction: "up" | "down",
    ) => {
      reorderFocusRef.current = { collection, id };
      patchFn((definition) => {
        switch (collection) {
          case "attributes":
            return {
              attributes: moveById(definition.attributes, id, direction),
            };
          case "resources":
            return { resources: moveById(definition.resources, id, direction) };
          case "relationships":
            return {
              relationships: moveById(definition.relationships, id, direction),
            };
          case "relationshipParties":
            return {
              relationshipParties: moveById(
                definition.relationshipParties ?? [],
                id,
                direction,
              ),
            };
          case "items":
            return { items: moveById(definition.items, id, direction) };
          case "npcs":
            return { npcs: moveById(definition.npcs, id, direction) };
        }
      });
    };

    const duplicateEntity = (
      collection: "attributes" | "resources" | "items" | "npcs",
      index: number,
    ) => {
      const id = createUuid();
      reorderFocusRef.current = { collection, id };
      patchFn((definition) => {
        switch (collection) {
          case "attributes":
            return {
              attributes: duplicateAfter(definition.attributes, index, id),
            };
          case "resources":
            return {
              resources: duplicateAfter(definition.resources, index, id),
            };
          case "items":
            return { items: duplicateAfter(definition.items, index, id) };
          case "npcs":
            return { npcs: duplicateAfter(definition.npcs, index, id) };
        }
      });
    };

    const renderEntityControls = (
      collection: EditableCollection,
      id: string,
      index: number,
      count: number,
      duplicate?: () => void,
    ) => (
      <div className="editor-entity-actions" aria-label="Aksi entri">
        <button
          type="button"
          aria-label={`Pindahkan ${id} ke atas`}
          data-reorder-direction="up"
          disabled={working || index === 0}
          onClick={() => moveEntity(collection, id, "up")}
        >
          Naik
        </button>
        <button
          type="button"
          aria-label={`Pindahkan ${id} ke bawah`}
          data-reorder-direction="down"
          disabled={working || index === count - 1}
          onClick={() => moveEntity(collection, id, "down")}
        >
          Turun
        </button>
        {duplicate && (
          <button type="button" disabled={working} onClick={duplicate}>
            Duplikat
          </button>
        )}
      </div>
    );
    const moveInventoryEntry = (index: number, direction: "up" | "down") => {
      const target = index + (direction === "up" ? -1 : 1);
      if (target < 0 || target >= current.startingInventory.length) return;
      inventoryReorderFocusRef.current = target;
      patchFn((definition) => {
        const entries = [...definition.startingInventory];
        [entries[index], entries[target]] = [entries[target], entries[index]];
        return { startingInventory: entries };
      });
    };

    const toggleEntityExpansion = () => {
      const panel = sectionPanelRefs.current[activeSection];
      const rows = Array.from(
        panel?.querySelectorAll<HTMLDetailsElement>(
          "details[data-editor-entity]",
        ) ?? [],
      );
      const expand = rows.some((row) => !row.open);
      rows.forEach((row) => {
        row.open = expand;
      });
      setEntitiesExpanded(expand);
    };

    const syncEntityExpansion = (panel: HTMLElement | null) => {
      const rows = Array.from(
        panel?.querySelectorAll<HTMLDetailsElement>(
          "details[data-editor-entity]",
        ) ?? [],
      );
      setEntitiesExpanded(rows.length > 0 && rows.every((row) => row.open));
    };

    // Input numerik: teks mentah di state; kosong = hapus (opsional) atau
    // pertahankan angka lama (wajib); tak ter-parse = pertahankan angka lama.
    const bindNumber = (
      key: string,
      value: number | undefined,
      apply: (parsed: number | undefined) => void,
      optional = false,
    ) => {
      const fieldName = key.slice(key.lastIndexOf(":") + 1);
      return {
        value: raws[key] ?? (value === undefined ? "" : String(value)),
        "data-field-key": key,
        "data-field-name":
          fieldName === "default"
            ? "defaultValue"
            : fieldName === "initial"
              ? "initialValue"
              : fieldName,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          const text = event.target.value;
          setRaws((prev) => ({ ...prev, [key]: text }));
          if (text.trim() === "") {
            if (optional) {
              setRawIssues((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
              apply(undefined);
            } else {
              setRawIssues((prev) => ({
                ...prev,
                [key]: "Masukkan angka yang valid.",
              }));
            }
            return;
          }
          const parsed = Number(text);
          if (Number.isFinite(parsed)) {
            setRawIssues((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
            apply(parsed);
          } else {
            setRawIssues((prev) => ({
              ...prev,
              [key]: "Masukkan angka yang valid.",
            }));
          }
        },
      };
    };

    const bindLines = (
      key: string,
      value: string[],
      apply: (lines: string[]) => void,
    ) => ({
      value: raws[key] ?? value.join("\n"),
      "data-field-key": key,
      "data-field-name": key.split(":").at(-1),
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
      relationshipParties: new Set(
        (original.relationshipParties ?? []).map((entry) => entry.id),
      ),
      items: new Set(original.items.map((entry) => entry.id)),
      npcs: new Set(original.npcs.map((entry) => entry.id)),
    };

    const handleSave = async (): Promise<boolean> => {
      if (working) return false;
      setWorking(true);
      setSaveNote(null);
      try {
        const next = { ...current, updatedAt: new Date().toISOString() };
        let sessions: SessionSummaryRecord[] = [];
        if (revision !== null) {
          setSessionsLoading(true);
          try {
            sessions = await listSessions(gameId);
            setSessionsCount(sessions.length);
            setSessionsError(null);
          } catch (error) {
            const message = describeError(
              error,
              "Daftar sesi tidak dapat dimuat.",
            );
            setSessionsCount(null);
            setSessionsError(message);
            setErrors([]);
            setSaveNote(
              `Daftar sesi tidak dapat dimuat, jadi perubahan lama belum diperiksa dan dunia belum disimpan. ${message}`,
            );
            return false;
          } finally {
            setSessionsLoading(false);
          }
        }
        const allErrors = [
          ...Object.entries(rawIssues).map(
            ([key, message]) => `input:${key}: ${message}`,
          ),
          ...(worldMapError ? [`World map: ${worldMapError}`] : []),
          ...validateDefinition(next),
        ];
        if (sessions.length > 0) {
          allErrors.push(...validateDefinitionUpdate(original, next));
        }
        if (allErrors.length > 0) {
          setErrors(allErrors);
          setReadinessOpen(true);
          return false;
        }
        const saved =
          revision === null
            ? await createGame(next)
            : await updateGame(gameId, revision, next);
        setDraft(structuredClone(saved.value));
        setOriginal(structuredClone(saved.value));
        setRevision(saved.revision);
        setSessionsCount(sessions.length);
        setRawIssues({});
        setErrors([]);
        setSaveNote("Definisi tersimpan.");
        await onDraftPersisted();
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
            setSaveNote(describeError(error, "Gagal menyimpan definisi."));
          }
          return false;
        }
        setSaveNote(describeError(error, "Gagal menyimpan definisi."));
        return false;
      } finally {
        setWorking(false);
      }
    };

    saveShortcutRef.current = handleSave;

    const handleStart = async () => {
      if (working) return;
      setWorking(true);
      setSaveNote(null);
      try {
        if (revision === null) {
          setErrors(["Simpan dunia ini sebelum memulai sesi."]);
          setReadinessOpen(true);
          return;
        }
        if (dirtyRef.current) {
          setSaveNote("Simpan perubahan sebelum memulai sesi baru.");
          return;
        }
        const definitionErrors = [
          ...validateDefinition(original),
          ...validatePlayability(original),
        ];
        if (definitionErrors.length > 0) {
          setErrors(definitionErrors);
          setReadinessOpen(true);
          return;
        }
        setErrors([]);
        const result = await startSavedSession(
          gameId,
          revision,
          defaultProfileId === undefined
            ? { ai: defaultAi }
            : { profileId: defaultProfileId },
        );
        onStarted(result.value.id);
      } catch (error) {
        if (
          defaultProfileId !== undefined &&
          error instanceof ApiError &&
          error.status === 404
        ) {
          setErrors([
            "Profil AI default tidak ditemukan. Buka Pengaturan untuk memilih profil default baru.",
          ]);
          return;
        }
        if (error instanceof ApiError && error.status === 409) {
          try {
            const latest = await getGame(gameId);
            setOriginal(structuredClone(latest.value));
            setRevision(latest.revision);
            setSessionsRetry((value) => value + 1);
            setSaveNote(
              "Versi tersimpan berubah di server. Versi terbaru dimuat; tinjau draft sebelum mencoba lagi.",
            );
          } catch {
            setSaveNote(describeError(error, "Gagal memulai sesi."));
          }
        }
        setErrors([describeError(error, "Gagal memulai sesi.")]);
      } finally {
        setWorking(false);
      }
    };

    const isDirty =
      revision === null ||
      JSON.stringify(current) !== JSON.stringify(original) ||
      Object.keys(rawIssues).length > 0 ||
      worldMapError !== null;
    dirtyRef.current = isDirty;
    const saveState = revision === null ? "new" : isDirty ? "dirty" : "saved";
    const savedDefinitionErrors =
      revision === null
        ? []
        : [...validateDefinition(original), ...validatePlayability(original)];
    const savedPlayable =
      revision !== null && savedDefinitionErrors.length === 0;
    const currentValidationIssues = [
      ...Object.entries(rawIssues).map(
        ([key, message]) => `input:${key}: ${message}`,
      ),
      ...(worldMapError ? [`World map: ${worldMapError}`] : []),
      ...validateDefinition(current),
      ...validatePlayability(current),
      ...(sessionsCount !== null && sessionsCount > 0
        ? validateDefinitionUpdate(original, current)
        : []),
    ];
    const readinessIssues = Array.from(
      new Set([...currentValidationIssues, ...errors]),
    );

    const sectionForIssue = (message: string): EditorSectionId => {
      const text = message.toLocaleLowerCase();
      if (text.startsWith("input:")) {
        const kind = message.slice("input:".length).split(":")[0];
        if (kind === "player") return "player";
        if (kind === "attr") return "attributes";
        if (kind === "res") return "resources";
        if (kind === "rel" || kind === "party") return "relationships";
        if (kind === "item") return "items";
        if (kind === "npc") return "npcs";
        if (kind === "inv") return "inventory";
      }
      if (
        text.includes("world map") ||
        text.includes("worldmap") ||
        text.includes("startinglocationid")
      )
        return "worldmap";
      if (text.includes("scenario.")) return "scenario";
      if (text.includes("relationshipparties")) return "relationships";
      if (text.includes("player") || text.includes("pemain")) return "player";
      if (text.includes("attributes") || text.includes("atribut"))
        return "attributes";
      if (text.includes("resources") || text.includes("sumber daya"))
        return "resources";
      if (text.includes("relationships") || text.includes("relasi"))
        return "relationships";
      if (text.includes("items") || text.includes("item")) return "items";
      if (text.includes("startinginventory") || text.includes("inventaris"))
        return "inventory";
      if (text.includes("npcs") || text.includes("npc")) return "npcs";
      if (text.includes("lorebookrefs")) return "lorebook";
      if (text.includes("profil ai") || text.includes("profil default"))
        return "preview";
      if (
        text.includes("title") ||
        text.includes("description") ||
        text.includes("genre") ||
        text.includes("tone") ||
        text.includes("language") ||
        text.includes("agerating") ||
        text.includes("game harus")
      )
        return "summary";
      return "summary";
    };

    const issueFocus = (
      message: string,
    ): NonNullable<typeof pendingIssueFocusRef.current> => {
      const section = sectionForIssue(message);
      const rawKey = message.match(/^input:(.+): /i)?.[1];
      if (rawKey) {
        const [kind, entityId] = rawKey.split(":");
        const rawSection: EditorSectionId =
          kind === "player"
            ? "player"
            : kind === "attr"
              ? "attributes"
              : kind === "res"
                ? "resources"
                : kind === "rel" || kind === "party"
                  ? "relationships"
                  : kind === "item"
                    ? "items"
                    : kind === "npc"
                      ? "npcs"
                      : kind === "inv"
                        ? "inventory"
                        : section;
        const collection =
          kind === "attr"
            ? "attributes"
            : kind === "res"
              ? "resources"
              : kind === "rel"
                ? "relationships"
                : kind === "item"
                  ? "items"
                  : kind === "npc"
                    ? "npcs"
                    : undefined;
        return {
          section: rawSection,
          fieldKey: rawKey,
          ...(collection ? { collection, entityId } : {}),
        };
      }

      if (/^startinglocationid/i.test(message)) {
        return { section: "worldmap", fieldKey: "startingLocationId" };
      }
      if (/^world ?map/i.test(message)) {
        return { section: "worldmap", fieldKey: "worldMap" };
      }

      const inventoryIndex = message.match(/startingInventory\[(\d+)\]/i)?.[1];
      const entityIndex = message.match(
        /(?:attributes|resources|relationships|relationshipParties|items|npcs)\[(\d+)\]/i,
      )?.[1];
      const fieldName =
        message.match(
          /(?:attributes|resources|relationships|relationshipParties|items|npcs)\[\d+\]\.(?:effects\[\d+\]\.)?([A-Za-z]+)/i,
        )?.[1] ??
        message.match(
          /(?:attributes|resources|relationships|relationshipParties|items|npcs|Atribut|Sumber daya|Relasi|Item|NPC)\s+"[^"]+"\s*:\s*([A-Za-z]+)/i,
        )?.[1];
      const effectIndex = message.match(/effects\[(\d+)\]/i)?.[1];
      const quotedIds = message
        .split('"')
        .filter((_, index) => index % 2 === 1);
      let entityId = quotedIds[0];
      if (!entityId && section === "items" && entityIndex !== undefined) {
        entityId = current.items[Number(entityIndex)]?.id;
      }
      const collection =
        section === "attributes"
          ? "attributes"
          : section === "resources"
            ? "resources"
            : section === "relationships"
              ? message.toLocaleLowerCase().includes("relationshipparties")
                ? "relationshipParties"
                : "relationships"
              : section === "items"
                ? "items"
                : section === "npcs"
                  ? "npcs"
                  : undefined;
      let fieldKey =
        message.match(/scenario\.([A-Za-z]+)/i)?.[0] ??
        [
          "title",
          "description",
          "genre",
          "tone",
          "language",
          "ageRating",
          "player.name",
          "player.role",
          "player.pronoun",
          "player.age",
          "player.goal",
          "player.fear",
          "startingLocationId",
          "worldMap",
        ].find((field) =>
          message.toLocaleLowerCase().includes(field.toLowerCase()),
        );
      if (!fieldKey && /world.?map/i.test(message)) fieldKey = "worldMap";
      if (!fieldKey && /lorebookrefs/i.test(message)) fieldKey = "lorebookRefs";
      if (!fieldKey && /profil ai|profil default/i.test(message))
        fieldKey = "profileRetry";
      if (!fieldKey && /player object/i.test(message)) fieldKey = "player.name";
      if (!fieldKey && /scenario object/i.test(message))
        fieldKey = "scenario.setting";
      if (section === "player" && quotedIds[0]) {
        const mapName = message.match(/player\.(attributes|resources)/i)?.[1];
        if (mapName) {
          fieldKey = `player:${mapName === "attributes" ? "attr" : "res"}:${quotedIds[0]}`;
        }
      }
      if (section === "npcs" && quotedIds[0]) {
        if (quotedIds[1] && /relationship/i.test(message)) {
          fieldKey = `npc:${quotedIds[0]}:rel:${quotedIds[1]}`;
        } else if (quotedIds[1] && /attribute/i.test(message)) {
          fieldKey = `npc:${quotedIds[0]}:attr:${quotedIds[1]}`;
        } else if (/voice/i.test(message)) {
          fieldKey = `npc:${quotedIds[0]}:voice`;
        }
      }
      if (inventoryIndex !== undefined) {
        const index = Number(inventoryIndex);
        const field =
          message.match(/startingInventory\[\d+\]\.(owner|place)/i)?.[1] ??
          (message.toLocaleLowerCase().includes("quantity")
            ? `${current.startingInventory[index]?.itemId ?? ""}:quantity`
            : "itemId");
        fieldKey = field.includes(":")
          ? `inv:${field}`
          : `inv:${index}:${field}`;
      }
      if (section === "relationships" && collection === "relationshipParties") {
        const field = message.match(
          /relationshipParties\[\d+\]\.(id|name|type|initialStance|secret)/i,
        )?.[1];
        if (field && entityId) fieldKey = `party:${entityId}:${field}`;
      }
      if (section === "items" && effectIndex !== undefined && entityId) {
        const effectField = (
          [
            ["type", /type effect/i],
            ["operation", /\boperation\b/i],
            ["value", /\bvalue\b/i],
            ["quantity", /\bquantity\b/i],
            ["text", /teks fakta|\btext\b/i],
            ["visibility", /\bvisibility\b/i],
            ["knownBy", /\bknownBy\b/i],
            ["revealableTo", /\brevealableTo\b/i],
            ["target", /\btarget\b|\bflag\b/i],
            ["npcId", /\bnpcId\b|\bNPC_PRESENCE\b|\bpenerima\b/i],
            ["loreId", /\bloreId\b|\bDISCOVER_LORE\b/i],
            ["factId", /\bfactId\b/i],
            ["present", /\bpresent\b/i],
          ] as const
        ).find(([, pattern]) => pattern.test(message))?.[0];
        fieldKey = effectField
          ? `item:${entityId}:fx:${effectIndex}:${effectField}`
          : undefined;
      }
      return {
        section,
        ...(fieldKey ? { fieldKey } : {}),
        ...(collection && entityId ? { collection, entityId } : {}),
        ...(entityIndex === undefined
          ? {}
          : { entityIndex: Number(entityIndex) }),
        ...(effectIndex === undefined
          ? {}
          : { effectIndex: Number(effectIndex) }),
        ...(inventoryIndex === undefined
          ? {}
          : { inventoryIndex: Number(inventoryIndex) }),
        ...(fieldName ? { fieldName } : {}),
      };
    };

    const focusIssue = (message: string) => {
      const target = issueFocus(message);
      sectionDialogRef.current?.close("issue");
      previewDialogRef.current?.close("issue");
      pendingIssueFocusRef.current = target;
      setFieldSearch("");
      setActiveSection(target.section);
      setIssueFocusVersion((value) => value + 1);
    };

    const selectSection = (section: EditorSectionId, keepSheetOpen = false) => {
      setActiveSection(section);
      setFieldSearch("");
      if (
        section === "preview" &&
        window.matchMedia("(max-width: 899px)").matches
      ) {
        previewReturnSection.current = activeSection;
        requestAnimationFrame(() => {
          const dialog = previewDialogRef.current;
          if (dialog && !dialog.open) {
            dialog.returnValue = "";
            dialog.showModal();
          }
        });
      } else {
        previewDialogRef.current?.close("selection");
      }
      if (!keepSheetOpen && sectionDialogRef.current?.open) {
        sectionDialogRef.current.close(
          section === "preview" ? "preview" : "selection",
        );
      }
    };

    const onSectionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      )
        return;
      event.preventDefault();
      const list = event.currentTarget.closest('[role="tablist"]');
      const tabs = Array.from(
        list?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
      );
      if (tabs.length === 0) return;
      const index = tabs.indexOf(event.currentTarget);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : tabs.length - 1)) %
              tabs.length;
      const nextTab = tabs[nextIndex];
      const section = EDITOR_SECTIONS.find(
        (candidate) => candidate.id === nextTab.dataset.editorSection,
      );
      if (!section) return;
      const inSheet =
        event.currentTarget.closest("dialog") === sectionDialogRef.current;
      if (inSheet && section.id !== "preview") {
        selectSection(section.id, true);
        requestAnimationFrame(() => nextTab.focus());
        return;
      }
      selectSection(section.id);
      requestAnimationFrame(() => nextTab.focus());
    };
    const reloadSavedTemplates = async () => {
      setTemplatesLoading(true);
      setTemplatesError(null);
      try {
        setSavedTemplates(await listSavedTemplates());
      } catch (error) {
        setTemplatesError(
          describeError(error, "Template tersimpan tidak dapat dimuat."),
        );
      } finally {
        setTemplatesLoading(false);
      }
    };

    const applySavedTemplate = async (id: string) => {
      if (templateLoadingId) return;
      setTemplateLoadingId(id);
      setImportError(null);
      try {
        setTemplateReview(parseTemplate(await getSavedTemplate(id)));
      } catch (error) {
        setImportError(
          error instanceof ImportError
            ? error.problems.join(" ")
            : describeError(error, "Template tersimpan gagal dimuat."),
        );
      } finally {
        setTemplateLoadingId(null);
      }
    };

    const savedStartSource =
      defaultProfileId === undefined
        ? `${defaultAi.provider} · ${defaultAi.model}`
        : (profileName ?? "Nama profil AI tidak tersedia");
    const factActors = [
      { id: PLAYER_ID, name: "Pemain" },
      ...current.npcs.map((npc) => ({
        id: npc.id,
        name: npc.name || npc.id,
      })),
    ];
    const renderFactRecipients = (
      itemIndex: number,
      itemId: string,
      effectIndex: number,
      effect: Extract<ItemEffect, { type: "ADD_FACT" }>,
      field: "knownBy" | "revealableTo",
    ) => (
      <fieldset className="editor-recipient-fields">
        <legend>
          {field === "knownBy"
            ? "Sudah diketahui oleh"
            : "Dapat diungkap kepada"}
        </legend>
        {[
          ...factActors,
          ...(effect[field] ?? [])
            .filter((id) => !factActors.some((actor) => actor.id === id))
            .map((id) => ({ id, name: `ID tidak dikenal: ${id}` })),
        ].map((actor) => (
          <label className="editor-checkbox" key={actor.id}>
            <input
              type="checkbox"
              data-field-key={`item:${itemId}:fx:${effectIndex}:${field}`}
              checked={effect[field]?.includes(actor.id) ?? false}
              onChange={(event) =>
                updateFactRecipients(
                  itemIndex,
                  effectIndex,
                  field,
                  actor.id,
                  event.target.checked,
                )
              }
            />
            {actor.name}
          </label>
        ))}
      </fieldset>
    );
    const handleBack = () => requestExit(onBack);

    const handleOpenSettings = () => requestExit(onOpenSettings);

    const handleExportTemplate = () => {
      try {
        const bundle = exportTemplate(current);
        const slug =
          current.title.trim().replace(/\s+/g, "-").toLowerCase() || "template";
        downloadText(
          JSON.stringify(bundle, null, 2),
          `fworld-template-${slug}.json`,
          "application/json",
        );
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

    const handleImportTemplate = async (
      event: ChangeEvent<HTMLInputElement>,
    ) => {
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
      setDraft((draftNow) =>
        draftNow
          ? applyTemplateDraft(draftNow, templateReview.draft)
          : draftNow,
      );
      setRaws({});
      setWorldMapError(null);
      setRawIssues({});
      setTemplateReview(null);
      setSaveNote("Template diterapkan ke draft; belum disimpan.");
    };

    const countForSection = (section: EditorSectionId): number | null => {
      switch (section) {
        case "attributes":
          return current.attributes.length;
        case "resources":
          return current.resources.length;
        case "relationships":
          return (
            current.relationships.length +
            (current.relationshipParties?.length ?? 0)
          );
        case "items":
          return current.items.length;
        case "inventory":
          return current.startingInventory.length;
        case "npcs":
          return current.npcs.length;
        case "lorebook":
          return current.lorebookRefs?.length ?? 0;
        case "worldmap":
          return current.worldMap?.locations.length ?? 0;
        default:
          return null;
      }
    };

    const renderPreview = (idPrefix: string) => (
      <div className="editor-preview-content">
        <article className="editor-world-card">
          <img
            src={storyIllustration(current)}
            width={900}
            height={600}
            alt=""
          />
          <div>
            <h3>{current.title.trim() || "Dunia tanpa judul"}</h3>
            <p>{current.genre?.trim() || "Genre belum diatur"}</p>
            <p>{current.tone?.trim() || "Nuansa belum diatur"}</p>
            {current.description?.trim() && <p>{current.description}</p>}
          </div>
        </article>
        <section aria-labelledby={`editor-preview-readiness-${idPrefix}`}>
          <h3 id={`editor-preview-readiness-${idPrefix}`}>Kesiapan</h3>
          {readinessIssues.length === 0 ? (
            <p role="status">
              Semua pemeriksaan definisi dan sesi awal terpenuhi.
            </p>
          ) : (
            <ul className="editor-preview-issues">
              {readinessIssues.map((message, index) => (
                <li key={`${message}-${index}`}>
                  <button
                    type="button"
                    className="editor-issue-link"
                    onClick={() => focusIssue(message)}
                  >
                    {message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <dl className="editor-preview-counts">
          <div>
            <dt>NPC</dt>
            <dd>{current.npcs.length}</dd>
          </div>
          <div>
            <dt>Item</dt>
            <dd>{current.items.length}</dd>
          </div>
          <div>
            <dt>Atribut</dt>
            <dd>{current.attributes.length}</dd>
          </div>
          <div>
            <dt>Sumber daya</dt>
            <dd>{current.resources.length}</dd>
          </div>
          <div>
            <dt>Relasi</dt>
            <dd>
              {current.relationships.length +
                (current.relationshipParties?.length ?? 0)}
            </dd>
          </div>
          <div>
            <dt>Inventaris</dt>
            <dd>{current.startingInventory.length}</dd>
          </div>
        </dl>
        <p className="editor-preview-profile">
          Profil AI aktif: <strong>{savedStartSource}</strong>
        </p>
        {profileError && (
          <div>
            <p className="error" role="alert">
              {profileError}
            </p>
            {defaultProfileId !== undefined && (
              <button
                type="button"
                data-field-key="profileRetry"
                onClick={() => setProfileRetry((value) => value + 1)}
              >
                Muat ulang profil AI
              </button>
            )}
          </div>
        )}
      </div>
    );

    const renderSectionTab = (
      section: (typeof EDITOR_SECTIONS)[number],
      prefix: string,
    ) => {
      const issueCount = readinessIssues.filter(
        (message) => sectionForIssue(message) === section.id,
      ).length;
      const count = countForSection(section.id);
      return (
        <button
          key={section.id}
          type="button"
          role="tab"
          id={`editor-tab-${prefix}-${section.id}`}
          aria-selected={activeSection === section.id}
          aria-controls={`editor-panel-${section.id}`}
          aria-label={`${section.label}${issueCount ? `, ${issueCount} perlu diperiksa` : ""}`}
          tabIndex={activeSection === section.id ? 0 : -1}
          data-editor-section={section.id}
          data-status={issueCount > 0 ? "attention" : "ready"}
          className="editor-section-tab"
          onClick={() => selectSection(section.id)}
          onKeyDown={onSectionKeyDown}
        >
          <span className="editor-section-tab-label">{section.label}</span>
          {count !== null && (
            <span className="editor-section-count">{count}</span>
          )}
          <span className="editor-section-dot" aria-hidden="true" />
        </button>
      );
    };

    const renderSectionTabs = (prefix: string) => (
      <>
        {EDITOR_SECTION_GROUPS.map((group) => (
          <div
            key={group.id}
            className="editor-section-group"
            role="presentation"
          >
            <p className="editor-section-group-label" role="presentation">
              {group.label}
            </p>
            {EDITOR_SECTIONS.filter(
              (section) => section.group === group.id,
            ).map((section) => renderSectionTab(section, prefix))}
          </div>
        ))}
      </>
    );

    return (
      <div className="editor-workshop">
        <aside className="editor-rail" aria-label="Navigasi editor dunia">
          <button
            type="button"
            ref={backButtonRef}
            className="editor-back"
            onClick={handleBack}
            disabled={working}
          >
            Kembali
          </button>
          <div className="editor-rail-title">
            <h2>{revision === null ? "Dunia baru" : "Lokakarya dunia"}</h2>
            <p className="hint">
              {revision === null
                ? "Draft disimpan hanya saat kamu memilih Simpan."
                : "Perubahan tersimpan berlaku untuk sesi baru."}
            </p>
          </div>
          <nav aria-label="Bagian editor">
            <div
              role="tablist"
              aria-label="Bagian dunia"
              aria-orientation="vertical"
              className="editor-section-tabs"
            >
              {renderSectionTabs("rail")}
            </div>
          </nav>
          <button
            type="button"
            className="editor-preview-toggle"
            aria-pressed={previewAsideOpen}
            aria-controls="editor-preview-aside"
            onClick={() => setPreviewAsideOpen((open) => !open)}
          >
            {previewAsideOpen ? "Sembunyikan pratinjau" : "Tampilkan pratinjau"}
          </button>
        </aside>

        <section className="editor-form-column">
          <header className="editor-intro">
            <h2>{current.title.trim() || "Dunia tanpa judul"}</h2>
            <p className="editor-save-state" data-state={saveState}>
              {saveState === "new"
                ? "Belum disimpan"
                : saveState === "dirty"
                  ? "Perubahan belum disimpan"
                  : "Tersimpan"}
            </p>
            {revision === null && (
              <p className="hint editor-start-hint">
                Mulai dari Ringkasan, Skenario, dan Pemain. Bagian lain dapat
                disesuaikan nanti.
              </p>
            )}
          </header>
          <button
            type="button"
            ref={sectionButtonRef}
            className="editor-mobile-section-trigger"
            aria-haspopup="dialog"
            aria-expanded={sectionSheetOpen}
            onClick={() => {
              setSectionSheetOpen(true);
              const dialog = sectionDialogRef.current;
              if (dialog && !dialog.open) {
                dialog.returnValue = "";
                dialog.showModal();
              }
            }}
          >
            Bagian:{" "}
            {
              EDITOR_SECTIONS.find((section) => section.id === activeSection)
                ?.label
            }
          </button>
          <details className="editor-utilities">
            <summary>Alat dunia</summary>
            <div className="row editor-toolbar" aria-label="Aksi editor">
              <button
                type="button"
                onClick={handleExportTemplate}
                disabled={working}
              >
                Ekspor template JSON
              </button>
              <label className="button">
                Impor template JSON
                <input
                  type="file"
                  accept="application/json"
                  className="visually-hidden"
                  onChange={(event) => void handleImportTemplate(event)}
                />
              </label>
              <button
                type="button"
                onClick={handleLoadExample}
                disabled={working}
              >
                Muat contoh
              </button>
              <button
                type="button"
                onClick={handleOpenSettings}
                disabled={working}
              >
                Pengaturan
              </button>
            </div>
          </details>
          {importError && (
            <p className="error" role="alert">
              {importError}
            </p>
          )}
          {saveNote && <p role="status">{saveNote}</p>}
          <details className="editor-search">
            <summary>Cari bidang</summary>
            <label className="editor-field-search">
              Cari bidang di{" "}
              {
                EDITOR_SECTIONS.find((section) => section.id === activeSection)
                  ?.label
              }
              <input
                type="search"
                value={fieldSearch}
                onChange={(event) => setFieldSearch(event.target.value)}
                placeholder="Nama bidang…"
                aria-controls={`editor-panel-${activeSection}`}
              />
            </label>
          </details>
          <section aria-live="polite">
            <p className="hint">
              {revision === null
                ? "Sesi baru memakai versi tersimpan setelah dunia disimpan."
                : sessionsLoading
                  ? "Memeriksa jumlah sesi tersimpan…"
                  : sessionsError
                    ? "Jumlah sesi belum diketahui."
                    : sessionsCount === null
                      ? "Status sesi belum diketahui."
                      : sessionsCount === 0
                        ? "Belum ada sesi tersimpan."
                        : `${sessionsCount} sesi tersimpan.`}
            </p>
            {revision !== null && sessionsError && (
              <div>
                <p role="alert">
                  Daftar sesi belum dapat dimuat. Jumlah sesi belum diketahui,
                  jadi ini bukan berarti belum ada sesi. {sessionsError}
                </p>
                <button
                  type="button"
                  onClick={() => setSessionsRetry((value) => value + 1)}
                  disabled={sessionsLoading}
                >
                  Coba periksa lagi
                </button>
              </div>
            )}
            <details className="editor-session-context">
              <summary>Tentang sesi dunia ini</summary>
              <p>
                Perubahan pada dunia tersimpan hanya berlaku untuk sesi yang
                dimulai setelah disimpan. Sesi yang sudah ada tetap menggunakan
                snapshot awalnya.
              </p>
              {revision === null ? (
                <p>
                  Simpan draft lebih dulu untuk memeriksa sesi yang memakai
                  versi tersimpan.
                </p>
              ) : sessionsLoading ? (
                <p role="status">Memeriksa daftar sesi tersimpan…</p>
              ) : sessionsError ? (
                <p>Jumlah sesi belum diketahui.</p>
              ) : sessionsCount !== null && sessionsCount > 0 ? (
                <p>
                  <strong>Perubahan ini hanya berlaku untuk sesi baru.</strong>{" "}
                  Sesi yang sudah ada tidak berubah.
                </p>
              ) : sessionsCount === 0 ? (
                <p>Belum ada sesi tersimpan.</p>
              ) : (
                <p>Status sesi belum diketahui.</p>
              )}
            </details>
          </section>
          {(activeSection === "attributes" ||
            activeSection === "resources" ||
            activeSection === "relationships" ||
            activeSection === "items" ||
            activeSection === "inventory" ||
            activeSection === "npcs") &&
          countForSection(activeSection) !== 0 ? (
            <div className="editor-panel-tools">
              <button
                type="button"
                aria-pressed={entitiesExpanded}
                onClick={toggleEntityExpansion}
              >
                {entitiesExpanded ? "Tutup semua entri" : "Buka semua entri"}
              </button>
            </div>
          ) : null}
          {readinessIssues.length > 0 && (
            <details
              className="editor-readiness"
              open={readinessOpen}
              onToggle={(event) => setReadinessOpen(event.currentTarget.open)}
            >
              <summary>
                {readinessIssues.length} pemeriksaan perlu diperbaiki
              </summary>
              <ul
                className="editor-error-list"
                aria-label="Pemeriksaan yang perlu diperbaiki"
              >
                {readinessIssues.map((message, index) => (
                  <li key={`${message}-${index}`}>
                    <button
                      type="button"
                      className="editor-issue-link"
                      onClick={() => focusIssue(message)}
                    >
                      {message}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="editor-section-panels">
            <section
              role="tabpanel"
              id="editor-panel-summary"
              aria-labelledby="editor-tab-rail-summary"
              aria-label="Ringkasan"
              ref={(element) => {
                sectionPanelRefs.current.summary = element;
              }}
              hidden={activeSection !== "summary"}
            >
              <details className="card" open data-editor-collapsible>
                <summary>Ringkasan</summary>
                <label>
                  Judul
                  <input
                    data-field-key="title"
                    value={current.title}
                    onChange={(event) => patch({ title: event.target.value })}
                  />
                </label>
                <label>
                  Deskripsi
                  <textarea
                    data-field-key="description"
                    value={current.description ?? ""}
                    onChange={(event) =>
                      patchFn((definition) =>
                        optionalText(
                          definition,
                          "description",
                          event.target.value,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Genre
                  <input
                    data-field-key="genre"
                    value={current.genre ?? ""}
                    onChange={(event) =>
                      patchFn((definition) =>
                        optionalText(definition, "genre", event.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  Nuansa
                  <input
                    data-field-key="tone"
                    value={current.tone ?? ""}
                    onChange={(event) =>
                      patchFn((definition) =>
                        optionalText(definition, "tone", event.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  Bahasa
                  <input
                    data-field-key="language"
                    value={current.language ?? ""}
                    onChange={(event) =>
                      patchFn((definition) =>
                        optionalText(
                          definition,
                          "language",
                          event.target.value,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Batas usia
                  <select
                    data-field-key="ageRating"
                    value={current.ageRating ?? ""}
                    onChange={(event) => {
                      const rating = AGE_RATINGS.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const next = { ...definition };
                        if (rating) next.ageRating = rating.value;
                        else delete next.ageRating;
                        return next;
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {AGE_RATINGS.map((rating) => (
                      <option key={rating.value} value={rating.value}>
                        {rating.label}
                      </option>
                    ))}
                  </select>
                </label>
              </details>
              <details
                className="card editor-template-gallery"
                data-editor-collapsible
              >
                <summary>Template tersimpan</summary>
                {templatesLoading && (
                  <p role="status">Memuat template tersimpan…</p>
                )}
                {templatesError && (
                  <p className="error" role="alert">
                    {templatesError}
                    {savedTemplates !== null &&
                      " Daftar sebelumnya tetap ditampilkan."}
                  </p>
                )}
                {templatesError && (
                  <button
                    type="button"
                    onClick={() => void reloadSavedTemplates()}
                    disabled={templatesLoading}
                  >
                    Coba muat lagi
                  </button>
                )}
                {savedTemplates?.length === 0 && !templatesLoading && (
                  <p className="hint">Belum ada template tersimpan.</p>
                )}
                {savedTemplates && savedTemplates.length > 0 && (
                  <ul className="editor-template-list">
                    {savedTemplates.map((template) => (
                      <li key={template.id}>
                        <span>{template.title}</span>
                        <button
                          type="button"
                          disabled={templateLoadingId !== null}
                          onClick={() => void applySavedTemplate(template.id)}
                        >
                          {templateLoadingId === template.id
                            ? "Memuat…"
                            : "Tinjau template"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-scenario"
              aria-labelledby="editor-tab-rail-scenario"
              aria-label="Skenario"
              ref={(element) => {
                sectionPanelRefs.current.scenario = element;
              }}
              hidden={activeSection !== "scenario"}
            >
              <details className="card" open data-editor-collapsible>
                <summary>Skenario</summary>
                <label>
                  Latar
                  <textarea
                    data-field-key="scenario.setting"
                    value={current.scenario.setting}
                    onChange={(event) =>
                      patch({
                        scenario: {
                          ...current.scenario,
                          setting: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Situasi awal
                  <textarea
                    data-field-key="scenario.startingSituation"
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
                  Pemicu
                  <textarea
                    data-field-key="scenario.trigger"
                    value={current.scenario.trigger ?? ""}
                    onChange={(event) =>
                      patch({
                        scenario: optionalText(
                          current.scenario,
                          "trigger",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Gaya narator
                  <select
                    data-field-key="scenario.narratorStyle"
                    value={current.scenario.narratorStyle ?? ""}
                    onChange={(event) => {
                      const choice = NARRATOR_STYLES.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const scenario = { ...definition.scenario };
                        if (choice) scenario.narratorStyle = choice.value;
                        else delete scenario.narratorStyle;
                        return { scenario };
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {NARRATOR_STYLES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tempo
                  <select
                    data-field-key="scenario.tempo"
                    value={current.scenario.tempo ?? ""}
                    onChange={(event) => {
                      const choice = SCENARIO_TEMPOS.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const scenario = { ...definition.scenario };
                        if (choice) scenario.tempo = choice.value;
                        else delete scenario.tempo;
                        return { scenario };
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {SCENARIO_TEMPOS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Panjang giliran
                  <select
                    data-field-key="scenario.turnLength"
                    value={current.scenario.turnLength ?? ""}
                    onChange={(event) => {
                      const choice = TURN_LENGTHS.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const scenario = { ...definition.scenario };
                        if (choice) scenario.turnLength = choice.value;
                        else delete scenario.turnLength;
                        return { scenario };
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {TURN_LENGTHS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Sudut pandang
                  <select
                    data-field-key="scenario.pointOfView"
                    value={current.scenario.pointOfView ?? ""}
                    onChange={(event) => {
                      const choice = POINTS_OF_VIEW.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const scenario = { ...definition.scenario };
                        if (choice) scenario.pointOfView = choice.value;
                        else delete scenario.pointOfView;
                        return { scenario };
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {POINTS_OF_VIEW.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Aturan dunia
                  <textarea
                    value={current.scenario.worldRules ?? ""}
                    onChange={(event) =>
                      patch({
                        scenario: optionalText(
                          current.scenario,
                          "worldRules",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Batas konten
                  <textarea
                    data-field-key="scenario.contentLimits"
                    value={current.scenario.contentLimits ?? ""}
                    onChange={(event) =>
                      patch({
                        scenario: optionalText(
                          current.scenario,
                          "contentLimits",
                          event.target.value,
                        ),
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
                        scenario: optionalText(
                          current.scenario,
                          "tone",
                          event.target.value,
                        ),
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
                        scenario: optionalText(
                          current.scenario,
                          "genre",
                          event.target.value,
                        ),
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
                        scenario: optionalText(
                          current.scenario,
                          "additionalContext",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-worldmap"
              aria-labelledby="editor-tab-rail-worldmap"
              aria-label="Peta dunia"
              ref={(element) => {
                sectionPanelRefs.current.worldmap = element;
              }}
              hidden={activeSection !== "worldmap"}
            >
              <details className="card" open data-editor-collapsible>
                <summary>Peta dunia</summary>
                <p className="hint">
                  Masukkan katalog kecil yang tervalidasi. ID lokasi awal harus
                  cocok persis dengan ID pada peta atau lorebook yang dipin.
                </p>
                <label>
                  Peta dunia (JSON)
                  <textarea
                    data-field-key="worldMap"
                    rows={10}
                    value={
                      raws.worldMap ??
                      (current.worldMap
                        ? JSON.stringify(current.worldMap, null, 2)
                        : "")
                    }
                    onChange={(event) => handleWorldMapText(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                {worldMapError && (
                  <p className="error" role="alert">
                    {worldMapError}
                  </p>
                )}
                <label>
                  Lokasi awal (ID persis)
                  <input
                    data-field-key="startingLocationId"
                    list="world-location-ids"
                    value={
                      raws.startingLocationId ??
                      current.startingLocationId ??
                      ""
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setRaws((prev) => ({
                        ...prev,
                        startingLocationId: value,
                      }));
                      setDraft((d) => {
                        if (!d) return d;
                        const next = { ...d };
                        if (value === "") delete next.startingLocationId;
                        else next.startingLocationId = value;
                        return next;
                      });
                    }}
                  />
                </label>
                <datalist id="world-location-ids">
                  {current.worldMap?.locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                  {loreEntriesPage?.entries
                    .filter(
                      (entry) =>
                        entry.kind === "location" || entry.kind === "place",
                    )
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                </datalist>
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-lorebook"
              aria-labelledby="editor-tab-rail-lorebook"
              aria-label="Lorebook"
              ref={(element) => {
                sectionPanelRefs.current.lorebook = element;
              }}
              hidden={activeSection !== "lorebook"}
            >
              <details className="card" open>
                <summary>Lorebook</summary>
                <p className="hint">
                  Pack dicoba dahulu tanpa menulis. Pencarian menampilkan
                  halaman entri publik; ekspor pack adalah akses pembuat yang
                  terpisah.
                </p>
                <h3>Template cerita berkembang</h3>
                <p className="hint">
                  Contoh preman → residivis → mafia → politisi. Unduh lorebook,
                  dunia pendamping, dan panduan; lalu sesuaikan isinya.
                </p>
                <div className="row">
                  <button
                    type="button"
                    onClick={() =>
                      downloadEvolvingAsset(
                        evolvingStoryLorebook,
                        "lorebook-evolving-story.json",
                        "application/json",
                      )
                    }
                  >
                    Unduh lorebook JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadEvolvingAsset(
                        evolvingStoryGame,
                        "lorebook-evolving-game.json",
                        "application/json",
                      )
                    }
                  >
                    Unduh template dunia
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadEvolvingAsset(
                        evolvingStoryGuide,
                        "lorebook-evolving-guide.md",
                        "text/markdown;charset=utf-8",
                      )
                    }
                  >
                    Unduh panduan
                  </button>
                </div>
                <label className="button">
                  Impor JSON lorebook (maks. 8 MiB)
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="visually-hidden"
                    disabled={loreWorking}
                    onChange={(event) => void handleLorebookFile(event)}
                  />
                </label>
                {loreImportError && (
                  <p className="error" role="alert">
                    {loreImportError}
                  </p>
                )}
                {loreImportStage && (
                  <section className="entity" aria-label="Hasil impor lorebook">
                    <h3>{loreImportStage.result.pack.name}</h3>
                    <p className="hint">
                      {loreImportStage.result.pack.id} v
                      {loreImportStage.result.pack.version} ·{" "}
                      {loreImportStage.result.entries} entri ·{" "}
                      {loreImportStage.result.links} tautan · digest{" "}
                      {loreImportStage.result.digest}
                    </p>
                    <p role="status">
                      {loreImportStage.status === "dry-run"
                        ? `Validasi tanpa penulisan berhasil untuk ${loreImportStage.fileName}.`
                        : `Pack ${loreImportStage.result.pack.id} v${loreImportStage.result.pack.version} telah diterbitkan.`}
                    </p>
                    {loreImportStage.status === "dry-run" && (
                      <button
                        type="button"
                        className="primary"
                        disabled={loreWorking}
                        onClick={() => void handlePublishLorebook()}
                      >
                        Terbitkan pack tervalidasi
                      </button>
                    )}
                  </section>
                )}

                <h3>Versi pack tersimpan</h3>
                {loreError && (
                  <p className="error" role="alert">
                    {loreError}
                  </p>
                )}
                {lorebookLoading && <p role="status">Memuat daftar pack…</p>}
                {lorebookPage?.packs.length === 0 && (
                  <p className="hint">Belum ada lorebook yang diterbitkan.</p>
                )}
                {lorebookPage?.packs.map((pack) => (
                  <article
                    key={`${pack.id}@${pack.version}`}
                    className="entity"
                  >
                    <h4>{pack.name}</h4>
                    <p className="hint">
                      {pack.id} v{pack.version} · {pack.entryCount} entri ·{" "}
                      {pack.linkCount} tautan
                    </p>
                    {pack.description && <p>{pack.description}</p>}
                    <button
                      type="button"
                      onClick={() => {
                        setLoreRef({ packId: pack.id, version: pack.version });
                        setLoreEntriesOffset(0);
                        setLoreQuery("");
                        setLoreKind("");
                        setLoreError(null);
                      }}
                    >
                      Telusuri versi ini
                    </button>
                  </article>
                ))}
                <div className="row">
                  <button
                    type="button"
                    disabled={lorebookLoading || lorebookOffset === 0}
                    onClick={() =>
                      setLorebookOffset((value) => Math.max(0, value - 20))
                    }
                  >
                    Pack sebelumnya
                  </button>
                  <span className="hint">
                    {lorebookPage
                      ? `${Math.min(lorebookOffset + 1, lorebookPage.total)}–${Math.min(lorebookOffset + lorebookPage.packs.length, lorebookPage.total)} dari ${lorebookPage.total}`
                      : "Daftar pack belum dimuat"}
                  </span>
                  <button
                    type="button"
                    disabled={
                      lorebookLoading ||
                      !lorebookPage ||
                      lorebookOffset + lorebookPage.packs.length >=
                        lorebookPage.total
                    }
                    onClick={() => setLorebookOffset((value) => value + 20)}
                  >
                    Pack berikutnya
                  </button>
                </div>

                <h3 data-field-key="lorebookRefs" tabIndex={-1}>
                  Pin persis pada draft
                </h3>
                {(current.lorebookRefs ?? []).length === 0 ? (
                  <p className="hint">Belum ada versi lorebook yang dipin.</p>
                ) : (
                  <ul>
                    {current.lorebookRefs?.map((ref) => (
                      <li key={`${ref.packId}@${ref.version}`}>
                        {ref.packId} v{ref.version}{" "}
                        <button
                          type="button"
                          onClick={() =>
                            patchFn((d) => ({
                              lorebookRefs: (d.lorebookRefs ?? []).filter(
                                (entry) =>
                                  entry.packId !== ref.packId ||
                                  entry.version !== ref.version,
                              ),
                            }))
                          }
                        >
                          Lepas pin
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {loreRef && (
                  <div className="card">
                    <h3>
                      Jelajahi {loreRef.packId} v{loreRef.version}
                    </h3>
                    <div className="row">
                      <button
                        type="button"
                        disabled={(current.lorebookRefs ?? []).some(
                          (ref) =>
                            ref.packId === loreRef.packId &&
                            ref.version === loreRef.version,
                        )}
                        onClick={() =>
                          patchFn((d) => ({
                            lorebookRefs: [
                              ...(d.lorebookRefs ?? []),
                              {
                                packId: loreRef.packId,
                                version: loreRef.version,
                              },
                            ],
                          }))
                        }
                      >
                        Pin versi persis ini
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleExportLorebook()}
                      >
                        Ekspor pack pembuat
                      </button>
                    </div>
                    <label>
                      Cari entri
                      <input
                        type="search"
                        maxLength={512}
                        value={loreQuery}
                        onChange={(event) => {
                          setLoreQuery(event.target.value);
                          setLoreEntriesOffset(0);
                        }}
                      />
                    </label>
                    <label>
                      Jenis entri
                      <select
                        value={loreKind}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLoreKind(
                            LORE_KINDS.find((kind) => kind === value) ?? "",
                          );
                          setLoreEntriesOffset(0);
                        }}
                      >
                        <option value="">Semua jenis</option>
                        {LORE_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ))}
                      </select>
                    </label>
                    {loreEntriesLoading && (
                      <p role="status">Memuat entri lore…</p>
                    )}
                    {loreEntriesPage?.entries.length === 0 && (
                      <p className="hint">Tidak ada entri publik yang cocok.</p>
                    )}
                    {loreEntriesPage?.entries.map((entry) => (
                      <article key={entry.id} className="entity">
                        <h4>{entry.name}</h4>
                        <p className="hint">
                          {entry.id} · {entry.kind} · {entry.visibility}
                        </p>
                        {entry.summary && <p>{entry.summary}</p>}
                        <p className="hint">
                          Sumber: {entry.provenance.sourceId}
                          {entry.provenance.license
                            ? ` · lisensi ${entry.provenance.license}`
                            : ""}
                          {entry.provenance.canon
                            ? ` · canon ${entry.provenance.canon}`
                            : ""}
                          {entry.provenance.sourceUrl
                            ? ` · ${entry.provenance.sourceUrl}`
                            : ""}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setLoreLinksFor(entry.id);
                            setLoreLinkOffset(0);
                          }}
                        >
                          Lihat tautan terkait
                        </button>
                        {loreLinksFor === entry.id && loreLinkPage && (
                          <div>
                            {loreLinkPage.links.length === 0 && (
                              <p className="hint">Tidak ada tautan publik.</p>
                            )}
                            <ul>
                              {loreLinkPage.links.map((link, index) => (
                                <li
                                  key={`${link.fromId}:${link.toId}:${link.relation}:${index}`}
                                >
                                  {link.fromId} — {link.relation} — {link.toId}
                                </li>
                              ))}
                            </ul>
                            <div className="row">
                              <button
                                type="button"
                                disabled={loreLinkOffset === 0}
                                onClick={() =>
                                  setLoreLinkOffset((value) =>
                                    Math.max(0, value - 20),
                                  )
                                }
                              >
                                Tautan sebelumnya
                              </button>
                              <span className="hint">
                                {loreLinkPage.total} tautan publik
                              </span>
                              <button
                                type="button"
                                disabled={
                                  loreLinkOffset + loreLinkPage.links.length >=
                                  loreLinkPage.total
                                }
                                onClick={() =>
                                  setLoreLinkOffset((value) => value + 20)
                                }
                              >
                                Tautan berikutnya
                              </button>
                            </div>
                          </div>
                        )}
                      </article>
                    ))}
                    <div className="row">
                      <button
                        type="button"
                        disabled={loreEntriesLoading || loreEntriesOffset === 0}
                        onClick={() =>
                          setLoreEntriesOffset((value) =>
                            Math.max(0, value - 20),
                          )
                        }
                      >
                        Entri sebelumnya
                      </button>
                      <span className="hint">
                        {loreEntriesPage
                          ? `${Math.min(loreEntriesOffset + 1, loreEntriesPage.total)}–${Math.min(loreEntriesOffset + loreEntriesPage.entries.length, loreEntriesPage.total)} dari ${loreEntriesPage.total}`
                          : "Entri belum dimuat"}
                      </span>
                      <button
                        type="button"
                        disabled={
                          loreEntriesLoading ||
                          !loreEntriesPage ||
                          loreEntriesOffset + loreEntriesPage.entries.length >=
                            loreEntriesPage.total
                        }
                        onClick={() =>
                          setLoreEntriesOffset((value) => value + 20)
                        }
                      >
                        Entri berikutnya
                      </button>
                    </div>
                  </div>
                )}

                <h3>Preview draft</h3>
                <label>
                  Lokasi preview (ID persis, kosong = semua lokasi)
                  <input
                    list="world-location-ids"
                    value={
                      lorePreviewLocationId ?? current.startingLocationId ?? ""
                    }
                    onChange={(event) =>
                      setLorePreviewLocationId(event.target.value)
                    }
                  />
                </label>
                <label>
                  Kata kunci tambahan (opsional)
                  <input
                    maxLength={512}
                    value={lorePreviewQuery}
                    onChange={(event) =>
                      setLorePreviewQuery(event.target.value)
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={loreWorking}
                  onClick={() => void handlePreviewLore()}
                >
                  Preview lore di lokasi terpilih
                </button>
                {lorePreviewError && (
                  <p className="error" role="alert">
                    {lorePreviewError}
                  </p>
                )}
                {lorePreview && (
                  <section className="entity" aria-label="Hasil preview lore">
                    <p role="status">
                      {lorePreview.entries.length} entri ditampilkan ·{" "}
                      {lorePreview.activeNpcIds.length} NPC aktif di lokasi
                      {lorePreview.locationId
                        ? ` ${lorePreview.locationId}`
                        : " (lokasi belum ditentukan)"}
                      {lorePreview.omitted.length
                        ? ` · ${lorePreview.omitted.length} pemberitahuan batas`
                        : ""}
                    </p>
                    {lorePreview.activeNpcIds.length > 0 && (
                      <p className="hint">
                        NPC aktif: {lorePreview.activeNpcIds.join(", ")}
                      </p>
                    )}
                    {lorePreview.omitted.map((omission) => (
                      <p key={omission} className="hint">
                        {omission}
                      </p>
                    ))}
                    {lorePreview.entries.map((entry) => (
                      <article key={entry.id} className="entity">
                        <h4>{entry.name}</h4>
                        <p className="hint">
                          {entry.id} · {entry.kind}
                        </p>
                        {entry.summary && <p>{entry.summary}</p>}
                        <p className="hint">
                          Sumber: {entry.provenance.sourceId}
                          {entry.provenance.license
                            ? ` · lisensi ${entry.provenance.license}`
                            : ""}
                          {entry.provenance.canon
                            ? ` · canon ${entry.provenance.canon}`
                            : ""}
                          {entry.provenance.sourceUrl
                            ? ` · ${entry.provenance.sourceUrl}`
                            : ""}
                        </p>
                      </article>
                    ))}
                  </section>
                )}
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-player"
              aria-labelledby="editor-tab-rail-player"
              aria-label="Pemain"
              ref={(element) => {
                sectionPanelRefs.current.player = element;
              }}
              hidden={activeSection !== "player"}
            >
              <details className="card" open>
                <summary>Pemain</summary>
                <label>
                  Nama
                  <input
                    data-field-key="player.name"
                    value={current.player.name}
                    onChange={(event) =>
                      patch({
                        player: { ...current.player, name: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Peran
                  <input
                    data-field-key="player.role"
                    value={current.player.role ?? ""}
                    onChange={(event) =>
                      patch({
                        player: optionalText(
                          current.player,
                          "role",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Kata ganti
                  <select
                    data-field-key="player.pronoun"
                    value={current.player.pronoun ?? ""}
                    onChange={(event) => {
                      const choice = PLAYER_PRONOUNS.find(
                        (option) => option.value === event.target.value,
                      );
                      patchFn((definition) => {
                        const player = { ...definition.player };
                        if (choice) player.pronoun = choice.value;
                        else delete player.pronoun;
                        return { player };
                      });
                    }}
                  >
                    <option value="">Gunakan default</option>
                    {PLAYER_PRONOUNS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Usia
                  <input
                    data-field-key="player.age"
                    value={current.player.age ?? ""}
                    onChange={(event) =>
                      patch({
                        player: optionalText(
                          current.player,
                          "age",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Tujuan
                  <textarea
                    data-field-key="player.goal"
                    value={current.player.goal ?? ""}
                    onChange={(event) =>
                      patch({
                        player: optionalText(
                          current.player,
                          "goal",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Ketakutan
                  <textarea
                    data-field-key="player.fear"
                    value={current.player.fear ?? ""}
                    onChange={(event) =>
                      patch({
                        player: optionalText(
                          current.player,
                          "fear",
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Deskripsi
                  <textarea
                    value={current.player.description ?? ""}
                    onChange={(event) =>
                      patch({
                        player: optionalText(
                          current.player,
                          "description",
                          event.target.value,
                        ),
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
                        player: optionalText(
                          current.player,
                          "background",
                          event.target.value,
                        ),
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
                        player: optionalText(
                          current.player,
                          "personality",
                          event.target.value,
                        ),
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
                        player: optionalText(
                          current.player,
                          "notes",
                          event.target.value,
                        ),
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
                          if (parsed === undefined)
                            delete attributes[attribute.id];
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
                          if (parsed === undefined)
                            delete resources[resource.id];
                          else resources[resource.id] = parsed;
                          patch({ player: { ...current.player, resources } });
                        },
                        true,
                      )}
                    />
                  </label>
                ))}
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-attributes"
              aria-labelledby="editor-tab-rail-attributes"
              aria-label="Atribut"
              ref={(element) => {
                sectionPanelRefs.current.attributes = element;
              }}
              hidden={activeSection !== "attributes"}
            >
              <details className="card" open>
                <summary>Atribut</summary>
                {current.attributes.map((attribute, index) => (
                  <details
                    className="entity editor-entity"
                    key={`attr-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="attributes"
                    data-entity-id={attribute.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.attributes ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{attribute.name || "Atribut tanpa nama"}</span>
                      <code>{attribute.id}</code>
                    </summary>
                    {renderEntityControls(
                      "attributes",
                      attribute.id,
                      index,
                      current.attributes.length,
                      () => duplicateEntity("attributes", index),
                    )}
                    <label>
                      Id
                      <input
                        data-field-name="id"
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
                        data-field-name="name"
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
                          patchAttribute(
                            index,
                            optionalText(
                              attribute,
                              "description",
                              event.target.value,
                            ),
                          )
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
                          attributes: d.attributes.filter(
                            (_, i) => i !== index,
                          ),
                        }))
                      }
                    >
                      Hapus atribut
                    </button>
                  </details>
                ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((d) => ({
                      attributes: [
                        ...d.attributes,
                        {
                          id: createUuid(),
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
            </section>
            <section
              role="tabpanel"
              id="editor-panel-resources"
              aria-labelledby="editor-tab-rail-resources"
              aria-label="Sumber daya"
              ref={(element) => {
                sectionPanelRefs.current.resources = element;
              }}
              hidden={activeSection !== "resources"}
            >
              <details className="card" open>
                <summary>Sumber daya</summary>
                {current.resources.map((resource, index) => (
                  <details
                    className="entity editor-entity"
                    key={`res-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="resources"
                    data-entity-id={resource.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.resources ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{resource.name || "Sumber daya tanpa nama"}</span>
                      <code>{resource.id}</code>
                    </summary>
                    {renderEntityControls(
                      "resources",
                      resource.id,
                      index,
                      current.resources.length,
                      () => duplicateEntity("resources", index),
                    )}
                    <label>
                      Id
                      <input
                        data-field-name="id"
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
                        data-field-name="name"
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
                          patchResource(
                            index,
                            optionalText(
                              resource,
                              "description",
                              event.target.value,
                            ),
                          )
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
                                resources: replaceIn(
                                  current.resources,
                                  index,
                                  next,
                                ),
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
                  </details>
                ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((d) => ({
                      resources: [
                        ...d.resources,
                        { id: createUuid(), name: "", min: 0, initialValue: 0 },
                      ],
                    }))
                  }
                >
                  Tambah sumber daya
                </button>
              </details>
            </section>
            <section
              role="tabpanel"
              id="editor-panel-relationships"
              aria-labelledby="editor-tab-rail-relationships"
              aria-label="Relasi"
              ref={(element) => {
                sectionPanelRefs.current.relationships = element;
              }}
              hidden={activeSection !== "relationships"}
            >
              <details className="card" open>
                <summary>Relasi</summary>
                {current.relationships.map((relationship, index) => (
                  <details
                    className="entity editor-entity"
                    key={`rel-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="relationships"
                    data-entity-id={relationship.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.relationships ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{relationship.name || "Relasi tanpa nama"}</span>
                      <code>{relationship.id}</code>
                    </summary>
                    {renderEntityControls(
                      "relationships",
                      relationship.id,
                      index,
                      current.relationships.length,
                    )}
                    <label>
                      Id
                      <input
                        data-field-name="id"
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
                        data-field-name="name"
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
                          patchRelationship(
                            index,
                            optionalText(
                              relationship,
                              "description",
                              event.target.value,
                            ),
                          )
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
                                patchRelationship(index, {
                                  defaultValue: parsed,
                                });
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
                          relationships: d.relationships.filter(
                            (_, i) => i !== index,
                          ),
                        }))
                      }
                    >
                      Hapus relasi
                    </button>
                  </details>
                ))}
                <h3>Kelompok pihak</h3>
                {(current.relationshipParties ?? []).map((party, index) => (
                  <details
                    className="entity editor-entity"
                    key={`party-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="relationshipParties"
                    data-entity-id={party.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.relationships ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{party.name || "Kelompok tanpa nama"}</span>
                      <code>{party.id}</code>
                    </summary>
                    {renderEntityControls(
                      "relationshipParties",
                      party.id,
                      index,
                      current.relationshipParties?.length ?? 0,
                    )}
                    <label>
                      Id
                      <input
                        data-field-key={`party:${party.id}:id`}
                        data-field-name="id"
                        value={party.id}
                        readOnly={savedIds.relationshipParties.has(party.id)}
                        onChange={(event) =>
                          patchFn((definition) => ({
                            relationshipParties: replaceIn(
                              definition.relationshipParties ?? [],
                              index,
                              {
                                ...(definition.relationshipParties ?? [])[
                                  index
                                ],
                                id: event.target.value,
                              },
                            ),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Nama
                      <input
                        data-field-key={`party:${party.id}:name`}
                        data-field-name="name"
                        value={party.name}
                        onChange={(event) =>
                          patchFn((definition) => ({
                            relationshipParties: replaceIn(
                              definition.relationshipParties ?? [],
                              index,
                              {
                                ...(definition.relationshipParties ?? [])[
                                  index
                                ],
                                name: event.target.value,
                              },
                            ),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Jenis pihak
                      <input
                        data-field-key={`party:${party.id}:type`}
                        data-field-name="type"
                        value={party.type}
                        onChange={(event) =>
                          patchFn((definition) => ({
                            relationshipParties: replaceIn(
                              definition.relationshipParties ?? [],
                              index,
                              {
                                ...(definition.relationshipParties ?? [])[
                                  index
                                ],
                                type: event.target.value,
                              },
                            ),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Sikap awal
                      <select
                        data-field-key={`party:${party.id}:initialStance`}
                        data-field-name="initialStance"
                        value={party.initialStance}
                        onChange={(event) => {
                          const stance = RELATIONSHIP_STANCES.find(
                            (option) => option.value === event.target.value,
                          );
                          if (!stance) return;
                          patchFn((definition) => ({
                            relationshipParties: replaceIn(
                              definition.relationshipParties ?? [],
                              index,
                              {
                                ...(definition.relationshipParties ?? [])[
                                  index
                                ],
                                initialStance: stance.value,
                              },
                            ),
                          }));
                        }}
                      >
                        {RELATIONSHIP_STANCES.map((stance) => (
                          <option key={stance.value} value={stance.value}>
                            {stance.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Rahasia (opsional)
                      <textarea
                        data-field-key={`party:${party.id}:secret`}
                        data-field-name="secret"
                        value={party.secret ?? ""}
                        onChange={(event) =>
                          patchFn((definition) => ({
                            relationshipParties: replaceIn(
                              definition.relationshipParties ?? [],
                              index,
                              optionalText(
                                (definition.relationshipParties ?? [])[index],
                                "secret",
                                event.target.value,
                              ),
                            ),
                          }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() =>
                        patchFn((definition) => ({
                          relationshipParties: (
                            definition.relationshipParties ?? []
                          ).filter((_, partyIndex) => partyIndex !== index),
                        }))
                      }
                    >
                      Hapus kelompok
                    </button>
                  </details>
                ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((definition) => ({
                      relationshipParties: [
                        ...(definition.relationshipParties ?? []),
                        {
                          id: createUuid(),
                          name: "",
                          type: "faction",
                          initialStance: "neutral",
                        },
                      ],
                    }))
                  }
                >
                  Tambah kelompok pihak
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((d) => ({
                      relationships: [
                        ...d.relationships,
                        {
                          id: createUuid(),
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
            </section>
            <section
              role="tabpanel"
              id="editor-panel-items"
              aria-labelledby="editor-tab-rail-items"
              aria-label="Item"
              ref={(element) => {
                sectionPanelRefs.current.items = element;
              }}
              hidden={activeSection !== "items"}
            >
              <details className="card" open>
                <summary>Item</summary>
                {current.items.map((item, index) => (
                  <details
                    className="entity editor-entity"
                    key={`item-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="items"
                    data-entity-id={item.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.items ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{item.name || "Item tanpa nama"}</span>
                      <code>{item.id}</code>
                    </summary>
                    {renderEntityControls(
                      "items",
                      item.id,
                      index,
                      current.items.length,
                      () => duplicateEntity("items", index),
                    )}
                    <label>
                      Id
                      <input
                        data-field-name="id"
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
                        data-field-name="name"
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
                          patchItem(
                            index,
                            optionalText(
                              item,
                              "description",
                              event.target.value,
                            ),
                          )
                        }
                      />
                    </label>
                    <div className="row">
                      <label>
                        <input
                          type="checkbox"
                          checked={item.stackable}
                          onChange={(event) =>
                            patchItem(index, {
                              stackable: event.target.checked,
                            })
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
                              patch({
                                items: replaceIn(current.items, index, next),
                              });
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
                            patchItem(index, {
                              consumable: event.target.checked,
                            })
                          }
                        />
                        Bisa dikonsumsi
                      </label>
                    </div>
                    <label>
                      Tag (pisahkan dengan koma)
                      <input
                        value={
                          raws[`item:${item.id}:tags`] ?? item.tags.join(", ")
                        }
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
                      <div
                        className="entity editor-effect"
                        key={effectIndex}
                        data-effect-index={effectIndex}
                        data-effect-type={effect.type}
                      >
                        <div className="row">
                          <label>
                            Tipe
                            <select
                              data-field-key={`item:${item.id}:fx:${effectIndex}:type`}
                              value={effect.type}
                              onChange={(event) => {
                                const type = EFFECT_TYPES.find(
                                  (candidate) =>
                                    candidate === event.target.value,
                                );
                                if (!type) return;
                                patchItem(index, {
                                  effects: replaceIn(
                                    item.effects,
                                    effectIndex,
                                    defaultEffect(type, current),
                                  ),
                                });
                              }}
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
                                data-field-key={`item:${item.id}:fx:${effectIndex}:target`}
                                value={effect.target}
                                onChange={(event) =>
                                  patchItem(index, {
                                    effects: replaceIn(
                                      item.effects,
                                      effectIndex,
                                      {
                                        ...effect,
                                        target: event.target.value,
                                      },
                                    ),
                                  })
                                }
                              >
                                <option value="">— pilih target —</option>
                                {effect.target &&
                                  !(
                                    effect.type === "ATTRIBUTE_CHANGE"
                                      ? current.attributes
                                      : effect.type === "RESOURCE_CHANGE"
                                        ? current.resources
                                        : effect.type === "RELATIONSHIP_CHANGE"
                                          ? current.relationships
                                          : current.items
                                  ).some(
                                    (option) => option.id === effect.target,
                                  ) && (
                                    <option value={effect.target}>
                                      {effect.target} (tersimpan saat ini)
                                    </option>
                                  )}
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
                                required
                                data-field-key={`item:${item.id}:fx:${effectIndex}:npcId`}
                                value={effect.npcId ?? ""}
                                onChange={(event) =>
                                  patchItem(index, {
                                    effects: replaceIn(
                                      item.effects,
                                      effectIndex,
                                      {
                                        ...effect,
                                        npcId: event.target.value,
                                      },
                                    ),
                                  })
                                }
                              >
                                <option value="" disabled>
                                  — pilih NPC —
                                </option>
                                {effect.npcId &&
                                  !current.npcs.some(
                                    (npc) => npc.id === effect.npcId,
                                  ) && (
                                    <option value={effect.npcId}>
                                      {effect.npcId} (tersimpan saat ini)
                                    </option>
                                  )}
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
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:operation`}
                                  value={effect.operation}
                                  onChange={(event) => {
                                    const operation = OPERATIONS.find(
                                      (candidate) =>
                                        candidate === event.target.value,
                                    );
                                    if (!operation) return;
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          operation,
                                        },
                                      ),
                                    });
                                  }}
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
                                        effects: replaceIn(
                                          item.effects,
                                          effectIndex,
                                          {
                                            ...effect,
                                            value: parsed,
                                          },
                                        ),
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
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          quantity: parsed,
                                        },
                                      ),
                                    });
                                  },
                                )}
                              />
                            </label>
                          )}

                          {effect.type === "ADD_FACT" && (
                            <>
                              <label>
                                Fakta yang ditambahkan
                                <input
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:text`}
                                  value={effect.text}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          text: event.target.value,
                                        },
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Visibilitas
                                <select
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:visibility`}
                                  value={effect.visibility ?? ""}
                                  onChange={(event) => {
                                    const visibility = FACT_VISIBILITIES.find(
                                      (option) =>
                                        option.value === event.target.value,
                                    );
                                    const next = { ...effect };
                                    if (visibility)
                                      next.visibility = visibility.value;
                                    else delete next.visibility;
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        next,
                                      ),
                                    });
                                  }}
                                >
                                  <option value="">Gunakan default</option>
                                  {FACT_VISIBILITIES.map((option) => (
                                    <option
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {renderFactRecipients(
                                index,
                                item.id,
                                effectIndex,
                                effect,
                                "knownBy",
                              )}
                              {renderFactRecipients(
                                index,
                                item.id,
                                effectIndex,
                                effect,
                                "revealableTo",
                              )}
                            </>
                          )}

                          {effect.type === "REMOVE_FACT" && (
                            <label>
                              Teks fakta yang dihapus
                              <input
                                data-field-key={`item:${item.id}:fx:${effectIndex}:target`}
                                value={effect.target}
                                onChange={(event) =>
                                  patchItem(index, {
                                    effects: replaceIn(
                                      item.effects,
                                      effectIndex,
                                      {
                                        ...effect,
                                        target: event.target.value,
                                      },
                                    ),
                                  })
                                }
                              />
                            </label>
                          )}
                          {effect.type === "DISCOVER_LORE" && (
                            <label>
                              ID lore untuk dibuka
                              <input
                                data-field-key={`item:${item.id}:fx:${effectIndex}:loreId`}
                                value={effect.loreId}
                                onChange={(event) =>
                                  patchItem(index, {
                                    effects: replaceIn(
                                      item.effects,
                                      effectIndex,
                                      {
                                        ...effect,
                                        loreId: event.target.value,
                                      },
                                    ),
                                  })
                                }
                              />
                            </label>
                          )}

                          {effect.type === "REVEAL_FACT" && (
                            <>
                              <label>
                                ID fakta yang diungkap
                                <input
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:factId`}
                                  value={effect.factId}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          factId: event.target.value,
                                        },
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Ungkap kepada
                                <select
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:npcId`}
                                  value={effect.npcId}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          npcId: event.target.value,
                                        },
                                      ),
                                    })
                                  }
                                >
                                  {effect.npcId &&
                                    !factActors.some(
                                      (actor) => actor.id === effect.npcId,
                                    ) && (
                                      <option value={effect.npcId}>
                                        {effect.npcId} (tersimpan saat ini)
                                      </option>
                                    )}
                                  {factActors.map((actor) => (
                                    <option key={actor.id} value={actor.id}>
                                      {actor.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </>
                          )}

                          {effect.type === "SET_FLAG" && (
                            <>
                              <label>
                                Kunci flag
                                <select
                                  required
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:target`}
                                  value={effect.target}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          target: event.target.value,
                                        },
                                      ),
                                    })
                                  }
                                >
                                  <option value="" disabled>
                                    — pilih flag —
                                  </option>
                                  {effect.target &&
                                    !Object.hasOwn(
                                      current.worldMap?.flags ?? {},
                                      effect.target,
                                    ) && (
                                      <option value={effect.target}>
                                        {effect.target} (tersimpan saat ini)
                                      </option>
                                    )}
                                  {Object.keys(
                                    current.worldMap?.flags ?? {},
                                  ).map((flag) => (
                                    <option key={flag} value={flag}>
                                      {flag}
                                    </option>
                                  ))}
                                </select>
                                {Object.keys(current.worldMap?.flags ?? {})
                                  .length === 0 && (
                                  <span className="hint">
                                    Tambahkan flag di JSON Katalog dunia
                                    terlebih dahulu.
                                  </span>
                                )}
                              </label>
                              <label className="editor-checkbox">
                                <input
                                  type="checkbox"
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:value`}
                                  checked={effect.value}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          value: event.target.checked,
                                        },
                                      ),
                                    })
                                  }
                                />
                                Flag aktif
                              </label>
                            </>
                          )}

                          {effect.type === "NPC_PRESENCE" && (
                            <>
                              <label>
                                NPC
                                <select
                                  required
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:npcId`}
                                  value={effect.npcId}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          npcId: event.target.value,
                                        },
                                      ),
                                    })
                                  }
                                >
                                  <option value="" disabled>
                                    — pilih NPC —
                                  </option>
                                  {effect.npcId &&
                                    !current.npcs.some(
                                      (npc) => npc.id === effect.npcId,
                                    ) && (
                                      <option value={effect.npcId}>
                                        {effect.npcId} (tersimpan saat ini)
                                      </option>
                                    )}
                                  {current.npcs.map((npc) => (
                                    <option key={npc.id} value={npc.id}>
                                      {npc.name || npc.id}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="editor-checkbox">
                                <input
                                  type="checkbox"
                                  data-field-key={`item:${item.id}:fx:${effectIndex}:present`}
                                  checked={effect.present}
                                  onChange={(event) =>
                                    patchItem(index, {
                                      effects: replaceIn(
                                        item.effects,
                                        effectIndex,
                                        {
                                          ...effect,
                                          present: event.target.checked,
                                        },
                                      ),
                                    })
                                  }
                                />
                                NPC hadir
                              </label>
                            </>
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
                  </details>
                ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((d) => ({
                      items: [
                        ...d.items,
                        {
                          id: createUuid(),
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
            </section>
            <section
              role="tabpanel"
              id="editor-panel-inventory"
              aria-labelledby="editor-tab-rail-inventory"
              aria-label="Inventaris awal"
              ref={(element) => {
                sectionPanelRefs.current.inventory = element;
              }}
              hidden={activeSection !== "inventory"}
            >
              <details className="card" open>
                <summary>Inventaris awal</summary>
                {current.startingInventory.map((entry, index) => (
                  <details
                    className="entity editor-entity editor-inventory-row"
                    key={`inventory-${index}`}
                    open
                    data-editor-entity
                    data-inventory-index={index}
                    onToggle={() =>
                      syncEntityExpansion(
                        sectionPanelRefs.current.inventory ?? null,
                      )
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>
                        {current.items.find((item) => item.id === entry.itemId)
                          ?.name ||
                          entry.itemId ||
                          "Item belum dipilih"}{" "}
                        × {entry.quantity}
                      </span>
                    </summary>
                    <div
                      className="editor-entity-actions"
                      aria-label="Aksi entri inventaris"
                    >
                      <button
                        type="button"
                        data-inventory-reorder
                        aria-label={`Pindahkan entri inventaris ${index + 1} ke atas`}
                        disabled={working || index === 0}
                        onClick={() => moveInventoryEntry(index, "up")}
                      >
                        Naik
                      </button>
                      <button
                        type="button"
                        data-inventory-reorder
                        aria-label={`Pindahkan entri inventaris ${index + 1} ke bawah`}
                        disabled={
                          working ||
                          index === current.startingInventory.length - 1
                        }
                        onClick={() => moveInventoryEntry(index, "down")}
                      >
                        Turun
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() =>
                          patchFn((definition) => ({
                            startingInventory:
                              definition.startingInventory.filter(
                                (_, currentIndex) => currentIndex !== index,
                              ),
                          }))
                        }
                      >
                        Hapus
                      </button>
                    </div>
                    <label>
                      Item
                      <select
                        data-field-key={`inv:${index}:itemId`}
                        data-field-name="itemId"
                        value={entry.itemId}
                        onChange={(event) => {
                          const itemId = event.target.value;
                          patchFn((definition) => {
                            const currentEntry =
                              definition.startingInventory[index];
                            if (!currentEntry) return {};
                            return {
                              startingInventory: replaceIn(
                                definition.startingInventory,
                                index,
                                { ...currentEntry, itemId },
                              ),
                            };
                          });
                        }}
                      >
                        <option value="">— pilih item —</option>
                        {entry.itemId &&
                          !current.items.some(
                            (item) => item.id === entry.itemId,
                          ) && (
                            <option value={entry.itemId}>
                              {entry.itemId} (tersimpan saat ini)
                            </option>
                          )}
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
                            patchFn((definition) => {
                              const currentEntry =
                                definition.startingInventory[index];
                              if (!currentEntry) return {};
                              return {
                                startingInventory: replaceIn(
                                  definition.startingInventory,
                                  index,
                                  { ...currentEntry, quantity: parsed },
                                ),
                              };
                            });
                          },
                        )}
                      />
                    </label>
                    <label>
                      Owner
                      <input
                        data-field-key={`inv:${index}:owner`}
                        data-field-name="owner"
                        value={entry.owner ?? ""}
                        onChange={(event) =>
                          patchFn((definition) => {
                            const currentEntry =
                              definition.startingInventory[index];
                            if (!currentEntry) return {};
                            return {
                              startingInventory: replaceIn(
                                definition.startingInventory,
                                index,
                                optionalText(
                                  currentEntry,
                                  "owner",
                                  event.target.value,
                                ),
                              ),
                            };
                          })
                        }
                      />
                    </label>
                    <label>
                      Tempat
                      <input
                        data-field-key={`inv:${index}:place`}
                        data-field-name="place"
                        value={entry.place ?? ""}
                        onChange={(event) =>
                          patchFn((definition) => {
                            const currentEntry =
                              definition.startingInventory[index];
                            if (!currentEntry) return {};
                            return {
                              startingInventory: replaceIn(
                                definition.startingInventory,
                                index,
                                optionalText(
                                  currentEntry,
                                  "place",
                                  event.target.value,
                                ),
                              ),
                            };
                          })
                        }
                      />
                    </label>
                  </details>
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
            </section>
            <section
              role="tabpanel"
              id="editor-panel-npcs"
              aria-labelledby="editor-tab-rail-npcs"
              aria-label="NPC"
              ref={(element) => {
                sectionPanelRefs.current.npcs = element;
              }}
              hidden={activeSection !== "npcs"}
            >
              <details className="card" open>
                <summary>NPC</summary>
                {current.npcs.map((npc, index) => (
                  <details
                    className="entity editor-entity"
                    key={`npc-${index}`}
                    open
                    data-editor-entity
                    data-entity-type="npcs"
                    data-entity-id={npc.id}
                    data-entity-index={index}
                    onToggle={() =>
                      syncEntityExpansion(sectionPanelRefs.current.npcs ?? null)
                    }
                  >
                    <summary className="editor-entity-summary">
                      <span>{npc.name || "NPC tanpa nama"}</span>
                      <code>{npc.id}</code>
                    </summary>
                    {renderEntityControls(
                      "npcs",
                      npc.id,
                      index,
                      current.npcs.length,
                      () => duplicateEntity("npcs", index),
                    )}
                    <label>
                      Id
                      <input
                        data-field-name="id"
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
                        data-field-name="name"
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
                          patchNpc(
                            index,
                            optionalText(
                              npc,
                              "description",
                              event.target.value,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Latar belakang
                      <textarea
                        value={npc.background ?? ""}
                        onChange={(event) =>
                          patchNpc(
                            index,
                            optionalText(npc, "background", event.target.value),
                          )
                        }
                      />
                    </label>
                    <label>
                      Peran
                      <input
                        data-field-key={`npc:${npc.id}:role`}
                        value={npc.role ?? ""}
                        onChange={(event) =>
                          patchNpc(
                            index,
                            optionalText(npc, "role", event.target.value),
                          )
                        }
                      />
                    </label>
                    <label>
                      Suara
                      <textarea
                        data-field-key={`npc:${npc.id}:voice`}
                        value={npc.voice ?? ""}
                        onChange={(event) =>
                          patchNpc(
                            index,
                            optionalText(npc, "voice", event.target.value),
                          )
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
                        {...bindLines(
                          `npc:${npc.id}:goals`,
                          npc.goals,
                          (lines) => patchNpc(index, { goals: lines }),
                        )}
                      />
                    </label>
                    <label>
                      Pengetahuan rahasia (satu per baris)
                      <textarea
                        {...bindLines(
                          `npc:${npc.id}:privateKnowledge`,
                          npc.privateKnowledge,
                          (lines) =>
                            patchNpc(index, { privateKnowledge: lines }),
                        )}
                      />
                    </label>
                    {current.relationships.map((relationship) => (
                      <label key={relationship.id}>
                        Relasi awal: {relationship.name || relationship.id}{" "}
                        (kosong = nilai default)
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
                              else
                                initialRelationships[relationship.id] = parsed;
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
                              if (parsed === undefined)
                                delete attributes[attribute.id];
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
                  </details>
                ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    patchFn((d) => ({
                      npcs: [
                        ...d.npcs,
                        {
                          id: createUuid(),
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
            </section>
            <section
              role="tabpanel"
              id="editor-panel-preview"
              aria-labelledby="editor-tab-rail-preview"
              aria-label="Pratinjau"
              ref={(element) => {
                sectionPanelRefs.current.preview = element;
              }}
              hidden={activeSection !== "preview"}
            >
              {renderPreview("panel")}
            </section>
          </div>

          <div className="sticky-actions editor-actions">
            {revision === null ? (
              <button
                type="button"
                className="primary"
                onClick={handleSave}
                disabled={working}
              >
                Simpan dunia
              </button>
            ) : isDirty ? (
              <>
                <button
                  type="button"
                  className="primary"
                  onClick={handleSave}
                  disabled={working}
                >
                  Simpan perubahan
                </button>
                <button type="button" disabled>
                  Mulai sesi baru
                </button>
                <p className="editor-start-disabled">
                  Simpan perubahan sebelum memulai sesi baru.
                </p>
              </>
            ) : savedPlayable ? (
              <button
                type="button"
                className="primary"
                onClick={handleStart}
                disabled={working}
              >
                Mulai sesi baru
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={handleSave}
                disabled={working}
              >
                Simpan dunia
              </button>
            )}
          </div>

          {templateReview && (
            <section
              className="card"
              role="alertdialog"
              aria-label="Review template"
            >
              <h2>Review template sebelum diterapkan</h2>
              <p>
                Judul:{" "}
                <strong>{templateReview.draft.title || "(kosong)"}</strong>
              </p>
              <p className="hint">
                {templateReview.draft.attributes.length} atribut ·{" "}
                {templateReview.draft.resources.length} sumber daya ·{" "}
                {templateReview.draft.relationships.length} relasi ·{" "}
                {templateReview.draft.items.length} item ·{" "}
                {templateReview.draft.npcs.length} NPC ·{" "}
                {templateReview.draft.startingInventory.length} inventaris awal
                {templateReview.ai
                  ? " · Pengaturan AI template akan diabaikan; default Pengaturan digunakan."
                  : ""}
              </p>
              {isDirty && (
                <p className="error">
                  {revision === null
                    ? "Draft baru belum disimpan."
                    : "Draft saat ini memiliki perubahan yang belum disimpan."}{" "}
                  Menerapkan template akan mengganti seluruh isi draft ini.
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
        </section>
        <aside
          id="editor-preview-aside"
          className="editor-preview-aside"
          aria-label="Pratinjau langsung"
          hidden={!previewAsideOpen}
        >
          <h2>Pratinjau langsung</h2>
          {renderPreview("aside")}
        </aside>

        <dialog
          ref={sectionDialogRef}
          className="editor-section-sheet"
          aria-labelledby="editor-section-sheet-heading"
          onClose={() => {
            const reason = sectionDialogRef.current?.returnValue;
            setSectionSheetOpen(false);
            if (reason !== "issue" && reason !== "preview") {
              sectionButtonRef.current?.focus();
            }
          }}
        >
          <div className="editor-dialog-heading">
            <h2 id="editor-section-sheet-heading">Bagian</h2>
            <button
              type="button"
              onClick={() => sectionDialogRef.current?.close()}
            >
              Tutup
            </button>
          </div>
          <div
            role="tablist"
            aria-label="Bagian dunia"
            aria-orientation="vertical"
            className="editor-section-tabs"
          >
            {renderSectionTabs("sheet")}
          </div>
        </dialog>

        <dialog
          ref={previewDialogRef}
          className="editor-preview-dialog"
          aria-labelledby="editor-preview-dialog-heading"
          onClose={() => {
            const reason = previewDialogRef.current?.returnValue;
            if (reason === "issue" || reason === "selection") return;
            setActiveSection(previewReturnSection.current);
            sectionButtonRef.current?.focus();
          }}
        >
          <div className="editor-dialog-heading">
            <h2 id="editor-preview-dialog-heading">Pratinjau dunia</h2>
            <button
              type="button"
              onClick={() => previewDialogRef.current?.close()}
            >
              Kembali ke editor
            </button>
          </div>
          {renderPreview("dialog")}
        </dialog>

        <dialog
          ref={discardDialogRef}
          className="editor-discard-dialog"
          onClose={() => {
            setPendingExit(null);
            backButtonRef.current?.focus();
          }}
        >
          <h2>
            {revision === null
              ? "Draft belum disimpan"
              : "Perubahan belum disimpan"}
          </h2>
          <p>
            {revision === null
              ? "Draft baru belum disimpan. Apa yang ingin kamu lakukan?"
              : "Ada perubahan pada draft yang belum disimpan. Apa yang dilakukan?"}
          </p>
          <div className="row">
            <button
              type="button"
              disabled={working}
              onClick={async () => {
                const navigate = pendingExit;
                const saved = await handleSave();
                setPendingExit(null);
                discardDialogRef.current?.close();
                if (saved) navigate?.();
              }}
            >
              Simpan & keluar
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => {
                const navigate = pendingExit;
                setPendingExit(null);
                discardDialogRef.current?.close();
                navigate?.();
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
  },
);
