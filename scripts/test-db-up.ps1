# test-db-up.ps1
#
# Starts a local single-node insecure CockroachDB cluster for dev/tests.
#
# Pinned binary:
#   Version: v26.2.5 (stable "Regular" release, confirmed via
#            https://api.github.com/repos/cockroachdb/cockroach/tags)
#   URL:     https://binaries.cockroachdb.com/cockroach-v26.2.5.windows-6.2-amd64.zip
#   SHA256:  701b0f570d70f16fd72adc14dec368acdcea2b46476bd80afb878a7c56b08003
#            (from https://binaries.cockroachdb.com/cockroach-v26.2.5.windows-6.2-amd64.zip.sha256sum)
#   Pinned:  2026-08-09
#
# `start-single-node --background` does not exist on the Windows build of
# this version (checked: `cockroach.exe start-single-node --help` has no
# --background flag). This script uses Start-Process to run the node
# detached instead, matching the pattern CockroachDB documents for Windows.
#
# Idempotent: if port 26257 already has a listener, this prints
# "already running" and exits 0 without starting a second node. If the
# binary is already extracted in tools/, the download is skipped.
#
# The readiness poll below hits 127.0.0.1, not localhost. Verified on
# this machine: Invoke-WebRequest against "http://localhost:8090/..." in
# Windows PowerShell 5.1 times out (System.Net.HttpWebRequest resolves
# localhost to the IPv6 loopback first and does not fall back in time),
# while curl, the cockroach CLI, and Invoke-WebRequest against
# "127.0.0.1" all connect immediately. The node itself binds fine on
# "localhost"; this only works around the .NET client-side quirk.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$CrVersion = "v26.2.5"
$CrZipName = "cockroach-$CrVersion.windows-6.2-amd64.zip"
$CrUrl = "https://binaries.cockroachdb.com/$CrZipName"
$CrSha256 = "701b0f570d70f16fd72adc14dec368acdcea2b46476bd80afb878a7c56b08003"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $RepoRoot "tools"
$ZipPath = Join-Path $ToolsDir $CrZipName
$ExtractDir = Join-Path $ToolsDir "cockroach-$CrVersion.windows-6.2-amd64"
$ExePath = Join-Path $ExtractDir "cockroach.exe"
$StoreDir = Join-Path $RepoRoot ".cockroach-data"
$ListenAddr = "localhost:26257"
$HttpAddr = "localhost:8090"
$DbName = "engram"

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

if (Test-PortOpen -HostName "localhost" -Port 26257) {
    Write-Output "already running (something is listening on localhost:26257)"
    exit 0
}

if (-not (Test-Path $ExePath)) {
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

    if (-not (Test-Path $ZipPath)) {
        Write-Output "downloading $CrUrl"
        Invoke-WebRequest -Uri $CrUrl -OutFile $ZipPath
    } else {
        Write-Output "zip already present at $ZipPath, skipping download"
    }

    $actualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $CrSha256) {
        Remove-Item -Force $ZipPath
        Write-Error "sha256 mismatch for $CrZipName (expected $CrSha256, got $actualHash); deleted corrupt download"
        exit 1
    }

    Write-Output "extracting to $ExtractDir"
    Expand-Archive -Path $ZipPath -DestinationPath $ToolsDir -Force
} else {
    Write-Output "cockroach binary already present at $ExePath, skipping download"
}

New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
$startStdout = Join-Path $StoreDir "start-stdout.log"
$startStderr = Join-Path $StoreDir "start-stderr.log"

$startArgs = @(
    "start-single-node",
    "--insecure",
    "--listen-addr=$ListenAddr",
    "--http-addr=$HttpAddr",
    "--store=$StoreDir"
)

Write-Output "starting cockroach $CrVersion (detached) on $ListenAddr"
$proc = Start-Process -FilePath $ExePath -ArgumentList $startArgs `
    -RedirectStandardOutput $startStdout -RedirectStandardError $startStderr `
    -WindowStyle Hidden -PassThru

$PidFile = Join-Path $StoreDir "cockroach.pid"
Set-Content -Path $PidFile -Value $proc.Id -NoNewline -Encoding ascii

$HealthUrl = "http://127.0.0.1:8090/health?ready=1"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # not ready yet, keep polling
    }
}

if (-not $ready) {
    Write-Error "cockroach did not become ready on $HealthUrl within 60s; see $startStderr"
    exit 1
}

& $ExePath sql --insecure --host=$ListenAddr -e "CREATE DATABASE IF NOT EXISTS $DbName;"

Write-Output "cockroach $CrVersion running: sql=$ListenAddr http=$HttpAddr store=$StoreDir db=$DbName"
exit 0
