[CmdletBinding()]
param(
    [string]$WorkerUrl = "https://repoforge-worker.game-developer-mb.workers.dev"
)

$ErrorActionPreference = "Stop"
$WorkerUrl = $WorkerUrl.Trim().TrimEnd('/')
if ($WorkerUrl -notmatch '^https://[A-Za-z0-9.-]+$') {
    throw "WorkerUrl must be an HTTPS workers.dev URL without a path."
}

function Read-SecretText {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$health = Invoke-RestMethod -Uri "$WorkerUrl/api/health" -Method Get -TimeoutSec 20
if (-not $health.ok) { throw "Worker health check did not return ok=true." }
Write-Host "Worker health: OK ($($health.version))" -ForegroundColor Green

$botToken = Read-SecretText "Telegram Bot API token"
$rawWebhookSecret = Read-SecretText "Exact TELEGRAM_WEBHOOK_SECRET value already stored in Wrangler"
if ([string]::IsNullOrEmpty($botToken)) { throw "Telegram bot token cannot be empty." }
if ([string]::IsNullOrEmpty($rawWebhookSecret)) { throw "Webhook secret cannot be empty." }

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $rawBytes = [System.Text.Encoding]::UTF8.GetBytes($rawWebhookSecret)
    $digest = $sha.ComputeHash($rawBytes)
    $telegramHeaderSecret = ([Convert]::ToHexString($digest)).ToLowerInvariant()
}
finally { $sha.Dispose() }

$payload = @{
    url = "$WorkerUrl/telegram"
    secret_token = $telegramHeaderSecret
    allowed_updates = @("message", "callback_query")
    drop_pending_updates = $false
    max_connections = 10
} | ConvertTo-Json -Depth 5

$telegramApi = "https://api.telegram.org/bot$botToken/setWebhook"
$result = Invoke-RestMethod -Uri $telegramApi -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 30
if (-not $result.ok) { throw "Telegram rejected setWebhook: $($result.description)" }
Write-Host "Telegram webhook registered successfully." -ForegroundColor Green
Write-Host "Webhook URL: $WorkerUrl/telegram"

$info = Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getWebhookInfo" -Method Get -TimeoutSec 30
if (-not $info.ok) { throw "Unable to read Telegram webhook status." }
$info.result | Select-Object url, pending_update_count, last_error_date, last_error_message, allowed_updates | Format-List

# Do not print or persist either credential.
$botToken = $null
$rawWebhookSecret = $null
$telegramApi = $null
$payload = $null
