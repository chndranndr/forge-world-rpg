import type {
  CheckRecord,
  ContextTelemetry,
  GameSession,
  LoreEntry,
  Message,
  NpcDefinition,
  ProviderId,
  StorySummary,
  WorldMap,
} from "../../shared/types.js";
import type { EffectContext } from "../../shared/engine.js";
import { sceneParticipants } from "../../shared/world.js";
import type { MovementCandidate } from "../../shared/world.js";
import { normalizeNarratorSystemPrompt } from "../../shared/narrator-prompt.js";

export type NarratorRunKind = "turn" | "opening" | "choices";

export type TokenEstimate = { approximateTokens: number; method: string };

export const KNOWLEDGE_FORMAT = "fworld-knowledge-v1";

export const MAX_CONTEXT_CHARS = 512_000;
export const MAX_CONTEXT_TOKENS = 128_000;
export const MAX_ACTION_CHARS = 8_000;
export const MAX_RECENT_MESSAGES = 24;
export const MAX_REPAIR_TEXT_CHARS = 8_000;

const SECTION_CHAR_LIMITS = {
  npcProfiles: 4_500,
  npcIdentities: 1_200,
  relationships: 2_000,
  inventory: 1_800,
  facts: 1_800,
  npcKnowledge: 1_800,
  summaries: 2_000,
  lore: 2_600,
  history: 3_600,
};

export interface NarratorContextInput {
  session: GameSession;
  history: Message[];
  kind: NarratorRunKind;
  playerAction: string;
  worldMap?: WorldMap;
  movement?: MovementCandidate;
  lore?: LoreEntry[];
  storySummaries?: StorySummary[];
  effectContext?: EffectContext;
  estimateTokens?: (
    chars: number,
    provider: ProviderId,
    model: string,
  ) => TokenEstimate;
}

export interface PreparedNarratorContext {
  system: string;
  prompt: string;
  stablePrompt: string;
  dynamicPrompt: string;
  audience: { kind: "player" } | { kind: "npc"; npcId: string };
  telemetry: ContextTelemetry;
}

export class NarratorContextError extends Error {
  constructor(
    readonly actualChars: number,
    readonly maxChars: number,
    readonly approximateTokens: number,
    readonly maxTokens: number,
    readonly telemetry?: ContextTelemetry,
  ) {
    super(
      `Konteks wajib berisi ${actualChars} karakter dan sekitar ${approximateTokens} token; batasnya ${maxChars} karakter dan ${maxTokens} token. Ringkas konfigurasi game atau aksi pemain.`,
    );
    this.name = "NarratorContextError";
  }
}

const DIRECT_ADDRESS_ACTION =
  /^(?:(?:(?:i|we|you|saya|aku)\s+)?(?:(?:please|tolong|privately|quietly|softly|gently|secara\s+pribadi|dengan\s+pelan)\s+)*(?:(?:want\s+to|would\s+like\s+to|mau|ingin)\s+)?(?:(?:am|are|is)\s+)?(?:ask|asks|asking|tell|tells|telling|say|says|saying|speak|speaks|speaking|talk|talks|talking|whisper|whispers|whispering|question|questions|questioning|discuss|discusses|discussing|greet|greets|greeting|berbicara|bicara|bertanya|menanyakan|tanya|tanyakan|berbisik|bisik|mengatakan|katakan|ucapkan|berdiskusi|diskusikan|menyapa|sapa|(?:memberi|beri)\s+tahu)(?:\s+(?:privately|quietly|softly|gently|secara\s+pribadi))?(?:\s+(?:to|with|kepada|pada|dengan))?)\s*$/u;

function isExplicitlyAddressed(text: string, identity: string): boolean {
  const haystack = text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
  const needle = identity
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
  if (!needle) return false;

  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const end = index + needle.length;
    const before = haystack.slice(0, index);
    const after = haystack.slice(end);
    const left = haystack[index - 1];
    const right = haystack[end];
    const possessive = /^(?:'s|’s)\b/u.test(after);
    if (
      !possessive &&
      (left === undefined || !/[\p{L}\p{N}_]/u.test(left)) &&
      (right === undefined || !/[\p{L}\p{N}_]/u.test(right))
    ) {
      const prefix = before.trim();
      if (
        /^(?:(?:hey|hi|hello|halo|hai)\s*,?\s*)?$/u.test(prefix) &&
        /^[,:!](?:\s|$)/u.test(after)
      ) {
        return true;
      }
      if (DIRECT_ADDRESS_ACTION.test(before)) return true;
    }
    offset = index + 1;
  }
  return false;
}

function narratorSceneLocationId(
  session: GameSession,
  worldMap: WorldMap | undefined,
  movement: MovementCandidate | undefined,
): string | undefined {
  const locationId = session.state.world.locationId;
  if (
    movement?.kind === "allowed" &&
    movement.fromId === locationId &&
    worldMap?.locations.some(({ id }) => id === movement.toId)
  ) {
    return movement.toId;
  }
  return locationId;
}

export function narratorParticipants(
  session: GameSession,
  worldMap = session.worldMap,
  locationId = session.state.world.locationId,
): string[] {
  const { definitionSnapshot: definition, state } = session;
  const knownNpcIds = definition.npcs.map((npc) => npc.id);
  const known = new Set(knownNpcIds);
  const ids = worldMap
    ? sceneParticipants(
        worldMap,
        locationId,
        state.world.npcPresence,
        knownNpcIds,
      )
    : state.world.activeCharacters.filter(
        (id) => id === "player" || known.has(id),
      );
  return [...new Set(["player", ...ids])].slice(0, 7);
}

export interface NarratorScene {
  locationId: string | undefined;
  principalNpcId: string | undefined;
}

export function resolveNarratorScene(
  session: GameSession,
  playerAction: string,
  worldMap: WorldMap | undefined,
  movement: MovementCandidate | undefined,
): NarratorScene {
  const originId = session.state.world.locationId;
  const destinationId = narratorSceneLocationId(session, worldMap, movement);
  const addressedAt = (locationId: string | undefined) => {
    const localNpcIds = new Set(
      narratorParticipants(session, worldMap, locationId),
    );
    const addressed = session.definitionSnapshot.npcs.filter(
      (npc) =>
        localNpcIds.has(npc.id) &&
        (isExplicitlyAddressed(playerAction, npc.id) ||
          isExplicitlyAddressed(playerAction, npc.name)),
    );
    return addressed.length === 1 ? addressed[0].id : undefined;
  };
  const destinationPrincipal = addressedAt(destinationId);
  if (destinationPrincipal !== undefined || destinationId === originId) {
    return { locationId: destinationId, principalNpcId: destinationPrincipal };
  }
  // "Ask Aiko, then travel" keeps the departure-scene principal; the arrival
  // scene wins for everything else so destination NPCs stay addressable.
  const originPrincipal = addressedAt(originId);
  return originPrincipal === undefined
    ? { locationId: destinationId, principalNpcId: undefined }
    : { locationId: originId, principalNpcId: originPrincipal };
}

export function selectPrincipalNpc(
  session: GameSession,
  playerAction: string,
  worldMap = session.worldMap,
  movement?: MovementCandidate,
): string | undefined {
  return resolveNarratorScene(session, playerAction, worldMap, movement)
    .principalNpcId;
}

function movementContext(movement: MovementCandidate | undefined) {
  if (!movement) return undefined;
  switch (movement.kind) {
    case "allowed":
      return {
        kind: movement.kind,
        fromId: movement.fromId,
        toId: movement.toId,
      };
    case "blocked":
      return {
        kind: movement.kind,
        fromId: movement.fromId,
        toId: movement.toId,
      };
    case "ambiguous":
      return { kind: movement.kind, ids: movement.ids };
    case "unknown":
      return { kind: movement.kind, fromId: movement.fromId };
    case "legacy":
    case "none":
      return { kind: movement.kind };
    default: {
      const exhaustive: never = movement;
      return exhaustive;
    }
  }
}

function truncateText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  return value === undefined ? undefined : value.slice(0, maxChars);
}

export function npcContext(npc: NpcDefinition) {
  return {
    id: npc.id,
    name: npc.name,
    ...(npc.description === undefined
      ? {}
      : { description: truncateText(npc.description, 400) }),
    personality: npc.personality
      .slice(0, 4)
      .map((value) => value.slice(0, 200)),
    ...(npc.background === undefined
      ? {}
      : { background: truncateText(npc.background, 400) }),
    ...(npc.role === undefined ? {} : { role: truncateText(npc.role, 200) }),
    ...(npc.voice === undefined ? {} : { voice: truncateText(npc.voice, 400) }),
    goals: npc.goals.slice(0, 3).map((value) => value.slice(0, 200)),
    ...(npc.attributes === undefined
      ? {}
      : {
          attributes: Object.fromEntries(
            Object.entries(npc.attributes).slice(0, 24),
          ),
        }),
  };
}

const RELEVANCE_STOP_WORDS: Record<string, true> = {
  about: true,
  after: true,
  again: true,
  aku: true,
  and: true,
  apa: true,
  atau: true,
  bisa: true,
  buat: true,
  dari: true,
  dengan: true,
  dia: true,
  do: true,
  for: true,
  from: true,
  i: true,
  in: true,
  ini: true,
  itu: true,
  ke: true,
  kan: true,
  karena: true,
  kepadanya: true,
  kita: true,
  look: true,
  me: true,
  menuju: true,
  my: true,
  of: true,
  on: true,
  pada: true,
  pergi: true,
  please: true,
  saya: true,
  sebuah: true,
  the: true,
  to: true,
  untuk: true,
  yang: true,
};

function actionTerms(action: string): string[] {
  return [
    ...new Set(
      (
        action
          .normalize("NFKC")
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}_-]+/gu) ?? []
      ).filter((token) => token.length > 2 && !RELEVANCE_STOP_WORDS[token]),
    ),
  ];
}

function relevance(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

type PromptLoreEntry =
  | { id: string; discoveryCandidate: true }
  | {
      id: string;
      kind: string;
      name: string;
      summary: string;
      body: string;
      tags: string[];
    };

const EMPTY_DISCOVERY_HANDLES: ReadonlyMap<string, string> = new Map<
  string,
  string
>();

const REGISTER_ITEM_INSTRUCTIONS = [
  "Dynamic items: REGISTER_ITEM creates one session-local item definition and immediately grants quantity copies to the player inventory. Its effects are stored now and validated only when the player uses the item, so registration itself changes no stat, resource, fact, or flag.",
  'Payload: {"type":"REGISTER_ITEM","id":"item-<slug>","name":"...","description":"...","stackable":false,"maxStack":3,"consumable":true,"effects":[],"tags":["dokumen"],"quantity":1}.',
  "Required fields: type, id, name, stackable, consumable, effects, tags, quantity. Optional fields: description and maxStack. effects and tags must be arrays and may be empty; quantity and maxStack are integers of at least 1. Effects use the existing effect shapes only; never invent an effect type.",
  "Generate a fresh unused lowercase ASCII id from the name as a slug prefixed with item- (for example item-surat-rekomendasi, at most 128 characters) and add a numeric suffix on conflict. Never reuse an id already used by the player, game, stat, resource, relationship, NPC, relationship party, location, or item.",
  "Register an item only when the story has just established that the player receives something whose exact id is not in the session snapshot. If the snapshot already contains that id, use ADD_ITEM with that id instead of a second definition; a duplicate name is rejected and the error names the existing id. Do not nest REGISTER_ITEM or REGISTER_NPC inside effects.",
  "Description, tags, and effects must describe properties already established by the story, never arbitrary rewards. Every effect target must already exist in the snapshot or current context: stats, resources, relationships, NPCs, inventory items, declared flags, and lore ids shown as discovery candidates or already discovered.",
].join("\n");

const NPC_REENCOUNTER_INSTRUCTIONS = [
  "Off-scene NPCs: knownNpcIdentities, when present, lists only the id and name of characters the player met earlier who are currently outside this scene. A name in that list does not put the character in the scene and does not make the character nearby, watching, or reachable; never place that character in the current scene from a mention alone, and never reveal or infer their location, private knowledge, relationships, or other details that are not in this context. get_npc_details still answers only for the server-selected interlocutor.",
  'Only when the current story itself establishes that one listed character actually joins the scene the player is in, emit {"type":"NPC_PRESENCE","npcId":"<id>","present":true} with an exact listed id. Leave the effect out for a character who is merely mentioned, remembered, contacted remotely, or already in activeCharacters.',
  "If the most recent narration of this scene already places one listed character here, emit that effect once in this turn so the saved scene matches the story, even when the player's action does not mention them again.",
].join("\n");

const EFFECT_CONTRACT_INSTRUCTIONS = [
  'Effect contract: operation must be exactly "ADD", "SUBTRACT", or "SET" in uppercase. Every target must be an existing id from this context, never a display name or a translation: relationship targets use the ids shown in state.relationships, attributes use the game attribute ids, and NPC effects use npc ids.',
].join("\n");

function effectiveNarratorSystem(input: NarratorContextInput): string {
  const stored = normalizeNarratorSystemPrompt(input.session.ai.systemPrompt);
  if (input.kind !== "turn") return stored;
  return `${stored}\n\n${EFFECT_CONTRACT_INSTRUCTIONS}\n\n${REGISTER_ITEM_INSTRUCTIONS}\n\n${NPC_REENCOUNTER_INSTRUCTIONS}`;
}

export function buildNarratorContext(
  input: NarratorContextInput,
  discoveryHandlesByLoreId: ReadonlyMap<
    string,
    string
  > = EMPTY_DISCOVERY_HANDLES,
  discoveryLoreIdsByHandle: ReadonlyMap<
    string,
    string
  > = EMPTY_DISCOVERY_HANDLES,
): PreparedNarratorContext {
  const system = effectiveNarratorSystem(input);
  if (input.playerAction.length > MAX_ACTION_CHARS) {
    throw new Error(`Aksi pemain melebihi batas ${MAX_ACTION_CHARS} karakter.`);
  }
  const candidateHistory = input.history.slice(-MAX_RECENT_MESSAGES);
  if (
    candidateHistory.some((message) => message.sessionId !== input.session.id)
  ) {
    throw new Error("History memuat pesan dari session lain.");
  }

  const session = input.session;
  const definition = session.definitionSnapshot;
  const state = session.state;
  const scene = resolveNarratorScene(
    session,
    input.playerAction,
    input.worldMap,
    input.movement,
  );
  const principalNpcId = scene.principalNpcId;
  const history = candidateHistory.filter(
    (message) =>
      message.visibility === "public" ||
      (message.visibility === "private" &&
        message.knownBy?.includes(principalNpcId ?? "player")) ||
      (!principalNpcId && message.visibility === undefined),
  );
  const participants = narratorParticipants(
    session,
    input.worldMap,
    scene.locationId,
  );
  const participantNpcIds = participants.filter((id) => id !== "player");
  const localNpcs = definition.npcs.filter((npc) =>
    participantNpcIds.includes(npc.id),
  );
  const sceneNpcIds = new Set(participantNpcIds);
  const knownNpcIdentityCandidates = Object.keys(state.world.npcPresence ?? {})
    .filter((npcId) => !sceneNpcIds.has(npcId))
    .flatMap((npcId) => {
      const npc = definition.npcs.find((candidate) => candidate.id === npcId);
      return npc ? [{ id: npc.id, name: npc.name.slice(0, 200) }] : [];
    });
  const knownNpcIdentities: Array<{ id: string; name: string }> = [];
  const selectedWorldFlags = Object.fromEntries(
    Object.entries(state.world.flags ?? {}).slice(0, 64),
  );
  const selectedDiscoveredLoreIds = (state.world.discoveredLoreIds ?? []).slice(
    0,
    64,
  );
  const selectedNpcPresence = Object.fromEntries(
    participantNpcIds.flatMap((npcId) => {
      const presence = state.world.npcPresence?.[npcId];
      return presence === undefined ? [] : [[npcId, presence]];
    }),
  );
  const worldContextOmitted =
    Math.max(
      0,
      Object.keys(state.world.flags ?? {}).length -
        Object.keys(selectedWorldFlags).length,
    ) +
    Math.max(
      0,
      (state.world.discoveredLoreIds ?? []).length -
        selectedDiscoveredLoreIds.length,
    ) +
    Math.max(
      0,
      Object.keys(state.world.npcPresence ?? {}).length -
        Object.keys(selectedNpcPresence).length,
    );
  const terms = actionTerms(input.playerAction);
  const selectedAttributes = definition.attributes.slice(0, 64);
  const selectedResources = definition.resources.slice(0, 64);
  const principalNpc = principalNpcId
    ? definition.npcs.find((npc) => npc.id === principalNpcId)
    : undefined;
  const principalFacts = principalNpcId
    ? state.facts.filter(
        (fact) =>
          fact.visibility === "private" &&
          fact.knownBy.includes(principalNpcId),
      )
    : [];
  const factsForContext = state.facts
    .filter((fact) => {
      if (!terms.length) return false;
      if (fact.visibility === "public") return true;
      if (principalNpcId) return fact.knownBy.includes(principalNpcId);
      return fact.knownBy.includes("player") || fact.knownBy.length === 0;
    })
    .map((fact) => ({
      fact,
      score: relevance(fact.text, terms),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.fact.createdAt.localeCompare(a.fact.createdAt) ||
        a.fact.id.localeCompare(b.fact.id),
    )
    .slice(0, 24);
  const relationshipParties = definition.relationshipParties;
  const partyContextOmitted = Math.max(
    0,
    (relationshipParties?.length ?? 0) - 32,
  );
  const turnLengthWordRange =
    definition.scenario.turnLength === undefined
      ? undefined
      : {
          short: "80–120",
          medium: "150–220",
          long: "250–350",
        }[definition.scenario.turnLength];
  const hasNarrativeGuidance =
    definition.scenario.narratorStyle !== undefined ||
    definition.scenario.tempo !== undefined ||
    definition.scenario.turnLength !== undefined ||
    definition.scenario.pointOfView !== undefined;
  const narrativeGuidance = hasNarrativeGuidance
    ? {
        pointOfView:
          definition.scenario.pointOfView ??
          (definition.scenario.narratorStyle === "literary-third-person"
            ? "limited-third-person"
            : "second-person"),
        pointOfViewSource:
          definition.scenario.pointOfView === undefined
            ? "style-default"
            : "explicit",
        ...(turnLengthWordRange === undefined
          ? {}
          : { approximateWordCount: turnLengthWordRange }),
        rule: "Explicit pointOfView overrides the person implied by style; style controls prose tone.",
      }
    : undefined;

  const context = {
    game: {
      title: definition.title,
      description: definition.description,
      genre: definition.genre,
      tone: definition.tone,
      language: definition.language,
      ...(definition.ageRating === undefined
        ? {}
        : { ageRating: definition.ageRating }),
      ...(relationshipParties === undefined
        ? {}
        : {
            relationshipParties: relationshipParties
              .slice(0, 32)
              .map((party) => ({
                id: party.id,
                name: party.name.slice(0, 200),
                type: party.type.slice(0, 200),
                initialStance: party.initialStance,
                ...(principalNpcId || party.secret === undefined
                  ? {}
                  : { secret: party.secret.slice(0, 600) }),
              })),
          }),
    },
    scenario: {
      setting: definition.scenario.setting,
      startingSituation: definition.scenario.startingSituation,
      worldRules: definition.scenario.worldRules,
      tone: definition.scenario.tone,
      genre: definition.scenario.genre,
      additionalContext: definition.scenario.additionalContext,
      ...(definition.scenario.trigger === undefined
        ? {}
        : { trigger: truncateText(definition.scenario.trigger, 1200) }),
      ...(definition.scenario.narratorStyle === undefined
        ? {}
        : { narratorStyle: definition.scenario.narratorStyle }),
      ...(definition.scenario.tempo === undefined
        ? {}
        : { tempo: definition.scenario.tempo }),
      ...(definition.scenario.turnLength === undefined
        ? {}
        : { turnLength: definition.scenario.turnLength }),
      ...(definition.scenario.pointOfView === undefined
        ? {}
        : { pointOfView: definition.scenario.pointOfView }),
      ...(definition.scenario.contentLimits === undefined
        ? {}
        : {
            contentLimits: truncateText(
              definition.scenario.contentLimits,
              1200,
            ),
          }),
      ...(narrativeGuidance === undefined ? {} : { narrativeGuidance }),
    },
    player: {
      name: definition.player.name,
      description: definition.player.description,
      background: definition.player.background,
      personality: definition.player.personality,
      notes: definition.player.notes,
      ...(definition.player.role === undefined
        ? {}
        : { role: truncateText(definition.player.role, 200) }),
      ...(definition.player.pronoun === undefined
        ? {}
        : { pronoun: definition.player.pronoun }),
      ...(definition.player.age === undefined
        ? {}
        : { age: truncateText(definition.player.age, 80) }),
      ...(definition.player.goal === undefined
        ? {}
        : { goal: truncateText(definition.player.goal, 500) }),
      ...(definition.player.fear === undefined
        ? {}
        : { fear: truncateText(definition.player.fear, 500) }),
    },
    actorScope: principalNpcId
      ? { kind: "npc", npcId: principalNpcId }
      : { kind: "player-narrator" },
    state: {
      attributes: selectedAttributes.map(({ id, name }) => ({
        id,
        name,
        value: state.attributes[id],
      })),
      resources: selectedResources.map(({ id, name }) => ({
        id,
        name,
        value: state.resources[id],
      })),
      relationships: [] as Array<{
        npcId: string;
        id: string;
        name: string;
        value: number | undefined;
      }>,
      inventory: [] as Array<Record<string, unknown>>,
      facts: {
        public: [] as Array<{ id: string; text: string }>,
        playerKnown: [] as Array<{ id: string; text: string }>,
        narratorOnly: [] as Array<{ id: string; text: string }>,
      },
      world: {
        location: state.world.location,
        locationId: state.world.locationId,
        time: state.world.time,
        scene: state.world.scene,
        activeCharacters: participants,
        flags: selectedWorldFlags,
        discoveredLoreIds: selectedDiscoveredLoreIds,
        npcPresence: selectedNpcPresence,
        movement: movementContext(input.movement),
      },
    },
    activeNpcs: [] as Array<Record<string, unknown>>,
    ...(knownNpcIdentityCandidates.length ? { knownNpcIdentities } : {}),
    npcKnowledge: principalNpc
      ? {
          npcId: principalNpc.id,
          privateKnowledge: [] as string[],
          privateFactsKnown: [] as Array<{ id: string; text: string }>,
        }
      : null,
    summaries: [] as Array<{
      fromSequence: number;
      toSequence: number;
      summary: string;
    }>,
    lore: [] as PromptLoreEntry[],
  };

  const recentMessages: Array<Record<string, unknown>> = [];
  const stablePrompt = JSON.stringify({
    format: KNOWLEDGE_FORMAT,
    context: {
      game: context.game,
      scenario: context.scenario,
      player: context.player,
    },
  });
  const promptObject = () => ({
    kind: input.kind,
    playerAction: input.playerAction,
    context,
    recentMessages,
  });
  const dynamicObject = () => {
    const { game, scenario, player, ...dynamicContext } = context;
    void game;
    void scenario;
    void player;
    return {
      kind: input.kind,
      playerAction: input.playerAction,
      context: { ...dynamicContext, knowledgeFormat: KNOWLEDGE_FORMAT },
      recentMessages,
    };
  };
  let partitionExtra = 0;
  let partitionMeasured = false;
  const measure = () => {
    const prompt = JSON.stringify(promptObject());
    if (!partitionMeasured) {
      const dynamic = JSON.stringify(dynamicObject());
      partitionExtra = Math.max(
        0,
        stablePrompt.length - (prompt.length - dynamic.length),
      );
      partitionMeasured = true;
    }
    const contextChars = system.length + prompt.length + partitionExtra;
    const estimate = input.estimateTokens?.(
      contextChars,
      session.ai.provider,
      session.ai.model,
    ) ?? {
      approximateTokens: Math.ceil(contextChars / 4),
      method: "chars-per-4",
    };
    return { prompt, contextChars, ...estimate };
  };
  const sections: ContextTelemetry["sections"] = {};
  const omissions: string[] = [];
  if (partyContextOmitted > 0) omissions.push("limit.relationshipParties");
  if (
    Object.keys(state.world.flags ?? {}).length >
    Object.keys(selectedWorldFlags).length
  ) {
    omissions.push("limit.worldFlags");
  }
  if (
    (state.world.discoveredLoreIds ?? []).length >
    selectedDiscoveredLoreIds.length
  ) {
    omissions.push("limit.discoveredLore");
  }
  if (
    Object.keys(state.world.npcPresence ?? {}).length >
    Object.keys(selectedNpcPresence).length
  ) {
    omissions.push("scope.npcPresence");
  }
  if (input.history.length > candidateHistory.length)
    omissions.push("limit.history");
  if (candidateHistory.length > history.length) omissions.push("scope.history");
  const record = (
    name: string,
    chars: number,
    count: number,
    omitted: number,
  ) => {
    sections[name] = { chars, count, omitted };
    if (omitted > 0) omissions.push(`budget.${name}`);
  };
  const addCandidates = <T>(
    name: string,
    target: T[],
    candidates: T[],
    maxChars: number,
  ) => {
    let added = 0;
    let omitted = 0;
    for (const candidate of candidates) {
      const currentChars = JSON.stringify(target).length;
      const candidateChars = JSON.stringify(candidate).length + 1;
      if (currentChars + candidateChars > maxChars) {
        omitted += 1;
        continue;
      }
      target.push(candidate);
      const measured = measure();
      if (
        measured.contextChars > MAX_CONTEXT_CHARS ||
        measured.approximateTokens > MAX_CONTEXT_TOKENS
      ) {
        target.pop();
        omitted += 1;
        continue;
      }
      added += 1;
    }
    record(name, JSON.stringify(target).length, added, omitted);
  };

  const mandatory = measure();
  const mandatoryTelemetry = (): ContextTelemetry => ({
    contextChars: mandatory.contextChars,
    approximateTokens: mandatory.approximateTokens,
    tokenEstimateMethod: mandatory.method,
    sections: {
      core: {
        chars: JSON.stringify({
          game: context.game,
          scenario: context.scenario,
        }).length,
        count: 2,
        omitted: 0,
      },
      player: {
        chars: JSON.stringify(context.player).length,
        count: 1,
        omitted: 0,
      },
      state: {
        chars: JSON.stringify({
          attributes: context.state.attributes,
          resources: context.state.resources,
        }).length,
        count: context.state.attributes.length + context.state.resources.length,
        omitted:
          Math.max(
            0,
            definition.attributes.length - selectedAttributes.length,
          ) +
          Math.max(0, definition.resources.length - selectedResources.length),
      },
      world: {
        chars: JSON.stringify(context.state.world).length,
        count: 1,
        omitted: worldContextOmitted,
      },
      action: {
        chars: input.playerAction.length,
        count: input.playerAction ? 1 : 0,
        omitted: 0,
      },
    },
    selectedLoreIds: [],
    omissions: [
      ...omissions,
      ...(definition.attributes.length > selectedAttributes.length
        ? ["limit.attributes"]
        : []),
      ...(definition.resources.length > selectedResources.length
        ? ["limit.resources"]
        : []),
    ],
    toolCalls: 0,
    repairs: 0,
  });
  if (
    mandatory.contextChars > MAX_CONTEXT_CHARS ||
    mandatory.approximateTokens > MAX_CONTEXT_TOKENS
  ) {
    const telemetry = mandatoryTelemetry();
    throw new NarratorContextError(
      mandatory.contextChars,
      MAX_CONTEXT_CHARS,
      mandatory.approximateTokens,
      MAX_CONTEXT_TOKENS,
      telemetry,
    );
  }

  const profileCandidates = localNpcs.map((npc) => npcContext(npc));
  addCandidates(
    "npcProfiles",
    context.activeNpcs,
    profileCandidates,
    SECTION_CHAR_LIMITS.npcProfiles,
  );
  if (knownNpcIdentityCandidates.length) {
    addCandidates(
      "npcIdentities",
      knownNpcIdentities,
      knownNpcIdentityCandidates,
      SECTION_CHAR_LIMITS.npcIdentities,
    );
    if (knownNpcIdentities.length === 0) {
      Reflect.deleteProperty(context, "knownNpcIdentities");
    }
  }

  const relationshipNpc = principalNpcId
    ? localNpcs.filter((npc) => npc.id === principalNpcId)
    : [];
  const relationshipCandidates = relationshipNpc.flatMap((npc) => {
    const values =
      state.relationships.find((entry) => entry.npcId === npc.id)?.values ?? {};
    return definition.relationships.slice(0, 64).map((relationship) => ({
      npcId: npc.id,
      id: relationship.id,
      name: relationship.name,
      value: values[relationship.id],
    }));
  });
  addCandidates(
    "relationships",
    context.state.relationships,
    relationshipCandidates,
    SECTION_CHAR_LIMITS.relationships,
  );

  const inventoryCandidates = state.inventory.slice(0, 64).flatMap((entry) => {
    const item = definition.items.find(
      (candidate) => candidate.id === entry.itemId,
    );
    return item
      ? [
          {
            id: item.id,
            name: item.name,
            description: truncateText(item.description, 300),
            tags: item.tags.slice(0, 8),
            quantity: entry.quantity,
            stackable: item.stackable,
            ...(entry.owner === undefined
              ? {}
              : { owner: truncateText(entry.owner, 200) }),
            ...(entry.place === undefined
              ? {}
              : { place: truncateText(entry.place, 200) }),
            consumable: item.consumable,
          },
        ]
      : [];
  });
  addCandidates(
    "inventory",
    context.state.inventory,
    inventoryCandidates,
    SECTION_CHAR_LIMITS.inventory,
  );
  if (state.inventory.length > inventoryCandidates.length) {
    omissions.push("limit.inventory");
  }

  const publicFacts = factsForContext
    .filter(({ fact }) => fact.visibility === "public")
    .map(({ fact }) => ({ id: fact.id, text: fact.text.slice(0, 600) }));
  addCandidates(
    "facts",
    context.state.facts.public,
    publicFacts,
    SECTION_CHAR_LIMITS.facts,
  );
  if (principalNpcId) {
    const knownFacts = principalFacts
      .map((fact) => ({ fact, score: relevance(fact.text, terms) }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.fact.createdAt.localeCompare(a.fact.createdAt) ||
          a.fact.id.localeCompare(b.fact.id),
      )
      .slice(0, 12)
      .map(({ fact }) => ({ id: fact.id, text: fact.text.slice(0, 600) }));
    addCandidates(
      "npcKnowledge",
      context.npcKnowledge?.privateFactsKnown ?? [],
      knownFacts,
      SECTION_CHAR_LIMITS.npcKnowledge,
    );
    const privateKnowledge = (principalNpc?.privateKnowledge ?? [])
      .slice(0, 12)
      .map((text) => text.slice(0, 600));
    if (context.npcKnowledge) {
      const privateCandidates = privateKnowledge;
      let added = 0;
      let omitted = 0;
      for (const knowledge of privateCandidates) {
        const values = context.npcKnowledge.privateKnowledge;
        if (
          JSON.stringify(context.npcKnowledge).length +
            JSON.stringify(knowledge).length >
          SECTION_CHAR_LIMITS.npcKnowledge
        ) {
          omitted += 1;
          continue;
        }
        values.push(knowledge);
        const measured = measure();
        if (
          measured.contextChars > MAX_CONTEXT_CHARS ||
          measured.approximateTokens > MAX_CONTEXT_TOKENS
        ) {
          values.pop();
          omitted += 1;
          continue;
        }
        added += 1;
      }
      sections.npcPrivateKnowledge = {
        chars: JSON.stringify(context.npcKnowledge.privateKnowledge).length,
        count: added,
        omitted,
      };
      if (omitted) omissions.push("budget.npcPrivateKnowledge");
    }
  } else {
    const playerKnown = factsForContext
      .filter(
        ({ fact }) =>
          fact.visibility === "private" && fact.knownBy.includes("player"),
      )
      .map(({ fact }) => ({ id: fact.id, text: fact.text.slice(0, 600) }));
    const narratorOnly = factsForContext
      .filter(
        ({ fact }) =>
          fact.visibility === "private" && fact.knownBy.length === 0,
      )
      .map(({ fact }) => ({ id: fact.id, text: fact.text.slice(0, 600) }));
    addCandidates(
      "playerKnownFacts",
      context.state.facts.playerKnown,
      playerKnown,
      900,
    );
    addCandidates(
      "narratorOnlyFacts",
      context.state.facts.narratorOnly,
      narratorOnly,
      900,
    );
  }

  const summaryCandidates = (input.storySummaries ?? [])
    .filter(
      (summary) =>
        summary.visibility === "public" ||
        (summary.visibility === "private" &&
          summary.knownBy.includes(principalNpcId ?? "player")),
    )
    .slice(0, 12)
    .map((summary) => ({
      fromSequence: summary.fromSequence,
      toSequence: summary.toSequence,
      summary: summary.summary.slice(0, 800),
    }));
  addCandidates(
    "summaries",
    context.summaries,
    summaryCandidates,
    SECTION_CHAR_LIMITS.summaries,
  );

  const discoveredLoreIds = new Set(state.world.discoveredLoreIds ?? []);
  const loreCandidates = (input.lore ?? [])
    .filter(
      (entry) =>
        entry.visibility !== "discovery" ||
        discoveredLoreIds.has(entry.id) ||
        discoveryHandlesByLoreId.has(entry.id),
    )
    .slice(0, 24)
    .map<PromptLoreEntry>((entry) => {
      const handle =
        entry.visibility === "discovery" && !discoveredLoreIds.has(entry.id)
          ? discoveryHandlesByLoreId.get(entry.id)
          : undefined;
      return handle === undefined
        ? {
            id: entry.id,
            kind: entry.kind,
            name: entry.name.slice(0, 200),
            summary: entry.summary.slice(0, 500),
            body: entry.body.slice(0, 800),
            tags: entry.tags.slice(0, 8).map((tag) => tag.slice(0, 100)),
          }
        : { id: handle, discoveryCandidate: true };
    });
  addCandidates("lore", context.lore, loreCandidates, SECTION_CHAR_LIMITS.lore);

  let historyOmitted = 0;
  for (const message of history.reverse()) {
    const entry = {
      role: message.role,
      ...(message.speakerId
        ? {
            speaker:
              definition.npcs.find((npc) => npc.id === message.speakerId)
                ?.name ?? message.speakerId,
          }
        : {}),
      content: message.content.slice(0, 1_200),
      ...(message.check ? { check: message.check } : {}),
    };
    recentMessages.unshift(entry);
    const measured = measure();
    if (
      JSON.stringify(recentMessages).length > SECTION_CHAR_LIMITS.history ||
      measured.contextChars > MAX_CONTEXT_CHARS ||
      measured.approximateTokens > MAX_CONTEXT_TOKENS
    ) {
      recentMessages.shift();
      break;
    }
  }
  historyOmitted = history.length - recentMessages.length;
  record(
    "history",
    JSON.stringify(recentMessages).length,
    recentMessages.length,
    historyOmitted,
  );

  const measured = measure();
  const dynamicPrompt = JSON.stringify(dynamicObject());
  const logicalChars =
    Math.max(
      measured.prompt.length,
      stablePrompt.length + dynamicPrompt.length,
    ) + system.length;
  const finalEstimate = input.estimateTokens?.(
    logicalChars,
    session.ai.provider,
    session.ai.model,
  ) ?? {
    approximateTokens: Math.ceil(logicalChars / 4),
    method: "chars-per-4",
  };
  const telemetry: ContextTelemetry = {
    contextChars: logicalChars,
    approximateTokens: finalEstimate.approximateTokens,
    tokenEstimateMethod: finalEstimate.method,
    sections: {
      core: {
        chars: JSON.stringify({
          game: context.game,
          scenario: context.scenario,
        }).length,
        count: 2,
        omitted: 0,
      },
      player: {
        chars: JSON.stringify(context.player).length,
        count: 1,
        omitted: 0,
      },
      state: {
        chars: JSON.stringify({
          attributes: context.state.attributes,
          resources: context.state.resources,
        }).length,
        count: context.state.attributes.length + context.state.resources.length,
        omitted:
          Math.max(
            0,
            definition.attributes.length - selectedAttributes.length,
          ) +
          Math.max(0, definition.resources.length - selectedResources.length),
      },
      world: {
        chars: JSON.stringify(context.state.world).length,
        count: 1,
        omitted: worldContextOmitted,
      },
      action: {
        chars: input.playerAction.length,
        count: input.playerAction ? 1 : 0,
        omitted: 0,
      },
      ...sections,
    },
    selectedLoreIds: context.lore.map(
      (entry) => discoveryLoreIdsByHandle.get(entry.id) ?? entry.id,
    ),
    omissions: [
      ...new Set([
        ...omissions,
        ...(definition.attributes.length > selectedAttributes.length
          ? ["limit.attributes"]
          : []),
        ...(definition.resources.length > selectedResources.length
          ? ["limit.resources"]
          : []),
      ]),
    ],
    toolCalls: 0,
    repairs: 0,
  };
  return {
    system,
    prompt: measured.prompt,
    stablePrompt,
    dynamicPrompt,
    audience: principalNpcId
      ? { kind: "npc", npcId: principalNpcId }
      : { kind: "player" },
    telemetry,
  };
}

export function buildNarratorRepair(
  originalPrompt: string,
  previousResponse: string,
  reason: string,
  check: CheckRecord | undefined,
  input: NarratorContextInput,
  baseTelemetry: ContextTelemetry,
): { prompt: string; telemetry: ContextTelemetry } {
  const system = effectiveNarratorSystem(input);
  const base = JSON.parse(originalPrompt) as Record<string, unknown>;
  const recent = Array.isArray(base.recentMessages)
    ? [...base.recentMessages]
    : [];
  const correction = {
    reason: reason.slice(0, 1_000),
    previousResponse: previousResponse.slice(0, MAX_REPAIR_TEXT_CHARS),
    ...(check ? { exactCheckResult: check } : {}),
    instruction:
      "Return only a corrected JSON response. Do not call tools, repeat a check, or add invalid state changes.",
  };
  let candidate = { ...base, recentMessages: recent, correction };
  let prompt = JSON.stringify(candidate);
  const estimate = (chars: number) =>
    input.estimateTokens?.(
      chars,
      input.session.ai.provider,
      input.session.ai.model,
    ) ?? {
      approximateTokens: Math.ceil(chars / 4),
      method: "chars-per-4",
    };
  let contextChars = system.length + prompt.length;
  let tokenResult = estimate(contextChars);
  while (
    (contextChars > MAX_CONTEXT_CHARS ||
      tokenResult.approximateTokens > MAX_CONTEXT_TOKENS) &&
    recent.length > 0
  ) {
    recent.shift();
    candidate = { ...base, recentMessages: recent, correction };
    prompt = JSON.stringify(candidate);
    contextChars = system.length + prompt.length;
    tokenResult = estimate(contextChars);
  }
  const telemetry: ContextTelemetry = {
    ...baseTelemetry,
    contextChars,
    approximateTokens: tokenResult.approximateTokens,
    tokenEstimateMethod: tokenResult.method,
    sections: {
      ...baseTelemetry.sections,
      repair: { chars: prompt.length, count: 1, omitted: 0 },
    },
  };
  if (
    contextChars > MAX_CONTEXT_CHARS ||
    tokenResult.approximateTokens > MAX_CONTEXT_TOKENS
  ) {
    throw new NarratorContextError(
      contextChars,
      MAX_CONTEXT_CHARS,
      tokenResult.approximateTokens,
      MAX_CONTEXT_TOKENS,
      telemetry,
    );
  }
  return { prompt, telemetry };
}
