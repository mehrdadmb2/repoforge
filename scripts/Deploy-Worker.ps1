[CmdletBinding()]
param(
    [string]$WorkerUrl = "https://repoforge-worker.game-developer-mb.workers.dev",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$WorkerDir = Join-Path $PSScriptRoot "..\worker"
Set-Location $WorkerDir

if (-not (Test-Path ".\wrangler.toml")) { throw "worker/wrangler.toml was not found." }
$toml = Get-Content ".\wrangler.toml" -Raw
if ($toml -match 'REPLACE_WITH_KV_NAMESPACE_ID') {
    throw "Set your real Workers KV namespace ID in worker/wrangler.toml before deploying."
}

Write-Host "Installing Worker dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "Checking JavaScript syntax..." -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) { throw "npm run check failed." }

if (-not $SkipTests) {
    Write-Host "Running unit and integration tests..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test failed." }
}

Write-Host "Deploying RepoForge Worker..." -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed." }

$WorkerUrl = $WorkerUrl.Trim().TrimEnd('/')
$health = Invoke-RestMethod -Uri "$WorkerUrl/api/health" -Method Get -TimeoutSec 30
if (-not $health.ok) { throw "Worker deployment completed, but health check failed." }
Write-Host "RepoForge Worker is healthy: $($health.version)" -ForegroundColor Green
$health | ConvertTo-Json -Depth 5
