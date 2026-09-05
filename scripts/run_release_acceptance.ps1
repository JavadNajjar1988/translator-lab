param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$containerName = "translator-lab-postgis"
$timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss", [System.Globalization.CultureInfo]::InvariantCulture)
$acceptanceDatabase = "translator_lab_acceptance_rc1_" + $timestamp.Replace("-", "")
$reportPath = if ($OutputPath) {
    [System.IO.Path]::GetFullPath($OutputPath)
} else {
    Join-Path $projectDirectory "outputs\acceptance\workflow-acceptance-$timestamp.json"
}

if ($acceptanceDatabase -notmatch '^translator_lab_acceptance_rc1_[0-9]{14}$') {
    throw "نام پایگاه پذیرش معتبر نیست."
}

Push-Location $projectDirectory
try {
    $running = docker inspect --format "{{.State.Running}}" $containerName 2>$null
    if ($running -ne "true") { throw "کانتینر پایگاه داده در حال اجرا نیست." }
    $databaseUser = (docker exec $containerName printenv POSTGRES_USER).Trim()
    $databasePassword = (docker exec $containerName printenv POSTGRES_PASSWORD).Trim()
    $sourceDatabase = (docker exec $containerName printenv POSTGRES_DB).Trim()
    if (-not $databaseUser -or -not $databasePassword -or -not $sourceDatabase) {
        throw "مشخصات پایگاه داده از کانتینر خوانده نشد."
    }

    $fingerprintSql = "SELECT count(*)::text || '|' || md5(string_agg(md5(row_to_json(g)::text), '' ORDER BY osm_type, osm_id, layer)) FROM public.geoms g;"
    $mainBefore = (docker exec $containerName psql -U $databaseUser -d $sourceDatabase -Atc $fingerprintSql).Trim()
    if (-not $mainBefore) { throw "اثر انگشت پایگاه اصلی ساخته نشد." }

    $temporaryDump = "/tmp/$acceptanceDatabase.dump"
    docker exec $containerName pg_dump -U $databaseUser -d $sourceDatabase -Fc -f $temporaryDump
    if ($LASTEXITCODE -ne 0) { throw "تهیهٔ کپی پذیرش ناموفق بود." }
    docker exec $containerName createdb -U $databaseUser $acceptanceDatabase
    if ($LASTEXITCODE -ne 0) { throw "ساخت پایگاه پذیرش ناموفق بود." }
    docker exec $containerName pg_restore -U $databaseUser -d $acceptanceDatabase --no-owner --no-privileges $temporaryDump
    if ($LASTEXITCODE -ne 0) { throw "بازیابی پایگاه پذیرش ناموفق بود." }

    New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
    $encodedPassword = [uri]::EscapeDataString($databasePassword)
    $env:DATABASE_URL = "postgresql://${databaseUser}:${encodedPassword}@127.0.0.1:5434/$acceptanceDatabase"
    node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts\run_workflow_acceptance.mjs --output $reportPath
    if ($LASTEXITCODE -ne 0) { throw "آزمون پذیرش ناموفق بود." }

    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    $mainAfter = (docker exec $containerName psql -U $databaseUser -d $sourceDatabase -Atc $fingerprintSql).Trim()
    $summary = [ordered]@{
        formatVersion = 1
        passed = $report.passed -eq $true -and $mainBefore -eq $mainAfter
        workflowPassed = $report.passed
        mainDatabaseUnchanged = $mainBefore -eq $mainAfter
        mainFingerprint = $mainAfter
        persistence = $report.run.persistence
        checks = $report.checks
        report = $reportPath
    }
    $summary | ConvertTo-Json -Depth 8
    if (-not $summary.passed) { exit 1 }
} finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    if ($temporaryDump) { docker exec $containerName rm -f $temporaryDump 2>$null | Out-Null }
    $exists = (docker exec $containerName psql -U $databaseUser -d postgres -Atc `
        "SELECT 1 FROM pg_database WHERE datname='$acceptanceDatabase';" 2>$null).Trim()
    if ($exists -eq "1") {
        docker exec $containerName dropdb -U $databaseUser --force $acceptanceDatabase | Out-Null
    }
    Pop-Location
}
