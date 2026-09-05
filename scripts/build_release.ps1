param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$releaseDirectory = if ($OutputDirectory) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    Join-Path $projectDirectory "outputs\release"
}
$version = (Get-Content (Join-Path $projectDirectory "package.json") -Raw | ConvertFrom-Json).version
$archiveName = "translator-lab-$version.zip"
$archivePath = Join-Path $releaseDirectory $archiveName
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("translator-lab-release-" + [guid]::NewGuid().ToString("N"))
$sourceArchive = Join-Path $temporaryRoot "source.zip"
$stageDirectory = Join-Path $temporaryRoot "translator-lab"

Push-Location $projectDirectory
try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "گیت در دسترس نیست." }
    $head = git rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { throw "نسخه هنوز در مخزن ثبت نشده است." }
    $dirty = @(git status --porcelain --untracked-files=all)
    if ($dirty.Count -gt 0) { throw "برای ساخت بسته، مخزن باید بدون تغییر ثبت‌نشده باشد." }

    $requiredAssets = @(
        "work\approved-translations\translation-memory.json",
        "work\approved-translations\manifest.json",
        "work\approved-translations\evaluation-set.json",
        "work\identity\osm-identity-snapshot.json"
    )
    foreach ($relativePath in $requiredAssets) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory $relativePath))) {
            throw "پروندهٔ ضروری بسته وجود ندارد: $relativePath"
        }
    }

    New-Item -ItemType Directory -Path $temporaryRoot,$stageDirectory,$releaseDirectory -Force | Out-Null
    git archive --format=zip --output=$sourceArchive HEAD
    if ($LASTEXITCODE -ne 0) { throw "استخراج نسخهٔ ثبت‌شده انجام نشد." }
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $stageDirectory -Force

    foreach ($relativePath in $requiredAssets) {
        $destination = Join-Path $stageDirectory $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectDirectory $relativePath) -Destination $destination
    }

    $assetEntries = foreach ($relativePath in $requiredAssets) {
        $item = Get-Item -LiteralPath (Join-Path $stageDirectory $relativePath)
        [ordered]@{
            path = $relativePath.Replace("\", "/")
            bytes = $item.Length
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{
        formatVersion = 1
        product = "Translator Lab"
        version = $version
        gitCommit = $head.Trim()
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        includesSecrets = $false
        modelsIncluded = $false
        requiredModels = @("qwen/qwen3.5-9b", "qwen3.5-4b")
        controlledAssets = @($assetEntries)
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageDirectory "RELEASE-MANIFEST.json") -Encoding utf8

    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -Path (Join-Path $stageDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archivePath.sha256" -Value "$hash  $archiveName" -Encoding ascii
    Write-Output $archivePath
    Write-Output "$archivePath.sha256"
} finally {
    Pop-Location
    $resolvedTemp = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemp).StartsWith("translator-lab-release-")) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
