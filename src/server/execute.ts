/**
 * SiliconFlow adapter — execute single agent run.
 *
 * v0.0.1: STUB.
 *
 * Strategy: streaming OpenAI-format HTTP client targeting
 *   https://api.siliconflow.cn/v1/chat/completions
 * with Bearer \$SILICONFLOW_API_KEY.
 *
 * Reference: openrouter-paperclip-adapter at
 *   /home/armani/adapters/openrouter-paperclip-adapter/src/server/execute.ts
 */

// TODO(Dev Team):
// 1. Streaming chat-completions client
// 2. Tool-call passthrough — Paperclip protocol → OpenAI function calling → back
// 3. Session resume via stored conversation history
// 4. Cost tracking (log token usage even if free)
// 5. Error handling: 429 (rate limit) → backoff, 401 → token error, 5xx → temp fail
// 6. Test with each model in FREE_MODELS

export async function execute(): Promise<never> {
  throw new Error("siliconflow-paperclip-adapter v0.0.1 is a scaffold; execute() not yet implemented");
}
