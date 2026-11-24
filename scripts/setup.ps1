$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectPath
try {
  & npm.cmd ci --ignore-scripts --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências.' }
  & node scripts/setup.js
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar a instalação.' }
} finally { Pop-Location }
