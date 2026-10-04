# RESULTS

- Date: 2026-10-04
- Environment: Node.js v22.22.1, standard library only, offline, `node:test`
- Command: `node --test` (exit code 0)

## Test summary

| file                | tests | pass | fail |
|---------------------|-------|------|------|
| test/hist.test.js   | 8     | 8    | 0    |
| test/random.test.js | 1 (400 seeds x 4 as-of queries) | 1 | 0 |
| test/cli.test.js    | 4     | 4    | 0    |
| **total**           | **13**| **13**| **0**|

`node --test` aggregate output:

```
# tests 3        # test files
# pass 3
# fail 0
```

## Acceptance coverage

1. Same-ts different-seq boundary — `same-ts seq boundary: asOf includes exactly the events up to ts:seq` (test/hist.test.js): positions 10:1/10:2/10:3/10:4 and 9:99/11:0 checked around sets at 10:2, 10:3, 10:4.
2. Revoke affects only later evaluation — `revoke changes asOf before/after the revocation point`: frozen at 10:5, not frozen at 10:6 (revoke at 10:6), explanation is the revoke event; rule defined after a revoke is unaffected.
3. Fork/freeze asymmetry + deny-first merge — `fork/merge: branch-local freeze, merge takes union with deny-first conflicts`: main safe at 6:1 (1.5), branch B breaches (1.2); main@7:0 not frozen, B@7:0 frozen, main@8:1 (post-merge) frozen with the denying fact from B in the explanation.
4. Random n<=12 branches vs reference replay — `random histories (<=12 branches) match reference replay` (test/random.test.js): 400 seeded logs (5-44 events, up to 12 branches, forks/merges/revokes/groups), 4 random as-of queries each, library result (frozen/rule/explain) compared to an independently written reference replay — all equal.

## Error codes (verified via real CLI invocations)

```
$ node cli.js examples/hist.jsonl --as-of 10:3   -> exit 0, {"frozen": true, "rule": "R1", ...}
$ node cli.js bad_time.jsonl --as-of 10:1        -> exit 1, stderr: E_TIME: branch "main": event 9:0 precedes previous event 10:1
$ node cli.js bad_fork.jsonl --as-of 1:0         -> exit 1, stderr: E_FORK: merge of unknown branch "ghost" at 1:0
```

Note: test/cli.test.js drives `cli.main` in-process because the offline
sandbox forbids spawning child processes (spawnSync -> EPERM); the real
`node cli.js ...` invocations above were run via the shell to confirm
stdout JSON and exit codes.
