param(
  [switch]$ForceFreshCache,
  [int]$RenderTimeoutSec = 360
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$PnpmShim = Join-Path $HOME 'AppData\Roaming\npm\pnpm.ps1'
$StdoutLog = Join-Path $RepoRoot 'tauri-dev.stdout.log'
$StderrLog = Join-Path $RepoRoot 'tauri-dev.stderr.log'
$CdpPort = 9222
$VitePort = 1420

function Write-Log([string]$Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

function Stop-NezhaProcesses {
  $procs = @(Get-Process -Name nezha -ErrorAction SilentlyContinue)
  foreach ($p in $procs) {
    $children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id })
    if ($children.Count -gt 0) {
      Write-Log "WARN: nezha pid $($p.Id) has $($children.Count) child process(es); stopping anyway (single-instance)"
    }
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Write-Log "stopped nezha pid $($p.Id)"
  }
}

function Stop-DevChain {
  $procs = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -match [regex]::Escape($RepoRoot)
  })
  $shims = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -eq 'powershell.exe' -and
    $_.CommandLine -match 'pnpm\.ps1'
  })
  foreach ($p in @($procs + $shims)) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Isolate-ViteCache {
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $vite = Join-Path $RepoRoot 'node_modules\.vite'
  $temp = Join-Path $RepoRoot 'node_modules\.vite-temp'
  if (Test-Path -LiteralPath $vite) {
    Rename-Item -LiteralPath $vite -NewName ".vite-stale-$stamp"
    Write-Log "isolated stale vite cache -> node_modules\.vite-stale-$stamp"
  }
  if (Test-Path -LiteralPath $temp) {
    Rename-Item -LiteralPath $temp -NewName ".vite-temp-stale-$stamp"
    Write-Log "isolated stale vite temp -> node_modules\.vite-temp-stale-$stamp"
  }
}

function Start-Dev {
  if (-not (Test-Path -LiteralPath $PnpmShim)) {
    throw "pnpm shim not found: $PnpmShim"
  }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
  Start-Process powershell -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PnpmShim, 'tauri', 'dev'
  ) -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog | Out-Null
  Write-Log "launched tauri dev (logs: $StdoutLog, $StderrLog)"
}

function Wait-DevReady([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $app = Get-Process -Name nezha -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like '*src-tauri\target\debug*' } | Select-Object -First 1
    $port = Get-NetTCPConnection -LocalPort $VitePort -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($app -and $port) { return $app }
    Start-Sleep -Seconds 3
  }
  return $null
}

function Get-CdpTarget {
  try {
    $list = (Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/list" -UseBasicParsing -TimeoutSec 5).Content |
      ConvertFrom-Json
    return @($list)[0]
  } catch {
    return $null
  }
}

function Invoke-Cdp($WebSocket, [int]$Id, [string]$Method, $Params) {
  $payload = @{ id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $WebSocket.SendAsync([ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
    [Threading.CancellationToken]::None).Wait()
  $buffer = New-Object byte[] 262144
  $stream = New-Object IO.MemoryStream
  do {
    $segment = [ArraySegment[byte]]::new($buffer)
    $result = $WebSocket.ReceiveAsync($segment, [Threading.CancellationToken]::None).Result
    $stream.Write($buffer, 0, $result.Count)
  } while (-not $result.EndOfMessage)
  return [Text.Encoding]::UTF8.GetString($stream.ToArray())
}

function Probe-Render {
  $target = Get-CdpTarget
  if (-not $target) { return $null }
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  try {
    $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
    $expr = 'JSON.stringify({href: location.href, rootChildren: (document.querySelector("#root") ? document.querySelector("#root").children.length : -1)})'
    $resp = Invoke-Cdp $ws 1 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true }
    $value = (($resp | ConvertFrom-Json).result.result.value)
    return ($value | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    $ws.Dispose()
  }
}

function Wait-Rendered([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $state = Probe-Render
    if ($state) {
      Write-Log ("render probe: href={0} rootChildren={1}" -f $state.href, $state.rootChildren)
      if ($state.rootChildren -gt 0) { return $true }
      if ($state.href -eq 'about:blank') {
        $target = Get-CdpTarget
        if ($target) {
          $ws = [System.Net.WebSockets.ClientWebSocket]::new()
          try {
            $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
            [void](Invoke-Cdp $ws 1 'Page.navigate' @{ url = 'http://localhost:1420/' })
            Write-Log 'navigated about:blank -> http://localhost:1420/'
          } finally {
            $ws.Dispose()
          }
        }
      }
    }
    Start-Sleep -Seconds 8
  }
  return $false
}

Write-Log "repo: $RepoRoot"
Stop-NezhaProcesses
Stop-DevChain
if ($ForceFreshCache) {
  Isolate-ViteCache
}

Start-Dev
$app = Wait-DevReady 90
if (-not $app) {
  Write-Log 'FAIL: dev process or vite port not ready within 90s (check tauri-dev.stderr.log)'
  exit 1
}
Write-Log "dev app up: pid $($app.Id), started $($app.StartTime.ToString('HH:mm:ss'))"

Write-Log "waiting up to ${RenderTimeoutSec}s for render (cold start can take 3-6 min)"
if (Wait-Rendered $RenderTimeoutSec) {
  Write-Log 'RENDERED OK'
  exit 0
}

Write-Log 'white screen detected; isolating vite cache and relaunching once'
Stop-DevChain
Stop-NezhaProcesses
Isolate-ViteCache
Start-Dev
$app2 = Wait-DevReady 90
if ($app2 -and (Wait-Rendered $RenderTimeoutSec)) {
  Write-Log "RENDERED OK after cache refresh (pid $($app2.Id))"
  exit 0
}

Write-Log 'FAIL: still not rendered within timeout (see tauri-dev.stderr.log).'
Write-Log 'The app may still be cold-transforming; probe again later with:'
Write-Log '  powershell -File .codex/skills/nezha-build-launch/scripts/launch-dev.ps1 (idempotent)'
exit 1
