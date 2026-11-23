[CmdletBinding()]
param(
    [string]$WorkerUrl = "https://repoforge-worker.game-developer-mb.workers.dev",
    [string]$DashboardUrl = "https://mehrdadmb2.github.io/repoforge/"
)

$ErrorActionPreference = "Continue"
$WorkerUrl = $WorkerUrl.Trim().TrimEnd('/')
$checks = [System.Collections.Generic.List[object]]::new()

try {
    $health = Invoke-RestMethod -Uri "$WorkerUrl/api/health" -Method Get -TimeoutSec 20
    $checks.Add([pscustomobject]@{ Name = "Worker health"; Ok = [bool]$health.ok; Detail = "version=$($health.version); storage=$($health.storage); R2=$($health.r2Required)" })
}
catch { $checks.Add([pscustomobject]@{ Name = "Worker health"; Ok = $false; Detail = $_.Exception.Message }) }

try {
    $response = Invoke-WebRequest -Uri $DashboardUrl -Method Get -TimeoutSec 30
    $hasIndex = $response.Content -match 'RepoForge|REPOFORGE'
    $checks.Add([pscustomobject]@{ Name = "GitHub Pages"; Ok = ($response.StatusCode -eq 200 -and $hasIndex); Detail = "HTTP $($response.StatusCode)" })
}
catch { $checks.Add([pscustomobject]@{ Name = "GitHub Pages"; Ok = $false; Detail = $_.Exception.Message }) }

$checks | Format-Table -AutoSize
if (@($checks | Where-Object { -not $_.Ok }).Count -gt 0) { exit 1 }
Write-Host "Public endpoint checks passed. Authenticated API and Telegram webhook need credential-backed tests." -ForegroundColor Green
