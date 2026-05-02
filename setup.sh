#!/bin/bash
# ============================================================
# setup.sh - VPS Deployment Script for Solana Degen Bot
# Compatible: Ubuntu 20.04 / 22.04 / 24.04
# ============================================================

set -e  # Exit on any error

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()    { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn()   { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

log "Starting Solana Degen Bot setup..."
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────
log "Checking Node.js..."
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Installing via NVM..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  nvm alias default 20
else
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    error "Node.js v18+ required. Current: $(node -v)"
  fi
  log "Node.js $(node -v) ✓"
fi

# ── 2. Check PM2 ──────────────────────────────────────────────
log "Checking PM2..."
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found. Installing globally..."
  npm install -g pm2
fi
log "PM2 $(pm2 -v) ✓"

# ── 3. Install dependencies ───────────────────────────────────
log "Installing npm dependencies..."
npm install --production=false
log "Dependencies installed ✓"

# ── 4. Check .env ─────────────────────────────────────────────
if [ ! -f ".env" ]; then
  warn ".env not found. Copying from .env.example..."
  cp .env.example .env
  echo ""
  warn "⚠️  IMPORTANT: Edit .env with your actual keys before starting!"
  warn "    Run: nano .env"
  echo ""
fi

# ── 5. Create logs directory ──────────────────────────────────
log "Creating logs directory..."
mkdir -p logs
log "Logs dir ready ✓"

# ── 6. Build TypeScript ───────────────────────────────────────
log "Building TypeScript..."
npm run build
log "Build successful ✓"

# ── 7. PM2 startup ────────────────────────────────────────────
log "Setting up PM2 auto-startup..."
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true

echo ""
echo "══════════════════════════════════════════════"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo "══════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Edit your .env:     nano .env"
echo "  2. Start the bot:      pm2 start ecosystem.config.js"
echo "  3. Save PM2 config:    pm2 save"
echo "  4. View logs:          pm2 logs solana-degen-bot"
echo "  5. Monitor:            pm2 monit"
echo ""
echo "Useful commands:"
echo "  pm2 stop solana-degen-bot    # Stop bot"
echo "  pm2 restart solana-degen-bot # Restart"
echo "  pm2 delete solana-degen-bot  # Remove from PM2"
echo ""
