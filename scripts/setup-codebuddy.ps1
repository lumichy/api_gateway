param([switch]$SkipInstall, [switch]$SkipLogin)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$toolRoot = Join-Path $projectRoot '.tools/codebuddy'
Push-Location -LiteralPath $projectRoot
try {
    if (-not $SkipInstall) {
        & npm install --prefix $toolRoot --ignore-scripts --no-audit --no-fund '@tencent-ai/codebuddy-code@2.161.0'
        if ($LASTEXITCODE -ne 0) { throw 'Official CodeBuddy installation failed.' }
    }
    if ($SkipLogin) {
        & $nodeCommand scripts/login-codebuddy.ts --prepare-only
    } else {
        & $nodeCommand scripts/login-codebuddy.ts
    }
    if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy setup or login failed.' }
} finally { Pop-Location }
