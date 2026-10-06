# jsonnorm

`jsonnorm` normalizes a relaxed JSON subset into strict, canonical JSON.

## Input subset

- Standard JSON values: objects, arrays, strings, numbers, `true`, `false`, `null`.
- `// line` and `/* block */` comments anywhere whitespace is allowed.
- Trailing commas in objects and arrays.
- Input must be UTF-8; a leading BOM is tolerated.

## Output guarantees

- Strict JSON (no comments, no trailing commas); keys are re-escaped minimally.
- Object keys sorted in UTF-8 byte order.
- Duplicate object keys (after escape decoding) are rejected with a source span.
- Numbers preserve their exact decimal value and are canonicalized
  (`1.50e1` → `15`, `0.30000000000000004` is preserved digit-for-digit,
  extreme exponents fall back to `d.ddde±X` notation).
- Errors are reported with line/column and byte offset.
- `-spans file.ndjson` emits a source span table (path, kind, byte offsets,
  line/column) for every value in the document.

## Usage

```
jsonnorm -i input.jsonc -o output.json [-mem BYTES] [-state DIR] [-spans spans.ndjson]
```

- `-i` / `-o`: input/output paths; `-` (default) means stdin/stdout.
- `-mem`: memory budget in bytes for buffered object keys/values
  (default 64 MiB). Objects exceeding the budget are sorted externally:
  sorted runs are spilled to segment files and k-way merged, with duplicate
  keys detected across segment boundaries.
- `-state`: directory for checkpoint/resume (see below).
- Exit codes: `0` success, `1` error, `3` paused (checkpoint written).

Normalized files are published atomically: output goes to a temporary file
and is renamed (or copied to stdout) only after the whole document
normalized successfully, so bad input never leaves a partial file behind.

## Pause and resume

With `-state DIR`, an interrupted run (SIGINT/SIGTERM, or
`JSONNORM_PAUSE_AFTER_SEGMENTS=N` for automation) writes a checkpoint at
the next top-level object member boundary and exits with code 3. Re-running
with the same `-state` directory resumes from the checkpoint:

- The SHA-256 of the original input is verified; changed input is rejected.
- The memory budget must match the checkpointed run.
- Every spilled segment file passes a size + SHA-256 integrity check.

After a successful run the checkpoint and segment files are removed.

## Development

```
go test ./...
```

Tests cover number canonicalization, parsing/error spans, randomized
round-trip verification against `encoding/json` (byte-exact reference,
semantic equality, idempotency), low-budget vs. full-memory equivalence,
cross-segment duplicate detection, multi-pass external merges, atomic
publication, and pause/resume including tamper rejection.
