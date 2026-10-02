# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test` runner.

Command: `node --test`

## Real output (2026-10-03)

```
ok 1 - A: reverse is idempotent and only appends one compensation entry
ok 2 - A: reverse of unknown id or settled period raises E_STATE
ok 3 - B: crash before fsync and after fsync both recover to committed prefix
ok 4 - B: recovery result equals committed prefix even with torn tail bytes
ok 5 - C: balance(asOfSeq) matches brute-force replay across 200 random histories
ok 6 - C: sparse index never scans the full log even for old asOfSeq
ok 7 - D: configurable negative-balance policy, failures leave no residue
ok 8 - CLI: apply + balance, errors exit non-zero with {code,message} on stderr
# tests 8
# pass 8
# fail 0
# duration_ms 19311.638288
```

Aggregate run via `node --test` (file-level): `pass 1 / fail 0`, exit code 0.

## Acceptance mapping

- **A (idempotent reversal)**: `reverse` appends exactly one compensation entry;
  repeat `reverse(id)` returns the original compensation seq without appending;
  reversing unknown ids or entries in an interest-settled period (`settle`)
  throws `E_STATE`. History entries are never mutated.
- **B (crash recovery)**: fault injection hooks at both sides of `fsync`
  (`afterWrite`, `afterFsync`, plus `afterCommit`). Recovery truncates any
  tail without a commit marker, so the recovered state equals the committed
  prefix in all cases; torn partial lines are truncated too.
- **C (sparse index)**: `balance(asOfSeq)` uses checkpoints every 64 entries
  plus tail aggregation; a `stats.scanned` counter proves each query scans at
  most 64 entries. Verified against independent brute-force replay of
  `data.log` over 200 seeded random histories x 10 random as-of points.
- **D (negative balance policy)**: `new Ledger(dir, { allowNegative: false })`
  rejects overdrafting posts/reversals with `E_POLICY`; rejected operations
  append nothing, leave balances untouched, and cause no seq gaps.

## CLI smoke (manual)

```
$ ledger --dir ./data apply ops.jsonl
{"op":"post","seq":1}
$ ledger --dir ./data balance alice --as-of 1
{"account":"alice","asOf":1,"balance":100}
```

Errors exit non-zero with `{"code","message"}` JSON on stderr (covered by the
CLI test above).
