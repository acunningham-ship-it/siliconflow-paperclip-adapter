/**
 * Server-side barrel for the SiliconFlow adapter.
 *
 * Re-exports the public adapter surface. SiliconFlow is stateless on the
 * server side, so the session codec is a pass-through stub (see parse.ts).
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel } from "./detect-model.js";
export { sessionCodec } from "./parse.js";
