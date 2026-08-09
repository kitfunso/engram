# test-db-down.ps1
#
# Stops the local single-node CockroachDB cluster started by
# test-db-up.ps1. Pinned binary: v26.2.5, see test-db-up.ps1 for the
# download URL and sha256.
#
# test-db-up.ps1 writes the started process id to <store-dir>/cockroach.pid;
# this script reads that file and stops the process by pid (kill by
# pidfile). It does not delete the store directory, so a later
# test-db-up.ps1 resumes the same data.

$RepoRoot = Split-Path -Parent $PSScriptRoot
$StoreDir = Join-Path $RepoRoot ".cockroach-data"
$PidFile = Join-Path $StoreDir "cockroach.pid"

if (-not (Test-Path $PidFile)) {
    Write-Output "not running (no pidfile at $PidFile)"
    exit 0
}

$targetPid = (Get-Content -Path $PidFile -Raw).Trim()
$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue

if (-not $proc) {
    Write-Output "not running (stale pidfile, pid $targetPid is not active)"
    exit 0
}

if ($proc.ProcessName -ne "cockroach") {
    Write-Error "pid $targetPid is process '$($proc.ProcessName)', not cockroach; refusing to kill it"
    exit 1
}

Stop-Process -Id $targetPid -Force
Wait-Process -Id $targetPid -Timeout 15 -ErrorAction SilentlyContinue

Write-Output "stopped cockroach (pid $targetPid)"
exit 0
