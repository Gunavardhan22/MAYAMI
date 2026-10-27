# Starts the whole MAYAMI project locally:
#   1. sets up backend/.venv and backend/.env if missing
#   2. installs and builds the Chrome extension into extension/dist
#   3. runs the backend on http://localhost:8000 (Ctrl+C to stop)
# Use -Docker to run the backend with docker compose instead (needs Docker Desktop running).
# Use -Dev to run the extension's Vite dev server (rebuilds on save) in a second window instead of a one-off build.
param([switch]$Docker, [switch]$SkipBuild, [switch]$Dev)

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
    Push-Location $extension
    try {
        if (-not (Test-Path "node_modules")) {
            Step "Installing the extension's Node modules"
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        if ($Dev) {
            Step "Starting the extension dev server in a new window (rebuilds extension\dist on save)"
            Start-Process powershell -WorkingDirectory $extension -ArgumentList "-NoExit", "-Command", "npm run dev"
        } else {
            Step "Building the Chrome extension"
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "Extension build failed" }
        }
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

$busy = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
    # A MAYAMI backend that is already up is fine; anything else on the port is a real conflict.
    try { $health = Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 3 } catch { $health = $null }
    if ($health.status -eq "ok") {
        Write-Host "`nThe MAYAMI backend is already running on http://localhost:8000 (pid $($busy.OwningProcess))." -ForegroundColor Green
        Write-Host "Load or reload extension\dist in chrome://extensions. To restart the backend, stop pid $($busy.OwningProcess) and run this again."
        exit 0
    }
    Write-Host "Port 8000 is used by another program (pid $($busy.OwningProcess)). Stop it, then run this again." -ForegroundColor Yellow
    exit 1
}

Write-Host @"

Extension: load (or reload) extension\dist in chrome://extensions (Developer mode > Load unpacked).
Options:   server URL and API key are pre-filled from backend\.env; the page shows whether it's connected.
"@ -ForegroundColor Green

Step "Starting the backend on http://localhost:8000 (Ctrl+C to stop)"
Push-Location $backend
try { & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --ws-ping-interval 20 }
finally { Pop-Location }
