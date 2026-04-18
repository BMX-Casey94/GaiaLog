# WhatsOnChain Plugin

GaiaLog includes a standalone WhatsOnChain data plugin package under:

```text
woc-plugin/gaialog-plugin
```

That package has its own `README.md` and should remain the package-level source of truth for:

- local development
- build and start commands
- webhook URL shapes
- payload decoding behaviour
- standalone deployment details

## Why this is separate

The main repository is the application and worker platform. The WoC plugin is a standalone package with its own runtime and packaging concerns.

## Quick pointer

See:

- `woc-plugin/gaialog-plugin/README.md`

for the plugin's detailed setup and webhook documentation.
