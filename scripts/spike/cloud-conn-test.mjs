// Spike: verify CockroachDB Cloud connectivity E2E and create the engram database.
// Reads the SQL password from a local file (never printed), writes .env, connects
// with verify-full TLS using the downloaded CA cert, and reports version + latency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const pwFile = process.argv[2];
if (!pwFile || !fs.existsSync(pwFile)) {
  console.error("usage: node cloud-conn-test.mjs <password-file>");
  process.exit(2);
}
const password = fs.readFileSync(pwFile, "ascii").trim();
const host = "engram-31554.j77.aws-us-east-1.cockroachlabs.cloud";
const port = 26257;
const user = "keith";
const caPath = path.join(process.env.APPDATA, "postgresql", "root.crt");

const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/engram?sslmode=verify-full`;

const ca = fs.readFileSync(caPath, "ascii");
const clientOpts = (database) => ({
  host, port, user, password, database,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});

const admin = new pg.Client(clientOpts("defaultdb"));
await admin.connect();
const t0 = Date.now();
const ver = await admin.query("SELECT version()");
const rtt = Date.now() - t0;
await admin.query("CREATE DATABASE IF NOT EXISTS engram");
await admin.end();

const app = new pg.Client(clientOpts("engram"));
await app.connect();
await app.query("SELECT 1");
await app.end();

// Write .env: local URL for tests, cloud URL for spikes/deploy.
const envBody = [
  "# Local single-node cockroach (tests)",
  "ENGRAM_DATABASE_URL=postgresql://root@localhost:26257/engram?sslmode=disable",
  "# CockroachDB Cloud Basic cluster 'engram' (aws us-east-1)",
  `ENGRAM_CLOUD_DATABASE_URL=${url}`,
  "AWS_REGION=us-east-1",
  "AWS_PROFILE=h0",
  "ENGRAM_FAKE_BEDROCK=1",
  "",
].join("\n");
fs.writeFileSync(path.join(repo, ".env"), envBody, { mode: 0o600 });

console.log(`CLOUD OK: ${ver.rows[0].version.slice(0, 60)}... rtt=${rtt}ms; database engram created; .env written`);
