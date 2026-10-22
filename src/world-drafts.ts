import { parseTemplate, type TemplateDraft } from "./template";
import type { GameDefinition } from "./types";

type DraftIdentity = Pick<GameDefinition, "id" | "updatedAt">;

function withNewDraftDefaults(draft: TemplateDraft): TemplateDraft {
  return {
    ...draft,
    ageRating: draft.ageRating ?? "teen-13-plus",
    scenario: {
      ...draft.scenario,
      narratorStyle: draft.scenario.narratorStyle ?? "cinematic-second-person",
      tempo: draft.scenario.tempo ?? "medium",
      turnLength: draft.scenario.turnLength ?? "medium",
      pointOfView: draft.scenario.pointOfView ?? "second-person",
    },
    player: { ...draft.player, pronoun: draft.player.pronoun ?? "neutral" },
  };
}

export function buildBlankDraft({
  id,
  updatedAt,
}: DraftIdentity): GameDefinition {
  return {
    id,
    updatedAt,
    title: "",
    description: "",
    ageRating: "teen-13-plus",
    scenario: {
      setting: "",
      startingSituation: "",
      narratorStyle: "cinematic-second-person",
      tempo: "medium",
      turnLength: "medium",
      pointOfView: "second-person",
    },
    attributes: [],
    resources: [],
    relationshipParties: [],
    relationships: [],
    items: [],
    player: { name: "", pronoun: "neutral", attributes: {}, resources: {} },
    npcs: [],
    startingInventory: [],
  };
}

export function buildBuiltinDraft(
  bundle: unknown,
  { id, updatedAt }: DraftIdentity,
): GameDefinition {
  const { draft } = parseTemplate(bundle);
  return { ...withNewDraftDefaults(draft), id, updatedAt };
}

export function buildSavedTemplateDraft(
  bundle: unknown,
  createIdentity: () => DraftIdentity,
): GameDefinition {
  const { draft } = parseTemplate(bundle);
  return { ...draft, ...createIdentity() };
}
