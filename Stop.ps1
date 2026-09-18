$ErrorActionPreference = 'Stop'
$settingsDirectory = if ($env:CODEX_FLOW_SETTINGS) { $env:CODEX_FLOW_SETTINGS } else { Join-Path $env:LOCALAPPDATA 'CodexFlow' }
$lockPath = Join-Path $settingsDirectory 'server.lock'
if (Test-Path -LiteralPath $lockPath) {
  $serverProcessId = [int](Get-Content -LiteralPath $lockPath -Raw)
  $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
  $expectedEntry = Join-Path $PSScriptRoot 'dist-server\index.js'
  if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine.Contains($expectedEntry)) {
    Stop-Process -Id $serverProcessId
    Write-Output 'Codex Flow stopped. Unfinished runs will require recovery on next start.'
  } elseif ($serverProcess) { throw 'PID does not belong to this Codex Flow server. Nothing was stopped.' }
}
