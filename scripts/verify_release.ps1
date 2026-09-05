param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot

function Read-Json([string]$Uri) {
    return Invoke-RestMethod -Uri $Uri -TimeoutSec 20
}

Push-Location $projectDirectory
try {
    docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw "تنظیمات داکر معتبر نیست." }

    if (-not $SkipTests) {
        npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw "آزمون‌های برنامه ناموفق بودند." }
    }

    $front = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3005/" -TimeoutSec 20
    $health = Read-Json "http://127.0.0.1:3006/health"
    $worker = Read-Json "http://127.0.0.1:3006/api/v1/translation-worker"
    $providers = (Read-Json "http://127.0.0.1:3006/api/v1/translation-providers").providers
    $memory = Read-Json "http://127.0.0.1:3006/api/v1/translation-memory"
    $places = Read-Json "http://127.0.0.1:3006/api/v1/canonical-place-names"
    $queue = Read-Json "http://127.0.0.1:3006/api/v1/translation-queue?limit=1"

    try {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:3006/api/v1/translation-jobs/run" `
            -ContentType "application/json" -Body '{"apply":true,"limit":1}' -TimeoutSec 20 | Out-Null
        $guardStatus = 200
    } catch {
        $guardStatus = [int]$_.Exception.Response.StatusCode
    }

    $trackedSecrets = @(git ls-files .env .env.local)
    $localProvider = $providers | Where-Object { $_.kind -eq "local" }
    $checks = [ordered]@{
        composeValid = $true
        frontendReady = $front.StatusCode -eq 200
        backendReady = $health.status -eq "ok"
        databaseReady = [bool]$health.database
        trustedAutomaticPolicy = $worker.automaticPolicy -eq "trusted-deterministic-only"
        localModelReady = $localProvider.ready -eq $true
        approvedMemoryLoaded = $memory.loaded -eq $true -and $memory.entries -gt 0
        canonicalPlacesLoaded = $places.loaded -eq $true -and $places.entries -gt 0
        queueReadable = [bool]$queue.summary
        manualBulkApplyLocked = $guardStatus -eq 403
        secretsNotTracked = $trackedSecrets.Count -eq 0
    }
    $passed = -not ($checks.Values -contains $false)
    $result = [ordered]@{
        formatVersion = 1
        checkedAt = (Get-Date).ToUniversalTime().ToString("o")
        version = (Get-Content package.json -Raw | ConvertFrom-Json).version
        passed = $passed
        checks = $checks
        worker = [ordered]@{
            automaticApply = $worker.automaticApply
            automaticPolicy = $worker.automaticPolicy
            lastRun = $worker.lastRun
        }
        database = $health.database
    }
    $result | ConvertTo-Json -Depth 10
    if (-not $passed) { exit 1 }
} finally {
    Pop-Location
}
