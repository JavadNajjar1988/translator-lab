param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$resolvedInput = (Resolve-Path -LiteralPath $InputFile).Path

if (-not $env:POSTGRES_PASSWORD) {
    throw "ابتدا متغیر POSTGRES_PASSWORD را برای پایگاه داده آزمایشی تنظیم کنید."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker روی این دستگاه در دسترس نیست."
}

Push-Location $projectDirectory
try {
    docker compose up -d postgres
    if ($LASTEXITCODE -ne 0) {
        throw "پایگاه داده آزمایشی اجرا نشد."
    }

    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $status = docker inspect --format "{{.State.Health.Status}}" translator-lab-postgis 2>$null
        if ($status -eq "healthy") {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) {
        throw "پایگاه داده در زمان مورد انتظار آماده نشد."
    }

    $databaseUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "postgres" }
    $databaseName = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "translator_lab" }
    $existingTable = docker exec translator-lab-postgis psql -U $databaseUser -d $databaseName -Atc "SELECT to_regclass('public.geoms');"
    if ($existingTable -eq "geoms") {
        throw "جدول public.geoms از قبل وجود دارد؛ برای جلوگیری از بازنویسی، بازیابی متوقف شد."
    }

    docker cp $resolvedInput "translator-lab-postgis:/tmp/approved-translations.sql"
    if ($LASTEXITCODE -ne 0) {
        throw "انتقال فایل تأییدشده به محیط آزمایشی انجام نشد."
    }

    docker exec translator-lab-postgis psql -v ON_ERROR_STOP=1 -U $databaseUser -d $databaseName -f /tmp/approved-translations.sql
    if ($LASTEXITCODE -ne 0) {
        throw "بازیابی فایل تأییدشده کامل نشد."
    }

    docker exec translator-lab-postgis psql -U $databaseUser -d $databaseName -c "SELECT COUNT(*) AS total_rows, COUNT(*) FILTER (WHERE NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL) AS named_rows, COUNT(*) FILTER (WHERE NULLIF(BTRIM(translate->>'name'), '') IS NOT NULL) AS translated_rows FROM public.geoms;"
}
finally {
    Pop-Location
}
