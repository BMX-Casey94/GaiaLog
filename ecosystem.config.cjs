/**
 * PM2 Ecosystem Configuration for GaiaLog VPS Deployment
 *
 * Runs two processes:
 *   1. gaialog-web  — Next.js production server (port 3000)
 *   2. gaialog-workers — Background workers (data collection, queue, UTXO maintainer)
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save          # persist across reboots
 *   pm2 startup       # generate systemd auto-start hook
 *   pm2 logs           # tail all logs
 *   pm2 monit          # live dashboard
 */

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
      name: 'gaialog-workers',
      script: 'node_modules/.bin/tsx',
      args: 'scripts/run-workers.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=6144',
      env: {
        NODE_ENV: 'production',
        GAIALOG_WORKER_PROCESS: '1',
      },
      max_memory_restart: '5G',
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
