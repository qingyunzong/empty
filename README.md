# Audit Voucher Ledger

Causal-merge audit voucher ledger. Node.js 22, standard library only, tests via `node:test`.

## Model

Each voucher event carries `voucherId`, `version`, `amount`, `status`, the
`predecessor` event hash, and a vector `clock`. Corrections must reference the
currently observed head: an unknown predecessor is rejected with
`unknown-predecessor`, a reference to a superseded version with `stale-clock`.
Merging replicas unions the event sets; concurrent heads of the same voucher
that diverge in `amount` or `status` are flagged as conflicts. The audit
certificate reports the frontier, per-voucher hashes, conflict count, and
missing-dependency count, and is `invalid` whenever conflicts or missing
dependencies exist.

## CLI

```
node cli.js [--state ledger.json] [--replica ID] put <voucherId> <amount> <status>
node cli.js [--state ledger.json] correct <voucherId> <amount> <status> [--predecessor <hash>]
node cli.js [--state ledger.json] merge <file>
node cli.js [--state ledger.json] audit
node cli.js [--state ledger.json] get <voucherId>
```

All output is JSON. Errors are printed as `{"error":"code"}` with exit code 1.

## Tests

```
node --test --test-reporter spec
```
