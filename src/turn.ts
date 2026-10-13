import {
  complete,
  type CompleteOptions,
  type LlmResult,
  type LlmSettings,
  type LlmUsage,
} from "./llm";
import { getHistory, getSession, saveTurn } from "./db";
import {
  applyEffects,
  parseTurnResponse,
  runCheck,
  useItem,
  validateCheckRequest,
  EngineError,
  type Choice,
  type TurnResponse,
} from "./engine";
import {
  type CheckRecord,
  type GameDefinition,
  type GameSession,
  type Message,
  type SessionState,
} from "./types";

const RECENT_MESSAGE_LIMIT = 24;
const MAX_CONTEXT_CHARS = 24_000;

const busySessions = new Set<string>();

export type TurnOutcome =
  | { ok: true; session: GameSession; messages: Message[]; choices: Choice[] }
  | { ok: false; error: string };

export interface TurnOptions {
  fetchImpl?: typeof fetch;
  random?: () => number;
  signal?: AbortSignal;
}

function npcName(def: GameDefinition, npcId: string): string {
  return def.npcs.find((npc) => npc.id === npcId)?.name ?? npcId;
}

export function buildContext(session: GameSession, history: Message[]): string {
  const def = session.definitionSnapshot;
  const state = session.state;
  const lines: string[] = [];

  lines.push(
    "SYSTEM:",
    "Kamu adalah narrator dan pemain semua NPC untuk game ini.",
    "Aturan:",
    "- Balas hanya dengan JSON sesuai kontrak pada akhir prompt.",
    "- Jangan mengarang item yang dimiliki pemain.",
    "- Usulkan perubahan state hanya lewat field effects.",
    "- Hormati facts yang sudah ada.",
    "- Karakter tidak boleh memakai private fact yang tidak mereka ketahui.",
    "- Lanjutkan cerita secara alami tanpa plot yang dipaksakan.",
  );

  lines.push(
    "",
    "SCENARIO:",
    def.scenario.setting,
    def.scenario.startingSituation,
  );
  if (def.scenario.worldRules)
    lines.push(`Aturan dunia: ${def.scenario.worldRules}`);
  if (def.scenario.tone) lines.push(`Nuansa: ${def.scenario.tone}`);
  if (def.scenario.genre) lines.push(`Genre: ${def.scenario.genre}`);
  if (def.scenario.additionalContext)
    lines.push(def.scenario.additionalContext);

  lines.push("", "PLAYER:", `Nama: ${def.player.name}`);
  if (def.player.description) lines.push(def.player.description);
  if (def.player.personality)
    lines.push(`Kepribadian: ${def.player.personality}`);
  if (def.player.background)
    lines.push(`Latar belakang: ${def.player.background}`);

  for (const npc of def.npcs) {
    if (!state.world.activeCharacters.includes(npc.id)) continue;
    lines.push("", `NPC ${npc.name} (${npc.id}):`);
    if (npc.description) lines.push(npc.description);
    if (npc.personality.length > 0) {
      lines.push(`Kepribadian: ${npc.personality.join(", ")}`);
    }
    if (npc.goals.length > 0) lines.push(`Tujuan: ${npc.goals.join(", ")}`);
    const knownFacts = state.facts.filter(
      (fact) => fact.visibility === "public" || fact.knownBy.includes(npc.id),
    );
    const knowledge = [
      ...npc.privateKnowledge,
      ...knownFacts.map((fact) => fact.text),
    ];
    if (knowledge.length > 0) {
      lines.push(
        "Pengetahuan NPC ini:",
        ...knowledge.map((entry) => `- ${entry}`),
      );
    }
  }

  lines.push(
    "",
    "ATTRIBUTES (gunakan id di dalam tanda kurung untuk check/effects):",
    ...def.attributes.map(
      (attribute) =>
        `${attribute.name} (${attribute.id}): ${state.attributes[attribute.id] ?? attribute.defaultValue}`,
    ),
  );
  lines.push(
    "",
    "RESOURCES (gunakan id untuk effects):",
    ...def.resources.map(
      (resource) =>
        `${resource.name} (${resource.id}): ${state.resources[resource.id] ?? resource.initialValue}`,
    ),
  );

  const relationshipLines: string[] = [];
  for (const entry of state.relationships) {
    const values = def.relationships
      .map(
        (rel) =>
          `${rel.name} (${rel.id}): ${entry.values[rel.id] ?? rel.defaultValue}`,
      )
      .join(", ");
    relationshipLines.push(`${npcName(def, entry.npcId)}: ${values}`);
  }
  if (relationshipLines.length > 0) {
    lines.push("", "RELATIONSHIPS:", ...relationshipLines);
  }

  const inventoryLines = state.inventory.map((entry) => {
    const item = def.items.find((candidate) => candidate.id === entry.itemId);
    return `${item?.name ?? entry.itemId} (${entry.itemId}) x${entry.quantity}`;
  });
  lines.push(
    "",
    "INVENTORY:",
    inventoryLines.length > 0 ? inventoryLines.join(", ") : "(kosong)",
  );

  lines.push(
    "",
    "WORLD STATE:",
    `Lokasi: ${state.world.location || "(belum ditentukan)"}`,
    `Waktu: ${state.world.time || "(belum ditentukan)"}`,
    `Scene: ${state.world.scene}`,
  );

  const publicFacts = state.facts.filter(
    (fact) => fact.visibility === "public",
  );
  const privateFacts = state.facts.filter(
    (fact) => fact.visibility === "private",
  );
  if (publicFacts.length > 0) {
    lines.push("", "FACTS:", ...publicFacts.map((fact) => `- ${fact.text}`));
  }
  if (privateFacts.length > 0) {
    lines.push(
      "",
      "Hanya untuk narrator:",
      ...privateFacts.map(
        (fact) =>
          `- ${fact.text}${fact.knownBy.length > 0 ? ` (diketahui: ${fact.knownBy.join(", ")})` : ""}`,
      ),
    );
  }

  const recent = history.slice(-RECENT_MESSAGE_LIMIT);
  if (recent.length > 0) {
    lines.push(
      "",
      "RECENT MESSAGES:",
      ...recent.map((message) => {
        const speaker = message.speakerId
          ? ` ${npcName(def, message.speakerId)}`
          : "";
        return `${message.role}${speaker}: ${message.content}`;
      }),
    );
  }

  const text = lines.join("\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    throw new EngineError(
      "Context terlalu besar; kurangi panjang history atau konfigurasi sebelum melanjutkan.",
    );
  }
  return text;
}

const CONTRACT_HINT =
  "Kontrak JSON (balas HANYA JSON, tanpa markdown):\n" +
  "- Jika aksi butuh attribute check: " +
  '{"requiresCheck": true, "attribute": "<attributeId>", "difficulty": <integer >= 0>, ' +
  '"mode": "OFF"|"LOW"|"NORMAL"|"HIGH", "npcId": "<opsional>"}\n' +
  "- Jika tidak: " +
  '{"narrative": "<teks>", "effects": [], "world": {"location": "...", "time": "...", "scene": "..."}}\n' +
  "Tipe effects: ATTRIBUTE_CHANGE, RESOURCE_CHANGE, RELATIONSHIP_CHANGE " +
  "(target, operation ADD|SUBTRACT|SET, value; RELATIONSHIP_CHANGE wajib npcId), " +
  "ADD_ITEM, REMOVE_ITEM (target, quantity), ADD_FACT (text), REMOVE_FACT (target).";

type ParseStep =
  | { kind: "llm-error"; message: string }
  | { kind: "parse-error"; message: string }
  | { kind: "ok"; response: TurnResponse; usage?: LlmUsage };
function llmFailureMessage(result: LlmResult): string {
  if (result.kind === "error") return result.message;
  if (result.kind === "refusal")
    return `Provider menolak request (${result.reason}).`;
  if (result.kind === "empty") return "Provider mengirim respons kosong.";
  return "Respons provider tidak dapat digunakan.";
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

function parseStep(result: LlmResult): ParseStep {
  if (result.kind !== "ok") {
    return { kind: "llm-error", message: llmFailureMessage(result) };
  }
  try {
    const parsed: unknown = JSON.parse(stripFences(result.text));
    return {
      kind: "ok",
      response: parseTurnResponse(parsed),
      usage: result.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "parse-error", message };
  }
}

interface RepairBudget {
  used: number;
}

interface StepResult {
  response?: TurnResponse;
  error?: string;
  usage?: LlmUsage;
}

async function requestStep(
  settings: LlmSettings,
  prompt: string,
  llmOptions: CompleteOptions,
  budget: RepairBudget,
  onAttempt?: (usage: LlmUsage | undefined) => void,
): Promise<StepResult> {
  const firstResult = await complete(settings, prompt, llmOptions);
  onAttempt?.(firstResult.usage);
  const first = parseStep(firstResult);
  if (first.kind === "ok")
    return { response: first.response, usage: first.usage };
  if (first.kind === "llm-error") return { error: first.message };
  if (budget.used >= 1) {
    return {
      error: "Respons AI tidak valid dan batas perbaikan sudah terpakai.",
    };
  }
  budget.used += 1;
  const repairPrompt = `${prompt}\n\nPerbaiki respons sebelumnya. Masalah: ${first.message}\n${CONTRACT_HINT}`;
  const secondResult = await complete(settings, repairPrompt, llmOptions);
  onAttempt?.(secondResult.usage);
  const second = parseStep(secondResult);
  if (second.kind === "ok")
    return { response: second.response, usage: second.usage };
  if (second.kind === "llm-error") return { error: second.message };
  return { error: "Respons AI tidak valid setelah perbaikan." };
}

async function commitWithRetry(
  session: GameSession,
  messages: Message[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await saveTurn(session, messages);
      return true;
    } catch {
      // Percobaan kedua memakai id yang sama sehingga tetap idempoten.
    }
  }
  return false;
}

export async function submitTurn(
  sessionId: string,
  input: string,
  apiKey: string,
  options: TurnOptions = {},
): Promise<TurnOutcome> {
  if (busySessions.has(sessionId)) {
    return { ok: false, error: "Turn lain sedang berjalan." };
  }
  busySessions.add(sessionId);
  const startedAt = Date.now();
  const budget: RepairBudget = { used: 0 };
  const usageTotals: LlmUsage = {};
  let providerAttempts = 0;
  let model: string | undefined;
  let turnSucceeded = false;
  let appliedCount: number | undefined;
  const recordAttempt = (usage: LlmUsage | undefined) => {
    providerAttempts += 1;
    if (!usage) return;
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
    ] as const) {
      const value = usage[key];
      if (value !== undefined) {
        usageTotals[key] = (usageTotals[key] ?? 0) + value;
      }
    }
  };
  const usageSummary = () => {
    const fields = [
      usageTotals.promptTokens === undefined
        ? undefined
        : `promptTokens=${usageTotals.promptTokens}`,
      usageTotals.completionTokens === undefined
        ? undefined
        : `completionTokens=${usageTotals.completionTokens}`,
      usageTotals.totalTokens === undefined
        ? undefined
        : `token=${usageTotals.totalTokens}`,
    ].filter((field): field is string => field !== undefined);
    return fields.length > 0 ? ` ${fields.join(" ")}` : "";
  };

  try {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "Session tidak ditemukan." };
    const history = await getHistory(sessionId);

    let context: string;
    try {
      context = buildContext(session, history);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const def = session.definitionSnapshot;
    const settings: LlmSettings = {
      provider: session.ai.provider,
      model: session.ai.model,
      apiKey,
    };
    model = settings.model;
    const llmOptions: CompleteOptions = {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      timeoutMs: 60_000,
    };

    const interpretPrompt = `${context}\n\nAKSI PEMAIN:\n${input}\n\n${CONTRACT_HINT}`;
    const interpret = await requestStep(
      settings,
      interpretPrompt,
      llmOptions,
      budget,
      recordAttempt,
    );
    if (interpret.error || !interpret.response) {
      return { ok: false, error: interpret.error ?? "Respons AI tidak valid." };
    }

    let response = interpret.response;
    let check: CheckRecord | undefined;

    if (response.type === "check_request") {
      let problems = validateCheckRequest(def, session.state, response.params);
      if (problems.length > 0) {
        const validAttributes = def.attributes
          .map((entry) => entry.id)
          .join(", ");
        const validNpcs = def.npcs.map((entry) => entry.id).join(", ");
        const retry = await requestStep(
          settings,
          `${interpretPrompt}\n\nPermintaan check sebelumnya ditolak: ${problems.join(" ")}. ` +
            `Attribute id yang valid: ${validAttributes}. ` +
            `npcId bersifat opsional, hanya dipakai saat check memakai atribut milik NPC itu sendiri; npc id yang valid: ${validNpcs}. ` +
            `Berikan respons valid.`,
          llmOptions,
          budget,
          recordAttempt,
        );
        if (retry.error || !retry.response) {
          return { ok: false, error: retry.error ?? "Respons AI tidak valid." };
        }
        response = retry.response;
        if (response.type === "check_request") {
          problems = validateCheckRequest(def, session.state, response.params);
          if (problems.length > 0) {
            return {
              ok: false,
              error: `Check request tidak valid: ${problems.join(" ")}`,
            };
          }
        }
      }

      if (response.type === "check_request") {
        check = runCheck(
          def,
          session.state,
          response.params,
          options.random ?? Math.random,
        );
        const attribute = def.attributes.find(
          (entry) => entry.id === check!.attributeId,
        );
        const narratePrompt =
          `${context}\n\nAKSI PEMAIN:\n${input}\n\n` +
          `Hasil check engine (otoritatif): atribut ${attribute?.name ?? check.attributeId}, ` +
          `skor ${check.score} vs difficulty ${check.difficulty}, hasil ${check.outcome}.\n` +
          `Tulis narasi yang mengikuti hasil tersebut. Jangan meminta check lagi.\n\n${CONTRACT_HINT}`;
        const narrate = await requestStep(
          settings,
          narratePrompt,
          llmOptions,
          budget,
          recordAttempt,
        );
        if (narrate.error || !narrate.response) {
          return {
            ok: false,
            error: narrate.error ?? "Respons AI tidak valid.",
          };
        }
        if (narrate.response.type === "check_request") {
          return {
            ok: false,
            error:
              "Model meminta check lagi setelah hasil engine; turn dibatalkan.",
          };
        }
        response = narrate.response;
      }
    }

    let newState: SessionState;
    let applied: string[];
    try {
      const result = applyEffects(def, session.state, response.effects);
      newState = result.state;
      applied = result.applied;
    } catch (error) {
      if (!(error instanceof EngineError) || budget.used >= 1) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      budget.used += 1;
      const retry = await requestStep(
        settings,
        `${interpretPrompt}\n\nPerubahan yang diusulkan ditolak engine: ${error.message}. Berikan respons valid tanpa perubahan itu atau dengan perubahan yang valid.`,
        llmOptions,
        budget,
        recordAttempt,
      );
      if (retry.error || !retry.response) {
        return { ok: false, error: retry.error ?? "Respons AI tidak valid." };
      }
      if (retry.response.type === "check_request") {
        return {
          ok: false,
          error: "Model meminta check pada perbaikan; turn dibatalkan.",
        };
      }
      response = retry.response;
      try {
        const result = applyEffects(def, session.state, response.effects);
        newState = result.state;
        applied = result.applied;
      } catch (secondError) {
        return {
          ok: false,
          error:
            secondError instanceof Error
              ? secondError.message
              : String(secondError),
        };
      }
    }

    const world = { ...newState.world };
    if (response.world?.location) world.location = response.world.location;
    if (response.world?.time) world.time = response.world.time;
    if (response.world?.scene) world.scene = response.world.scene;
    newState = { ...newState, world };

    const turnId = crypto.randomUUID();
    const now = new Date().toISOString();
    const startSequence = session.nextSequence;
    const messages: Message[] = [
      {
        id: crypto.randomUUID(),
        sessionId,
        turnId,
        sequence: startSequence,
        role: "PLAYER",
        content: input,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        sessionId,
        turnId,
        sequence: startSequence + 1,
        role: "NARRATOR",
        content: response.narrative,
        ...(check ? { check } : {}),
        createdAt: now,
      },
    ];
    if (applied.length > 0) {
      messages.push({
        id: crypto.randomUUID(),
        sessionId,
        turnId,
        sequence: startSequence + 2,
        role: "SYSTEM_EVENT",
        content: applied.join(" | "),
        createdAt: now,
      });
    }

    const nextSession: GameSession = {
      ...session,
      state: newState,
      nextSequence: startSequence + messages.length,
      updatedAt: now,
    };
    if (!(await commitWithRetry(nextSession, messages))) {
      return { ok: false, error: "Gagal menyimpan turn." };
    }

    turnSucceeded = true;
    appliedCount = applied.length;
    return {
      ok: true,
      session: nextSession,
      messages,
      choices: response.type === "narrative" ? response.choices : [],
    };
  } finally {
    busySessions.delete(sessionId);
    if (providerAttempts > 0) {
      console.info(
        `[fworld] turn ${turnSucceeded ? "selesai" : "gagal"} model=${model} ` +
          `latency=${Date.now() - startedAt}ms attempts=${providerAttempts}` +
          (appliedCount === undefined ? "" : ` perubahan=${appliedCount}`) +
          ` repair=${budget.used}${usageSummary()}`,
      );
    }
  }
}

export async function beginOpeningScene(
  sessionId: string,
  apiKey: string,
  options: TurnOptions = {},
): Promise<TurnOutcome> {
  if (busySessions.has(sessionId)) {
    return { ok: false, error: "Turn lain sedang berjalan." };
  }
  busySessions.add(sessionId);
  try {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "Session tidak ditemukan." };
    const history = await getHistory(sessionId);
    if (history.length > 0) {
      return { ok: false, error: "Scene awal sudah ada." };
    }

    let context: string;
    try {
      context = buildContext(session, history);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const settings: LlmSettings = {
      provider: session.ai.provider,
      model: session.ai.model,
      apiKey,
    };
    const llmOptions: CompleteOptions = {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      timeoutMs: 60_000,
    };
    const budget: RepairBudget = { used: 0 };

    const prompt =
      `${context}\n\nTulis scene pembuka berdasarkan starting situation di atas. ` +
      `Jangan mengubah state dan jangan meminta check.\n\n${CONTRACT_HINT}`;
    const step = await requestStep(settings, prompt, llmOptions, budget);
    if (step.error || !step.response) {
      return { ok: false, error: step.error ?? "Respons AI tidak valid." };
    }
    if (step.response.type === "check_request") {
      return { ok: false, error: "Scene awal tidak boleh meminta check." };
    }
    if (step.response.effects.length > 0) {
      return { ok: false, error: "Scene awal tidak boleh mengubah state." };
    }

    const now = new Date().toISOString();
    const message: Message = {
      id: crypto.randomUUID(),
      sessionId,
      turnId: crypto.randomUUID(),
      sequence: 0,
      role: "NARRATOR",
      content: step.response.narrative,
      createdAt: now,
    };
    const nextSession: GameSession = {
      ...session,
      nextSequence: 1,
      updatedAt: now,
    };
    if (!(await commitWithRetry(nextSession, [message]))) {
      return { ok: false, error: "Gagal menyimpan scene awal." };
    }
    return { ok: true, session: nextSession, messages: [message], choices: [] };
  } finally {
    busySessions.delete(sessionId);
  }
}

export interface ChoicesOutcome {
  ok: true;
  choices: Choice[];
  boundSequence: number;
}

export async function requestChoices(
  sessionId: string,
  apiKey: string,
  options: TurnOptions = {},
): Promise<ChoicesOutcome | { ok: false; error: string }> {
  if (busySessions.has(sessionId)) {
    return { ok: false, error: "Turn lain sedang berjalan." };
  }
  busySessions.add(sessionId);
  try {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "Session tidak ditemukan." };
    const history = await getHistory(sessionId);

    let context: string;
    try {
      context = buildContext(session, history);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const settings: LlmSettings = {
      provider: session.ai.provider,
      model: session.ai.model,
      apiKey,
    };
    const llmOptions: CompleteOptions = {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      timeoutMs: 60_000,
    };
    const budget: RepairBudget = { used: 0 };

    const prompt =
      `${context}\n\nBerikan 0 sampai 3 pilihan tindakan yang berguna untuk pemain saat ini. ` +
      `Isi field choices dengan object {"id": "...", "label": "..."}. ` +
      `Jangan ubah state: effects harus array kosong. Jangan meminta check.\n\n${CONTRACT_HINT}`;
    const step = await requestStep(settings, prompt, llmOptions, budget);
    if (step.error || !step.response) {
      return { ok: false, error: step.error ?? "Respons AI tidak valid." };
    }
    if (step.response.type === "check_request") {
      return { ok: false, error: "Choices request tidak boleh meminta check." };
    }
    if (step.response.effects.length > 0) {
      return {
        ok: false,
        error: "Choices request tidak boleh mengubah state.",
      };
    }
    return {
      ok: true,
      choices: step.response.choices,
      boundSequence: session.nextSequence,
    };
  } finally {
    busySessions.delete(sessionId);
  }
}

export async function useSessionItem(
  sessionId: string,
  itemId: string,
): Promise<TurnOutcome> {
  if (busySessions.has(sessionId)) {
    return { ok: false, error: "Turn lain sedang berjalan." };
  }
  busySessions.add(sessionId);
  try {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "Session tidak ditemukan." };
    const def = session.definitionSnapshot;
    const item = def.items.find((entry) => entry.id === itemId);
    if (!item) return { ok: false, error: `Item "${itemId}" tidak dikenal.` };

    let result;
    try {
      result = useItem(def, session.state, itemId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const now = new Date().toISOString();
    const startSequence = session.nextSequence;
    const message: Message = {
      id: crypto.randomUUID(),
      sessionId,
      turnId: crypto.randomUUID(),
      sequence: startSequence,
      role: "SYSTEM_EVENT",
      content:
        result.applied.length > 0
          ? `${item.name} digunakan. ${result.applied.join(" | ")}`
          : `${item.name} digunakan tanpa efek.`,
      createdAt: now,
    };
    const nextSession: GameSession = {
      ...session,
      state: result.state,
      nextSequence: startSequence + 1,
      updatedAt: now,
    };
    if (!(await commitWithRetry(nextSession, [message]))) {
      return { ok: false, error: "Gagal menyimpan penggunaan item." };
    }
    return { ok: true, session: nextSession, messages: [message], choices: [] };
  } finally {
    busySessions.delete(sessionId);
  }
}
