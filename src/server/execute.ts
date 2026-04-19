/**
 * SiliconFlow adapter — single-turn execute() implementation.
 *
 * Strategy: talk directly to SiliconFlow's OpenAI-compatible
 *   POST https://api.siliconflow.cn/v1/chat/completions
 * with `stream: true`. We parse the SSE body into a ParsedSiliconFlowStream
 * and translate that into an AdapterExecutionResult for Paperclip.
 *
 * Scope (v0.0.1):
 *   - Single-turn only. We send { role: "system", content: <prompt> } and
 *     one { role: "user", content: <taskBody> } message assembled from the
 *     prompt template.
 *   - No tool calling. TODO: wire up SiliconFlow's `tools` / `tool_choice`
 *     fields (OpenAI-compatible) and teach parse.ts to reassemble function
 *     call deltas.
 *   - No session resume. See parse.ts sessionCodec for the stub.
 *
 * Latency note: SiliconFlow's control plane is in China. For callers in the
 * US/EU expect connection-setup overhead of 300-2000ms on top of normal
 * inference time. We set generous timeouts and surface streaming to the
 * Paperclip `onLog` callback so the operator sees progress as bytes arrive.
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
import { parseSiliconFlowStream } from "./parse.js";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  BILLER_SLUG,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  PROVIDER_SLUG,
  SILICONFLOW_BASE_URL,
} from "../shared/constants.js";

function resolveApiKey(envConfig: Record<string, unknown>): string | null {
  const fromConfig = typeof envConfig[AUTH_ENV_VAR] === "string"
    ? (envConfig[AUTH_ENV_VAR] as string).trim()
    : "";
  if (fromConfig) return fromConfig;
  const fromProc = (process.env[AUTH_ENV_VAR] ?? "").trim();
  return fromProc.length > 0 ? fromProc : null;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const model = asString(config.model, DEFAULT_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const temperature = asNumber(config.temperature, 0.7);
  const maxTokens = asNumber(config.maxTokens, 0); // 0 = let server decide
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
  // Prompt assembly (mirrors openrouter/claude_local shape so operators
  // can reuse the same promptTemplate they already have).
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
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  // Build env for logging (we do not spawn a subprocess, but Paperclip's
  // onMeta expects an env summary so operators can audit what was used).
  const loggedEnv: Record<string, string> = { ...buildPaperclipEnv(agent) };
  loggedEnv.PAPERCLIP_RUN_ID = runId;
  loggedEnv[AUTH_ENV_VAR] = "***redacted***";

  const requestUrl = `${SILICONFLOW_BASE_URL}/chat/completions`;
  const requestBody: Record<string, unknown> = {
    model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  };
  if (temperature >= 0) requestBody.temperature = temperature;
  if (maxTokens > 0) requestBody.max_tokens = maxTokens;

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: requestUrl,
      commandArgs: ["POST", "/v1/chat/completions", `model=${model}`],
      commandNotes: [
        "Direct HTTPS to SiliconFlow OpenAI-compatible endpoint (China-based, expect extra RTT).",
        "Single-turn; no tool calling (TODO).",
      ],
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  // ------------------------------------------------------------------
  // Fire the streaming request.
  // ------------------------------------------------------------------
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "siliconflow-paperclip-adapter/0.0.1",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const aborted = (err as { name?: string })?.name === "AbortError";
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip-siliconflow] Request failed: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: aborted,
      errorMessage: aborted ? `Timed out after ${timeoutSec}s` : msg,
      errorCode: aborted ? "timeout" : "siliconflow_network_error",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "credits",
    };
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeoutHandle);
    const errorBody = await response.text().catch(() => "");
    await onLog(
      "stderr",
      `[paperclip-siliconflow] HTTP ${response.status}: ${errorBody.slice(0, 4000)}\n`,
    );
    const isAuth = response.status === 401 || response.status === 403;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `SiliconFlow returned HTTP ${response.status}`,
      errorCode: isAuth ? "siliconflow_auth_required" : "siliconflow_http_error",
      errorMeta: { httpStatus: response.status, body: errorBody.slice(0, 2000) },
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model,
      billingType: "credits",
      clearSession: isAuth,
    };
  }

  // ------------------------------------------------------------------
  // Consume SSE body as text chunks, forwarding each chunk to onLog so
  // the Paperclip UI sees streaming output in real time.
  // ------------------------------------------------------------------
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
      if (chunk) await onLog("stdout", chunk);
    }
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    timedOut = aborted;
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip-siliconflow] Stream read error: ${msg}\n`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const parsed = parseSiliconFlowStream(rawBody);

  if (timedOut) {
    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model: parsed.model || model,
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
      model: parsed.model || model,
      billingType: "credits",
      summary: parsed.text || null,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: parsed.usage ?? undefined,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: parsed.model || model,
    billingType: "credits",
    // SiliconFlow's free-pool models are priced at $0; paid ones are billed
    // on their side but they do not report per-call cost in the response.
    // Leave null to signal "unknown".
    costUsd: null,
    summary: parsed.text || null,
    resultJson: {
      finishReason: parsed.finishReason,
      lastChunkId: parsed.lastChunkId,
    },
  };
}
