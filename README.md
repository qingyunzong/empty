# jsoncanon

Canonicalizes a JSON-with-comments subset into strict JSON.

## Input subset

Standard JSON plus:

- `// line` and `/* block */` comments
- trailing commas in arrays and objects

## Canonical output

- Strict JSON (re-parseable by any standards-compliant parser)
- Object keys sorted by UTF-8 byte order; duplicate keys are rejected
- Numbers preserved as their exact source decimal literals (no float64
  precision loss)
- Strings re-encoded with minimal escapes; no insignificant whitespace

## Usage

```
jsoncanon -o out.json [flags] input.jsonc
  -o file            canonical JSON output (atomically published)
  -spans file        also write source spans (JSON Pointer path -> byte range)
  -mem-budget N      per-object sort buffer budget in bytes (0 = unlimited)
  -tmp dir           directory for external-sort temporary files
  -state file        checkpoint state file (enables pause/resume)
  -pause-after N     pause after N sort segments (exit code 3)
  -resume            resume from the checkpoint state file
```

## Guarantees

- **Atomic publish**: output is written to a temp sibling and renamed only
  on full success; bad input never produces a partial canonical file and
  never clobbers an existing output.
- **External sort**: objects exceeding the memory budget spill key/value
  pairs to sorted temp segments that are k-way merged; duplicate keys are
  detected across segment boundaries at merge time.
- **Pause/resume**: checkpoints record the SHA-256 of the original input
  (plus the memory budget); resume refuses to continue if either changed.
  Completed sort segments are reused, not recomputed.

## Layout

- `parser.go` — JSONC parser producing an AST with source spans
- `canon.go` — canonical writer (in-memory path, span collection)
- `extsort.go` — external sort, k-way merge, checkpoint state
- `run.go` — file-to-file runs: hashing, atomic publish, pause/resume
- `cmd/jsoncanon` — CLI

## Tests

```
go test ./...
```

Covers parser edge cases, UTF-8 key ordering, duplicate rejection (within
and across sort segments), exact decimal preservation, randomized tree
round-trips checked against an independent `encoding/json` reference
canonicalizer, low-budget vs full-memory output equivalence, atomic
publish on bad input, and pause/resume with hash verification.
