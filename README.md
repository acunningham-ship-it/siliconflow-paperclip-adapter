# siliconflow-paperclip-adapter

> Paperclip adapter for SiliconFlow's free LLM tier.

Paperclip adapter for SiliconFlow's free pool (DeepSeek V3, Qwen 3, Kimi K2.5, GLM 5).

## Status

🚧 **v0.0.1 — scaffold only.** Implementation in progress.

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
