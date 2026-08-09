// Tiny ordered migration runner. Reads migrations/*.sql (NNNN_name.sql) in
// filename order, applies each unapplied file, and records it in
// schema_migrations. Idempotent: re-running once everything is applied is a
// no-op.
//
// CRDB caveat (verified against local v26.2.5 before writing this file): DDL
// auto-commits even inside an explicit client-driven BEGIN...COMMIT - a
// CREATE TABLE issued between BEGIN and a later ROLLBACK was NOT undone.
// That means the BEGIN/COMMIT wrapping below does not give a migration file
// true all-or-nothing atomicity for DDL; it only atomically groups any pure
// DML at the end (the schema_migrations bookkeeping insert). Real safety
// against partial-apply-then-retry comes from writing migration SQL with
// IF NOT EXISTS (see migrations/0001_core.sql), so re-running a failed
// migration file is safe rather than erroring on already-created objects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "migrations");

interface MigrationFile {
  version: number;
  name: string;
  filePath: string;
}

const MIGRATION_FILENAME_RE = /^(\d{4})_(.+)\.sql$/;

function loadMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) return [];
  const entries = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = MIGRATION_FILENAME_RE.exec(entry);
    if (!match) {
      throw new Error(`migrate: filename does not match NNNN_name.sql: ${entry}`);
    }
    files.push({
      version: Number(match[1]),
      name: match[2],
      filePath: path.join(migrationsDir, entry),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name STRING NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(): Promise<Set<number>> {
  // node-postgres returns CRDB's INT (INT8/bigint, OID 20) columns as JS
  // strings by default, to avoid silent precision loss above
  // Number.MAX_SAFE_INTEGER. version numbers here are tiny, so coerce to
  // number explicitly - otherwise `applied.has(file.version)` below compares
  // a number against a Set of strings and never matches, and every run
  // re-attempts every migration (verified: this happened on a second local
  // run, INSERT collided with the version=1 primary key already committed).
  const result = await getPool().query<{ version: string | number }>("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => Number(row.version)));
}

async function applyMigration(migration: MigrationFile): Promise<void> {
  const sql = fs.readFileSync(migration.filePath, "utf8");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
      migration.version,
      migration.name,
    ]);
    await client.query("COMMIT");
    console.log(`migrate: applied ${migration.version}_${migration.name}`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // DDL in this file may already have auto-committed (see header
      // comment); ROLLBACK failing here does not change the outcome.
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`migrate: failed applying ${migration.version}_${migration.name}: ${message}`);
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const files = loadMigrationFiles();
  const applied = await appliedVersions();
  const pending = files.filter((file) => !applied.has(file.version));
  if (pending.length === 0) {
    console.log("migrate: nothing to apply");
    return;
  }
  for (const migration of pending) {
    await applyMigration(migration);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runMigrations()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
