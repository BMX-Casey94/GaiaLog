/**
 * PM2 Ecosystem Configuration for GaiaLog VPS Deployment
 *
 * Runs three processes:
 *   1. gaialog-web      — Next.js production server (port 3000)
 *   2. gaialog-overlay  — Private loopback overlay lookup/submit service
 *   3. gaialog-workers  — Background workers
 *                         (data collection, queue, in-process UTXO maintainer,
 *                          confirmation worker, wallet funding monitor)
 *
 * UTXO inventory (important):
 *   The DB-backed UTXO splitter (`lib/utxo-maintainer.ts`) runs INSIDE
 *   `gaialog-workers` and is the *only* component that can refill the
 *   `overlay_admitted_utxos` pool the broadcast path actually consumes from.
 *   The legacy file-backed `gaialog-utxo-manager` (Python) and
 *   `gaialog-utxo-replenish` (TypeScript) processes were removed because
 *   they monitored a parallel inventory that the workers never read from,
 *   so they could not prevent inventory starvation. They remain available
 *   as scripts (`scripts/emergency-utxo-manager.py`,
 *   `scripts/utxo-auto-replenish.ts`) for break-glass emergency-legacy mode
 *   only — gated by `GAIALOG_EMERGENCY_LEGACY_UTXO=true`.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save          # persist across reboots
 *   pm2 startup       # generate systemd auto-start hook
 *   pm2 logs           # tail all logs
 *   pm2 monit          # live dashboard
 *
 * Worker restart strategy:
 *   Provider cursors are now DB-persisted so workers can run continuously
 *   without losing coverage progress. Periodic restarts are no longer needed
 *   to work around in-memory cursor resets.
 *
 *   Queue items persist across restarts (worker_queue DB table); any items marked
 *   'processing' at kill-time are automatically reclaimed as 'queued' after 2 minutes
 *   by loadPendingQueueItems(). On-chain dedup checks (hasAirQualityTxId etc.) prevent
 *   re-broadcasting records that were already confirmed before the restart.
 *
 *   kill_timeout gives the SIGINT handler 8 seconds to drain gracefully before SIGKILL.
 */

// Load .env so overlay/worker vars are passed to PM2 processes.
// override: true — file wins over stale shell/PM2 env (e.g. old BSV_QUEUE_CONCURRENCY).
require('dotenv').config({
  path: require('path').join(__dirname, '.env'),
  override: true,
})

module.exports = {
  apps: [
    {
      name: 'gaialog-web',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=4096',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        GAIALOG_WORKER_PROCESS: '0',
        GAIALOG_SINGLE_WRITER_MODE: 'run-workers',
        GAIALOG_MUTATOR_ROLE: 'secondary',
        EXPLORER_READ_SOURCE: process.env.EXPLORER_READ_SOURCE || 'overlay',
        EXPLORER_WRITE_MODE: process.env.EXPLORER_WRITE_MODE || 'overlay',
      },
      max_memory_restart: '3G',
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '30s',
      exp_backoff_restart_delay: 1000,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/web-error.log',
      out_file: 'logs/web-out.log',
      merge_logs: true,
      log_type: 'json',
    },
    {
      name: 'gaialog-overlay',
      script: 'node',
      args: ['--import', 'tsx', 'scripts/run-overlay-server.ts'],
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        GAIALOG_WORKER_PROCESS: '0',
        GAIALOG_SINGLE_WRITER_MODE: 'run-workers',
        GAIALOG_MUTATOR_ROLE: 'secondary',
        GAIALOG_OVERLAY_RATE_LIMIT_MAX: process.env.GAIALOG_OVERLAY_RATE_LIMIT_MAX || '20000',
        GAIALOG_OVERLAY_AUDIT_HMAC_SECRET: process.env.GAIALOG_OVERLAY_AUDIT_HMAC_SECRET,
        GAIALOG_OVERLAY_SERVER_IDENTITY_WIF: process.env.GAIALOG_OVERLAY_SERVER_IDENTITY_WIF,
        EXPLORER_READ_SOURCE: process.env.EXPLORER_READ_SOURCE || 'overlay',
        EXPLORER_WRITE_MODE: process.env.EXPLORER_WRITE_MODE || 'overlay',
      },
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '30s',
      exp_backoff_restart_delay: 1000,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/overlay-error.log',
      out_file: 'logs/overlay-out.log',
      merge_logs: true,
      log_type: 'json',
    },
    {
      name: 'gaialog-workers',
      script: 'node',
      args: ['--max-old-space-size=8192', '--import', 'tsx', 'scripts/run-workers.ts'],
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
        GAIALOG_WORKER_PROCESS: '1',
        GAIALOG_SINGLE_WRITER_MODE: 'run-workers',
        GAIALOG_MUTATOR_ROLE: 'primary',
        BSV_OVERLAY_AUTH_MODE: 'none',  // Force none for VPS localhost overlay; brc104 needs /.well-known/auth
        BSV_OVERLAY_CLIENT_IDENTITY_WIF: process.env.BSV_OVERLAY_CLIENT_IDENTITY_WIF,
        BSV_OVERLAY_TIMEOUT_MS: process.env.BSV_OVERLAY_TIMEOUT_MS || '10000',
        BSV_OVERLAY_MAX_RETRIES: process.env.BSV_OVERLAY_MAX_RETRIES || '1',
        BSV_QUEUE_CONCURRENCY: process.env.BSV_QUEUE_CONCURRENCY || '2',
        BSV_ARC_ACCEPT_ORPHAN_MEMPOOL: process.env.BSV_ARC_ACCEPT_ORPHAN_MEMPOOL ?? 'false',
        BSV_WALLET_PICK_BY_CONFIRMED_FIRST: process.env.BSV_WALLET_PICK_BY_CONFIRMED_FIRST ?? 'true',
        BSV_HEAP_GUARD_ENABLED: process.env.BSV_HEAP_GUARD_ENABLED ?? 'false',
        BSV_HEAP_GUARD_HIGH_WATERMARK: process.env.BSV_HEAP_GUARD_HIGH_WATERMARK || '0.98',
        BSV_HEAP_GUARD_PAUSE_MS: process.env.BSV_HEAP_GUARD_PAUSE_MS || '10000',
        BSV_ENABLE_UTXO_DB_LOCKS: process.env.BSV_ENABLE_UTXO_DB_LOCKS ?? 'false',
        BSV_SPEND_SOURCE_MODE: process.env.BSV_SPEND_SOURCE_MODE || 'overlay',
        GAIALOG_QUEUE_GATE_SOURCE: process.env.GAIALOG_QUEUE_GATE_SOURCE || 'overlay',
        EXPLORER_READ_SOURCE: process.env.EXPLORER_READ_SOURCE || 'overlay',
        EXPLORER_WRITE_MODE: process.env.EXPLORER_WRITE_MODE || 'overlay',
      },
      max_memory_restart: '8G',
      kill_timeout: 8000,
      restart_delay: 10000,
      max_restarts: 100,
      min_uptime: '30s',
      exp_backoff_restart_delay: 2000,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/workers-error.log',
      out_file: 'logs/workers-out.log',
      merge_logs: true,
      log_type: 'json',
    },
  ],
}

