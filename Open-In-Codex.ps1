param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

# Use Codex's registered browser deep link, without opening the default browser.
$serverUrl = 'http://127.0.0.1:43127/'
$codexLink = 'codex://browser?url=' + [Uri]::EscapeDataString($serverUrl)
if (-not (Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\codex')) {
  throw 'Codex URL handler is not installed. Open the Codex desktop app once and try again.'
}
& (Join-Path $PSScriptRoot 'Start.ps1') -NoBrowser
$health = Invoke-RestMethod ($serverUrl + 'api/health') -TimeoutSec 5
if ($health.app -ne 'codex-flow') { throw 'The local service is not Codex Flow.' }
if ($CheckOnly) {
  Write-Output "Ready: $codexLink"
  return
}
# MSIX URL activation can silently fail on this installation. Sending the same
# supported deep link to the running app reaches its single-instance handler.
$appPath = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' } |
  Select-Object -First 1 -ExpandProperty Path
if (-not $appPath) {
  $package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
  if ($package) {
    $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $candidate) { $appPath = $candidate }
  }
}
if ($appPath) {
  Start-Process -FilePath $appPath -ArgumentList $codexLink
} else {
  Start-Process -FilePath $codexLink
}
Write-Output 'Codex Flow opening in the Codex browser.'
