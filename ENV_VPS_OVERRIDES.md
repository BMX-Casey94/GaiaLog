# VPS .env Overrides

After `git pull`, ensure your `.env` on the VPS includes these vars (merge from `env.vps.template` or add manually):

```bash
# Full rollout — enables all providers
GAIALOG_ROLLOUT_GATE=gate_d

# Overlay auth — use 'none' when workers and overlay run on same host (127.0.0.1)
BSV_OVERLAY_AUTH_MODE=none
GAIALOG_QUEUE_GATE_SOURCE=overlay
```

Then restart:

```bash
pm2 restart gaialog-workers gaialog-overlay
```

**Note:** `.env` is gitignored. Copy your `.env` to the VPS via `scp` or merge these overrides into the existing `.env` on the VPS.
