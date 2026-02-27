#!/usr/bin/env bash
# ============================================================================
# GaiaLog Watchdog — belt-and-braces cron safety net
# ============================================================================
# Checks every 5 minutes (via cron) whether PM2 and the GaiaLog processes
# are alive. Restarts PM2 from the saved process list if anything is down.
#
# Install (as the gaialog user):
#   crontab -e
#   */5 * * * * /opt/gaialog/scripts/gaialog-watchdog.sh >> /opt/gaialog/logs/watchdog.log 2>&1
# ============================================================================

set -uo pipefail

INSTALL_DIR="/opt/gaialog"
PM2_BIN="$(command -v pm2 || echo '/usr/lib/node_modules/pm2/bin/pm2')"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

if ! command -v "$PM2_BIN" &>/dev/null; then
  echo "[$TIMESTAMP] WATCHDOG: pm2 not found at $PM2_BIN — cannot recover."
  exit 1
fi

# Check if PM2 daemon is responsive
if ! "$PM2_BIN" ping &>/dev/null; then
  echo "[$TIMESTAMP] WATCHDOG: PM2 daemon not responding. Resurrecting..."
  "$PM2_BIN" resurrect
  sleep 5
fi

# Check gaialog-web
WEB_STATUS=$("$PM2_BIN" jlist 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{const a=JSON.parse(d);const p=a.find(x=>x.name==='gaialog-web');
    console.log(p?p.pm2_env.status:'missing')}catch{console.log('error')}
  })
" 2>/dev/null || echo "error")

if [ "$WEB_STATUS" != "online" ]; then
  echo "[$TIMESTAMP] WATCHDOG: gaialog-web status=$WEB_STATUS — restarting via ecosystem..."
  cd "$INSTALL_DIR"
  "$PM2_BIN" start ecosystem.config.cjs --only gaialog-web
fi

# Check gaialog-workers
WORKER_STATUS=$("$PM2_BIN" jlist 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{const a=JSON.parse(d);const p=a.find(x=>x.name==='gaialog-workers');
    console.log(p?p.pm2_env.status:'missing')}catch{console.log('error')}
  })
" 2>/dev/null || echo "error")

if [ "$WORKER_STATUS" != "online" ]; then
  echo "[$TIMESTAMP] WATCHDOG: gaialog-workers status=$WORKER_STATUS — restarting via ecosystem..."
  cd "$INSTALL_DIR"
  "$PM2_BIN" start ecosystem.config.cjs --only gaialog-workers
fi

# Log heap usage for trend monitoring
HEAP_INFO=$(node -e "
  try{const v8=require('v8');const s=v8.getHeapStatistics();
  const u=Math.round(s.used_heap_size/1024/1024);
  const t=Math.round(s.heap_size_limit/1024/1024);
  console.log('heap='+u+'MB limit='+t+'MB')}catch{console.log('n/a')}
" 2>/dev/null || echo "n/a")

echo "[$TIMESTAMP] WATCHDOG: web=$WEB_STATUS workers=$WORKER_STATUS node_$HEAP_INFO"
