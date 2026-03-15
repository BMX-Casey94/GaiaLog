/**
 * PM2 Ecosystem Configuration for GaiaLog VPS Deployment
 *
 * Runs three processes:
 *   1. gaialog-web  — Next.js production server (port 3000)
 *   2. gaialog-overlay — Private loopback overlay lookup/submit service
 *   3. gaialog-workers — Background workers (data collection, queue, UTXO maintainer)
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save          # persist across reboots
 *   pm2 startup       # generate systemd auto-start hook
 *   pm2 logs           # tail all logs
 *   pm2 monit          # live dashboard
 *
 * Scheduled restart strategy (gaialog-workers):
 *   cron_restart recycles the worker process every 30 minutes (:00 and :30).
 *   This is the most reliable anti-stall mechanism because it is managed entirely
 *   by PM2 — an external process — so it cannot be blocked by a stuck Node.js
 *   event loop or hung timer inside the worker.
 *
 *   Queue items persist across restarts (worker_queue DB table); any items marked
 *   'processing' at kill-time are automatically reclaimed as 'queued' after 2 minutes
 *   by loadPendingQueueItems(). On-chain dedup checks (hasAirQualityTxId etc.) prevent
 *   re-broadcasting records that were already confirmed before the restart.
 *
 *   kill_timeout gives the SIGINT handler 8 seconds to drain gracefully before SIGKILL.
 */

// Load .env so overlay/worker vars are passed to PM2 processes
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

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
      args: ['--import', 'tsx', 'scripts/run-workers.ts'],
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      node_args: ['--max-old-space-size=8192'],
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
        GAIALOG_WORKER_PROCESS: '1',
        GAIALOG_SINGLE_WRITER_MODE: 'run-workers',
        GAIALOG_MUTATOR_ROLE: 'primary',
        BSV_OVERLAY_AUTH_MODE: process.env.BSV_OVERLAY_AUTH_MODE || 'brc104',
        BSV_OVERLAY_CLIENT_IDENTITY_WIF: process.env.BSV_OVERLAY_CLIENT_IDENTITY_WIF,
        BSV_HEAP_GUARD_HIGH_WATERMARK: process.env.BSV_HEAP_GUARD_HIGH_WATERMARK || '0.98',
        BSV_HEAP_GUARD_PAUSE_MS: process.env.BSV_HEAP_GUARD_PAUSE_MS || '10000',
      },
      max_memory_restart: '8G',
      // Recycle the worker process every 30 minutes to prevent event-loop stalls.
      // PM2 sends SIGINT, waits kill_timeout ms, then SIGKILL if still alive.
      // Queue state is persisted in the DB and re-hydrated on each restart.
      cron_restart: '*/30 * * * *',
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

