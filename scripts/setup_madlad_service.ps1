param(
    [string]$ModelId = "google/madlad400-3b-mt",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$environmentDirectory = Join-Path $projectDirectory "work\madlad-venv"
$modelDirectory = Join-Path $projectDirectory "work\models\madlad400-3b-mt"
$downloadsDirectory = Join-Path $projectDirectory "work\downloads"
$torchWheel = Join-Path $downloadsDirectory "torch-2.9.0+cu128-cp312-cp312-win_amd64.whl"
$pythonPath = Join-Path $environmentDirectory "Scripts\python.exe"
$requiredModelFiles = @(
    "model.safetensors", "config.json", "generation_config.json", "tokenizer.json",
    "tokenizer_config.json", "spiece.model", "added_tokens.json", "special_tokens_map.json"
)

if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv $environmentDirectory
    if ($LASTEXITCODE -ne 0) { throw "ساخت محیط جداگانهٔ پایتون ناموفق بود." }
}

& $pythonPath -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "به‌روزرسانی ابزار نصب بسته‌ها ناموفق بود." }
if (Test-Path -LiteralPath $torchWheel) {
    & $pythonPath -m pip install $torchWheel
} else {
    & $pythonPath -m pip install torch==2.9.0 --index-url $TorchIndexUrl
}
if ($LASTEXITCODE -ne 0) { throw "نصب نسخهٔ شتاب‌گرفتهٔ PyTorch ناموفق بود." }
& $pythonPath -m pip install -r (Join-Path $projectDirectory "services\madlad\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "نصب وابستگی‌های سرویس MADLAD ناموفق بود." }
$missingModelFiles = @($requiredModelFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $modelDirectory $_))
})
if ($missingModelFiles.Count -gt 0) {
    & $pythonPath (Join-Path $projectDirectory "services\madlad\download_model.py") `
        --model-id $ModelId --output $modelDirectory
    if ($LASTEXITCODE -ne 0) { throw "دریافت مدل رسمی MADLAD ناموفق بود." }
}

& $pythonPath -c "import torch; assert torch.cuda.is_available(), 'CUDA unavailable'; print(torch.__version__, torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) { throw "نسخهٔ نصب‌شدهٔ PyTorch به کارت گرافیک دسترسی ندارد." }

Write-Host "محیط و مدل رسمی آماده شدند."
Write-Host "مدل: $modelDirectory"
