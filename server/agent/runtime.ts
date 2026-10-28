import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";
import type {
  AgentTrace,
  AgentTraceEvent,
  AgentTraceFinishReason,
  ProviderId,
} from "../../shared/types.js";

const MAX_STEPS = 3;
const MAX_REPAIRS = 2;
const MAX_EXTRA_REPAIR_REQUESTS = 1;
const MAX_TOTAL_REQUESTS = MAX_STEPS + MAX_EXTRA_REPAIR_REQUESTS;
const MAX_OUTPUT_TOKENS = 4_096;
// Providers such as Gemini count hidden reasoning inside the output cap. Tool
// steps only emit small tool calls, but a narrative JSON that needs ~1.000
// visible tokens can be cut off at 4.096 when thinking uses ~3.000 of them
// (observed on the same session), so the answer and repair steps get headroom.
const MAX_FINAL_OUTPUT_TOKENS = 8_192;
const MAX_REPAIR_OUTPUT_TOKENS = MAX_FINAL_OUTPUT_TOKENS;
const RUN_TIMEOUT_MS = 60_000;
const MAX_TRACE_EVENTS = 128;

const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);

export interface AttemptEvent {
  step: number;
  provider: ProviderId;
  model: string;
  status: "started" | "succeeded" | "failed";
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  } | null;
  latencyMs: number | null;
  finishReason: AgentTraceFinishReason | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

export type AgentProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]["providerOptions"]
>;

export type AgentReasoning = NonNullable<
  Parameters<typeof generateText>[0]["reasoning"]
>;

export interface AgentRequest {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools?: ToolSet;
  providerOptions?: AgentProviderOptions;
  reasoning?: AgentReasoning;
}

export type AgentValidation<TResult> =
  | { kind: "accepted"; value: TResult }
  | { kind: "repair"; reason: string; suppressPreviousResponse: boolean };

export interface AgentTask<TResult> {
  request: AgentRequest;
  validate(input: {
    text: string;
    finishReason: AgentTraceFinishReason | null;
  }): AgentValidation<TResult>;
  repair(input: {
    reason: string;
    previousText: string;
    suppressPreviousResponse: boolean;
  }): AgentRequest;
}

export interface AgentRunInput<TResult> {
  provider: ProviderId;
  model: string;
  prepare(signal: AbortSignal): AgentTask<TResult>;
  onAttemptStart: (event: AttemptEvent) => void | Promise<void>;
  onAttemptFinish: (event: AttemptEvent) => void | Promise<void>;
  onTrace?: (event: AgentTraceInput) => void;
  signal?: AbortSignal;
}

export interface AgentRunOptions {
  generateText?: typeof generateText;
}

export class NarratorResponseError extends Error {
  constructor(
    readonly reason: "output_limit" | "invalid",
    readonly repairs = 0,
    readonly detail = "",
    readonly textSample = "",
  ) {
    const summary =
      reason === "output_limit"
        ? "Respons AI terpotong sebelum selesai. Coba lagi dengan konteks yang lebih ringkas atau pilih model lain."
        : repairs > 0
          ? `Respons AI belum bisa dipakai setelah ${repairs === 1 ? "satu" : "dua"} kali perbaikan. Silakan coba lagi.`
          : "Respons AI belum valid; batas permintaan run ini habis sebelum perbaikan. Silakan coba lagi.";
    super(
      detail
        ? `${summary} Alasan: ${Array.from(detail.trim()).slice(0, 300).join("")}`
        : summary,
    );
    this.name = "NarratorResponseError";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type AgentTraceInput = DistributiveOmit<AgentTraceEvent, "elapsedMs">;

export class AgentTraceCollector {
  readonly #startedAt = performance.now();
  readonly #events: AgentTraceEvent[] = [];
  #dropped = 0;

  push(event: AgentTraceInput): void {
    if (this.#events.length >= MAX_TRACE_EVENTS) {
      this.#dropped += 1;
      return;
    }
    this.#events.push({
      ...event,
      elapsedMs: Math.max(0, Math.round(performance.now() - this.#startedAt)),
    } as AgentTraceEvent);
  }

  snapshot(): AgentTrace {
    return {
      events: this.#events.map((event) => ({ ...event })),
      dropped: this.#dropped,
    };
  }
}

function readTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedUsage(usage: LanguageModelUsage | undefined) {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
  };
}

function usageDetails(
  provider: ProviderId,
  usage: LanguageModelUsage | undefined,
): { cachedInputTokens: number | null; reasoningTokens: number | null } {
  if (!usage) return { cachedInputTokens: null, reasoningTokens: null };
  if (provider === "gemini") {
    const raw = usage.raw;
    return {
      cachedInputTokens: readTokenCount(raw?.cachedContentTokenCount),
      reasoningTokens: readTokenCount(raw?.thoughtsTokenCount),
    };
  }
  return {
    cachedInputTokens: readTokenCount(usage.inputTokenDetails?.cacheReadTokens),
    reasoningTokens: readTokenCount(usage.outputTokenDetails?.reasoningTokens),
  };
}

function normalizeFinishReason(value: unknown): AgentTraceFinishReason | null {
  return typeof value === "string" && FINISH_REASONS.has(value)
    ? (value as AgentTraceFinishReason)
    : null;
}

export async function runAgent<TResult>(
  input: AgentRunInput<TResult>,
  options: AgentRunOptions = {},
): Promise<TResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Batas waktu AI 60 detik terlampaui.")),
    RUN_TIMEOUT_MS,
  );
  let rejectOnAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const external = input.signal;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let closed = false;
  let latchedError: unknown;
  const trace = (event: AgentTraceInput) => {
    if (closed) return;
    input.onTrace?.(event);
  };
  const latchError = (error: unknown) => {
    if (latchedError === undefined) latchedError = error;
    if (!controller.signal.aborted) controller.abort(error);
  };
  const throwIfLatched = () => {
    if (latchedError !== undefined) throw latchedError;
  };

  const attempts = new Map<string, { step: number; startedAt: number }>();
  let attemptCount = 0;
  let generationCount = 0;
  let currentPhase: "initial" | "repair" = "initial";
  let allowedToolNames: ReadonlySet<string> = new Set<string>();

  const finishAttempt = async (
    callId: string,
    status: "succeeded" | "failed",
    usage: LanguageModelUsage | undefined,
    latencyMs?: number,
    finishReason?: AgentTraceFinishReason | null,
  ) => {
    const attempt = attempts.get(callId);
    if (!attempt) return;
    attempts.delete(callId);
    const details = usageDetails(input.provider, usage);
    try {
      await input.onAttemptFinish({
        step: attempt.step,
        provider: input.provider,
        model: input.model,
        status,
        usage: normalizedUsage(usage),
        latencyMs: Math.max(
          0,
          Math.round(latencyMs ?? performance.now() - attempt.startedAt),
        ),
        finishReason: finishReason ?? null,
        ...details,
      });
      trace({
        kind: "model",
        attempt: attempt.step,
        phase: currentPhase,
        status,
        finishReason: finishReason ?? null,
      });
    } catch (error) {
      trace({
        kind: "model",
        attempt: attempt.step,
        phase: currentPhase,
        status: "failed",
        finishReason: null,
      });
      latchError(error);
    }
  };

  try {
    controller.signal.throwIfAborted();
    const task = input.prepare(controller.signal);
    throwIfLatched();
    controller.signal.throwIfAborted();
    allowedToolNames = new Set(Object.keys(task.request.tools ?? {}));

    const callbacks = {
      onLanguageModelCallStart: async ({ callId }: { callId: string }) => {
        if (closed || controller.signal.aborted) return;
        const step = ++attemptCount;
        attempts.set(callId, { step, startedAt: performance.now() });
        try {
          await input.onAttemptStart({
            step,
            provider: input.provider,
            model: input.model,
            status: "started",
            usage: null,
            latencyMs: null,
            finishReason: null,
            cachedInputTokens: null,
            reasoningTokens: null,
          });
          trace({
            kind: "model",
            attempt: step,
            phase: currentPhase,
            status: "started",
            finishReason: null,
          });
        } catch (error) {
          trace({
            kind: "model",
            attempt: step,
            phase: currentPhase,
            status: "failed",
            finishReason: null,
          });
          latchError(error);
        }
      },
      onLanguageModelCallEnd: async ({
        callId,
        usage,
        finishReason,
        performance: metrics,
      }: {
        callId: string;
        usage: LanguageModelUsage;
        finishReason: unknown;
        performance: { responseTimeMs?: number };
      }) => {
        if (closed || controller.signal.aborted) return;
        await finishAttempt(
          callId,
          "succeeded",
          usage,
          metrics.responseTimeMs,
          normalizeFinishReason(finishReason),
        );
      },
      onToolExecutionEnd: ({
        toolCall,
        toolOutput,
      }: {
        toolCall: { toolName: string };
        toolOutput: { type: string; output?: unknown; error?: unknown };
      }) => {
        if (closed) return;
        let resultChars: number | null = null;
        if (toolOutput.type === "tool-result") {
          try {
            resultChars = JSON.stringify(toolOutput.output)?.length ?? null;
          } catch {
            resultChars = null;
          }
        }
        const failure =
          toolOutput.type === "tool-result"
            ? ""
            : toolOutput.error instanceof Error
              ? toolOutput.error.message
              : typeof toolOutput.error === "string"
                ? toolOutput.error
                : "";
        trace({
          kind: "tool",
          name: allowedToolNames.has(toolCall.toolName)
            ? toolCall.toolName
            : "unknown",
          status: toolOutput.type === "tool-result" ? "succeeded" : "failed",
          resultChars,
          reason: failure ? failure.slice(0, 200) : null,
        });
      },
    };

    const generate = options.generateText ?? generateText;

    // attemptLimit stays 3 for the initial/tool loop and ordinary repairs. The
    // single authorized fourth request passes MAX_TOTAL_REQUESTS instead.
    async function generateResponse(
      request: AgentRequest,
      isRepair: boolean,
      attemptLimit: number = MAX_STEPS,
    ): Promise<{
      text: string;
      finishReason: AgentTraceFinishReason | null;
    }> {
      if (attemptCount >= attemptLimit || generationCount >= MAX_STEPS) {
        throw new Error(`Batas ${attemptLimit} request AI per run tercapai.`);
      }
      generationCount += 1;
      currentPhase = isRepair ? "repair" : "initial";
      allowedToolNames = new Set(Object.keys(request.tools ?? {}));
      const remainingCalls = Math.max(1, attemptLimit - attemptCount);
      const tools = request.tools;
      const generation = generate({
        model: request.model,
        system: request.system,
        prompt: request.prompt,
        ...(request.providerOptions
          ? { providerOptions: request.providerOptions }
          : {}),
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        ...(tools
          ? {
              tools,
              stopWhen: stepCountIs(remainingCalls),
            }
          : {}),
        prepareStep: () => {
          controller.signal.throwIfAborted();
          if (attemptCount >= attemptLimit) {
            throw new Error(
              `Batas ${attemptLimit} request AI per run tercapai.`,
            );
          }
          // The last permitted provider request is reserved for prose. Without
          // this, a tool-heavy turn can spend every request on tool calls and
          // end with no final response at all. Providers such as Google AI
          // Studio ignore tool_choice "none" while a tool loop is in progress,
          // so the tool definitions are removed for that step; an empty tool
          // set is the only provider-agnostic way to force a text answer.
          if (tools && attemptCount >= attemptLimit - 1) {
            return {
              activeTools: [],
              toolChoice: "none" as const,
              maxOutputTokens: MAX_FINAL_OUTPUT_TOKENS,
            };
          }
        },
        maxRetries: 0,
        maxOutputTokens: isRepair
          ? MAX_REPAIR_OUTPUT_TOKENS
          : MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
        ...callbacks,
      });
      try {
        const result = await Promise.race([generation, aborted]);
        throwIfLatched();
        controller.signal.throwIfAborted();
        return {
          text: result.text,
          finishReason: normalizeFinishReason(result.finishReason),
        };
      } catch (error) {
        for (const callId of [...attempts.keys()]) {
          await finishAttempt(callId, "failed", undefined);
        }
        throw error;
      }
    }

    let result = await generateResponse(task.request, false);
    let repairCount = 0;
    while (true) {
      const outputLimit = result.finishReason === "length";
      const validation = task.validate({
        text: result.text,
        finishReason: result.finishReason,
      });
      throwIfLatched();
      controller.signal.throwIfAborted();
      if (validation.kind === "accepted") {
        trace({
          kind: "validation",
          status: "accepted",
          reason: null,
          textChars: result.text.length,
        });
        controller.signal.throwIfAborted();
        throwIfLatched();
        return validation.value;
      }
      trace({
        kind: "validation",
        status: "rejected",
        reason: validation.reason.slice(0, 400),
        textChars: result.text.length,
      });
      // Repairs may use whatever provider requests remain under the hard
      // 4-request cap, so a turn that only needed two requests for tools and a
      // first answer can still be corrected twice. A tool-heavy turn that
      // already spent three requests gets exactly one repair, as before.
      if (
        attemptCount >= MAX_TOTAL_REQUESTS ||
        generationCount >= MAX_STEPS ||
        repairCount >= MAX_REPAIRS
      ) {
        throw new NarratorResponseError(
          outputLimit ? "output_limit" : "invalid",
          repairCount,
          validation.reason,
          result.text.slice(0, 1_500),
        );
      }
      repairCount += 1;
      trace({ kind: "repair" });
      const repairRequest = task.repair({
        reason: validation.reason,
        previousText: result.text,
        suppressPreviousResponse: validation.suppressPreviousResponse,
      });
      throwIfLatched();
      controller.signal.throwIfAborted();
      result = await generateResponse(repairRequest, true, MAX_TOTAL_REQUESTS);
    }
  } finally {
    closed = true;
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
