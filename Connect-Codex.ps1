$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start.ps1') -NoBrowser
& codex mcp add codex-flow --url 'http://127.0.0.1:43127/mcp'
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP configuration failed.' }
$skillSource = Join-Path $PSScriptRoot 'integration/codex-workflow'
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillTarget = Join-Path $codexRoot 'skills/codex-workflow'
New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $skillSource 'SKILL.md') -Destination (Join-Path $skillTarget 'SKILL.md') -Force
Write-Output 'Connected. Reload MCP in Codex or start a new conversation to load the tools and skill.'
