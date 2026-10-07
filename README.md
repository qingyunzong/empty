# jsonl-bigint-sort

External merge sort for JSON Lines, ordered by a bigint key. Stable,
memory-budgeted, crash-recoverable, and atomic on failure.

## Usage

```sh
npm run build
node dist/src/cli.js --input in.jsonl --output out.jsonl --key id --budget 100000
```

Options: `-i/--input` (`-` = stdin), `-o/--output` (`-` = stdout),
`-k/--key` (required), `-b/--budget` (max resident records, >= 2),
`-t/--temp-dir` (default `<output>.runs`).

Exit codes: `0` ok, `1` bad line or I/O error, `2` usage error.

## Behavior

- **Bigint key**: the key field accepts integers or integer strings
  (e.g. `"9007199254740993"`) and is compared as `BigInt`, exactly,
  beyond 2^53.
- **Stable**: every record carries its input ordinal; equal keys keep
  their original input order.
- **Memory budget**: at most `budget` records are buffered before being
  sorted and flushed as a run segment; merging never opens more than
  `budget` segments at once (multi-pass merge).
- **Bad lines abort**: any line that is not a JSON object with an
  integer key aborts the sort. Output is written to a temp file and
  only renamed into place after a fully successful merge, so nothing
  partial is ever published.
- **Recoverable segments**: each completed run segment is recorded in
  `<temp-dir>/manifest.json`. If a run crashes (or the write fails),
  rerunning with the same temp dir merges the surviving segments
  directly — the input is not re-read. Segments are cleaned up after
  a successful publish.

## Tests

```sh
npm test
```

Covers: low-budget external sort vs. in-memory stable sort, stability
with equal keys, bad-line abort without publish, injected write failure
with segment recovery (rerun succeeds with the input deleted), empty
input, and CLI exit codes.
