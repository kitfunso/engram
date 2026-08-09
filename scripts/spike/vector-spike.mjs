// Spike (plan steps 4+5, cloud half): vector index E2E + AOST/GC-window on CockroachDB Cloud.
// Answers, empirically: exact CREATE VECTOR INDEX syntax, ANN query latency (p50),
// whether the index is used, AOST in-window behavior, the past-GC-window error text,
// and the actual gc.ttlseconds on the serverless cluster.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(repo, ".env"), "ascii").split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = new URL(env.ENGRAM_CLOUD_DATABASE_URL);
const ca = fs.readFileSync(path.join(process.env.APPDATA, "postgresql", "root.crt"), "ascii");
const client = new pg.Client({
  host: url.hostname, port: +url.port, user: url.username,
  password: decodeURIComponent(url.password), database: url.pathname.slice(1),
  ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 15000,
});

const DIM = 1024;
const rnd = (seed) => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5; };
const vec = (seed) => { const r = rnd(seed); return "[" + Array.from({ length: DIM }, () => r().toFixed(6)).join(",") + "]"; };
const out = [];
const log = (s) => { out.push(s); console.log(s); };

await client.connect();
await client.query("DROP TABLE IF EXISTS vspike");
await client.query(`CREATE TABLE vspike (scope_id STRING NOT NULL, id STRING NOT NULL, embedding VECTOR(${DIM}), PRIMARY KEY (scope_id, id))`);
log("table created: VECTOR(1024) accepted");

try {
  await client.query("CREATE VECTOR INDEX v_idx ON vspike (embedding)");
  log("CREATE VECTOR INDEX v_idx ON vspike (embedding) -> OK");
} catch (e) {
  log(`CREATE VECTOR INDEX failed: ${e.message}`);
  try {
    await client.query("SET CLUSTER SETTING feature.vector_index.enabled = true");
    await client.query("CREATE VECTOR INDEX v_idx ON vspike (embedding)");
    log("OK after SET CLUSTER SETTING feature.vector_index.enabled = true");
  } catch (e2) { log(`still failed: ${e2.message}`); }
}

// 200 rows, batched
for (let b = 0; b < 10; b++) {
  const values = [], params = [];
  for (let i = 0; i < 20; i++) {
    const n = b * 20 + i;
    params.push("s1", `m${n}`, vec(n + 7));
    values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  await client.query(`INSERT INTO vspike (scope_id, id, embedding) VALUES ${values.join(",")}`, params);
}
log("inserted 200 x 1024-dim vectors");

const q = vec(42 + 7); // same seed as row m42 -> nearest neighbor should be m42
const times = [];
let top;
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  const r = await client.query("SELECT id, embedding <-> $1::vector AS dist FROM vspike WHERE scope_id = $2 ORDER BY embedding <-> $1::vector LIMIT 5", [q, "s1"]);
  times.push(Date.now() - t0);
  top = r.rows[0];
}
times.sort((a, b) => a - b);
log(`ANN top hit: ${top.id} (dist ${Number(top.dist).toFixed(4)}) — needle ${top.id === "m42" ? "FOUND" : "MISSED"}`);
log(`ANN latency ms over 10 runs: p50=${times[4]} min=${times[0]} max=${times[9]} (UK->us-east-1 includes ~100ms network RTT)`);

const plan = await client.query("EXPLAIN SELECT id FROM vspike WHERE scope_id = 's1' ORDER BY embedding <-> $1::vector LIMIT 5", [q]);
const planText = plan.rows.map(r => r["info"]).join("\n");
log(`EXPLAIN mentions vector index: ${/vector|v_idx/i.test(planText)}`);
log("--- plan ---\n" + planText.split("\n").slice(0, 12).join("\n"));

// AOST semantics
await client.query("CREATE TABLE IF NOT EXISTS aost_probe (k STRING PRIMARY KEY, v STRING)");
await client.query("UPSERT INTO aost_probe VALUES ('x', 'v1')");
await new Promise(r => setTimeout(r, 3000));
await client.query("UPSERT INTO aost_probe VALUES ('x', 'v2')");
const past = await client.query("SELECT v FROM aost_probe AS OF SYSTEM TIME '-2.5s' WHERE k = 'x'");
log(`AOST '-2.5s' sees: ${past.rows[0]?.v} (current is v2) -> in-window historical read ${past.rows[0]?.v === "v1" ? "WORKS" : "unexpected"}`);

try {
  await client.query("SELECT v FROM aost_probe AS OF SYSTEM TIME '-5h' WHERE k = 'x'");
  log("AOST '-5h': unexpectedly succeeded");
} catch (e) {
  log(`AOST '-5h' error (exact text for timetravel.ts fallback gate): ${e.message}`);
}

try {
  const zc = await client.query("SHOW ZONE CONFIGURATION FROM DATABASE engram");
  log("zone config:\n" + zc.rows.map(r => JSON.stringify(r)).join("\n").slice(0, 500));
} catch (e) { log(`SHOW ZONE CONFIGURATION: ${e.message}`); }

await client.query("DROP TABLE vspike");
await client.query("DROP TABLE aost_probe");
await client.end();
fs.writeFileSync(path.join(here, "RESULTS-cloud.md"), "# Cloud spike results (serverless, aws-us-east-1, v26.2.5)\n\n```\n" + out.join("\n") + "\n```\n");
log("RESULTS-cloud.md written");
