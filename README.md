# tenantq

Hierarchical tenant quotas with reservation lifecycle: reserve, confirm,
release, and idempotent retry. Pure Python 3.11+ standard library.

## Semantics

- **reserve** walks the tenant chain leaf -> root, tentatively adding
  `pending` at every level. If any level would exceed its quota, the whole
  operation fails with `E_QUOTA` and every level is rolled back to its
  pre-operation value. The failed attempt is recorded as a `FAILED`
  reservation.
- **confirm** converts `pending` into `used` along the chain. Confirming a
  missing, failed, or released reservation raises `E_STATE`; state never
  changes silently.
- **release** subtracts from `used` only (full or partial), and requires the
  `CONFIRMED` state.
- **Idempotency**: repeating a successful `reserve` with the same
  `idempotency_key` returns the original result without charging quota again.
  A key whose attempt failed may be retried.
- **Quota 0** forbids any reservation. A tenant node missing from the quota
  config raises `E_CONFIG` instead of being treated as unlimited.

Error codes: `E_QUOTA`, `E_STATE`, `E_CONFIG`, `E_ARGS` — raised as
`tenantq.PolicyError` with a machine-readable `.code`.

## CLI

```sh
python -m tenantq reserve --tenant root/team --amount 3 --key k1 \
    --config cfg.json --state state.json
python -m tenantq confirm --key k1 --config cfg.json --state state.json
python -m tenantq release --key k1 [--amount 1] --config cfg.json --state state.json
python -m tenantq status --config cfg.json --state state.json
```

Config is a flat JSON map of tenant path to quota (or `{"quotas": {...}}`).
All output is JSON on stdout; policy errors exit with code 2.

## Tests

```sh
python -m unittest discover -s tests -v
```

Includes a randomized parity test (hierarchy depth <= 5, 1000 operations with
failure injection) checked field by field against an event-sourced reference
ledger.
