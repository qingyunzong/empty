# RESULTS

## Test run

- Command: `node --test`
- Date: 2026-10-02 (Asia/Shanghai)
- Node: v22.22.1 (stdlib only, `node:test`)
- **Real exit code: 0** (captured via `node --test; echo $?`)

## Test summary

- 7 tests, 7 pass, 0 fail
- A: NULL amounts never match (SQL three-valued logic); NULL-involving
  mismatches reported in `feeDiff` with `isNull: true`; duplicate keys in one
  file -> `E_AMBIGUOUS`, exit 1, stderr `{"code","message"}`; schema
  violations (bad header / bad amount / bad date / missing file) ->
  `E_SCHEMA`, exit 1.
- B: `--no-index` vs default (hash index) produce byte-identical `result.json`;
  plans differ (`hash-join` vs `nested-loop`, join order + rationale).
- C: 100-row generated fixture (NULLs, amount/fee/currency mismatches,
  missing keys) — CLI output deep-equals the independent brute-force
  reference (`scripts/brute.js`, no shared code).
- D: empty `bank.csv` (header only) -> all internal rows in `onlyInternal`,
  empty `matched`/`onlyBank`/`feeDiff`; fully empty inputs -> empty outputs.

## Environment note

This sandbox swallows piped stdout/stderr of spawned child processes, so the
tests invoke the CLI through `bash -c` with stderr redirected to a file.
The CLI itself writes errors to stderr as JSON and exits non-zero as specified
(verified directly from a shell).
