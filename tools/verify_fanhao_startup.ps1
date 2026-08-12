param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$script:Checks = 0
$fixtureRoot = $null
$fixtureProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$fixtureChildIds = New-Object System.Collections.Generic.List[int]

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $script:Checks += 1
  if (-not $Condition) { throw $Message }
}

function Assert-Match {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Message
  )

  Assert-True -Condition ([regex]::IsMatch($Value, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) -Message "$Message`nOutput:`n$Value"
}

function Get-DynamicPort {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Test-PortListening {
  param([Parameter(Mandatory = $true)][int]$Port)

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.ConnectAsync([System.Net.IPAddress]::Loopback, $Port)
    return $connect.Wait(500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ProcessExit {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$TimeoutMilliseconds = 3000
  )

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Read-TextFileWithRetry {
  param([Parameter(Mandatory = $true)][string]$Path)

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
      return [System.IO.File]::ReadAllText($Path)
    } catch [System.IO.IOException] {
      if ($attempt -eq 39) { throw }
      Start-Sleep -Milliseconds 50
    }
  }
  return ""
}

function Invoke-StartupFixture {
  param(
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$DelayMilliseconds = 0
  )

  $oldMode = $env:FANHAO_STARTUP_FIXTURE_MODE
  $oldDelay = $env:FANHAO_STARTUP_FIXTURE_DELAY_MS
  $launcher = Join-Path $fixtureRoot "start-fanhao.ps1"
  $powerShellPath = (Get-Process -Id $PID).Path
  $invocationId = [guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $fixtureRoot "launcher-$invocationId.out.log"
  $stderrPath = Join-Path $fixtureRoot "launcher-$invocationId.err.log"
  try {
    $env:FANHAO_STARTUP_FIXTURE_MODE = $Mode
    $env:FANHAO_STARTUP_FIXTURE_DELAY_MS = [string]$DelayMilliseconds
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $launcherProcess = Start-Process -FilePath $powerShellPath `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $launcher), "-Port", [string]$Port, "-HostName", "127.0.0.1", "-SkipDownloadManager", "-StartupTimeoutSeconds", [string]$TimeoutSeconds) `
      -WorkingDirectory $fixtureRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    $timer.Stop()
    $launcherProcess.Refresh()
    $exitCode = $launcherProcess.ExitCode
    $launcherProcess.Dispose()
    $outputParts = New-Object System.Collections.Generic.List[string]
    $outputParts.Add((Read-TextFileWithRetry -Path $stdoutPath))
    $outputParts.Add((Read-TextFileWithRetry -Path $stderrPath))
    $output = $outputParts -join "`n"
    $startedMatch = [regex]::Match($output, 'Starting FanHao on port \d+ \(PID (\d+)\)')
    if ($startedMatch.Success) {
      $startedProcessId = [int]$startedMatch.Groups[1].Value
      if (-not $fixtureChildIds.Contains($startedProcessId)) { $fixtureChildIds.Add($startedProcessId) }
    }
    return [pscustomobject]@{
      ExitCode = $exitCode
      Output = $output
      ElapsedMilliseconds = $timer.ElapsedMilliseconds
    }
  } finally {
    $env:FANHAO_STARTUP_FIXTURE_MODE = $oldMode
    $env:FANHAO_STARTUP_FIXTURE_DELAY_MS = $oldDelay
  }
}

function Get-StartedProcessId {
  param([Parameter(Mandatory = $true)][string]$Output)

  $match = [regex]::Match($Output, 'Starting FanHao on port \d+ \(PID (\d+)\)')
  if (-not $match.Success) { throw "launcher output did not report its startup PID:`n$Output" }
  return [int]$match.Groups[1].Value
}

function Stop-FixtureProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedRoot
  )

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) { return }
  $expectedFullPath = [System.IO.Path]::GetFullPath($ExpectedRoot)
  if (-not ([string]$processInfo.CommandLine).Contains($expectedFullPath)) {
    throw "refusing to stop PID $ProcessId because its command line is outside the fixture root: $($processInfo.CommandLine)"
  }
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  }
  if (-not (Wait-ProcessExit -ProcessId $ProcessId)) {
    throw "fixture PID $ProcessId did not exit after termination"
  }
}

$projectFullPath = [System.IO.Path]::GetFullPath($ProjectRoot)
$launcherSource = Join-Path $projectFullPath "start-fanhao.ps1"
if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
  throw "launcher not found: $launcherSource"
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$fixtureRoot = Join-Path $tempRoot ("fanhao-startup-gate-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Path (Join-Path $fixtureRoot "tools") -Force | Out-Null
  Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $fixtureRoot "start-fanhao.ps1")
  Set-Content -LiteralPath (Join-Path $fixtureRoot "tools\build_short_video_web.mjs") -Encoding UTF8 -Value 'console.log("fixture-build: ok");'
  Set-Content -LiteralPath (Join-Path $fixtureRoot "server.js") -Encoding UTF8 -Value @'
import fs from "node:fs";
import http from "node:http";

const mode = process.env.FANHAO_STARTUP_FIXTURE_MODE || "healthy";
const delay = Number(process.env.FANHAO_STARTUP_FIXTURE_DELAY_MS || 0);
const port = Number(process.env.PORT);
const host = process.env.HOST || "127.0.0.1";
console.log(`fixture-stdout:${mode}`);
console.error(`fixture-stderr:${mode}`);

if (mode === "exit") {
  setTimeout(() => { process.exitCode = 23; }, 100);
} else if (mode === "never") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: mode === "healthy" }));
      if (mode === "healthy") {
        fs.writeFileSync(new URL("./health-hit.json", import.meta.url), JSON.stringify({ ok: true, pid: process.pid }));
        response.on("finish", () => server.close());
      }
      return;
    }
    response.writeHead(404).end();
  });
  setTimeout(() => server.listen(port, host), delay);
}
'@
  Set-Content -LiteralPath (Join-Path $fixtureRoot "sentinel.js") -Encoding UTF8 -Value @'
import http from "node:http";
const server = http.createServer((_request, response) => response.end("sentinel"));
server.listen(Number(process.env.FANHAO_STARTUP_SENTINEL_PORT), "127.0.0.1");
'@

  $successPort = Get-DynamicPort
  $success = Invoke-StartupFixture -Mode "healthy" -Port $successPort -TimeoutSeconds 5 -DelayMilliseconds 800
  Assert-True -Condition ($success.ExitCode -eq 0) -Message "delayed healthy listener must start successfully (exit $($success.ExitCode)): $($success.Output)"
  Assert-Match -Value $success.Output -Pattern 'FanHao started:.*PID \d+' -Message "successful startup must report the target PID"
  $successProcessId = Get-StartedProcessId -Output $success.Output
  $healthEvidencePath = Join-Path $fixtureRoot "health-hit.json"
  Assert-True -Condition (Test-Path -LiteralPath $healthEvidencePath -PathType Leaf) -Message "successful startup must probe the fixture health endpoint"
  $healthEvidence = ConvertFrom-Json ([System.IO.File]::ReadAllText($healthEvidencePath))
  Assert-True -Condition ([bool]$healthEvidence.ok) -Message "successful startup must observe true health"
  Assert-True -Condition ([int]$healthEvidence.pid -eq $successProcessId) -Message "the healthy listener PID must be the process started by the launcher"
  Assert-True -Condition ($success.ElapsedMilliseconds -ge 650 -and $success.ElapsedMilliseconds -lt 5000) -Message "delayed health must succeed within the five-second deadline"
  Assert-True -Condition (Wait-ProcessExit -ProcessId $successProcessId) -Message "self-closing successful fixture must release its process after proving readiness"

  $unhealthyPort = Get-DynamicPort
  $unhealthy = Invoke-StartupFixture -Mode "unhealthy" -Port $unhealthyPort -TimeoutSeconds 5
  Assert-True -Condition ($unhealthy.ExitCode -eq 2) -Message "a listening but unhealthy server must time out: $($unhealthy.Output)"
  Assert-Match -Value $unhealthy.Output -Pattern 'health endpoint did not become healthy' -Message "unhealthy startup must explain the failed health contract"
  $unhealthyProcessId = Get-StartedProcessId -Output $unhealthy.Output
  Assert-True -Condition (Wait-ProcessExit -ProcessId $unhealthyProcessId) -Message "unhealthy startup must stop the process created by the launcher"
  Assert-True -Condition ($unhealthy.ElapsedMilliseconds -lt 7500) -Message "health probing must not overrun the five-second startup budget"

  $exitPort = Get-DynamicPort
  $earlyExit = Invoke-StartupFixture -Mode "exit" -Port $exitPort -TimeoutSeconds 5
  Assert-True -Condition ($earlyExit.ExitCode -eq 1) -Message "an early process exit must fail immediately: $($earlyExit.Output)"
  Assert-Match -Value $earlyExit.Output -Pattern 'failed to start before opening its port \(PID \d+\)' -Message "early exit must report the child PID"
  Assert-Match -Value $earlyExit.Output -Pattern 'fixture-stdout:exit' -Message "early exit must include the stdout tail"
  Assert-Match -Value $earlyExit.Output -Pattern 'fixture-stderr:exit' -Message "early exit must include the stderr tail"
  Assert-True -Condition ($earlyExit.ElapsedMilliseconds -lt 3000) -Message "early exit must not wait for the startup deadline"

  $sentinelPort = Get-DynamicPort
  $oldSentinelPort = $env:FANHAO_STARTUP_SENTINEL_PORT
  try {
    $env:FANHAO_STARTUP_SENTINEL_PORT = [string]$sentinelPort
    $sentinel = Start-Process -FilePath "node" -ArgumentList @((Join-Path $fixtureRoot "sentinel.js")) -WorkingDirectory $fixtureRoot -WindowStyle Hidden -PassThru
    $fixtureProcesses.Add($sentinel)
  } finally {
    $env:FANHAO_STARTUP_SENTINEL_PORT = $oldSentinelPort
  }
  $sentinelTimer = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-PortListening -Port $sentinelPort) -and $sentinelTimer.ElapsedMilliseconds -lt 3000) {
    Start-Sleep -Milliseconds 50
  }
  Assert-True -Condition (Test-PortListening -Port $sentinelPort) -Message "sentinel fixture must be listening before timeout isolation is tested"

  $neverPort = Get-DynamicPort
  $never = Invoke-StartupFixture -Mode "never" -Port $neverPort -TimeoutSeconds 5
  Assert-True -Condition ($never.ExitCode -eq 2) -Message "a process that never listens must time out: $($never.Output)"
  Assert-Match -Value $never.Output -Pattern "did not listen on port $neverPort" -Message "never-listening startup must explain the missing listener"
  $neverProcessId = Get-StartedProcessId -Output $never.Output
  Assert-True -Condition (Wait-ProcessExit -ProcessId $neverProcessId) -Message "never-listening startup must stop its own child"
  Assert-True -Condition (-not $sentinel.HasExited) -Message "startup timeout must not stop an unrelated process"
  Assert-True -Condition (Test-PortListening -Port $sentinelPort) -Message "startup timeout must leave an unrelated listener intact"
  Assert-True -Condition ($never.ElapsedMilliseconds -lt 7500) -Message "never-listening startup must honor the hard five-second budget"

  foreach ($invalidTimeout in @(4, 601)) {
    $invalidPort = Get-DynamicPort
    $invalid = Invoke-StartupFixture -Mode "never" -Port $invalidPort -TimeoutSeconds $invalidTimeout
    Assert-True -Condition ($invalid.ExitCode -ne 0) -Message "StartupTimeoutSeconds=$invalidTimeout must fail parameter binding"
    Assert-Match -Value $invalid.Output -Pattern '(ParameterArgumentValidationError,start-fanhao\.ps1|Cannot validate argument on parameter)' -Message "invalid startup timeout must fail through ValidateRange parameter binding"
    Assert-True -Condition (-not $invalid.Output.Contains("Preparing FanHao web assets")) -Message "invalid startup timeout must fail before build or process launch"
  }

  Write-Host "fanhao-startup: $script:Checks checks passed ($($PSVersionTable.PSVersion))"
} finally {
  $fixtureRootProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ([string]$_.CommandLine).Contains([System.IO.Path]::GetFullPath($fixtureRoot))
  })
  foreach ($fixtureRootProcess in $fixtureRootProcesses) {
    Stop-FixtureProcess -ProcessId ([int]$fixtureRootProcess.ProcessId) -ExpectedRoot $fixtureRoot
  }
  foreach ($fixtureChildId in $fixtureChildIds) {
    Stop-FixtureProcess -ProcessId $fixtureChildId -ExpectedRoot $fixtureRoot
  }
  foreach ($fixtureProcess in $fixtureProcesses) {
    if ($null -ne $fixtureProcess -and -not $fixtureProcess.HasExited) {
      Stop-FixtureProcess -ProcessId $fixtureProcess.Id -ExpectedRoot $fixtureRoot
    }
  }

  if ($null -ne $fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)) {
    $resolvedFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
    $expectedPrefix = $tempRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixtureRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "refusing to remove fixture outside the system temp directory: $resolvedFixtureRoot"
    }
    $removed = $false
    for ($attempt = 0; $attempt -lt 20 -and -not $removed; $attempt++) {
      try {
        Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force -ErrorAction Stop
        $removed = $true
      } catch {
        if ($attempt -eq 19) { throw }
        Start-Sleep -Milliseconds 100
      }
    }
  }
}
