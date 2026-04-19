# siliconflow-paperclip-adapter

> Paperclip adapter for SiliconFlow's free LLM tier.

Paperclip adapter for SiliconFlow's free pool (DeepSeek V3, Qwen 3, Kimi K2.5, GLM 5).

## Status

## Status (updated 2026-04-19)

✅ **v0.5.0 — installable + LLM streaming verified working in Paperclip.**

```bash
# Install via Paperclip dashboard "Install Adapter" or:
curl -X POST http://localhost:3101/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/siliconflow-paperclip-adapter","isLocalPath":true}'
```

Then configure agents with:
```json
{"adapterType":"siliconflow_local","adapterConfig":{"model":"...","env":{"SILICONFLOW_API_KEY":{"type":"plain","value":"YOUR_KEY"}}}}
```

**Pending for v1.0:**
- Tool calling (currently no way for agent to post back to Paperclip issues)
- Multi-turn session resume
- 429 backoff

Part of the [Free LLM Adapter Pack](https://github.com/acunningham-ship-it) for Paperclip.

## Authentication

Set environment variable:

```bash
export SILICONFLOW_API_KEY=your_key_here
```

## Installation (when v1 ships)

```bash
npm install -g siliconflow-paperclip-adapter
```

## Agent configuration

```json
{
  "adapterType": "siliconflow_local",
  "adapterConfig": {
    "model": "deepseek-ai/DeepSeek-V3.2",
    "timeoutSec": 300
  }
}
```

## Available free models

See `FREE_MODELS` in `src/shared/constants.ts`.

## Roadmap

- v0.0.1 (now) — scaffold + README
- v0.5.0 — execute.ts MVP
- v1.0.0 — production-ready, launches with Free LLM Adapter Pack

## License

MIT — Armani Cunningham, 2026.
