# misstatement-bound

Exact rational interval propagation for audit misstatement bounds. Node.js 22,
standard library only (`node:test`, `node:crypto`), no dependencies.

## Model

- Each item carries a claimed amount as an exact rational `claimedNum/claimedDen`.
- Auditing records the actual amount; the per-item error interval is
  `[min(0, actual - claimed), max(0, actual - claimed)]`, split by sign.
- The population interval is the exact BigInt rational sum over the **audited
  stratum only**. Unaudited items form a pending stratum: `bound` reports
  `status: "E_PENDING"` and never merges them into the interval.
- `correct` updates the claimed amount; for audited items the stratum sum
  (derived on demand) and the hash-chained certificate log both move, so any
  previously issued `explain` certificate fails `verifyExplain`.

## CLI

NDJSON session over stdin/stdout:

```sh
printf '%s\n' \
  '{"cmd":"addItem","id":"a","claimedNum":3,"claimedDen":2}' \
  '{"cmd":"audit","id":"a","actualNum":1,"actualDen":1}' \
  '{"cmd":"bound","confidenceNum":19,"confidenceDen":20}' \
  | node cli.js
```

Commands: `addItem{id,claimedNum,claimedDen}`, `audit{id,actualNum,actualDen}`,
`correct{id,newClaimed}` (`"n/d"` string or `{num,den}`),
`bound{confidenceNum,confidenceDen}`, `explain`.

`bound` returns `{lower, upper, status, witnessIds, confidence, version, head}`
with `upper` the conservative misstatement upper bound; `status` is `OK` or
`E_PENDING`. Errors: `E_LAYER` (empty population), `E_CONF` (confidence not in
the open interval `(0,1)`), `E_ITEM`/`E_DUP`/`E_CMD`.

## Tests

```sh
node --test
```

Covers: full-audit interval equals the exact sum; partial audit is pending and
excludes unaudited items; corrections invalidate old explain certificates;
randomized `N <= 10` cross-check against an independent in-test enumeration
(no external language).
