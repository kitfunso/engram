# CockroachDB Cloud setup log (plan step 3)

Created 2026-08-09 via the CockroachDB Cloud console (deviation from plan: `ccloud auth login`
hard-requires an interactive TTY, so provisioning went through the console; `ccloud` CLI is
installed at `%LOCALAPPDATA%\ccloud\ccloud.exe` and can be authed later for CLI workflows).

- Org: kitfunso (free trial, $400 credits)
- Cluster: `engram`, Basic (serverless), AWS `us-east-1`, unlimited on-demand capacity
- Cluster ID: `<cluster-id>`
- Host: `<cluster-host>:26257`
- SQL user: `<sql-user>` (password in local `.env` only, never committed)
- CA cert: `%APPDATA%\postgresql\root.crt` (verify-full), from
  `https://cockroachlabs.cloud/clusters/<cluster-id>/cert`
- Database: `engram` (created by `cloud-conn-test.mjs`)
- Server version: CockroachDB CCL v26.2.5
- Measured `gc.ttlseconds`: 4500 (75 min) — the AS OF SYSTEM TIME live window

## Managed MCP Server (hackathon CRDB tool)

- URL: `https://cockroachlabs.cloud/mcp` (Streamable HTTP)
- Required header: `mcp-cluster-id: <cluster-id>`
- Auth: OAuth (browser) or API key
- Claude Code registration:
  `claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp --transport http --header "mcp-cluster-id: <cluster-id>"`

## Spike results

See `RESULTS-cloud.md` (vector index, ANN latency, AOST semantics, zone config) and
`cloud-conn-test.mjs` / `vector-spike.mjs` for the reproducible scripts.

Key follow-up for the execute stage: at 200 rows with a `scope_id` filter the planner
chose a full scan over the vector index (missing stats). Likely fix: make `scope_id` a
prefix column of the vector index; re-verify EXPLAIN at realistic row counts.
`timetravel.ts` must catch BOTH past-window error classes: the GC-threshold error AND
`database/relation ... does not exist` for reads predating object creation.
