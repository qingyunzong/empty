# RESULTS

Date: 2026-10-03. Environment: Node.js v22.22.1, standard library only, `node:test`.

## Test run

Command: `node --test`

- Real exit code: **0**
- Summary (from TAP output): `tests 5, pass 5, fail 0` (5 test files, all passing)

Subtests per file (each file run individually, all `ok`):

- `test/relalg.test.js`: 8 subtests — NULL three-valued comparison, select/project/join/union/except, sum/count/avg with NULL semantics (all-NULL sum = NULL, not 0), empty groups
- `test/engine.test.js`: 9 subtests — acceptance A (NULL fee, duplicate reversal 冲正, E_DUP_TRADE, E_BAD_NULL), B (incremental insert/revoke == independent full recompute, directed + randomized), D (empty input, all-NULL fee group, fully revoked group, unknown revoke)
- `test/cert.test.js`: 5 subtests — certificate build/verify, determinism, acceptance C (tampered row / chain / root / order / row_count all fail with E_CERT_TAMPER), empty certificate
- `test/cli.test.js`: 6 subtests — `settle --in --out --cert` end-to-end, `verify`, tamper detection, error JSON `{code,message}` on stderr with exit != 0 (E_DUP_TRADE, E_BAD_NULL, E_PARSE, E_ARGS), empty inputs
- `test/perf.test.js`: 1 subtest — 50,000 trades + 6,204 valid events: incremental engine matches full recompute in ~1.2 s (limit: 30 s)

## Manual CLI verification (real exit codes)

- `settle --in dir --out out.json --cert cert.json` → exit 0, stdout `{"rows":1,"root":"ac18c4f8…"}`
- `settle verify --cert cert.json` → exit 0, `{"ok":true,...}`
- verify on tampered cert → exit 1, stderr `{"code":"E_CERT_TAMPER","message":"chain mismatch at row 0"}`
- settle on missing input dir → exit 1, stderr `{"code":"E_IO",...}`

## Notes

- Sums use exact decimal accumulation (BigInt mantissa + exponent) so incremental
  updates and full recompute are bit-identical regardless of update order.
- The sandbox blocks node-from-node subprocess spawning with pipes, so CLI tests
  invoke `run()` from `src/cli.js` in-process; `bin/settle.js` is a thin wrapper
  (`process.exit(run(process.argv.slice(2)))`) and was also verified directly in
  the shell as shown above.
