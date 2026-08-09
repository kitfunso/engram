-- 0001_core.sql
-- Core schema per docs/ARCHITECTURE.md Data Model. Append-only migration file:
-- never edit after it ships, add a new numbered file for changes.
--
-- Vector index syntax: the Step 4/5 spike (scripts/spike/vector-spike.mjs,
-- RESULTS-cloud.md) found that a plain `CREATE VECTOR INDEX ... (embedding)`
-- is not used by the planner for a scope-filtered ANN query at small row
-- counts (it falls back to a primary-key scan). This migration therefore
-- attempts the prefix-column form `(scope_id, embedding)` first, so scope_id
-- is a leading index column the way any other scoped query would want it.
-- That syntax was verified working directly against local CockroachDB
-- v26.2.5 before writing this file (CREATE VECTOR INDEX ... ON t (scope_id,
-- embedding) succeeded, including with IF NOT EXISTS). Default opclass is
-- vector_l2_ops (L2 / <-> operator), which is what recall queries use.
--
-- Growth note: memory_versions and recall_log are append-only and grow
-- unbounded by design. Fine at hackathon/demo scale; retention policy is
-- explicitly deferred post-hackathon.

CREATE TABLE IF NOT EXISTS scopes (
  scope_id STRING NOT NULL,
  name STRING NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id)
);

CREATE TABLE IF NOT EXISTS memories (
  scope_id STRING NOT NULL,
  memory_id STRING NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  layer STRING NOT NULL CHECK (layer IN ('episodic', 'semantic')),
  strength FLOAT NOT NULL DEFAULT 1.0,
  half_life_days FLOAT NOT NULL DEFAULT 30,
  retrieval_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin STRING NOT NULL DEFAULT 'api',
  tags JSONB NOT NULL DEFAULT '[]',
  status STRING NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consolidated', 'deleted')),
  consolidated_into STRING NULL,
  PRIMARY KEY (scope_id, memory_id),
  FOREIGN KEY (scope_id) REFERENCES scopes (scope_id),
  FOREIGN KEY (scope_id, consolidated_into) REFERENCES memories (scope_id, memory_id)
);

-- Prefix-column vector index (spike finding, see header comment). If this
-- syntax is ever rejected on a future CRDB version, fall back to a plain
-- `CREATE VECTOR INDEX memories_embedding_idx ON memories (embedding)` and
-- keep the scope filter as a WHERE clause only - record the change here.
CREATE VECTOR INDEX IF NOT EXISTS memories_scope_embedding_idx ON memories (scope_id, embedding);

-- Decay-sweep / status-filtered listing index (filter pushed into SQL before
-- any LIMIT, per CLAUDE.md "Common Mistakes to Avoid").
CREATE INDEX IF NOT EXISTS memories_scope_status_last_retrieved_idx
  ON memories (scope_id, status, last_retrieved_at);

CREATE TABLE IF NOT EXISTS memory_versions (
  scope_id STRING NOT NULL,
  version_id STRING NOT NULL,
  memory_id STRING NOT NULL,
  op STRING NOT NULL CHECK (op IN ('insert', 'update', 'retrieve_boost', 'consolidate', 'decay', 'delete')),
  snapshot JSONB NOT NULL,
  actor STRING NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, version_id),
  FOREIGN KEY (scope_id, memory_id) REFERENCES memories (scope_id, memory_id)
);

CREATE TABLE IF NOT EXISTS recall_log (
  scope_id STRING NOT NULL,
  recall_id STRING NOT NULL,
  query_text TEXT NOT NULL,
  query_embedding_hash STRING NOT NULL,
  results JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, recall_id),
  FOREIGN KEY (scope_id) REFERENCES scopes (scope_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  scope_id STRING NOT NULL,
  session_id STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, session_id),
  FOREIGN KEY (scope_id) REFERENCES scopes (scope_id)
);

CREATE TABLE IF NOT EXISTS turns (
  scope_id STRING NOT NULL,
  turn_id STRING NOT NULL,
  session_id STRING NOT NULL,
  role STRING NOT NULL,
  content TEXT NOT NULL,
  recall_id STRING NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, turn_id),
  FOREIGN KEY (scope_id, session_id) REFERENCES sessions (scope_id, session_id),
  FOREIGN KEY (scope_id, recall_id) REFERENCES recall_log (scope_id, recall_id)
);
