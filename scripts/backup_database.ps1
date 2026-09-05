param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$backupDirectory = if ($OutputDirectory) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    Join-Path $projectDirectory "outputs\backups"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "داکر روی این دستگاه در دسترس نیست."
}

Push-Location $projectDirectory
try {
    $containerName = "translator-lab-postgis"
    $running = docker inspect --format "{{.State.Running}}" $containerName 2>$null
    if ($running -ne "true") { throw "کانتینر پایگاه داده در حال اجرا نیست." }

    $databaseUser = (docker exec $containerName printenv POSTGRES_USER).Trim()
    $databaseName = (docker exec $containerName printenv POSTGRES_DB).Trim()
    if (-not $databaseUser -or -not $databaseName) { throw "مشخصات پایگاه داده از کانتینر خوانده نشد." }

    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss", [System.Globalization.CultureInfo]::InvariantCulture)
    $baseName = "translator-lab-$databaseName-$timestamp"
    $containerPath = "/tmp/$baseName.dump"
    $backupPath = Join-Path $backupDirectory "$baseName.dump"

    docker exec $containerName pg_dump -U $databaseUser -d $databaseName -Fc -f $containerPath
    if ($LASTEXITCODE -ne 0) { throw "تهیهٔ نسخهٔ پشتیبان کامل نشد." }

    docker exec $containerName pg_restore --list $containerPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ساختار نسخهٔ پشتیبان معتبر نیست." }

    docker cp "${containerName}:$containerPath" $backupPath
    if ($LASTEXITCODE -ne 0) { throw "انتقال نسخهٔ پشتیبان به میزبان انجام نشد." }

    docker exec $containerName rm -f $containerPath
    if ($LASTEXITCODE -ne 0) { throw "پاک‌سازی فایل موقت داخل کانتینر انجام نشد." }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash.ToLowerInvariant()
    $hashPath = "$backupPath.sha256"
    Set-Content -LiteralPath $hashPath -Value "$hash  $([System.IO.Path]::GetFileName($backupPath))" -Encoding ascii

    $metadata = [ordered]@{
        formatVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        database = $databaseName
        container = $containerName
        file = [System.IO.Path]::GetFileName($backupPath)
        bytes = (Get-Item -LiteralPath $backupPath).Length
        sha256 = $hash
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath "$backupPath.json" -Encoding utf8
    Write-Output $backupPath
    Write-Output $hashPath
} finally {
    Pop-Location
}
