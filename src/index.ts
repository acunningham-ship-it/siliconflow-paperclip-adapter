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
  KNOWN_NO_TOOLS_MODELS,
  NON_CHAT_ID_FRAGMENTS,
  PAID_MODELS,
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
 * Extended model shape. `AdapterModel` in the SDK is currently `{id,label}`
 * only; we attach extra metadata (free, contextWindow, supportsTools) as
 * loosely-typed optional fields so downstream consumers (UI / model-pickers
 * / cost estimators) can read them when present. TypeScript structural
 * typing keeps this compatible with the SDK contract.
 */
type EnrichedAdapterModel = AdapterModel & {
  free?: boolean;
  contextWindow?: number;
  supportsTools?: boolean;
};

const FREE_SET = new Set<string>(FREE_MODELS);
const KNOWN_NO_TOOLS_SET = new Set<string>(KNOWN_NO_TOOLS_MODELS);

/** Filter: skip embedding / reranker / audio / image models. */
function isChatCapable(id: string): boolean {
  const lower = id.toLowerCase();
  for (const frag of NON_CHAT_ID_FRAGMENTS) {
    if (lower.includes(frag)) return false;
  }
  return true;
}

/**
 * Tool-calling support heuristic. Prefers the live `supports_tools` field
 * when SiliconFlow exposes it; otherwise falls back to a denylist.
 */
function inferSupportsTools(id: string, live: unknown): boolean {
  if (typeof live === "boolean") return live;
  if (KNOWN_NO_TOOLS_SET.has(id)) return false;
  // Default assumption: modern SiliconFlow chat models speak OpenAI tools.
  return true;
}

/** Rough capability rank for sort-order tie breaking (higher = better). */
function capabilityRank(id: string): number {
  const lower = id.toLowerCase();
  // Heuristic: bigger / newer families first.
  if (lower.includes("deepseek-v3")) return 95;
  if (lower.includes("deepseek-r1")) return 94;
  if (lower.includes("qwen3-235b")) return 90;
  if (lower.includes("kimi-k2")) return 88;
  if (lower.includes("qwen3-32b")) return 80;
  if (lower.includes("glm-5")) return 75;
  if (lower.includes("qwen3")) return 70;
  return 50;
}

function buildLabel(id: string, free: boolean, supportsTools: boolean): string {
  const tags: string[] = [];
  if (free) tags.push("free");
  if (!supportsTools) tags.push("no-tools");
  return tags.length > 0 ? `${id} — ${tags.join(", ")}` : id;
}

/**
 * Static fallback for the model list. Seeded with FREE_MODELS + known paid
 * models so the UI always has something coherent when /v1/models is
 * unreachable (e.g. a trans-Pacific connectivity blip).
 */
const STATIC_FALLBACK: EnrichedAdapterModel[] = [
  ...FREE_MODELS.map((id) => ({
    id,
    free: true,
    supportsTools: !KNOWN_NO_TOOLS_SET.has(id),
    label: buildLabel(id, true, !KNOWN_NO_TOOLS_SET.has(id)),
  })),
  ...PAID_MODELS.map((id) => ({
    id,
    free: false,
    supportsTools: true,
    label: buildLabel(id, false, true),
  })),
];

interface LiveModelRecord {
  id?: string;
  context_length?: unknown;
  context_window?: unknown;
  max_context_length?: unknown;
  supports_tools?: unknown;
  pricing?: unknown;
}

function asNumberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function inferFree(id: string, record: LiveModelRecord): boolean {
  if (FREE_SET.has(id)) return true;
  // Some providers indicate free via zero pricing; be permissive.
  const pricing = record.pricing;
  if (pricing && typeof pricing === "object") {
    const p = pricing as Record<string, unknown>;
    const inCost = asNumberOrUndef(p.input) ?? asNumberOrUndef(p.prompt);
    const outCost = asNumberOrUndef(p.output) ?? asNumberOrUndef(p.completion);
    if (inCost === 0 && outCost === 0) return true;
  }
  return false;
}

async function loadModels(): Promise<EnrichedAdapterModel[]> {
  try {
    const apiKey = (process.env[AUTH_ENV_VAR] ?? "").trim();
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const resp = await fetch(`${SILICONFLOW_BASE_URL}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return STATIC_FALLBACK;
    const body = (await resp.json()) as { data?: LiveModelRecord[] };
    if (!body || !Array.isArray(body.data)) return STATIC_FALLBACK;

    const out: EnrichedAdapterModel[] = [];
    for (const m of body.data) {
      if (!m || typeof m.id !== "string" || !m.id) continue;
      const id = m.id;
      if (!isChatCapable(id)) continue;
      const free = inferFree(id, m);
      const supportsTools = inferSupportsTools(id, m.supports_tools);
      const contextWindow =
        asNumberOrUndef(m.context_length) ??
        asNumberOrUndef(m.context_window) ??
        asNumberOrUndef(m.max_context_length);
      out.push({
        id,
        label: buildLabel(id, free, supportsTools),
        free,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        supportsTools,
      });
    }

    // Sort: free first, then by capability rank desc, then alpha.
    out.sort((a, b) => {
      const aFree = a.free ? 0 : 1;
      const bFree = b.free ? 0 : 1;
      if (aFree !== bFree) return aFree - bFree;
      const rankDiff = capabilityRank(b.id) - capabilityRank(a.id);
      if (rankDiff !== 0) return rankDiff;
      return a.id.localeCompare(b.id);
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

## Tool Calling (v0.7)

The adapter now speaks OpenAI-style tool calling. Pass tool definitions in
\`agentConfig.tools\` (array of \`{ type: "function", function: {...} }\`
entries) or via \`context.paperclipTools\`. The adapter will:

1. Forward them to SiliconFlow with \`tool_choice: "auto"\`.
2. Stream the response, reassemble \`tool_calls\` deltas.
3. On \`finish_reason: "tool_calls"\`, invoke each tool through
   \`context.paperclipInvokeTool(name, args)\` if provided, otherwise record
   the call + an error stub and continue.
4. Loop until \`finish_reason: "stop"\` or ${DEFAULT_TIMEOUT_SEC}s elapse,
   capped at 10 iterations.

Models with \`supportsTools: false\` reject the call up front with a
graceful error.

## Limitations

- **No per-call cost reporting.** SiliconFlow does not return cost in the
  chat/completions response; \`costUsd\` is always \`null\`.
- **No session resume.** Each run starts fresh (SiliconFlow is stateless).
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
