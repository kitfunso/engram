#!/usr/bin/env bash
# test-db-up.sh
#
# Starts a local single-node insecure CockroachDB cluster for dev/tests.
# POSIX counterpart of test-db-up.ps1; same pinned version.
#
# Pinned binary: v26.2.5 (stable "Regular" release)
#   Windows (Git Bash): https://binaries.cockroachdb.com/cockroach-v26.2.5.windows-6.2-amd64.zip
#     sha256: 701b0f570d70f16fd72adc14dec368acdcea2b46476bd80afb878a7c56b08003
#   Linux (amd64 glibc): https://binaries.cockroachdb.com/cockroach-v26.2.5.linux-amd64.tgz
#     sha256: published at https://binaries.cockroachdb.com/cockroach-v26.2.5.linux-amd64.tgz.sha256sum
#   Pinned: 2026-08-09
#
# Idempotent: if port 26257 already has a listener, prints "already
# running" and exits 0. If the binary is already extracted, download is
# skipped.

set -euo pipefail

CR_VERSION="v26.2.5"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/tools"
STORE_DIR="$REPO_ROOT/.cockroach-data"
LISTEN_ADDR="localhost:26257"
HTTP_ADDR="localhost:8090"
DB_NAME="engram"

if (exec 3<>"/dev/tcp/localhost/26257") 2>/dev/null; then
  exec 3<&- 3>&-
  echo "already running (something is listening on localhost:26257)"
  exit 0
fi

uname_s="$(uname -s)"
case "$uname_s" in
  MINGW*|MSYS*|CYGWIN*)
    CR_ZIP_NAME="cockroach-$CR_VERSION.windows-6.2-amd64.zip"
    CR_URL="https://binaries.cockroachdb.com/$CR_ZIP_NAME"
    CR_SHA256="701b0f570d70f16fd72adc14dec368acdcea2b46476bd80afb878a7c56b08003"
    EXTRACT_DIR="$TOOLS_DIR/cockroach-$CR_VERSION.windows-6.2-amd64"
    EXE="$EXTRACT_DIR/cockroach.exe"
    ARCHIVE_KIND="zip"
    ;;
  Linux)
    CR_ZIP_NAME="cockroach-$CR_VERSION.linux-amd64.tgz"
    CR_URL="https://binaries.cockroachdb.com/$CR_ZIP_NAME"
    CR_SHA256="$(curl -sSL "$CR_URL.sha256sum" | awk '{print $1}')"
    EXTRACT_DIR="$TOOLS_DIR/cockroach-$CR_VERSION.linux-amd64"
    EXE="$EXTRACT_DIR/cockroach"
    ARCHIVE_KIND="tgz"
    ;;
  *)
    echo "unsupported platform: $uname_s (this project targets Windows dev + Linux CI)" >&2
    exit 1
    ;;
esac

ZIP_PATH="$TOOLS_DIR/$CR_ZIP_NAME"

if [ ! -x "$EXE" ]; then
  mkdir -p "$TOOLS_DIR"

  if [ ! -f "$ZIP_PATH" ]; then
    echo "downloading $CR_URL"
    curl -sSL -o "$ZIP_PATH" "$CR_URL"
  else
    echo "archive already present at $ZIP_PATH, skipping download"
  fi

  actual_sha256="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
  if [ "$actual_sha256" != "$CR_SHA256" ]; then
    rm -f "$ZIP_PATH"
    echo "sha256 mismatch for $CR_ZIP_NAME (expected $CR_SHA256, got $actual_sha256); deleted corrupt download" >&2
    exit 1
  fi

  echo "extracting to $EXTRACT_DIR"
  if [ "$ARCHIVE_KIND" = "zip" ]; then
    unzip -q -o "$ZIP_PATH" -d "$TOOLS_DIR"
  else
    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$ZIP_PATH" -C "$TOOLS_DIR"
  fi
else
  echo "cockroach binary already present at $EXE, skipping download"
fi

mkdir -p "$STORE_DIR"

echo "starting cockroach $CR_VERSION (detached) on $LISTEN_ADDR"
nohup "$EXE" start-single-node \
  --insecure \
  --listen-addr="$LISTEN_ADDR" \
  --http-addr="$HTTP_ADDR" \
  --store="$STORE_DIR" \
  > "$STORE_DIR/start-stdout.log" 2> "$STORE_DIR/start-stderr.log" &
cr_pid=$!
echo "$cr_pid" > "$STORE_DIR/cockroach.pid"
disown

ready=""
for _ in $(seq 1 60); do
  sleep 1
  if curl -sf "http://$HTTP_ADDR/health?ready=1" >/dev/null 2>&1; then
    ready="1"
    break
  fi
done

if [ -z "$ready" ]; then
  echo "cockroach did not become ready on http://$HTTP_ADDR within 60s; see $STORE_DIR/start-stderr.log" >&2
  exit 1
fi

"$EXE" sql --insecure --host="$LISTEN_ADDR" -e "CREATE DATABASE IF NOT EXISTS $DB_NAME;"

echo "cockroach $CR_VERSION running: sql=$LISTEN_ADDR http=$HTTP_ADDR store=$STORE_DIR db=$DB_NAME"
