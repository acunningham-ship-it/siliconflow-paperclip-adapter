/**
 * SiliconFlow adapter — execute() implementation (v0.7).
 *
 * Talks directly to SiliconFlow's OpenAI-compatible
 *   POST https://api.siliconflow.cn/v1/chat/completions
 * with `stream: true`, now with full OpenAI-style tool calling:
 *
 *   1. Read tool definitions from `agentConfig.tools` (preferred) or
 *      `context.paperclipTools`. Each entry must already be in OpenAI
 *      `{ type: "function", function: { name, description, parameters } }`
 *      shape — no translation required.
 *   2. Pass `tools` + `tool_choice: "auto"` on every iteration.
 *   3. Stream each iteration, parse tool_calls deltas via parse.ts.
 *   4. On `finish_reason: "tool_calls"`: invoke each tool through
 *      `context.paperclipInvokeTool(name, argsJson)` if provided, append
 *      the assistant message + tool results, and loop (cap 10 iterations).
 *   5. Stop on `finish_reason: "stop"` (or anything non-"tool_calls").
 *
 * Tool-support guard: if the configured model is known NOT to support
 * tool calling AND the caller supplied tools, we return a graceful error
 * up front rather than letting SiliconFlow reject the request mid-stream.
 *
 * Latency note: SiliconFlow is based in China. Expect 300ms-2s extra RTT
 * from US/EU hosts per iteration. Timeouts are set generously.
 */

import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { parseSiliconFlowStream, type ParsedToolCall } from "./parse.js";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  BILLER_SLUG,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  KNOWN_NO_TOOLS_MODELS,
  MAX_TOOL_ITERATIONS,
  PROVIDER_SLUG,
  SILICONFLOW_BASE_URL,
} from "../shared/constants.js";

/** OpenAI-shape tool definition, passed through to SiliconFlow as-is. */
interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** OpenAI-shape message used for multi-turn conversation state. */
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ParsedToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type InvokeToolFn = (
  name: string,
  argsJson: string,
  toolCallId: string,
) => Promise<string> | string;

function resolveApiKey(envConfig: Record<string, unknown>): string | null {
  const fromConfig = typeof envConfig[AUTH_ENV_VAR] === "string"
    ? (envConfig[AUTH_ENV_VAR] as string).trim()
    : "";
  if (fromConfig) return fromConfig;
  const fromProc = (process.env[AUTH_ENV_VAR] ?? "").trim();
  return fromProc.length > 0 ? fromProc : null;
}

/**
 * Validate + normalize tool defs supplied by the caller. Anything that
 * doesn't match the OpenAI shape is dropped (with no hard failure — the
 * model will simply not see it).
 */
function normalizeTools(raw: unknown): OpenAIToolDef[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenAIToolDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const fn = rec.function;
    if (!fn || typeof fn !== "object") continue;
    const fnRec = fn as Record<string, unknown>;
    const name = typeof fnRec.name === "string" ? fnRec.name.trim() : "";
    if (!name) continue;
    const def: OpenAIToolDef = {
      type: "function",
      function: { name },
    };
    if (typeof fnRec.description === "string" && fnRec.description.length > 0) {
      def.function.description = fnRec.description;
    }
    if (fnRec.parameters && typeof fnRec.parameters === "object") {
      def.function.parameters = fnRec.parameters as Record<string, unknown>;
    }
    out.push(def);
  }
  return out;
}

/**
 * Extract tool definitions from config or context. Config wins.
 */
function resolveTools(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): OpenAIToolDef[] {
  const fromConfig = normalizeTools(config.tools);
  if (fromConfig.length > 0) return fromConfig;
  return normalizeTools(context.paperclipTools);
}

/**
 * Look up the Paperclip tool invocation callback on the context, if any.
 * The wider Paperclip runtime may inject one; when absent we fall back to
 * returning a structured error for every tool call so the conversation
 * still makes progress.
 */
function resolveInvokeTool(
  context: Record<string, unknown>,
): InvokeToolFn | null {
  const candidate = (context as { paperclipInvokeTool?: unknown })
    .paperclipInvokeTool;
  return typeof candidate === "function"
    ? (candidate as InvokeToolFn)
    : null;
}

const KNOWN_NO_TOOLS_SET = new Set<string>(KNOWN_NO_TOOLS_MODELS);

/**
 * Heuristic: does the given model support tool calling? We read this off
 * the adapter's own `models` array metadata when present, else fall back
 * to the static denylist. Kept deliberately permissive — false positives
 * just mean we try and let SiliconFlow reject.
 */
function supportsTools(
  model: string,
  config: Record<string, unknown>,
): boolean {
  // Operator can force-disable via config to route around buggy providers.
  if (config.supportsTools === false) return false;
  if (KNOWN_NO_TOOLS_SET.has(model)) return false;
  // Per-model metadata lookup from the loaded models array is optional;
  // if a caller attached a `supportsTools` hint on the config we trust it.
  if (typeof config.supportsTools === "boolean") return config.supportsTools;
  return true;
}

/**
 * Fire a single streaming chat/completions request and return the parsed
 * result, along with rawBody for transcript audit.
 */
async function streamOnce(args: {
  apiKey: string;
  body: Record<string, unknown>;
  timeoutSec: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<
  | {
      ok: true;
      parsed: ReturnType<typeof parseSiliconFlowStream>;
      rawBody: string;
      timedOut: boolean;
    }
  | {
      ok: false;
      httpStatus: number;
      errorBody: string;
      aborted: boolean;
      networkError: string | null;
    }
> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    args.timeoutSec * 1000,
  );

  let response: Response;
  try {
    response = await fetch(`${SILICONFLOW_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${args.apiKey}`,
        "user-agent": "siliconflow-paperclip-adapter/0.7.0",
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const aborted = (err as { name?: string })?.name === "AbortError";
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      errorBody: "",
      aborted,
      networkError: msg,
    };
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeoutHandle);
    const errorBody = await response.text().catch(() => "");
    return {
      ok: false,
      httpStatus: response.status,
      errorBody,
      aborted: false,
      networkError: null,
    };
  }

  const decoder = new TextDecoder();
  let rawBody = "";
  let timedOut = false;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawBody += chunk;
      if (chunk) await args.onLog("stdout", chunk);
    }
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    timedOut = aborted;
    const msg = err instanceof Error ? err.message : String(err);
    await args.onLog(
      "stderr",
      `[paperclip-siliconflow] Stream read error: ${msg}\n`,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  return {
    ok: true,
    parsed: parseSiliconFlowStream(rawBody),
    rawBody,
    timedOut,
  };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const model = asString(config.model, DEFAULT_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const temperature = asNumber(config.temperature, 0.7);
  const maxTokens = asNumber(config.maxTokens, 0);
  const envConfig = parseObject(config.env);

  const apiKey = resolveApiKey(envConfig);
  if (!apiKey) {
    await onLog(
      "stderr",
      `[paperclip-siliconflow] Missing ${AUTH_ENV_VAR}. Set it on agent config env or process env.\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Missing ${AUTH_ENV_VAR}`,
      errorCode: "siliconflow_no_api_key",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "credits",
      clearSession: true,
    };
  }

  // ------------------------------------------------------------------
  // Prompt + tool resolution.
  // ------------------------------------------------------------------
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: false,
  });
  const sessionHandoffNote = asString(
    context.paperclipSessionHandoffMarkdown,
    "",
  ).trim();
  const prompt = joinPromptSections([
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const tools = resolveTools(config, context);
  const invokeTool = resolveInvokeTool(context);

  // Graceful early exit when the operator wired tools to a model that
  // cannot execute them.
  if (tools.length > 0 && !supportsTools(model, config)) {
    const msg = `Model ${model} does not support tool calling on SiliconFlow.`;
    await onLog("stderr", `[paperclip-siliconflow] ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: msg,
      errorCode: "siliconflow_tools_unsupported",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "credits",
    };
  }

  const loggedEnv: Record<string, string> = { ...buildPaperclipEnv(agent) };
  loggedEnv.PAPERCLIP_RUN_ID = runId;
  loggedEnv[AUTH_ENV_VAR] = "***redacted***";

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: `${SILICONFLOW_BASE_URL}/chat/completions`,
      commandArgs: ["POST", "/v1/chat/completions", `model=${model}`],
      commandNotes: [
        "Direct HTTPS to SiliconFlow OpenAI-compatible endpoint (China-based, expect extra RTT).",
        tools.length > 0
          ? `Tool calling enabled: ${tools.length} tool(s), max ${MAX_TOOL_ITERATIONS} iterations.`
          : "Tool calling disabled (no tools supplied).",
      ],
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
        toolCount: tools.length,
      },
      context,
    });
  }

  // ------------------------------------------------------------------
  // Conversation state — seeded with the rendered prompt as a single user
  // turn. Tool loop appends assistant + tool messages per iteration.
  // ------------------------------------------------------------------
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

  let aggregateInputTokens = 0;
  let aggregateOutputTokens = 0;
  let aggregateCachedInputTokens = 0;
  let lastModelReported = model;
  let lastChunkId: string | null = null;
  let lastFinishReason: string | null = null;
  let finalText = "";
  const iterationsMeta: Array<{
    iteration: number;
    finishReason: string | null;
    toolCalls: number;
  }> = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const requestBody: Record<string, unknown> = {
      model,
      stream: true,
      messages,
    };
    if (temperature >= 0) requestBody.temperature = temperature;
    if (maxTokens > 0) requestBody.max_tokens = maxTokens;
    if (tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }

    const result = await streamOnce({
      apiKey,
      body: requestBody,
      timeoutSec,
      onLog,
    });

    if (!result.ok) {
      const isAuth = result.httpStatus === 401 || result.httpStatus === 403;
      if (result.networkError) {
        await onLog(
          "stderr",
          `[paperclip-siliconflow] Request failed: ${result.networkError}\n`,
        );
        return {
          exitCode: 1,
          signal: null,
          timedOut: result.aborted,
          errorMessage: result.aborted
            ? `Timed out after ${timeoutSec}s`
            : result.networkError,
          errorCode: result.aborted ? "timeout" : "siliconflow_network_error",
          provider: PROVIDER_SLUG,
          biller: BILLER_SLUG,
          model: lastModelReported,
          billingType: "credits",
        };
      }
      await onLog(
        "stderr",
        `[paperclip-siliconflow] HTTP ${result.httpStatus}: ${result.errorBody.slice(0, 4000)}\n`,
      );
      // SiliconFlow returns 400 with a helpful message when a model does
      // not support tools; surface that cleanly.
      const looksLikeToolsUnsupported =
        result.httpStatus === 400 &&
        /tool/i.test(result.errorBody) &&
        tools.length > 0;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: looksLikeToolsUnsupported
          ? `Model ${model} does not support tool calling on SiliconFlow.`
          : `SiliconFlow returned HTTP ${result.httpStatus}`,
        errorCode: isAuth
          ? "siliconflow_auth_required"
          : looksLikeToolsUnsupported
            ? "siliconflow_tools_unsupported"
            : "siliconflow_http_error",
        errorMeta: {
          httpStatus: result.httpStatus,
          body: result.errorBody.slice(0, 2000),
        },
        provider: PROVIDER_SLUG,
        biller: BILLER_SLUG,
        model: lastModelReported,
        billingType: "credits",
        clearSession: isAuth,
      };
    }

    const parsed = result.parsed;
    if (parsed.model) lastModelReported = parsed.model;
    if (parsed.lastChunkId) lastChunkId = parsed.lastChunkId;
    lastFinishReason = parsed.finishReason;
    if (parsed.usage) {
      aggregateInputTokens += parsed.usage.inputTokens;
      aggregateOutputTokens += parsed.usage.outputTokens;
      aggregateCachedInputTokens += parsed.usage.cachedInputTokens;
    }

    iterationsMeta.push({
      iteration: iter,
      finishReason: parsed.finishReason,
      toolCalls: parsed.toolCalls.length,
    });

    if (result.timedOut) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        provider: PROVIDER_SLUG,
        biller: BILLER_SLUG,
        model: lastModelReported,
        billingType: "credits",
        summary: parsed.text || null,
      };
    }

    if (parsed.error) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: parsed.error,
        errorCode: "siliconflow_stream_error",
        provider: PROVIDER_SLUG,
        biller: BILLER_SLUG,
        model: lastModelReported,
        billingType: "credits",
        summary: parsed.text || null,
      };
    }

    // Non-tool-calls finish (stop, length, content_filter, ...) — done.
    if (parsed.finishReason !== "tool_calls" || parsed.toolCalls.length === 0) {
      finalText = parsed.text;
      break;
    }

    // Record the assistant turn (with tool_calls) in conversation state.
    messages.push({
      role: "assistant",
      content: parsed.text || null,
      tool_calls: parsed.toolCalls,
    });

    // Execute each tool and append the result as a `tool` message.
    for (const call of parsed.toolCalls) {
      let resultStr: string;
      if (invokeTool) {
        try {
          const invoked = await invokeTool(
            call.function.name,
            call.function.arguments || "{}",
            call.id,
          );
          resultStr = typeof invoked === "string" ? invoked : JSON.stringify(invoked);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          resultStr = JSON.stringify({ error: msg });
        }
      } else {
        // No executor wired — surface a structured error so the model can
        // decide to continue with a textual fallback rather than hang.
        resultStr = JSON.stringify({
          error:
            "Tool invocation is not supported in this Paperclip runtime " +
            "(context.paperclipInvokeTool is not set).",
        });
      }
      await onLog(
        "stdout",
        `\n[paperclip-siliconflow] tool_result ${call.function.name} (${call.id}): ${resultStr.slice(0, 400)}\n`,
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultStr,
      });
    }

    // Carry the last text forward in case the final iteration is a pure
    // tool iteration that never emits more content.
    if (parsed.text) finalText = parsed.text;

    // Loop — another streamed completion with the appended context.
  }

  // If we fell out of the loop by exceeding MAX_TOOL_ITERATIONS (last
  // iteration still asked for tool_calls), treat as a graceful stop but
  // flag it for the caller.
  const hitIterationCap =
    lastFinishReason === "tool_calls" &&
    iterationsMeta.length === MAX_TOOL_ITERATIONS;

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: hitIterationCap
      ? `Reached ${MAX_TOOL_ITERATIONS}-iteration tool-loop cap.`
      : null,
    errorCode: hitIterationCap ? "siliconflow_tool_loop_cap" : null,
    usage:
      aggregateInputTokens > 0 || aggregateOutputTokens > 0
        ? {
            inputTokens: aggregateInputTokens,
            outputTokens: aggregateOutputTokens,
            cachedInputTokens: aggregateCachedInputTokens,
          }
        : undefined,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: lastModelReported,
    billingType: "credits",
    // SiliconFlow does not report per-call cost.
    costUsd: null,
    summary: finalText || null,
    resultJson: {
      finishReason: lastFinishReason,
      lastChunkId,
      iterations: iterationsMeta,
      toolCallsRequested: tools.length,
    },
  };
}
