# Starts the whole MAYAMI project locally:
#   1. sets up backend/.venv and backend/.env if missing
#   2. installs and builds the Chrome extension into extension/dist
#   3. runs the backend on http://localhost:8000 (Ctrl+C to stop)
# Use -Docker to run the backend with docker compose instead (needs Docker Desktop running).
param([switch]$Docker, [switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$extension = Join-Path $root "extension"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

# --- configuration -------------------------------------------------------------------
$envFile = Join-Path $backend ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $backend ".env.example") $envFile
    Write-Host "Created backend\.env - put your GOOGLE_API_KEY in it, then run this again." -ForegroundColor Yellow
    exit 1
}
if (-not (Select-String -Path $envFile -Pattern '^GOOGLE_API_KEY=\S+' -Quiet)) {
    Write-Host "backend\.env has no GOOGLE_API_KEY. Add it, then run this again." -ForegroundColor Yellow
    exit 1
}

# --- extension -----------------------------------------------------------------------
if (-not $SkipBuild) {
    Step "Building the Chrome extension"
    Push-Location $extension
    try {
        if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Extension build failed" }
    } finally { Pop-Location }
}

# --- backend -------------------------------------------------------------------------
if ($Docker) {
    Step "Starting the backend with Docker (http://localhost:8000)"
    Push-Location $root
    try { docker compose up --build } finally { Pop-Location }
    exit $LASTEXITCODE
}

$python = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Step "Creating backend\.venv and installing dependencies (first run only, a few minutes)"
    python -m venv (Join-Path $backend ".venv")
    & $python -m pip install --upgrade pip
    & $python -m pip install -r (Join-Path $backend "requirements.txt")
}

$busy = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "Port 8000 is already in use (pid $($busy.OwningProcess)). Stop that process first." -ForegroundColor Yellow
    exit 1
}

Write-Host @"

Extension: load (or reload) extension\dist in chrome://extensions (Developer mode > Load unpacked).
Options:   server ws://localhost:8000, API key = MAYAMI_API_KEY from backend\.env.
"@ -ForegroundColor Green

Step "Starting the backend on http://localhost:8000 (Ctrl+C to stop)"
Push-Location $backend
try { & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --ws-ping-interval 20 }
finally { Pop-Location }
