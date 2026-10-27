import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  applyNarratorEffects,
  isLoreDiscoveryActionAllowed,
  parseTurnResponse,
  runCheck,
  validateCheckRequest,
  type EffectContext,
  type NarratorApplyResult,
  type TurnResponse,
} from "../../shared/engine.js";
import type {
  CheckRecord,
  ContextTelemetry,
  GameSession,
} from "../../shared/types.js";
import { applyWorldProposal } from "../../shared/world.js";
import type { MovementCandidate } from "../../shared/world.js";
import type { NarratorResult } from "../agent.js";
import {
  buildNarratorContext,
  buildNarratorRepair,
  npcContext,
  selectPrincipalNpc,
  type NarratorContextInput,
  type PreparedNarratorContext,
  NarratorContextError,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_TOKENS,
} from "./context.js";
import type { MemoryHit, MemorySearch } from "./knowledge.js";
import type { AgentValidation } from "./runtime.js";
import { publicItemEffects } from "../item-projection.js";

const MAX_MEMORY_RESULTS = 5;
const MAX_MEMORY_CHARS = 4_000;

const DISCOVERY_REPAIR_ISSUE =
  "One or more lore discovery effects are not available for this run.";

const SEARCH_MEMORY_SCHEMA = z
  .object({
    query: z.string().trim().min(1).max(500),
    npcId: z.string().min(1).max(200).optional(),
  })
  .strict();
const NPC_SCHEMA = z.object({ npcId: z.string().min(1).max(200) }).strict();
const ITEM_SCHEMA = z.object({ itemId: z.string().min(1).max(200) }).strict();
const CHECK_SCHEMA = z
  .object({
    attributeId: z.string().min(1).max(200),
    difficulty: z.number().int().nonnegative(),
    mode: z.enum(["OFF", "LOW", "NORMAL", "HIGH"]),
    npcId: z.string().min(1).max(200).optional(),
  })
  .strict();

export interface NarratorHarness {
  context: PreparedNarratorContext;
  tools: ToolSet;
  validate(input: {
    text: string;
    finishReason: string | null;
  }): AgentValidation<NarratorResult>;
  repair(input: {
    reason: string;
    previousText: string;
    suppressPreviousResponse: boolean;
  }): { system: string; prompt: string };
  getTelemetry(): ContextTelemetry;
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

// Models that are not in JSON mode sometimes wrap the payload in a sentence or
// append commentary after it. JSON.parse alone would reject a usable answer,
// so fall back to the first balanced object or array in the text. The result is
// still parsed and domain-validated afterwards.
function balancedSlice(text: string, start: number): string | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseNarratorJson(text: string): unknown {
  const body = stripFences(text);
  try {
    return JSON.parse(body);
  } catch (error) {
    const start = body.search(/[[{]/);
    if (start >= 0) {
      const candidate = balancedSlice(body, start);
      if (candidate !== undefined) return JSON.parse(candidate);
    }
    throw error;
  }
}

function npcDetails(
  session: GameSession,
  npcId: string,
  principalNpcId: string | undefined,
) {
  if (!principalNpcId || npcId !== principalNpcId) {
    throw new Error("NPC detail hanya tersedia untuk interlocutor terpilih.");
  }
  const npc = session.definitionSnapshot.npcs.find(
    (entry) => entry.id === npcId,
  );
  if (!npc) throw new Error("NPC ID tidak ada di snapshot session.");
  const relationship =
    session.state.relationships.find((entry) => entry.npcId === npc.id)
      ?.values ?? {};
  const knownFacts = session.state.facts
    .filter(
      (fact) => fact.visibility === "public" || fact.knownBy.includes(npc.id),
    )
    .slice(0, 24)
    .map(({ id, text }) => ({ id, text: text.slice(0, 500) }));
  return {
    ...npcContext(npc),
    relationship: Object.fromEntries(Object.entries(relationship).slice(0, 24)),
    knowledge: {
      privateKnowledge: npc.privateKnowledge
        .slice(0, 12)
        .map((text) => text.slice(0, 500)),
      knownFacts,
    },
  };
}

function itemDetails(session: GameSession, itemId: string) {
  const item = session.definitionSnapshot.items.find(
    (entry) => entry.id === itemId,
  );
  if (!item) throw new Error("Item ID tidak ada di snapshot session.");
  const quantity =
    session.state.inventory.find((entry) => entry.itemId === itemId)
      ?.quantity ?? 0;
  if (quantity <= 0) throw new Error("Item tidak ada di inventory session.");
  return { ...item, effects: publicItemEffects(item.effects), quantity };
}

function boundedMemoryHits(
  hits: MemoryHit[],
  limit: number,
  maxChars: number,
): MemoryHit[] {
  const bounded: MemoryHit[] = [];
  for (const hit of hits) {
    if (
      bounded.length >= limit ||
      !hit ||
      typeof hit.id !== "string" ||
      typeof hit.text !== "string"
    ) {
      continue;
    }
    const id = hit.id.slice(0, 200);
    let low = 1;
    let high = hit.text.length;
    let best = 0;
    while (low <= high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = [
        ...bounded,
        {
          kind: hit.kind,
          id,
          text: hit.text.slice(0, middle),
          ...(hit.sequence === undefined ? {} : { sequence: hit.sequence }),
          ...(hit.role === undefined ? {} : { role: hit.role }),
          ...(hit.speakerId === undefined ? {} : { speakerId: hit.speakerId }),
          createdAt: hit.createdAt,
        },
      ];
      if (JSON.stringify(candidate).length <= maxChars) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === 0) continue;
    bounded.push({
      kind: hit.kind,
      id,
      text: hit.text.slice(0, best),
      ...(hit.sequence === undefined ? {} : { sequence: hit.sequence }),
      ...(hit.role === undefined ? {} : { role: hit.role }),
      ...(hit.speakerId === undefined ? {} : { speakerId: hit.speakerId }),
      createdAt: hit.createdAt,
    });
  }
  return bounded;
}

function boundedToolDetail<T>(value: T, kind: string): T {
  if (JSON.stringify(value).length > MAX_MEMORY_CHARS) {
    throw new Error(
      `${kind} detail melebihi batas ${MAX_MEMORY_CHARS} karakter.`,
    );
  }
  return value;
}

export function createNarratorHarness(input: {
  input: NarratorContextInput;
  searchMemory: MemorySearch;
  signal: AbortSignal;
}): NarratorHarness {
  const { searchMemory, signal } = input;
  const session = input.input.session;
  const discoveredLoreIds = new Set(
    session.state.world.discoveredLoreIds ?? [],
  );
  const principalNpcId = selectPrincipalNpc(
    session,
    input.input.playerAction,
    input.input.worldMap,
    input.input.movement,
  );
  const actorScopedLore = (entries: EffectContext["loreEntries"] | undefined) =>
    (entries ?? []).filter(
      (entry) =>
        !entry.metadata.actorId ||
        entry.metadata.actorId === principalNpcId ||
        (entry.visibility === "discovery" && discoveredLoreIds.has(entry.id)),
    );
  const promptLore = actorScopedLore(input.input.lore);
  const effectLore = actorScopedLore(input.input.effectContext?.loreEntries);
  const promptLoreIds = new Set(promptLore.map(({ id }) => id));
  const discoveryHandlesByLoreId = new Map<string, string>();
  const discoveryLoreIdsByHandle = new Map<string, string>();
  const discoveryAction = input.input.effectContext?.playerAction ?? "";
  const worldMapForEffects = input.input.effectContext?.worldMap;
  const movement = input.input.movement;
  let effectiveLocationId = session.state.world.locationId;
  if (movement?.kind === "allowed") {
    const destinationExists =
      movement.fromId === effectiveLocationId &&
      input.input.worldMap?.locations.some(({ id }) => id === movement.toId) ===
        true &&
      worldMapForEffects?.locations.some(({ id }) => id === movement.toId) ===
        true;
    effectiveLocationId = destinationExists ? movement.toId : undefined;
  }
  const locationIsKnown =
    effectiveLocationId !== undefined &&
    worldMapForEffects?.locations.some(
      ({ id }) => id === effectiveLocationId,
    ) === true &&
    (!input.input.worldMap ||
      input.input.worldMap.locations.some(
        ({ id }) => id === effectiveLocationId,
      ));
  if (
    input.input.kind === "turn" &&
    worldMapForEffects &&
    locationIsKnown &&
    effectiveLocationId
  ) {
    for (const entry of effectLore) {
      if (
        entry.visibility !== "discovery" ||
        discoveredLoreIds.has(entry.id) ||
        !promptLoreIds.has(entry.id) ||
        !entry.metadata.discoverAt?.includes(effectiveLocationId) ||
        !isLoreDiscoveryActionAllowed(entry, discoveryAction)
      ) {
        continue;
      }
      const handle = `discovery-candidate:${crypto.randomUUID()}`;
      discoveryHandlesByLoreId.set(entry.id, handle);
      discoveryLoreIdsByHandle.set(handle, entry.id);
    }
  }
  const allowlistedEffectLore = effectLore.filter(
    (entry) =>
      entry.visibility === "discovery" &&
      (discoveredLoreIds.has(entry.id) ||
        discoveryHandlesByLoreId.has(entry.id)),
  );
  const allowlistedDiscoveredLoreIds = new Set(
    allowlistedEffectLore
      .filter(({ id }) => discoveredLoreIds.has(id))
      .map(({ id }) => id),
  );
  const runInput: NarratorContextInput = {
    ...input.input,
    lore: promptLore,
    ...(input.input.effectContext
      ? {
          effectContext: {
            ...input.input.effectContext,
            loreEntries: allowlistedEffectLore,
          },
        }
      : {}),
  };
  const context = buildNarratorContext(
    runInput,
    discoveryHandlesByLoreId,
    discoveryLoreIdsByHandle,
  );
  let contextTelemetry = context.telemetry;
  let toolCalls = 0;
  let repairCount = 0;
  let usedCheck: { key: string; result: CheckRecord } | undefined;
  let memoryResults = 0;
  let memoryChars = 0;
  const baseContextChars = context.telemetry.contextChars;
  let toolContextChars = 0;
  const estimateContext = (chars: number) =>
    input.input.estimateTokens?.(
      chars,
      session.ai.provider,
      session.ai.model,
    ) ?? { approximateTokens: Math.ceil(chars / 4), method: "chars-per-4" };
  const availableToolChars = () => {
    let low = 0;
    let high = Math.max(
      0,
      Math.min(
        MAX_MEMORY_CHARS,
        MAX_CONTEXT_CHARS - baseContextChars - toolContextChars,
      ),
    );
    let available = 0;
    while (low <= high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        estimateContext(baseContextChars + toolContextChars + middle)
          .approximateTokens <= MAX_CONTEXT_TOKENS
      ) {
        available = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return available;
  };
  const includeToolResult = <T>(value: T): T => {
    const resultChars = JSON.stringify(value).length;
    const contextChars = baseContextChars + toolContextChars + resultChars;
    const estimate = estimateContext(contextChars);
    const telemetry: ContextTelemetry = {
      ...contextTelemetry,
      contextChars,
      approximateTokens: estimate.approximateTokens,
      tokenEstimateMethod: estimate.method,
      sections: {
        ...contextTelemetry.sections,
        toolResults: {
          chars: toolContextChars + resultChars,
          count: toolCalls,
          omitted: 0,
        },
      },
    };
    contextTelemetry = telemetry;
    if (
      contextChars > MAX_CONTEXT_CHARS ||
      estimate.approximateTokens > MAX_CONTEXT_TOKENS
    ) {
      throw new NarratorContextError(
        contextChars,
        MAX_CONTEXT_CHARS,
        estimate.approximateTokens,
        MAX_CONTEXT_TOKENS,
        telemetry,
      );
    }
    toolContextChars += resultChars;
    return value;
  };

  const tools: ToolSet = {
    search_memory: tool({
      description:
        "Search committed story memory for the server-selected interlocutor; without one, search player-visible messages and public facts.",
      inputSchema: SEARCH_MEMORY_SCHEMA,
      execute: async (raw) => {
        signal.throwIfAborted();
        const { query, npcId } = SEARCH_MEMORY_SCHEMA.parse(raw);
        toolCalls += 1;
        const remainingHits = MAX_MEMORY_RESULTS - memoryResults;
        const remainingChars = Math.min(
          MAX_MEMORY_CHARS - memoryChars,
          availableToolChars(),
        );
        if (
          (principalNpcId
            ? npcId !== undefined && npcId !== principalNpcId
            : npcId !== undefined) ||
          remainingHits <= 0 ||
          remainingChars < 2
        ) {
          return includeToolResult([]);
        }
        memoryResults += remainingHits;
        memoryChars += remainingChars;
        try {
          const hits = await searchMemory(query, {
            ...(principalNpcId ? { npcId: principalNpcId } : {}),
            limit: remainingHits,
            maxChars: remainingChars,
            signal,
          });
          signal.throwIfAborted();
          if (!Array.isArray(hits)) {
            throw new Error("Memory search returned invalid data.");
          }
          const visibleHits = hits.filter((hit) => {
            if (hit.kind === "message" || hit.visibility === "public") {
              return true;
            }
            return (
              hit.visibility === "private" &&
              hit.knownBy?.includes(principalNpcId ?? "player") === true
            );
          });
          const bounded = boundedMemoryHits(
            visibleHits,
            remainingHits,
            remainingChars,
          );
          memoryResults -= remainingHits - bounded.length;
          memoryChars -= remainingChars - JSON.stringify(bounded).length;
          return includeToolResult(bounded);
        } catch (error) {
          memoryResults -= remainingHits;
          memoryChars -= remainingChars;
          throw error;
        }
      },
    }),
    get_npc_details: tool({
      description:
        "Read only the server-selected interlocutor's details and scoped knowledge.",
      inputSchema: NPC_SCHEMA,
      execute: (raw) => {
        signal.throwIfAborted();
        toolCalls += 1;
        return includeToolResult(
          boundedToolDetail(
            npcDetails(session, NPC_SCHEMA.parse(raw).npcId, principalNpcId),
            "NPC",
          ),
        );
      },
    }),
    get_item_details: tool({
      description: "Read one held item definition from the session snapshot.",
      inputSchema: ITEM_SCHEMA,
      execute: (raw) => {
        signal.throwIfAborted();
        toolCalls += 1;
        return includeToolResult(
          boundedToolDetail(
            itemDetails(session, ITEM_SCHEMA.parse(raw).itemId),
            "Item",
          ),
        );
      },
    }),
    run_check: tool({
      description:
        "Resolve one RPG check using the shared engine; an exact repeat returns the same result.",
      inputSchema: CHECK_SCHEMA,
      execute: (raw) => {
        signal.throwIfAborted();
        toolCalls += 1;
        if (input.input.kind !== "turn") {
          throw new Error("Read-only runs cannot execute checks.");
        }
        const params = CHECK_SCHEMA.parse(raw);
        if (params.npcId !== undefined && params.npcId !== principalNpcId) {
          throw new Error(
            "NPC checks are limited to the server-selected interlocutor.",
          );
        }
        const key = JSON.stringify([
          params.attributeId,
          params.difficulty,
          params.mode,
          params.npcId ?? null,
        ]);
        if (usedCheck) {
          if (usedCheck.key !== key) {
            throw new Error(
              "Only one distinct check is allowed per narrator run.",
            );
          }
          return includeToolResult(usedCheck.result);
        }
        const problems = validateCheckRequest(
          session.definitionSnapshot,
          session.state,
          params,
        );
        if (problems.length) throw new Error(problems.join("; "));
        const result = runCheck(
          session.definitionSnapshot,
          session.state,
          params,
          Math.random,
        );
        usedCheck = { key, result };
        return includeToolResult(result);
      },
    }),
  };

  const validate = (result: {
    text: string;
    finishReason: string | null;
  }): AgentValidation<NarratorResult> => {
    let response: TurnResponse | undefined;
    let issue: string | undefined;
    let application: NarratorApplyResult | null = null;
    let suppressPreviousResponse = false;
    try {
      response = parseTurnResponse(parseNarratorJson(result.text));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issue = `Respons narrator bukan JSON atau bentuk domain yang valid: ${detail}`;
    }

    if (response?.type === "check_request") {
      if (input.input.kind !== "turn") {
        issue = `${input.input.kind} tidak boleh meminta check.`;
      } else if (
        response.params.npcId !== undefined &&
        response.params.npcId !== principalNpcId
      ) {
        issue = "NPC check harus memakai interlocutor yang dipilih server.";
      } else if (usedCheck) {
        issue =
          "Check sudah dihitung; gunakan hasil exact check yang tersedia.";
      } else {
        const problems = validateCheckRequest(
          session.definitionSnapshot,
          session.state,
          response.params,
        );
        if (problems.length) {
          issue = problems.join(" ");
        } else {
          const check = runCheck(
            session.definitionSnapshot,
            session.state,
            response.params,
            Math.random,
          );
          usedCheck = {
            key: JSON.stringify([
              response.params.attributeId,
              response.params.difficulty,
              response.params.mode,
              response.params.npcId ?? null,
            ]),
            result: check,
          };
          issue =
            "Check telah selesai. Narasikan dengan hasil exact check dan jangan meminta atau menghitung ulang check.";
        }
      }
    } else if (response?.type === "narrative") {
      const canonicalLoreId = (loreId: string): string | undefined => {
        const resolved = discoveryLoreIdsByHandle.get(loreId);
        if (resolved !== undefined) return resolved;
        return allowlistedDiscoveredLoreIds.has(loreId) ? loreId : undefined;
      };
      const containsDiscovery = response.effects.some(
        (effect) =>
          effect.type === "DISCOVER_LORE" ||
          (effect.type === "REGISTER_ITEM" &&
            effect.effects.some((nested) => nested.type === "DISCOVER_LORE")),
      );
      const effects: typeof response.effects = [];
      let unavailableDiscovery = false;
      for (const effect of response.effects) {
        if (effect.type === "DISCOVER_LORE") {
          const loreId = canonicalLoreId(effect.loreId);
          if (loreId === undefined) {
            unavailableDiscovery = true;
            continue;
          }
          effects.push({ ...effect, loreId });
          continue;
        }
        if (effect.type === "REGISTER_ITEM") {
          const nestedEffects = effect.effects.map((nested) => {
            if (nested.type !== "DISCOVER_LORE") return nested;
            const loreId = canonicalLoreId(nested.loreId);
            if (loreId === undefined) {
              unavailableDiscovery = true;
              return nested;
            }
            return { ...nested, loreId };
          });
          effects.push({ ...effect, effects: nestedEffects });
          continue;
        }
        effects.push(effect);
      }
      if (unavailableDiscovery) {
        issue = DISCOVERY_REPAIR_ISSUE;
        suppressPreviousResponse = true;
      } else {
        response = { ...response, effects };
      }
      if (
        !issue &&
        input.input.kind === "choices" &&
        (response.effects.length || usedCheck)
      ) {
        issue = containsDiscovery
          ? DISCOVERY_REPAIR_ISSUE
          : "Pilihan tidak boleh mengubah state atau meminta check.";
        suppressPreviousResponse = containsDiscovery;
      } else if (!issue && input.input.kind === "turn") {
        try {
          const movement: MovementCandidate =
            input.input.movement ??
            (input.input.worldMap ? { kind: "none" } : { kind: "legacy" });
          const effectState = {
            ...session.state,
            world: applyWorldProposal(
              input.input.worldMap,
              session.state.world,
              movement,
              response.world ?? {},
              session.definitionSnapshot.npcs.map(({ id }) => id),
            ),
          };
          application = applyNarratorEffects(
            session.definitionSnapshot,
            effectState,
            response.effects,
            runInput.effectContext,
          );
        } catch (error) {
          if (containsDiscovery) {
            issue = DISCOVERY_REPAIR_ISSUE;
            suppressPreviousResponse = true;
          } else {
            issue =
              error instanceof Error ? error.message : "Effects tidak valid.";
          }
        }
      }
      if (!issue) {
        return {
          kind: "accepted",
          value: {
            response,
            check: usedCheck?.result ?? null,
            application,
          },
        };
      }
    }

    if (!issue) issue = "Respons narrator tidak valid.";
    if (result.finishReason === "length" && !suppressPreviousResponse) {
      issue =
        input.input.kind === "choices"
          ? "Respons terpotong karena mencapai batas output token. Buat narasi satu kalimat dan pilihan sangat singkat."
          : "Respons terpotong karena mencapai batas output token. Jawab dengan lebih ringkas.";
    }
    return { kind: "repair", reason: issue, suppressPreviousResponse };
  };

  const repair = (request: {
    reason: string;
    previousText: string;
    suppressPreviousResponse: boolean;
  }): { system: string; prompt: string } => {
    repairCount += 1;
    const repaired = buildNarratorRepair(
      context.prompt,
      request.suppressPreviousResponse ? "" : request.previousText,
      request.reason,
      usedCheck?.result,
      runInput,
      contextTelemetry,
    );
    contextTelemetry = repaired.telemetry;
    return { system: context.system, prompt: repaired.prompt };
  };

  return {
    context,
    tools,
    validate,
    repair,
    getTelemetry: () => ({
      ...contextTelemetry,
      toolCalls,
      repairs: repairCount,
    }),
  };
}
