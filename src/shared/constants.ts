/**
 * SiliconFlow adapter — shared constants.
 */

export const ADAPTER_TYPE = "siliconflow_local";
export const ADAPTER_LABEL = "siliconflow_local";
export const PROVIDER_SLUG = "siliconflow";
export const BILLER_SLUG = "siliconflow";

export const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";

export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_GRACE_SEC = 10;

export const DEFAULT_PROMPT_TEMPLATE = `{{instructions}}

{{paperclipContext}}

{{taskBody}}`;

/**
 * Max number of tool-call <-> tool-result round trips per execute() call.
 * Guards against the model getting stuck in a tool loop.
 */
export const MAX_TOOL_ITERATIONS = 10;

/**
 * Free models known to work on SiliconFlow (April 2026).
 */
export const FREE_MODELS = [
  "deepseek-ai/DeepSeek-V3.2",
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "moonshotai/Kimi-K2.5-Instruct",
  "zai-org/GLM-5-9B-Chat",
  "Qwen/Qwen3-32B",
] as const;

/**
 * Paid/capability models known to expose chat + tools on SiliconFlow.
 * Used only for the static fallback ordering when the live /v1/models
 * probe fails — the live endpoint is authoritative when reachable.
 */
export const PAID_MODELS = [
  "deepseek-ai/DeepSeek-R1",
  "Qwen/Qwen3-235B-A22B-Thinking-2507",
] as const;

/**
 * Lowercased id substrings used to exclude non-chat models (embeddings,
 * rerankers, audio/TTS, image generation) from the listing.
 */
export const NON_CHAT_ID_FRAGMENTS = [
  "embedding",
  "embed",
  "bge-",
  "gte-",
  "rerank",
  "whisper",
  "tts",
  "speech",
  "audio",
  "stable-diffusion",
  "sdxl",
  "flux",
  "kolors",
  "janus",
  "cogview",
  "wan-",
] as const;

/**
 * Models known NOT to support OpenAI-style tool calling on SiliconFlow.
 * Best-effort denylist used when the live /v1/models metadata lacks a
 * `supports_tools` signal.
 */
export const KNOWN_NO_TOOLS_MODELS = [
  "zai-org/GLM-5-9B-Chat",
] as const;

export const AUTH_ENV_VAR = "SILICONFLOW_API_KEY";
