/**
 * Environment test for the SiliconFlow adapter.
 *
 * Validates:
 *   1. SILICONFLOW_API_KEY is reachable (agent config env > process env).
 *   2. Model is configured (or we fall back to DEFAULT_MODEL with a warn).
 *   3. The SiliconFlow /v1/models endpoint is reachable + auth works.
 *
 * Latency note: SiliconFlow is hosted in China, so a 8-10s timeout is
 * appropriate for this check — don't tighten it.
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  DEFAULT_MODEL,
  SILICONFLOW_BASE_URL,
} from "../shared/constants.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function makeCheck(
  level: AdapterEnvironmentCheckLevel,
  code: string,
  message: string,
  extras: { detail?: string | null; hint?: string | null } = {},
): AdapterEnvironmentCheck {
  return {
    code,
    level,
    message,
    detail: extras.detail ?? null,
    hint: extras.hint ?? null,
  };
}

function resolveEnv(config: Record<string, unknown>): Record<string, string> {
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

function checkApiKey(resolvedEnv: Record<string, string>): AdapterEnvironmentCheck {
  const fromConfig = resolvedEnv[AUTH_ENV_VAR];
  const fromProc = (process.env[AUTH_ENV_VAR] ?? "").trim();
  if (fromConfig) {
    return makeCheck("info", "siliconflow_api_key_found", `API key from agent.env.${AUTH_ENV_VAR}`);
  }
  if (fromProc) {
    return makeCheck("info", "siliconflow_api_key_found", `API key from process.env.${AUTH_ENV_VAR}`);
  }
  return makeCheck("error", "siliconflow_no_api_key", `${AUTH_ENV_VAR} not set`, {
    hint: `Set ${AUTH_ENV_VAR} in the agent adapter env or in the Paperclip server env.`,
  });
}

function checkModel(config: Record<string, unknown>): AdapterEnvironmentCheck {
  const model = asString(config.model);
  if (!model) {
    return makeCheck(
      "warn",
      "siliconflow_no_model",
      `No model specified — will fall back to "${DEFAULT_MODEL}"`,
      { hint: `Set adapterConfig.model to a SiliconFlow model id (e.g. "${DEFAULT_MODEL}").` },
    );
  }
  return makeCheck("info", "siliconflow_model_configured", `Model: ${model}`);
}

async function checkReachable(
  resolvedEnv: Record<string, string>,
): Promise<AdapterEnvironmentCheck> {
  const apiKey = resolvedEnv[AUTH_ENV_VAR] || (process.env[AUTH_ENV_VAR] ?? "").trim();
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "siliconflow-paperclip-adapter/0.0.1",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${SILICONFLOW_BASE_URL}/models`, {
      method: "GET",
      headers,
      // Generous 10s to account for trans-Pacific latency.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return makeCheck(
          "error",
          "siliconflow_auth_failed",
          `SiliconFlow rejected the API key (HTTP ${response.status})`,
          { hint: "Verify key at https://cloud.siliconflow.cn/account/ak" },
        );
      }
      return makeCheck(
        "warn",
        "siliconflow_models_endpoint_unhappy",
        `SiliconFlow /models returned HTTP ${response.status}`,
      );
    }
    return makeCheck("info", "siliconflow_reachable", "SiliconFlow /models endpoint reachable");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeCheck(
      "warn",
      "siliconflow_unreachable",
      "Could not reach SiliconFlow /models endpoint",
      {
        detail: message,
        hint: "SiliconFlow is hosted in China — verify outbound HTTPS from this host.",
      },
    );
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const resolvedEnv = resolveEnv(config);
  const checks: AdapterEnvironmentCheck[] = [];

  const apiKeyCheck = checkApiKey(resolvedEnv);
  checks.push(apiKeyCheck);
  checks.push(checkModel(config));
  if (apiKeyCheck.level !== "error") {
    checks.push(await checkReachable(resolvedEnv));
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
