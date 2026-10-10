param([switch]$Demo, [string]$Config = 'config.local.json')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $nodeCommand --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
if ($Demo) { $Config = 'config.demo.json' }
Push-Location -LiteralPath $projectRoot
try {
    & $nodeCommand src/main.ts --config $Config
    if ($LASTEXITCODE -ne 0) { throw "Gateway exited with code $LASTEXITCODE" }
} finally { Pop-Location }
