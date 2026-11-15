# Private DeepSeek adapter

`deepseek-0.2.2-rc.1.mjs` is the published `@deepseek-ai/dsh-llm-deepseek` 0.2.2-rc.1 `lib/index.js`, with Arcfold's existing exact transport patch applied. The upstream repository commit and the original and patched SHA-256 values are recorded in `patches/deepseek-0.2.2-rc.1-transport.json`. The upstream license is included as `LICENSE.deepseek`.

It is a private copy used only by the Desktop integration. The source still resolves the host's shared services, but its transport is controlled by Arcfold's per-request authority and metering. It does not modify the installed Desktop application or other plugins' copies of the provider.
