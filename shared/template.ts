import {
  ImportError,
  hasDangerousKeysDeep,
  pickGameDefinition,
  validateDefinition,
} from "./validation.js";
import {
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
  type AiConfig,
  type GameDefinition,
  type GameTemplateBundle,
} from "./types.js";

export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

export type TemplateDraft = Omit<GameDefinition, "id" | "updatedAt">;

export function exportTemplate(game: GameDefinition): GameTemplateBundle {
  const picked = pickGameDefinition(game);
  const draft: TemplateDraft = {
    title: picked.title,
    scenario: picked.scenario,
    attributes: picked.attributes,
    resources: picked.resources,
    relationships: picked.relationships,
    items: picked.items,
    player: picked.player,
    npcs: picked.npcs,
    startingInventory: picked.startingInventory,
  };
  if (picked.worldMap !== undefined) draft.worldMap = picked.worldMap;
  if (picked.startingLocationId !== undefined) {
    draft.startingLocationId = picked.startingLocationId;
  }
  if (picked.lorebookRefs !== undefined) {
    draft.lorebookRefs = picked.lorebookRefs;
  }
  if (picked.description !== undefined) draft.description = picked.description;
  if (picked.genre !== undefined) draft.genre = picked.genre;
  if (picked.tone !== undefined) draft.tone = picked.tone;
  if (picked.language !== undefined) draft.language = picked.language;
  if (picked.ageRating !== undefined) draft.ageRating = picked.ageRating;
  if (picked.relationshipParties !== undefined) {
    draft.relationshipParties = picked.relationshipParties;
  }
  const bundle: GameTemplateBundle = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString(),
    game: draft,
  };
  return bundle;
}

export function parseTemplate(raw: unknown): {
  draft: TemplateDraft;
  ai?: Pick<AiConfig, "provider" | "model">;
} {
  const problems: string[] = [];
  if (hasDangerousKeysDeep(raw)) {
    throw new ImportError(["File mengandung key berbahaya."]);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImportError(["File bukan JSON object."]);
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.format !== TEMPLATE_FORMAT) {
    problems.push(
      `Format tidak dikenal (ditemukan ${String(candidate.format)}). Template harus berformat ${TEMPLATE_FORMAT} versi ${TEMPLATE_VERSION}; save fworld-save dipulihkan lewat Settings.`,
    );
  }
  if (candidate.version !== TEMPLATE_VERSION) {
    problems.push(
      `Versi template tidak didukung (ditemukan ${String(candidate.version)}).`,
    );
  }
  if (
    !candidate.game ||
    typeof candidate.game !== "object" ||
    Array.isArray(candidate.game)
  ) {
    problems.push("Bagian game hilang atau bukan object.");
  }
  if (problems.length > 0) throw new ImportError(problems);

  if (
    candidate.ai !== undefined &&
    (typeof candidate.ai !== "object" ||
      candidate.ai === null ||
      Array.isArray(candidate.ai))
  ) {
    throw new ImportError(["Bagian ai harus object atau dihilangkan."]);
  }

  const game = pickGameDefinition({
    ...(candidate.game as Record<string, unknown>),
    id: "template",
    updatedAt: new Date().toISOString(),
  });
  const definitionErrors = validateDefinition(game);
  if (definitionErrors.length > 0) throw new ImportError(definitionErrors);

  const draft: TemplateDraft = {
    title: game.title,
    scenario: game.scenario,
    attributes: game.attributes,
    resources: game.resources,
    relationships: game.relationships,
    items: game.items,
    player: game.player,
    npcs: game.npcs,
    startingInventory: game.startingInventory,
  };
  if (game.worldMap !== undefined) draft.worldMap = game.worldMap;
  if (game.startingLocationId !== undefined) {
    draft.startingLocationId = game.startingLocationId;
  }
  if (game.lorebookRefs !== undefined) {
    draft.lorebookRefs = game.lorebookRefs;
  }
  if (game.description !== undefined) draft.description = game.description;
  if (game.genre !== undefined) draft.genre = game.genre;
  if (game.tone !== undefined) draft.tone = game.tone;
  if (game.language !== undefined) draft.language = game.language;
  if (game.ageRating !== undefined) draft.ageRating = game.ageRating;
  if (game.relationshipParties !== undefined) {
    draft.relationshipParties = game.relationshipParties;
  }

  const aiRaw = candidate.ai as Record<string, unknown> | undefined;
  let ai: AiConfig | undefined;
  if (aiRaw) {
    if (
      aiRaw.provider !== "gemini" &&
      aiRaw.provider !== "openrouter" &&
      aiRaw.provider !== "custom"
    ) {
      throw new ImportError([
        "ai.provider harus gemini, openrouter, atau custom.",
      ]);
    }
    if (typeof aiRaw.model !== "string") {
      throw new ImportError(["ai.model harus string."]);
    }
    ai = {
      provider: aiRaw.provider as AiConfig["provider"],
      model: aiRaw.model,
    };
  }

  return { draft, ai };
}
export function applyTemplateDraft(
  current: GameDefinition,
  template: TemplateDraft,
): GameDefinition {
  return {
    ...current,
    ...structuredClone(template),
    description: template.description,
    genre: template.genre,
    tone: template.tone,
    language: template.language,
    ageRating: template.ageRating,
    relationshipParties: template.relationshipParties,
    worldMap: template.worldMap,
    startingLocationId: template.startingLocationId,
    lorebookRefs: template.lorebookRefs,
  };
}
