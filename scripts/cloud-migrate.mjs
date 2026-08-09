#!/usr/bin/env node
// Runs src/migrate.ts against CockroachDB Cloud (docs/plans/2026-08-09-phase-4-ship.md
// Step 2: "Run migrations against the cloud cluster"). Reads
// ENGRAM_CLOUD_DATABASE_URL from .env in this process and injects it into
// the child process's env object as ENGRAM_DATABASE_URL - never via a shell
// string, never printed. src/db.ts's cloud-host auto-detection (host ends
// with .cockroachlabs.cloud) then picks the verify-full + CA-cert path for
// that connection automatically, same as a Lambda deploy.
//
// Usage: node scripts/cloud-migrate.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const env = readDotEnv();
const cloudUrl = env.ENGRAM_CLOUD_DATABASE_URL;
if (!cloudUrl) {
  console.error("[cloud-migrate] FAIL: ENGRAM_CLOUD_DATABASE_URL not set in .env");
  process.exit(1);
}

// Invokes tsx's own JS entry via `node` rather than the node_modules/.bin
// shim: on Windows, spawning the .cmd shim directly (no shell:true) fails
// with EINVAL (verified) - going straight to tsx's actual bin target
// (package.json "bin") sidesteps the platform-specific shim entirely.
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
console.log("[cloud-migrate] running migrations against CockroachDB Cloud...");

const result = spawnSync(process.execPath, [tsxCli, path.join(repoRoot, "src", "migrate.ts")], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ENGRAM_DATABASE_URL: cloudUrl },
});

if (result.status !== 0) {
  console.error(`[cloud-migrate] FAIL: migrate.ts exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log("[cloud-migrate] done");
