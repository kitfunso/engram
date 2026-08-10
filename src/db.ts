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

// Strict ISO-8601 UTC timestamp (what Date.prototype.toISOString() always
// produces), validated before it is ever string-built into SQL.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Builds a validated `AS OF SYSTEM TIME '...'` clause for `at`.
 *
 * Confirmed empirically against local CockroachDB v26.2.5: binding the
 * timestamp as a query placeholder (`AS OF SYSTEM TIME $1`) is rejected -
 * `AS OF SYSTEM TIME: only constant expressions, with_min_timestamp,
 * with_max_staleness, or follower_read_timestamp are allowed`. AOST must be
 * a constant expression, so this is the one documented exception to
 * CLAUDE.md rule 3 (parameterized SQL only): the timestamp is validated
 * against a strict ISO-8601 UTC regex first, then string-built, because the
 * database itself refuses a bound parameter here. `at` always comes from
 * `new Date(...)` in this codebase, whose `.toISOString()` is always
 * well-formed, but the regex check runs anyway since this is the one place
 * string-building touches SQL at all.
 */
export function aostClause(at: Date): string {
  const iso = at.toISOString();
  if (!ISO_TIMESTAMP_RE.test(iso)) {
    throw new Error(`aostClause: invalid timestamp ${iso}`);
  }
  return `AS OF SYSTEM TIME '${iso}'`;
}

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

const CLOUD_HOST_SUFFIX = ".cockroachlabs.cloud";

/**
 * Locates the CRDB Cloud CA certificate. Checked in order:
 *  1. next to this module itself (`certs/crdb-root.crt` alongside the file) -
 *     the shape scripts/deploy-lambda.mjs zips (bundle + certs/ sibling), so
 *     this resolves correctly inside the Lambda runtime (/var/task/index.mjs
 *     + /var/task/certs/crdb-root.crt) without any Lambda-specific branching.
 *  2. the repo root's `certs/crdb-root.crt` (checked-in copy, dev machine
 *     running from src/ via tsx - `here` is src/, so candidate 1 misses and
 *     this repo-root candidate hits).
 *  3. the original spike-era `%APPDATA%\postgresql\root.crt` location, as a
 *     last-resort fallback for a dev machine that has cockroach's downloaded
 *     cert but hasn't pulled the repo copy.
 * The CA is public key material (CLAUDE.md rule 4 exempts it explicitly), so
 * committing certs/crdb-root.crt to the repo is intentional, not a leak.
 */
function resolveCaPath(): string {
  const candidates = [
    path.join(here, "certs", "crdb-root.crt"),
    path.join(repoRoot, "certs", "crdb-root.crt"),
    path.join(process.env.APPDATA ?? "", "postgresql", "root.crt"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`db: could not locate CRDB Cloud CA cert; tried ${candidates.join(", ")}`);
}

/**
 * Builds a pg PoolConfig from a connection string. When the URL's host ends
 * with .cockroachlabs.cloud, parses it into discrete fields and applies an
 * explicit ssl:{ca, rejectUnauthorized:true} option instead of passing
 * {connectionString, ssl}: pg's ConnectionParameters re-parses the URL's
 * sslmode and overwrites any explicit `ssl` option with what it derives
 * (verified by reading node_modules/pg/lib/connection-parameters.js -
 * config.connectionString is re-parsed and Object.assign'd LAST, so it wins
 * over an explicit ssl object). That would silently drop our CA and fail
 * verify-full. Any other host (local insecure cluster) passes the connection
 * string straight through - sslmode=disable in the URL is enough there.
 */
function buildPoolConfigForUrl(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  if (!url.hostname.endsWith(CLOUD_HOST_SUFFIX)) {
    return { connectionString };
  }
  const ca = fs.readFileSync(resolveCaPath(), "utf8");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 26257,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: { ca, rejectUnauthorized: true },
  };
}

function buildLocalPoolConfig(): PoolConfig {
  return buildPoolConfigForUrl(requireEnv("ENGRAM_DATABASE_URL"));
}

function buildCloudPoolConfig(): PoolConfig {
  return buildPoolConfigForUrl(requireEnv("ENGRAM_CLOUD_DATABASE_URL"));
}

let pool: PgPool | undefined;

/** Shared pg Pool. Target picked by ENGRAM_TARGET=cloud, else local. */
export function getPool(): PgPool {
  if (!pool) {
    const config = process.env.ENGRAM_TARGET === "cloud" ? buildCloudPoolConfig() : buildLocalPoolConfig();
    pool = new Pool(config);
    // pg emits 'error' on an idle client whose connection drops server-side
    // (network blip, CRDB node restart) - node-postgres's own docs call this
    // out as required: an unhandled 'error' on the Pool is an uncaught
    // exception that crashes the process. Logged, not rethrown; the next
    // getPool().query()/connect() call gets a fresh client from the pool.
    pool.on("error", (err) => {
      console.error("[db] idle pool client error:", err instanceof Error ? err.message : String(err));
    });
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

// CRDB transient serialization errors: SQLSTATE 40001, surfaced by pg as
// err.code, or by message text (WriteTooOldError / TransactionRetryWith-
// ProtoRefreshError / "restart transaction"). CRDB's own guidance is that
// clients retry these. tests/memories.test.ts and tests/recall.test.ts
// previously carried a test-only rememberWithRetry wrapper for exactly this
// error class, observed on vector-index writes during bulk inserts; this is
// the root-cause fix, in the write paths themselves rather than in tests.
// Also matches connection-drop patterns (ECONNRESET, pg's own "Connection
// terminated" client error, CRDB's "server closed the connection" on a
// killed node) - these are exactly the errors a fresh pool.connect() (now
// acquired INSIDE withTransientRetry's closure at every call site, not
// once outside it) can recover from by getting a healthy connection.
const TRANSIENT_SQLSTATE = "40001";
const TRANSIENT_MESSAGE_RE =
  /WriteTooOldError|TransactionRetryWithProtoRefreshError|restart transaction|ECONNRESET|Connection terminated|server closed the connection/i;
const MAX_ATTEMPTS = 4;
const BACKOFF_MIN_MS = 25;
const BACKOFF_MAX_MS = 100;

function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === TRANSIENT_SQLSTATE) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_MESSAGE_RE.test(message);
}

function jitteredBackoffMs(): number {
  return BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS);
}

/**
 * Retries `fn` on CRDB transient serialization errors, up to 4 attempts
 * total, with a small jittered 25-100ms backoff between attempts. Anything
 * else (including a non-transient error surfaced only after a prior
 * transient retry) rethrows immediately.
 *
 * Callers must put the ENTIRE transaction body - BEGIN through COMMIT, with
 * their own ROLLBACK on the failure path - inside `fn`, so a retry replays a
 * fresh transaction rather than resuming one that already failed. A
 * partially-applied then-retried transaction would be a correctness bug,
 * not a resilience win.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransientError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, jitteredBackoffMs()));
    }
  }
}
