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
 * Free models known to work on SiliconFlow.
 */
export const FREE_MODELS = [
  "deepseek-ai/DeepSeek-V3.2",
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "moonshotai/Kimi-K2.5-Instruct",
  "zai-org/GLM-5-9B-Chat",
  "Qwen/Qwen3-32B"
] as const;

export const AUTH_ENV_VAR = "SILICONFLOW_API_KEY";
