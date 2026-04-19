/**
 * SiliconFlow Paperclip adapter — main entry.
 *
 * Talks directly to SiliconFlow's OpenAI-compatible chat/completions
 * endpoint (https://api.siliconflow.cn/v1). No CLI subprocess — we do the
 * HTTPS call + SSE parsing in-process.
 *
 * Scope (v0.0.1):
 *   - Single-turn only. No tool calling. TODO: wire up `tools` / reassemble
 *     function-call deltas in parse.ts.
 *   - No session resume — SiliconFlow is stateless. sessionCodec is a
 *     pass-through stub so the Paperclip runtime has something to hand us.
 *
 * Latency: SiliconFlow is based in China. Expect 300ms-2s extra RTT from
 * US/EU hosts. All timeouts in this adapter are set generously (10s for
 * model-list probes, 300s default for completions).
 *
 * @packageDocumentation
 */

import type {
  AdapterConfigSchema,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  FREE_MODELS,
  SILICONFLOW_BASE_URL,
} from "./shared/constants.js";
import {
  detectModel,
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Static fallback for the model list. Populated from FREE_MODELS so the UI
 * has something to show when the /v1/models fetch at boot fails (e.g.
 * trans-Pacific connectivity issue).
 */
const STATIC_FALLBACK: AdapterModel[] = FREE_MODELS.map((id) => ({
  id,
  label: `${id} — free`,
}));

async function loadModels(): Promise<AdapterModel[]> {
  try {
    const apiKey = (process.env[AUTH_ENV_VAR] ?? "").trim();
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const resp = await fetch(`${SILICONFLOW_BASE_URL}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return STATIC_FALLBACK;
    const body = (await resp.json()) as { data?: Array<{ id?: string }> };
    if (!body || !Array.isArray(body.data)) return STATIC_FALLBACK;
    const freeSet = new Set<string>(FREE_MODELS);
    const out: AdapterModel[] = [];
    for (const m of body.data) {
      if (!m || typeof m.id !== "string" || !m.id) continue;
      out.push({
        id: m.id,
        label: freeSet.has(m.id) ? `${m.id} — free` : m.id,
      });
    }
    // Put free models first, keep the rest in server order.
    out.sort((a, b) => {
      const aFree = freeSet.has(a.id) ? 0 : 1;
      const bFree = freeSet.has(b.id) ? 0 : 1;
      return aFree - bFree;
    });
    return out.length > 0 ? out : STATIC_FALLBACK;
  } catch {
    return STATIC_FALLBACK;
  }
}

export const models: AdapterModel[] = await loadModels();

export const agentConfigurationDoc = `# SiliconFlow Adapter

Free/cheap LLM access via [SiliconFlow](https://siliconflow.cn)'s
OpenAI-compatible API. Hosts DeepSeek V3.2, Qwen 3, Kimi K2.5, GLM 5, and more.

## Prerequisites

- A SiliconFlow API key: https://cloud.siliconflow.cn/account/ak
- Outbound HTTPS connectivity to \`api.siliconflow.cn\` (the host is in China,
  so expect extra round-trip latency from US/EU callers).

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | \`${DEFAULT_MODEL}\` | SiliconFlow model id. Use "org/Name" exactly as reported. |
| timeoutSec | number | ${DEFAULT_TIMEOUT_SEC} | Hard timeout for a single run. |
| temperature | number | 0.7 | Sampling temperature. |
| maxTokens | number | _(server default)_ | Max output tokens; 0 means let the server choose. |
| env | object | \`{}\` | Extra env vars. \`${AUTH_ENV_VAR}\` here is preferred. |

## Environment Variables

The adapter reads \`${AUTH_ENV_VAR}\` in this order:
1. \`agentConfig.env.${AUTH_ENV_VAR}\`
2. \`process.env.${AUTH_ENV_VAR}\`

## Free Models (no billing)

${FREE_MODELS.map((m) => `- \`${m}\``).join("\n")}

## Limitations (v0.0.1)

- **Single-turn only.** Every run starts a fresh conversation.
- **No tool calling.** TODO — the SiliconFlow API supports OpenAI-style
  \`tools\` / \`tool_choice\`, but the adapter does not yet translate
  Paperclip's tool protocol to them.
- **No per-call cost reporting.** SiliconFlow does not return cost in the
  chat/completions response; \`costUsd\` is always \`null\`.
`;

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "timeoutSec",
      label: "Timeout (seconds)",
      type: "number",
      default: DEFAULT_TIMEOUT_SEC,
      required: false,
      hint: "SiliconFlow is hosted in China — keep this generous (300s+).",
    },
    {
      key: "temperature",
      label: "Temperature",
      type: "number",
      default: 0.7,
      required: false,
    },
    {
      key: "maxTokens",
      label: "Max output tokens",
      type: "number",
      default: 0,
      required: false,
      hint: "0 = server default.",
    },
    {
      key: "promptTemplate",
      label: "Prompt template",
      type: "textarea",
      default: DEFAULT_PROMPT_TEMPLATE,
      required: false,
    },
  ],
};

/**
 * Factory invoked by the Paperclip plugin loader.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    models,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema: () => configSchema,
    supportsInstructionsBundle: false,
  };
}

export default createServerAdapter;
