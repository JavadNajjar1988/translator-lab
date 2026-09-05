param(
    [int]$Port = 3007,
    [string]$HostAddress = "0.0.0.0"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectDirectory "work\madlad-venv\Scripts\python.exe"
$modelDirectory = Join-Path $projectDirectory "work\models\madlad400-3b-mt"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "محیط مدل آماده نیست. ابتدا scripts\setup_madlad_service.ps1 را اجرا کنید."
}
if (-not (Test-Path -LiteralPath (Join-Path $modelDirectory "model.safetensors"))) {
    throw "فایل رسمی مدل پیدا نشد. ابتدا scripts\setup_madlad_service.ps1 را اجرا کنید."
}

$env:MADLAD_MODEL_ID = "google/madlad400-3b-mt"
$env:MADLAD_MODEL_PATH = $modelDirectory
$env:PYTHONPATH = $projectDirectory
& $pythonPath -m uvicorn services.madlad.app:app --host $HostAddress --port $Port
