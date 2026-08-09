-- 0002_vector_index_status.sql
-- Replaces the (scope_id, embedding) vector index from 0001 with a
-- three-column-prefix form (scope_id, status, embedding), so the recall
-- query's real WHERE clause (scope_id + status='active') can use the index
-- directly instead of falling back to a primary-key scan + JS filter.
-- Append-only migration file: never edit after it ships.
--
-- Probe (throwaway table, run against local CockroachDB v26.2.5 before
-- writing this file; script not part of the repo):
--   CREATE VECTOR INDEX probe_two_prefix_idx ON probe_two_prefix
--     (scope_id, status, embedding)
--   -> ACCEPTED.
-- Loaded 300 rows across 2 scopes (matches tests/recall.test.ts's EXPLAIN
-- fixture: 150 rows/scope, ~10% status='consolidated'), ran ANALYZE, then:
--   EXPLAIN SELECT memory_id FROM probe_two_prefix
--     WHERE scope_id = $1 AND status = 'active'
--     ORDER BY embedding <-> $2::vector LIMIT $3
-- Plan used the index directly, with the status literal folded into the
-- index prefix span (verbatim plan excerpt):
--   └── • vector search
--         table: probe_two_prefix@probe_two_prefix_idx
--         target count: 5
--         prefix spans: [/'probe-scope-a'/'active' - /'probe-scope-a'/'active']
-- No pkey lookup/full-scan fallback appeared for the scope_id+status shape.
-- Conclusion: the two-prefix form is both accepted and used by the planner
-- at this row count, so it replaces 0001's (scope_id, embedding) index
-- rather than being kept alongside it as a second, unused index.

DROP INDEX IF EXISTS memories_scope_embedding_idx;

CREATE VECTOR INDEX IF NOT EXISTS memories_scope_status_embedding_idx
  ON memories (scope_id, status, embedding);
