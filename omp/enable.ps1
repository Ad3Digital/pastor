# Liga a ligacao ao vivo do Pastor nos paineis do OMP (Windows). Para desligar: .\omp\enable.ps1 -Off
param([switch]$Off)
$ErrorActionPreference = 'Stop'
$ext = Join-Path $PSScriptRoot 'extension.ts'
$current = @(((omp config get extensions --json) -join "`n" | ConvertFrom-Json).value)
$next = @($current | Where-Object { $_ -and $_.Replace('\', '/') -ine $ext.Replace('\', '/') })
if (-not $Off) { $next += $ext }
$json = ConvertTo-Json -InputObject @($next) -Compress
# O PowerShell 5.1 precisa das aspas do JSON escapadas para passar o argumento ao omp.
omp config set extensions ($json.Replace('"', '\"')) | Out-Null
if ($Off) { 'OK  ligacao ao vivo do OMP desligada.' } else { 'OK  ligacao ao vivo ligada para os proximos OMP abertos no Herdr.' }
