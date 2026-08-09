# Cloud spike results (serverless, aws-us-east-1, v26.2.5)

```
table created: VECTOR(1024) accepted
CREATE VECTOR INDEX v_idx ON vspike (embedding) -> OK
inserted 200 x 1024-dim vectors
ANN top hit: m42 (dist 0.0000) — needle FOUND
ANN latency ms over 10 runs: p50=103 min=101 max=109 (UK->us-east-1 includes ~100ms network RTT)
EXPLAIN mentions vector index: false
--- plan ---
distribution: local

• top-k
│ order: +column8
│ k: 5
│
└── • render
    │
    └── • scan
          missing stats
          table: vspike@vspike_pkey
          spans: [/'s1' - /'s1']
AOST '-2.5s' sees: v1 (current is v2) -> in-window historical read WORKS
AOST '-5h' error (exact text for timetravel.ts fallback gate): database "engram" does not exist
zone config:
{"target":"DATABASE engram","raw_config_sql":"ALTER DATABASE engram CONFIGURE ZONE USING\n\trange_min_bytes = 134217728,\n\trange_max_bytes = 536870912,\n\tgc.ttlseconds = 4500,\n\tnum_replicas = 3,\n\tnum_voters = 3,\n\tconstraints = '{+region=aws-us-east-1: 1}',\n\tvoter_constraints = '[+region=aws-us-east-1]',\n\tlease_preferences = '[[+region=aws-us-east-1]]'"}
```
