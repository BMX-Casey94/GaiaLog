#!/usr/bin/env bash
# ============================================================================
# GaiaLog VPS Setup Script
# ============================================================================
# Run this ONCE on a fresh Ubuntu 22.04/24.04 VPS as root (or with sudo).
#
# Prerequisites:
#   - SSH access to the VPS
#   - Your .env file ready to upload (contains secrets — NOT in git)
#
# Usage:
#   chmod +x scripts/vps-setup.sh
#   sudo bash scripts/vps-setup.sh
#
# After this script completes:
#   1. Copy your .env to /opt/gaialog/.env
#   2. Run: cd /opt/gaialog && npm run db:migrate
#   3. Run: pm2 start ecosystem.config.cjs
#   4. Run: pm2 save && pm2 startup
# ============================================================================

set -euo pipefail

REPO_URL="https://github.com/BMX-Casey94/GaiaLog.git"
INSTALL_DIR="/opt/gaialog"
NODE_VERSION="20"
APP_USER="gaialog"

echo "========================================"
echo " GaiaLog VPS Setup"
echo "========================================"

# ── 1. System updates and essentials ──────────────────────────────────────────

echo "[1/8] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq git curl wget build-essential ufw fail2ban logrotate

# ── 2. Firewall (UFW) ────────────────────────────────────────────────────────

echo "[2/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable
echo "  Firewall enabled: SSH, HTTP, HTTPS, 3000 open."

# ── 3. Create application user ───────────────────────────────────────────────

echo "[3/8] Creating application user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
  echo "  User '$APP_USER' created."
else
  echo "  User '$APP_USER' already exists."
fi

# ── 4. Install Node.js (via NodeSource) ──────────────────────────────────────

echo "[4/8] Installing Node.js ${NODE_VERSION}.x..."
if ! command -v node &>/dev/null || ! node -v | grep -q "v${NODE_VERSION}"; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node.js $(node -v) installed."
echo "  npm $(npm -v) installed."

# ── 5. Install PM2 globally ──────────────────────────────────────────────────

echo "[5/8] Installing PM2..."
npm install -g pm2
echo "  PM2 $(pm2 -v) installed."

# ── 6. Clone repository ──────────────────────────────────────────────────────

echo "[6/8] Cloning GaiaLog repository..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Repository already exists at $INSTALL_DIR — pulling latest..."
  cd "$INSTALL_DIR"
  git pull origin master
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── 7. Install dependencies and build ────────────────────────────────────────

echo "[7/8] Installing dependencies and building..."
cd "$INSTALL_DIR"
npm install --production=false
npm run build
mkdir -p logs

# Set ownership
chown -R "$APP_USER":"$APP_USER" "$INSTALL_DIR"

# ── 8. Configure PM2 startup and logrotate ────────────────────────────────────

echo "[8/8] Configuring PM2 startup and log rotation..."
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" --service-name gaialog-pm2

# Log rotation for PM2 logs
cat > /etc/logrotate.d/gaialog <<'LOGROTATE'
/opt/gaialog/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    copytruncate
    maxsize 100M
}
LOGROTATE

echo ""
echo "========================================"
echo " Setup complete!"
echo "========================================"
echo ""
echo " Next steps:"
echo ""
echo "   1. Upload your .env file:"
echo "      scp .env root@your-vps-ip:${INSTALL_DIR}/.env"
echo ""
echo "   2. Run database migrations:"
echo "      cd ${INSTALL_DIR} && sudo -u ${APP_USER} npm run db:migrate"
echo ""
echo "   3. Start the application:"
echo "      cd ${INSTALL_DIR} && sudo -u ${APP_USER} pm2 start ecosystem.config.cjs"
echo "      sudo -u ${APP_USER} pm2 save"
echo ""
echo "   4. Verify it is running:"
echo "      sudo -u ${APP_USER} pm2 status"
echo "      sudo -u ${APP_USER} pm2 logs"
echo ""
echo "   5. (Optional) Set up a reverse proxy (Nginx/Caddy) for port 80/443."
echo ""
echo " Useful commands:"
echo "   pm2 restart all        — restart both web + workers"
echo "   pm2 logs --lines 100   — view recent logs"
echo "   pm2 monit              — live monitoring dashboard"
echo ""
