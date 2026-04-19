/**
 * SiliconFlow Paperclip adapter — main entry.
 *
 * v0.0.1: scaffold. Implementation TBD.
 */

import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  DEFAULT_MODEL,
  AUTH_ENV_VAR,
} from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models = [];

export const agentConfigurationDoc = `# SiliconFlow Adapter Configuration

Free LLM access via SiliconFlow. Requires \`SILICONFLOW_API_KEY\` env var.

## Core configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | deepseek-ai/DeepSeek-V3.2 | Model id |
| timeoutSec | number | 300 | Execution timeout |

See FREE_MODELS in src/shared/constants.ts for available free models.
`;

// TODO(Dev Team): implement createServerAdapter() factory
