param(
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [Parameter(Mandatory=$true)][string]$CodexPath,
  [Parameter(Mandatory=$true)][int]$ProviderPort
)
$ErrorActionPreference = 'Stop'
$fixtureRoot = [IO.Path]::GetFullPath($EvidenceRoot)
foreach ($part in @('profile/.nezha','codex-home','project','webview')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot $part) | Out-Null
}
$fixtureProject = Join-Path $fixtureRoot 'project'
if (-not (Test-Path -LiteralPath (Join-Path $fixtureProject '.git'))) { git -C $fixtureProject init --quiet }
foreach ($report in @('warm','cold','one')) {
  $reportPath = Join-Path $fixtureProject "$report-report.json"
  if (-not (Test-Path -LiteralPath $reportPath)) { '{}' | Set-Content -LiteralPath $reportPath -Encoding utf8 }
}
$catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'model.json') -Raw | ConvertFrom-Json
$catalog.slug = 'gpt-6-astra'
$catalog.display_name = 'Synthetic acceptance model'
@{models=@($catalog)} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'catalog.json') -Encoding utf8
$catalogPath = (Join-Path $fixtureRoot 'catalog.json') -replace '\\','/'
@"
model = "gpt-6-astra"
model_provider = "openai"
model_reasoning_effort = "medium"
openai_base_url = "http://127.0.0.1:$ProviderPort/v1"
cli_auth_credentials_store = "file"
features.reasoning_effort_override = true
features.enable_request_compression = false
model_catalog_json = "$catalogPath"
"@ | Set-Content -LiteralPath (Join-Path $fixtureRoot 'codex-home/config.toml') -Encoding utf8
@{OPENAI_API_KEY='synthetic-loopback-only'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'codex-home/auth.json') -Encoding utf8
@{
  codex_path=$CodexPath; codex_run_mode='structured'; codex_prompt_predictions_enabled=$true;
  claude_enabled=$false; codex_enabled=$true; dsh_enabled=$false; system_notifications=$false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'profile/.nezha/settings.json') -Encoding utf8
@(@{id='acceptance-project';name='Prediction acceptance';path=$fixtureProject;lastOpenedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}) |
  ConvertTo-Json -AsArray | Set-Content -LiteralPath (Join-Path $fixtureRoot 'profile/.nezha/projects.json') -Encoding utf8
Write-Output $fixtureRoot
