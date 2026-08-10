# Real-path recall latency (PRD metric, measured 2026-08-10)

Method: 20 timed requests against the deployed Function URL
(`/api/recall`, scope `demo`, k=5, warm Lambda), interleaved with 20
`/health` requests from the same client (UK) as a network + Lambda
overhead baseline. The recall path measured is the REAL one: Titan V2
query embedding, scoped ANN over the vector index, strength re-rank,
retrieval reinforcement (versioned write), and the recall_log
provenance write.

```
health  p50=108ms p95=124ms   (baseline: network RTT + lambda overhead)
recall  p50=348ms p95=456ms   (client-observed, UK -> us-east-1)
derived server-side recall p50 ~= 240ms
```

PRD success metric: recall p50 < 300ms server-side. Result: ~240ms, PASS.

Notes, honestly stated:
- The dominant cost inside the 240ms is the Bedrock Titan embedding call
  for the query; the CockroachDB ANN + re-rank + two writes are the
  remainder (the 0.28 MB bundle spike measured pure ANN at p50 ~14ms on
  the same cluster, scripts/spike/RESULTS-cloud.md).
- Derivation is subtraction of medians from the same client and warm
  connection; CloudWatch per-invoke Duration would be more precise but
  log read access is not granted to the CLI users on this account.
- Cold starts are excluded by design (one warm-up request first); a cold
  start adds ~1-2s once per container.
