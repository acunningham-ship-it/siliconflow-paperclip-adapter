/**
 * Model detection for the SiliconFlow adapter.
 *
 * Fetches the live model catalog from SiliconFlow's `/v1/models` endpoint
 * (OpenAI-compatible) so the Paperclip UI can show live availability.
 *
 * Note: SiliconFlow's API is hosted in China, so there is real latency from
 * US/EU callers (observed ~500ms-2s). We cap the fetch at 10s.
 */

import {
  DEFAULT_MODEL,
  PROVIDER_SLUG,
  SILICONFLOW_BASE_URL,
  AUTH_ENV_VAR,
  FREE_MODELS,
} from "../shared/constants.js";

export interface DetectedModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
  models?: Array<{ id: string; label: string }>;
}

interface SiliconFlowModel {
  id?: string;
  object?: string;
  owned_by?: string;
}

interface SiliconFlowModelsResponse {
  data?: SiliconFlowModel[];
}

const DETECTION_TIMEOUT_MS = 10_000;

function resolveApiKey(): string | null {
  const v = (process.env[AUTH_ENV_VAR] ?? "").trim();
  return v.length > 0 ? v : null;
}

export async function detectModel(): Promise<DetectedModel | null> {
  const apiKey = resolveApiKey();
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "siliconflow-paperclip-adapter/0.0.1",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${SILICONFLOW_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS),
    });
  } catch {
    // Network error / timeout — likely SF blocked or poor connectivity to China.
    return null;
  }

  if (!response.ok) return null;

  let body: SiliconFlowModelsResponse | null = null;
  try {
    body = (await response.json()) as SiliconFlowModelsResponse;
  } catch {
    return null;
  }

  if (!body || !Array.isArray(body.data)) return null;

  const freeSet = new Set<string>(FREE_MODELS);
  const ids: string[] = [];
  const models: Array<{ id: string; label: string }> = [];
  for (const m of body.data) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    ids.push(m.id);
    const isFree = freeSet.has(m.id);
    models.push({
      id: m.id,
      label: isFree ? `${m.id} — free` : m.id,
    });
  }

  // Preserve case-sensitive model ids ("org/Name") exactly as the server
  // reports them; Paperclip uses this string verbatim when calling chat/completions.
  return {
    model: DEFAULT_MODEL,
    provider: PROVIDER_SLUG,
    source: "siliconflow_models_endpoint",
    candidates: ids,
    models,
  };
}
