# fee-engine

Tiered asset-management fee engine (Node.js 22, standard library only) with an
incremental dependency graph and a JSONL CLI. Trades flow through
`trade -> tier accumulator -> fee -> invoice`; amends, cancels, reversals and
rate-version switches update end-of-day fees differentially and every run
emits a deterministic fee certificate.

## Layout

- `src/fees.js` — fee-package math: tiered rates, minimum fee, rebates
  (integer cents + per-million rates, fully deterministic).
- `src/engine.js` — incremental engine: differential per-tier amounts,
  invalidation limited to cross-tier accounts, optimal-package selection
  (all ties listed, smallest rule id wins), snapshot/restore, certificate.
- `src/journal.js` — crash-safe invoice journal (`begin`/`commit` framing,
  fsync, recovery discards uncommitted fragments: restart never double-bills).
- `bin/feecli.js` — JSONL CLI.
- `test/` — node:test suites (see below).

## Events (one JSON object per line)

```jsonl
{"type":"package","id":"std","version":1,"tiers":[{"upTo":100000,"rate":0.001},{"upTo":null,"rate":0.0008}],"minFee":5,"rebates":[{"minTurnover":200000,"percent":10}]}
{"type":"deactivate","packageId":"std"}
{"type":"trade","id":"t1","account":"A","amount":120000}
{"type":"amend","id":"t1","amount":150000}
{"type":"cancel","id":"t1"}
{"type":"reversal","id":"r1","ref":"t1","amount":-120000}
```

Rules:

- Amend is exactly cancel-old-plus-add-new, applied as one net delta.
- Negative amounts are only accepted as `reversal` events referencing a live
  original (`ref`); a reversal may not push turnover below zero.
- Re-registering a package `id` switches its rate version and reprices.
- The minimum fee applies only while turnover is positive; rebates apply
  after the minimum.

## CLI

```sh
node bin/feecli.js examples/events.jsonl --explain
node bin/feecli.js events.jsonl --state var/state --persist var/invoices
cat events.jsonl | node bin/feecli.js        # reads stdin
```

Output: one `{"type":"fee-diff",...}` line per affected account (previous fee,
new fee, delta, turnover, hit tier, chosen package, all tied packages), then a
`{"type":"certificate","algorithm":"sha256","digest":...}` line. `--state`
carries packages/trades across runs so diffs are incremental; `--persist`
appends crash-safe invoice batches. Any input or validation error is printed
to stderr and exits with code **6**.

## Tests

```sh
node --test
```

Covers: cross-tier invalidation (only the crossing account is recomputed),
tied optimal packages, cancel-below-minimum-fee, amend/reversal validation,
rate version switching, random event streams checked against an independent
brute-force recomputation, certificate determinism across replays/restores,
crash-mid-invoice-batch recovery, and CLI behaviour including exit code 6.
