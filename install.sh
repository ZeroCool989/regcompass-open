#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# RegCompass Open installer (macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ZeroCool989/regcompass-open/main/install.sh | bash
#
# Or from a local checkout:
#   ./install.sh
#
# Environment overrides:
#   RCO_DIR   install directory        (default: ~/regcompass-open)
#   RCO_SRC   copy from this local dir instead of cloning (for offline installs)
#   RCO_REPO  git URL to clone         (default: the public GitHub repo)

set -euo pipefail

REPO="${RCO_REPO:-https://github.com/ZeroCool989/regcompass-open.git}"
INSTALL_DIR="${RCO_DIR:-$HOME/regcompass-open}"
MIN_NODE_MAJOR=20

info()  { printf '\033[1;34m›\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$1"; }
die()   { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

info "RegCompass Open — installer"

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required (v${MIN_NODE_MAJOR}+). Install it from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die "Node.js v${MIN_NODE_MAJOR}+ required; found v$(node -v). Please upgrade and re-run."
ok "Node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm not found — enabling it via corepack…"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  command -v pnpm >/dev/null 2>&1 || die "Could not install pnpm automatically. Install it (https://pnpm.io/installation) and re-run."
fi
ok "pnpm $(pnpm -v)"

command -v git >/dev/null 2>&1 || [ -n "${RCO_SRC:-}" ] || die "git is required to fetch the source (or set RCO_SRC to a local checkout)."

# ── Fetch source ───────────────────────────────────────────────────────────
if [ -n "${RCO_SRC:-}" ]; then
  info "Copying source from $RCO_SRC → $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # Copy the working tree without build/venv/local artifacts.
  ( cd "$RCO_SRC" && git archive --format=tar HEAD 2>/dev/null || tar --exclude='./node_modules' --exclude='./.next' --exclude='./.git' --exclude='./local.db' -cf - . ) | tar -xf - -C "$INSTALL_DIR"
  ok "Source copied"
elif [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || warn "Could not fast-forward; keeping current checkout."
elif [ -f "package.json" ] && grep -q '"name": "regcompass-open"' package.json 2>/dev/null; then
  info "Running from a local checkout — installing in place ($(pwd))"
  INSTALL_DIR="$(pwd)"
else
  info "Cloning $REPO → $INSTALL_DIR"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Cloned"
fi

cd "$INSTALL_DIR"

# ── Dependencies ───────────────────────────────────────────────────────────
info "Installing dependencies (this can take a minute)…"
pnpm install --silent
ok "Dependencies installed"

info "Generating database client…"
pnpm exec prisma generate >/dev/null
ok "Prisma client generated"

# ── Environment ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  info "Creating .env with fresh local secrets…"
  cp .env.example .env
  SESSION_SECRET_VAL="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  BYOK_KEY_VAL="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  node - "$SESSION_SECRET_VAL" "$BYOK_KEY_VAL" <<'NODE'
const fs = require('fs');
const [sessionSecret, byokKey] = process.argv.slice(2);
let env = fs.readFileSync('.env', 'utf8');
env = env.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET="${sessionSecret}"`);
env = env.replace(/^AEGIS_BYOK_ENCRYPTION_KEY=.*$/m, `AEGIS_BYOK_ENCRYPTION_KEY="${byokKey}"`);
fs.writeFileSync('.env', env);
NODE
  ok "Wrote .env (app secrets generated; model keys left blank — set one in the app)"
else
  ok ".env already present — leaving it untouched"
fi

# ── Database + local user ──────────────────────────────────────────────────
info "Setting up the local database…"
pnpm exec prisma db push >/dev/null
pnpm exec tsx --env-file=.env scripts/setup-local.ts
ok "Local database ready"

# ── Launcher on PATH ───────────────────────────────────────────────────────
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/regcompass-open" "$BIN_DIR/regcompass-open"
ok "Launcher linked → $BIN_DIR/regcompass-open"

printf '\n'
ok "RegCompass Open is installed at $INSTALL_DIR"
printf '\n'
info "Start it:"
printf '    regcompass-open\n'
if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  printf '\n'
  warn "$BIN_DIR is not on your PATH. Either add it, or start with:"
  printf '    %s/bin/regcompass-open\n' "$INSTALL_DIR"
fi
printf '\n'
info "Then open http://localhost:3000 and pick your model under Konto → AI-Provider."
info "Model options (API key / subscription / local CLI / self-hosted) are in the README and .env.example."
