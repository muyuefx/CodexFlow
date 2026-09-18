param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$serverUrl = 'http://127.0.0.1:43127'
$running = $false
try { $health = Invoke-RestMethod "$serverUrl/api/health" -TimeoutSec 2; $running = $health.app -eq 'codex-flow' } catch {}
if (-not $running) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    Push-Location $projectRoot
    try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed.' } } finally { Pop-Location }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist-server/index.js'))) {
    Push-Location $projectRoot
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed.' } } finally { Pop-Location }
  }
  $logDirectory = Join-Path $projectRoot 'logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $serverEntry = Join-Path $projectRoot 'dist-server/index.js'
  Start-Process -FilePath $nodeCommand.Source -ArgumentList @('"' + $serverEntry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log') | Out-Null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-RestMethod "$serverUrl/api/health" -TimeoutSec 1; if ($health.app -eq 'codex-flow') { $running = $true; break } } catch {}
  }
  if (-not $running) { throw "Server did not start. Check $logDirectory/server-error.log" }
}
if (-not $NoBrowser) { Start-Process $serverUrl }
Write-Output "Codex Flow: $serverUrl"
