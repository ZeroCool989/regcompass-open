# SPDX-License-Identifier: Apache-2.0
#
# RegCompass Open installer (Windows / PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/ZeroCool989/regcompass-open/main/install.ps1 | iex
#
# Or from a local checkout:
#   ./install.ps1
#
# Environment overrides:
#   RCO_DIR   install directory   (default: %USERPROFILE%\regcompass-open)
#   RCO_SRC   copy from this local dir instead of cloning
#   RCO_REPO  git URL to clone

$ErrorActionPreference = 'Stop'

$Repo       = if ($env:RCO_REPO) { $env:RCO_REPO } else { 'https://github.com/ZeroCool989/regcompass-open.git' }
$InstallDir = if ($env:RCO_DIR)  { $env:RCO_DIR }  else { Join-Path $env:USERPROFILE 'regcompass-open' }
$MinNode    = 20

function Info($m) { Write-Host "› $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

Info 'RegCompass Open — installer'

# Prerequisites
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js v$MinNode+ is required. Install from https://nodejs.org and re-run." }
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $MinNode) { Die "Node.js v$MinNode+ required; found $(node -v). Upgrade and re-run." }
Ok "Node $(node -v)"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Info 'pnpm not found — enabling via corepack…'
  corepack enable 2>$null
  corepack prepare pnpm@latest --activate 2>$null
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Die 'Could not install pnpm. See https://pnpm.io/installation' }
}
Ok "pnpm $(pnpm -v)"

# Fetch source
if ($env:RCO_SRC) {
  Info "Copying source from $($env:RCO_SRC) → $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Recurse -Force -Exclude @('node_modules', '.next', '.git', 'local.db') -Path (Join-Path $env:RCO_SRC '*') -Destination $InstallDir
} elseif (Test-Path (Join-Path $InstallDir '.git')) {
  Info "Updating existing install at $InstallDir"
  git -C $InstallDir pull --ff-only
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is required to fetch the source (or set RCO_SRC).' }
  Info "Cloning $Repo → $InstallDir"
  git clone --depth 1 $Repo $InstallDir
}

Set-Location $InstallDir

# Dependencies
Info 'Installing dependencies…'
pnpm install --silent
pnpm exec prisma generate | Out-Null
Ok 'Dependencies installed'

# Environment
if (-not (Test-Path .env)) {
  Info 'Creating .env with fresh local secrets…'
  Copy-Item .env.example .env
  $sessionSecret = node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  $byokKey       = node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  $env:RCO_SESSION = $sessionSecret; $env:RCO_BYOK = $byokKey
  node -e "const fs=require('fs');let e=fs.readFileSync('.env','utf8');e=e.replace(/^SESSION_SECRET=.*$/m,'SESSION_SECRET=\""+process.env.RCO_SESSION+"\"');e=e.replace(/^AEGIS_BYOK_ENCRYPTION_KEY=.*$/m,'AEGIS_BYOK_ENCRYPTION_KEY=\""+process.env.RCO_BYOK+"\"');fs.writeFileSync('.env',e);"
  Ok 'Wrote .env (app secrets generated; model keys left blank)'
} else {
  Ok '.env already present — leaving it untouched'
}

# Database + local user
Info 'Setting up the local database…'
pnpm exec tsx --env-file=.env scripts/db-migrate.ts
pnpm exec tsx --env-file=.env scripts/setup-local.ts
Ok 'Local database ready'

# Launcher (parity with install.sh's ~/.local/bin symlink)
$binDir   = Join-Path $HOME '.local\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$launcher = Join-Path $binDir 'regcompass-open.cmd'
$target   = Join-Path $InstallDir 'bin\regcompass-open'
Set-Content -Path $launcher -Value "@echo off`r`nnode `"$target`" %*" -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Ok "Launcher installed → $launcher (added $binDir to your PATH; reopen your terminal)"
} else {
  Ok "Launcher installed → $launcher"
}

Write-Host ''
Ok "RegCompass Open is installed at $InstallDir"
Write-Host ''
Info 'Start it with:'
Write-Host '    regcompass-open' -ForegroundColor White
Write-Host '  (or, from ' $InstallDir '): pnpm start'
Write-Host ''
Info 'Then open http://localhost:3000 and pick your model under Konto → AI-Provider.'
