// Shared pg Pool factory + tiny .env reader. No dotenv dependency: this file
// is the whole reader (CLAUDE.md coding conventions keep dependencies lean;
// docs/plans/2026-08-09-phase-1-foundation.md Step 7 asks for exactly this).
//
// Also owns the GC-window constants used by time travel (src/store/timetravel.ts,
// a later step), per docs/ARCHITECTURE.md ("src/db.ts - AS OF SYSTEM TIME
// helpers; GC-window constant lives here").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgModule from "pg";
import type { Pool as PgPool, PoolConfig } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// pg's own package exports an instance (`module.exports = new PG(...)`), not
// an object literal, so Node's CJS/ESM interop cannot statically detect named
// exports from it. `import { Pool } from "pg"` is unreliable under NodeNext;
// the default-import-then-destructure form is the working pattern (matches
// scripts/spike/vector-spike.mjs, which already connects successfully).
const { Pool } = pgModule;

// Serverless GC window, measured empirically against CockroachDB Cloud
// (scripts/spike/RESULTS-cloud.md): the engram database zone config reports
// gc.ttlseconds = 4500. AOST reads older than this window error; time travel
// falls back to a memory_versions replay past this point.
export const GC_WINDOW_MS = 4500_000;
export const AOST_SAFE_WINDOW_MS = GC_WINDOW_MS - 300_000;

/**
 * Fills process.env from .env without overriding variables the shell/CI
 * already set (matches dotenv's precedence). Missing .env is not an error -
 * process.env may already carry everything needed.
 */
function loadDotEnv(): void {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`db: missing required env var ${name}`);
  }
  return value;
}

function buildLocalPoolConfig(): PoolConfig {
  // sslmode=disable lives in the URL itself; pg-connection-string parses it
  // into ssl:false. No explicit ssl override needed for local.
  return { connectionString: requireEnv("ENGRAM_DATABASE_URL") };
}

function buildCloudPoolConfig(): PoolConfig {
  const connectionString = requireEnv("ENGRAM_CLOUD_DATABASE_URL");
  // Parsed into discrete fields rather than passed as {connectionString, ssl}:
  // pg's ConnectionParameters re-parses the URL's sslmode and overwrites any
  // explicit `ssl` option with what it derives (verified by reading
  // node_modules/pg/lib/connection-parameters.js - config.connectionString
  // is re-parsed and Object.assign'd LAST, so it wins over an explicit ssl
  // object). That would silently drop our CA and fail verify-full. Passing
  // host/port/user/password/database + an explicit ssl object avoids the
  // clash - this is the same shape scripts/spike/vector-spike.mjs used to
  // connect successfully to CockroachDB Cloud.
  const url = new URL(connectionString);
  const caPath = path.join(process.env.APPDATA ?? "", "postgresql", "root.crt");
  const ca = fs.readFileSync(caPath, "utf8");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 26257,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: { ca, rejectUnauthorized: true },
  };
}

let pool: PgPool | undefined;

/** Shared pg Pool. Target picked by ENGRAM_TARGET=cloud, else local. */
export function getPool(): PgPool {
  if (!pool) {
    const config = process.env.ENGRAM_TARGET === "cloud" ? buildCloudPoolConfig() : buildLocalPoolConfig();
    pool = new Pool(config);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
