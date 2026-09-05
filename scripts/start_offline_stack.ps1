param(
    [int]$MadladPort = 3007,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$workDirectory = Join-Path $projectDirectory "work"
$pythonPath = Join-Path $workDirectory "madlad-venv\Scripts\python.exe"
$modelDirectory = Join-Path $workDirectory "models\madlad400-3b-mt"
New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null

function Read-MadladHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$MadladPort/health" -TimeoutSec 5 }
    catch { return $null }
}

$health = Read-MadladHealth
if ($health.ready -ne $true) {
    if (-not (Test-Path -LiteralPath $pythonPath)) { throw "محیط پایتون مدل آماده نیست." }
    if (-not (Test-Path -LiteralPath (Join-Path $modelDirectory "model.safetensors"))) {
        throw "فایل رسمی مدل آماده نیست."
    }
    $env:MADLAD_MODEL_ID = "google/madlad400-3b-mt"
    $env:MADLAD_MODEL_PATH = $modelDirectory
    $env:PYTHONPATH = $projectDirectory
    Start-Process -FilePath $pythonPath `
        -ArgumentList "-m uvicorn services.madlad.app:app --host 0.0.0.0 --port $MadladPort" `
        -WorkingDirectory $projectDirectory -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddMinutes(8)
    do {
        Start-Sleep -Seconds 3
        $health = Read-MadladHealth
    } while ($health.ready -ne $true -and (Get-Date) -lt $deadline)
    if ($health.ready -ne $true) {
        throw "سرویس MADLAD در مهلت مقرر آماده نشد."
    }
}

Push-Location $projectDirectory
try {
    if ($SkipBuild) { docker compose up -d } else { docker compose up -d --build }
    if ($LASTEXITCODE -ne 0) { throw "راه‌اندازی سرویس‌های داکر ناموفق بود." }
} finally { Pop-Location }

$backendDeadline = (Get-Date).AddMinutes(2)
do {
    try { $backendHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3006/health" -TimeoutSec 5 }
    catch { $backendHealth = $null }
    if ($backendHealth.status -eq "ok") { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $backendDeadline)
if ($backendHealth.status -ne "ok") { throw "سرویس مترجم در مهلت مقرر آماده نشد." }

$worker = Invoke-RestMethod -Uri "http://127.0.0.1:3006/api/v1/translation-worker" -TimeoutSec 10
if ($worker.provider.kind -notin @("madlad", "hybrid")) { throw "پردازشگر روی مسیر تخصصی آفلاین تنظیم نشده است." }
$providers = (Invoke-RestMethod -Uri "http://127.0.0.1:3006/api/v1/translation-providers" -TimeoutSec 10).providers
$madlad = $providers | Where-Object { $_.kind -eq "madlad" }
if ($madlad.ready -ne $true) { throw "مدل تخصصی از طریق سرویس پشتیبان آماده گزارش نشده است." }
$memory = Invoke-RestMethod -Uri "http://127.0.0.1:3006/api/v1/translation-memory" -TimeoutSec 10
if (-not $memory.loaded -or $memory.entries -lt 1) { throw "حافظهٔ ترجمهٔ تأییدشده بارگیری نشده است." }
$places = Invoke-RestMethod -Uri "http://127.0.0.1:3006/api/v1/canonical-place-names" -TimeoutSec 10
if (-not $places.loaded -or $places.entries -lt 1) { throw "حافظهٔ نام‌های جغرافیایی معیار بارگیری نشده است." }

Write-Host "مدل تخصصی آفلاین و داشبورد آماده‌اند."
Write-Host "داشبورد: http://127.0.0.1:3005/"
Write-Host "مدل فعال: $($worker.provider.model)"
Write-Host "حافظهٔ تأییدشده: $($memory.entries) ترجمه"
Write-Host "نام‌های جغرافیایی معیار: $($places.entries) موجودیت در $($places.languages) زبان"
Write-Host "ثبت خودکار: $($worker.automaticApply)"
