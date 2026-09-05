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
$archiveName = "translator-lab-docker-images-$version.tar"
$archivePath = Join-Path $releaseDirectory $archiveName
$images = @(
    "translator-lab-backend:$version",
    "translator-lab-frontend:$version",
    "postgis/postgis:18-3.6"
)

Push-Location $projectDirectory
try {
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    foreach ($image in $images) {
        docker image inspect $image | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "تصویر داکر آماده نیست: $image" }
    }
    docker save --output $archivePath $images
    if ($LASTEXITCODE -ne 0) { throw "ساخت بستهٔ تصویرهای داکر ناموفق بود." }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archivePath.sha256" -Value "$hash  $archiveName" -Encoding ascii
    Write-Output $archivePath
    Write-Output "$archivePath.sha256"
} finally {
    Pop-Location
}
