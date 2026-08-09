# resilience-demo.ps1
#
# Phase 4 Step 4 (docs/plans/2026-08-09-phase-4-ship.md): local 3-node
# resilience film. Boots a local insecure 3-node CockroachDB cluster on
# ports DIFFERENT from the single-node test DB (scripts/test-db-up.ps1 owns
# :26257 and .cockroach-data/ - this script never touches either), runs the
# engram server against node1, drives a remember/recall loop against it, and
# kills node3 then node2 mid-loop to show the honest resilience story:
#
#   - pg (node-postgres) opens ONE TCP connection to ONE gateway node. It
#     cannot fail over to a different host on its own - that is not what is
#     being demonstrated here.
#   - What IS demonstrated: CockroachDB's resilience lives at the range/
#     replica layer BEHIND whichever gateway the app is connected to. With
#     3 nodes and the default 3x replication factor, killing ONE other node
#     (node3) leaves the gateway (node1) with a live majority (2/3) for
#     every range, so app requests keep succeeding uninterrupted even
#     though a node in the CLUSTER died.
#   - Killing a SECOND node (node2) drops the cluster to 1/3 live. Raft
#     quorum needs a majority of replicas (2 of 3) to agree before a range
#     can serve reads or writes, so with only the gateway node left alive,
#     ranges cannot reach quorum: requests hang until they time out. This
#     is not a bug, it is the honest teaching moment - "resilient" means
#     "survives losing a minority of replicas", not "survives losing
#     everything but the box you happen to be talking to".
#   - Restarting node2 and node3 restores quorum and requests recover.
#
# Pinned binary: same as scripts/test-db-up.ps1 (v26.2.5, tools/cockroach-
# v26.2.5.windows-6.2-amd64/cockroach.exe). This script does not download
# it - run scripts/test-db-up.ps1 (or scripts/test-db-up.sh) at least once
# first so tools/ is populated; the single-node test DB does not need to
# stay running for this script's own cluster, but it must not be stopped
# either (tests depend on it).
#
# Usage:
#   powershell -File scripts/resilience-demo.ps1            run the full demo, clean up on exit
#   powershell -File scripts/resilience-demo.ps1 -Teardown  clean up a previous run only, no demo
#   powershell -File scripts/resilience-demo.ps1 -NoCleanup keep the cluster + server running after the demo (manual inspection)
#
# Idempotent: safe to re-run. If a previous run's processes or data dir are
# still around, -Teardown clears them; the main run always cleans up after
# itself (success or failure) unless -NoCleanup is passed.

param(
    [switch]$Teardown,
    [switch]$NoCleanup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# Paths, ports, pinned binary (same pin as scripts/test-db-up.ps1)
# ---------------------------------------------------------------------------

$CrVersion = "v26.2.5"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExePath = Join-Path $RepoRoot "tools\cockroach-$CrVersion.windows-6.2-amd64\cockroach.exe"
$TsxCli = Join-Path $RepoRoot "node_modules\tsx\dist\cli.mjs"

$ResilienceDir = Join-Path $RepoRoot ".cockroach-resilience"
$Node1Store = Join-Path $ResilienceDir "node1"
$Node2Store = Join-Path $ResilienceDir "node2"
$Node3Store = Join-Path $ResilienceDir "node3"

$Node1Sql = "localhost:26261"
$Node2Sql = "localhost:26262"
$Node3Sql = "localhost:26263"
$Node1Http = "localhost:8091"
$Node2Http = "localhost:8092"
$Node3Http = "localhost:8093"
$JoinList = "$Node1Sql,$Node2Sql,$Node3Sql"

$DbName = "engram_resilience"
$DatabaseUrl = "postgresql://root@$($Node1Sql)/$($DbName)?sslmode=disable"
$ServerPort = 8797
$ServerUrl = "http://localhost:$ServerPort"
$ScopeId = "resilience-demo"

$Node1PidFile = Join-Path $ResilienceDir "node1.pid"
$Node2PidFile = Join-Path $ResilienceDir "node2.pid"
$Node3PidFile = Join-Path $ResilienceDir "node3.pid"
$ServerPidFile = Join-Path $ResilienceDir "server.pid"
$LoopScript = Join-Path $ResilienceDir "loop.mjs"
$LoopLog = Join-Path $ResilienceDir "loop.log"
$LoopErrLog = Join-Path $ResilienceDir "loop-err.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Test-PortOpen {
    param([string]$HostName, [int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        $ok = $task.Wait(500)
        return ($ok -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Write-Phase {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 78) -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("=" * 78) -ForegroundColor Cyan
}

# Stops a process by pidfile, verifying the process name first (mirrors
# scripts/test-db-down.ps1's defensive pattern) so a stale or reused pid can
# never kill an unrelated process.
function Stop-ByPidFile {
    param([string]$PidFile, [string]$ExpectedName)
    if (-not (Test-Path $PidFile)) { return }
    $targetPid = (Get-Content -Path $PidFile -Raw -ErrorAction SilentlyContinue)
    if ($targetPid) { $targetPid = $targetPid.Trim() }
    if (-not $targetPid) { return }
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    if ($proc.ProcessName -ne $ExpectedName) {
        Write-Host "  skip: pid $targetPid is '$($proc.ProcessName)', not '$ExpectedName' - not killing it"
        return
    }
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $targetPid -Timeout 10 -ErrorAction SilentlyContinue
    Write-Host "  stopped $ExpectedName (pid $targetPid)"
}

# Defensive net beyond the pidfiles above: kills anything whose command line
# mentions the resilience store dir, scoped strictly to that literal path so
# this can never touch scripts/test-db-up.ps1's .cockroach-data cluster or
# any other cockroach.exe/node.exe on the box.
function Stop-StragglersByCommandLine {
    param([string]$MarkerPath)
    $marker = $MarkerPath -replace '\\', '\\\\'
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'cockroach.exe' OR Name = 'node.exe'" -ErrorAction SilentlyContinue
    } catch {
        return
    }
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$MarkerPath*") {
            Write-Host "  stopped straggler $($p.Name) (pid $($p.ProcessId))"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-Cleanup {
    Write-Phase "CLEANUP"
    Stop-ByPidFile -PidFile $ServerPidFile -ExpectedName "node"
    Stop-ByPidFile -PidFile $Node1PidFile -ExpectedName "cockroach"
    Stop-ByPidFile -PidFile $Node2PidFile -ExpectedName "cockroach"
    Stop-ByPidFile -PidFile $Node3PidFile -ExpectedName "cockroach"
    Stop-StragglersByCommandLine -MarkerPath $ResilienceDir
    Start-Sleep -Milliseconds 500
    $existed = Test-Path $ResilienceDir
    if ($existed) {
        Remove-Item -Recurse -Force $ResilienceDir -ErrorAction SilentlyContinue
    }
    if (Test-Path $ResilienceDir) {
        Write-Host "  WARNING: $ResilienceDir still present after cleanup (a file may be locked); leaving it for manual removal"
    } elseif ($existed) {
        Write-Host "  removed $ResilienceDir"
    } else {
        Write-Host "  nothing to remove ($ResilienceDir did not exist)"
    }
    Write-Host "  the single-node test DB on :26257 and .cockroach-data/ were never touched by this script"
}

if ($Teardown) {
    Invoke-Cleanup
    exit 0
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

if (-not (Test-Path $ExePath)) {
    Write-Error "cockroach binary not found at $ExePath. Run scripts/test-db-up.ps1 once first to download the pinned binary (this script reuses it, it does not download its own copy)."
    exit 1
}
if (-not (Test-Path $TsxCli)) {
    Write-Error "tsx not found at $TsxCli. Run npm install first."
    exit 1
}
if (-not (Test-PortOpen -HostName "127.0.0.1" -Port 26257)) {
    Write-Host "NOTE: the single-node test DB on :26257 does not appear to be running. This script does not need it, but tests will fail until you start it with scripts/test-db-up.ps1." -ForegroundColor Yellow
}
foreach ($p in @(26261, 26262, 26263, 8091, 8092, 8093, $ServerPort)) {
    if (Test-PortOpen -HostName "127.0.0.1" -Port $p) {
        Write-Error "port $p is already in use. Run 'powershell -File scripts/resilience-demo.ps1 -Teardown' to clean up a previous run, or free the port manually, then retry."
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $ResilienceDir | Out-Null
New-Item -ItemType Directory -Force -Path $Node1Store | Out-Null
New-Item -ItemType Directory -Force -Path $Node2Store | Out-Null
New-Item -ItemType Directory -Force -Path $Node3Store | Out-Null

# Node driver script (fetch loop against /api/remember + /api/recall). This
# is generated into the (gitignored) .cockroach-resilience/ dir at run time,
# not committed - it lives and dies with this script's own working dir, so
# scripts/resilience-demo.ps1 is the only source file this demo adds to the
# repo. AbortSignal.timeout(3000) is what turns "quorum lost, request hangs
# forever" into a clean "stalled" log line instead of hanging the loop
# process itself (Step 7 of the task brief).
# Single-quoted here-string: PowerShell applies ZERO variable expansion and
# ZERO backtick-escape processing inside '@ ... @' (unlike "@ ... @"), which
# matters here because the JS body below is full of template-literal
# backticks and ${...} interpolation that a double-quoted here-string would
# corrupt (backtick-dollar is an escape sequence there, and ${NAME} is
# PowerShell's curly-brace variable syntax). The two dynamic values
# (server URL, scope id) are injected afterwards via plain .Replace() on
# placeholder tokens instead, so this block stays 100% literal JS.
$loopSource = @'
const BASE_URL = "__BASE_URL__";
const SCOPE_ID = "__SCOPE_ID__";
const TIMEOUT_MS = 3000;
let i = 0;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

async function timedFetch(pathname, body) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, latency, detail: `http_${res.status} ${text.slice(0, 80)}` };
    }
    const json = await res.json();
    return { ok: true, latency, json };
  } catch (err) {
    const latency = Date.now() - start;
    const isTimeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const detail = isTimeout ? `stalled (quorum likely lost, ${TIMEOUT_MS}ms timeout)` : (err && err.message) || String(err);
    return { ok: false, latency, detail };
  }
}

async function tick() {
  i++;
  const content = `resilience demo fact #${i}`;
  const r = await timedFetch("/api/remember", { scope_id: SCOPE_ID, content });
  if (r.ok) {
    console.log(`[${ts()}] remember #${i}  OK      ${r.latency}ms`);
  } else {
    console.log(`[${ts()}] remember #${i}  FAILED  ${r.latency}ms  ${r.detail}`);
  }

  const q = await timedFetch("/api/recall", { scope_id: SCOPE_ID, query: "resilience demo fact" });
  if (q.ok) {
    console.log(`[${ts()}] recall   #${i}  OK      ${q.latency}ms  (${q.json.memories.length} memories)`);
  } else {
    console.log(`[${ts()}] recall   #${i}  FAILED  ${q.latency}ms  ${q.detail}`);
  }
}

async function loop() {
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, 500));
  }
}

loop();
'@
$loopSource = $loopSource.Replace('__BASE_URL__', $ServerUrl).Replace('__SCOPE_ID__', $ScopeId)
Set-Content -Path $LoopScript -Value $loopSource -Encoding utf8 -NoNewline

$overallOk = $true

try {
    # -----------------------------------------------------------------------
    # PHASE 1: boot the 3-node cluster, migrate, start server, baseline loop
    # -----------------------------------------------------------------------
    Write-Phase "PHASE 1: baseline - 3-node cluster up, all replicas live"

    $startArgsFor = {
        param($Store, $Listen, $Http)
        @("start", "--insecure", "--store=$Store", "--listen-addr=$Listen", "--http-addr=$Http", "--join=$JoinList")
    }

    Write-Host "starting node1 ($Node1Sql) ..."
    $node1Proc = Start-Process -FilePath $ExePath -ArgumentList (& $startArgsFor $Node1Store $Node1Sql $Node1Http) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "node1-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "node1-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $Node1PidFile -Value $node1Proc.Id -NoNewline -Encoding ascii

    Write-Host "starting node2 ($Node2Sql) ..."
    $node2Proc = Start-Process -FilePath $ExePath -ArgumentList (& $startArgsFor $Node2Store $Node2Sql $Node2Http) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "node2-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "node2-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $Node2PidFile -Value $node2Proc.Id -NoNewline -Encoding ascii

    Write-Host "starting node3 ($Node3Sql) ..."
    $node3Proc = Start-Process -FilePath $ExePath -ArgumentList (& $startArgsFor $Node3Store $Node3Sql $Node3Http) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "node3-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "node3-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $Node3PidFile -Value $node3Proc.Id -NoNewline -Encoding ascii

    # Nodes wait for `cockroach init` before serving; poll each node's HTTP
    # health endpoint via 127.0.0.1 (localhost resolves IPv6-first and stalls
    # under .NET's HttpWebRequest on this machine - same quirk documented in
    # scripts/test-db-up.ps1) until all three answer, then init once.
    Write-Host "waiting for all 3 nodes to accept connections ..."
    foreach ($httpAddr in @("8091", "8092", "8093")) {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-PortOpen -HostName "127.0.0.1" -Port ([int]$httpAddr)) { $ready = $true; break }
        }
        if (-not $ready) {
            throw "node on http port $httpAddr did not start listening within 15s"
        }
    }

    Write-Host "running cockroach init ..."
    & $ExePath init --insecure --host=$Node1Sql
    if ($LASTEXITCODE -ne 0) { throw "cockroach init failed with exit code $LASTEXITCODE" }

    Write-Host "waiting for all 3 nodes to report is_live=true ..."
    $clusterLive = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $csv = & $ExePath node status --insecure --host=$Node1Sql --format=csv 2>$null
        if ($LASTEXITCODE -eq 0 -and $csv) {
            $rows = $csv | ConvertFrom-Csv
            $liveCount = ($rows | Where-Object { $_.is_live -eq "true" }).Count
            if ($liveCount -eq 3) { $clusterLive = $true; break }
        }
    }
    if (-not $clusterLive) { throw "cluster did not report 3/3 nodes live within 15s" }
    Write-Host "cluster live: 3/3 nodes (node1=$Node1Sql node2=$Node2Sql node3=$Node3Sql)"

    Write-Host "creating database $DbName on node1 ..."
    & $ExePath sql --insecure --host=$Node1Sql -e "CREATE DATABASE IF NOT EXISTS $DbName;"
    if ($LASTEXITCODE -ne 0) { throw "CREATE DATABASE failed with exit code $LASTEXITCODE" }

    Write-Host "running migrations against $DatabaseUrl (insecure local URL, safe to print) ..."
    $env:ENGRAM_DATABASE_URL = $DatabaseUrl
    & node $TsxCli (Join-Path $RepoRoot "src\migrate.ts")
    if ($LASTEXITCODE -ne 0) { throw "migrate failed with exit code $LASTEXITCODE" }

    Write-Host "starting engram server on :$ServerPort against node1, ENGRAM_FAKE_BEDROCK=1 (offline; this demo exercises the DB layer, not Bedrock) ..."
    $env:ENGRAM_DATABASE_URL = $DatabaseUrl
    $env:ENGRAM_FAKE_BEDROCK = "1"
    $env:PORT = "$ServerPort"
    $serverProc = Start-Process -FilePath "node" -ArgumentList @($TsxCli, (Join-Path $RepoRoot "src\server.ts")) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "server-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "server-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $ServerPidFile -Value $serverProc.Id -NoNewline -Encoding ascii

    $serverReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-PortOpen -HostName "127.0.0.1" -Port $ServerPort) { $serverReady = $true; break }
    }
    if (-not $serverReady) { throw "engram server did not start listening on :$ServerPort within 15s (see $ResilienceDir\server-err.log)" }
    Write-Host "engram server up: $ServerUrl (scope=$ScopeId)"

    Write-Host ""
    Write-Host "IMPORTANT (honest framing for the recording): the app's pg pool holds ONE"
    Write-Host "connection to node1. pg cannot fail over between hosts by itself. What this"
    Write-Host "demo shows is CockroachDB's resilience at the RANGE/REPLICA layer behind"
    Write-Host "that one gateway node - the cluster keeps serving node1's queries as long"
    Write-Host "as a majority of each range's replicas (2 of 3) stay alive, even while"
    Write-Host "other nodes in the cluster are killed."

    Write-Host ""
    Write-Host "starting remember/recall loop (every 500ms, POST /api/remember + /api/recall) ..."
    $loopProc = Start-Process -FilePath "node" -ArgumentList @($LoopScript) `
        -RedirectStandardOutput $LoopLog -RedirectStandardError $LoopErrLog `
        -WindowStyle Hidden -PassThru

    function Show-LoopTail {
        param([int]$Seconds, [ref]$LastLineCount)
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path $LoopLog) {
                $lines = Get-Content -Path $LoopLog -ErrorAction SilentlyContinue
                if ($lines -and $lines.Count -gt $LastLineCount.Value) {
                    $lines[$LastLineCount.Value..($lines.Count - 1)] | ForEach-Object { Write-Host "  $_" }
                    $LastLineCount.Value = $lines.Count
                }
            }
            Start-Sleep -Milliseconds 300
        }
    }

    $lastLine = 0
    Show-LoopTail -Seconds 5 -LastLineCount ([ref]$lastLine)

    # -----------------------------------------------------------------------
    # PHASE 2: kill node3 (2/3 up, quorum held)
    # -----------------------------------------------------------------------
    Write-Phase "PHASE 2: Stop-Process node3 -> 2/3 nodes up, Raft quorum HELD"
    Write-Host "killing node3 (pid $($node3Proc.Id)) - the app is NOT connected to this node"
    Stop-Process -Id $node3Proc.Id -Force
    Write-Host "node3 down. loop keeps running against node1; expect OK lines to continue:"
    Show-LoopTail -Seconds 8 -LastLineCount ([ref]$lastLine)

    # -----------------------------------------------------------------------
    # PHASE 3: kill node2 (1/3 up, quorum lost - writes stall)
    # -----------------------------------------------------------------------
    Write-Phase "PHASE 3: Stop-Process node2 -> 1/3 nodes up, Raft quorum LOST"
    Write-Host "killing node2 (pid $($node2Proc.Id)) - only node1 (the gateway) is left alive"
    Stop-Process -Id $node2Proc.Id -Force
    Write-Host "node2 down. 2 of 3 replicas for every range are gone: no majority is"
    Write-Host "reachable, so ranges cannot serve. Requests below should time out at"
    Write-Host "~3000ms and print 'stalled (quorum likely lost)' - this is the honest"
    Write-Host "teaching moment, not a demo failure:"
    Show-LoopTail -Seconds 10 -LastLineCount ([ref]$lastLine)

    # -----------------------------------------------------------------------
    # PHASE 4: nodes back, recovery
    # -----------------------------------------------------------------------
    Write-Phase "PHASE 4: restart node2 + node3 -> quorum restored, recovery"
    Write-Host "restarting node2 ($Node2Sql) ..."
    $node2Proc = Start-Process -FilePath $ExePath -ArgumentList (& $startArgsFor $Node2Store $Node2Sql $Node2Http) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "node2-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "node2-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $Node2PidFile -Value $node2Proc.Id -NoNewline -Encoding ascii

    Write-Host "restarting node3 ($Node3Sql) ..."
    $node3Proc = Start-Process -FilePath $ExePath -ArgumentList (& $startArgsFor $Node3Store $Node3Sql $Node3Http) `
        -RedirectStandardOutput (Join-Path $ResilienceDir "node3-out.log") `
        -RedirectStandardError (Join-Path $ResilienceDir "node3-err.log") `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $Node3PidFile -Value $node3Proc.Id -NoNewline -Encoding ascii

    Write-Host "waiting for nodes to rejoin ..."
    foreach ($httpAddr in @("8092", "8093")) {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-PortOpen -HostName "127.0.0.1" -Port ([int]$httpAddr)) { $ready = $true; break }
        }
        if (-not $ready) { throw "node on http port $httpAddr did not restart within 15s" }
    }

    Write-Host "quorum should now be restored (majority of replicas reachable again);"
    Write-Host "requests below should recover to OK:"
    Show-LoopTail -Seconds 8 -LastLineCount ([ref]$lastLine)

    $csv = & $ExePath node status --insecure --host=$Node1Sql --format=csv 2>$null
    if ($csv) {
        $rows = $csv | ConvertFrom-Csv
        $liveCount = ($rows | Where-Object { $_.is_live -eq "true" }).Count
        Write-Host ""
        Write-Host "final node status: $liveCount/3 nodes is_live=true"
    }

    Write-Host ""
    Write-Host "loop process (pid $($loopProc.Id)) stopping ..."
    Stop-Process -Id $loopProc.Id -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "DONE. Full loop transcript: $LoopLog (removed on cleanup unless -NoCleanup)."
} catch {
    $overallOk = $false
    Write-Host ""
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($NoCleanup) {
        Write-Host ""
        Write-Host "-NoCleanup passed: leaving cluster, server, and $ResilienceDir running for inspection." -ForegroundColor Yellow
        Write-Host "Run 'powershell -File scripts/resilience-demo.ps1 -Teardown' when done."
    } else {
        Invoke-Cleanup
    }
}

if (-not $overallOk) { exit 1 }
exit 0
