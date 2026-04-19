/**
 * SiliconFlow adapter — SSE stream parser + session codec helpers.
 *
 * SiliconFlow exposes an OpenAI-compatible `/v1/chat/completions` endpoint.
 * When called with `stream: true` it emits Server-Sent Events, one JSON
 * payload per `data:` line, terminated by `data: [DONE]`.
 *
 * Each chunk looks like:
 *   { id, object, created, model,
 *     choices: [{ index, delta: { role?, content? }, finish_reason }],
 *     usage?: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * The final chunk (or the second-to-last, before [DONE]) carries the usage
 * block when the server is configured to emit it. SiliconFlow usually
 * does, but we guard for absence.
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface ParsedSiliconFlowStream {
  /** Concatenated assistant text across all delta chunks. */
  text: string;
  /** Model id reported by the server (may differ from the requested id). */
  model: string;
  /** Last `finish_reason` we saw, or null. */
  finishReason: string | null;
  /** Aggregated usage, or null if the server did not report it. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  } | null;
  /** Raw id of the last chunk (useful for debugging; not a session id). */
  lastChunkId: string | null;
  /** Error payload if the server sent `data: {"error": ...}` mid-stream. */
  error: string | null;
}

function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Parse a full SSE body produced by SiliconFlow's chat/completions stream.
 * Safe to call on a partial body (will simply return whatever was parsed so far).
 */
export function parseSiliconFlowStream(body: string): ParsedSiliconFlowStream {
  const out: ParsedSiliconFlowStream = {
    text: "",
    model: "",
    finishReason: null,
    usage: null,
    lastChunkId: null,
    error: null,
  };

  const textParts: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") break;

    const event = tryParseJson(payload);
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const obj = event as Record<string, unknown>;

    // Mid-stream error object: SiliconFlow occasionally returns
    // { "error": { "message": "...", "code": ... } } on the stream.
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      out.error = typeof err.message === "string" ? err.message : JSON.stringify(err);
      continue;
    }

    if (typeof obj.id === "string") out.lastChunkId = obj.id;
    if (typeof obj.model === "string" && !out.model) out.model = obj.model;

    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const c of choices) {
      if (!c || typeof c !== "object") continue;
      const choice = c as Record<string, unknown>;
      const delta = (choice.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta))
        ? (choice.delta as Record<string, unknown>)
        : null;
      if (delta && typeof delta.content === "string") {
        textParts.push(delta.content);
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        out.finishReason = choice.finish_reason;
      }
    }

    // Usage is typically sent on the final chunk before [DONE].
    const usage = obj.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as Record<string, unknown>;
      out.usage = {
        inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
        outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
        cachedInputTokens: 0,
      };
    }
  }

  out.text = textParts.join("");
  return out;
}

/**
 * Session codec. First-pass: we do not support multi-turn session resumption
 * (SiliconFlow is stateless — there is no server-side session id). We still
 * ship a codec so the Paperclip runtime has something to hand us. It simply
 * passes `sessionId` strings through unchanged, if one is provided.
 *
 * TODO: multi-turn. Persist a list of messages here and resend on resume.
 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
