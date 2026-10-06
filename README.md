# bigint-external-sort

External merge-sort CLI for JSONL files that are larger than the memory
budget. Records are sorted by their bigint `key` field, stably: equal keys
keep their original input order.

## Usage

```sh
npm run build          # compile TypeScript to dist/
npm test               # build + run the test suite

node dist/src/cli.js --input in.jsonl --output out.jsonl --budget 10000
```

Options:

- `-i, --input` — input JSONL file (required)
- `-o, --output` — output JSONL file, published atomically (required)
- `-b, --budget` — max records held resident in memory (default 10000)
- `-t, --tmp-dir` — temp segment directory (default `<output>.segments`)
- `--resume` — reuse temp segments from an interrupted run

Each input line must be a JSON object with an integer `key`, either as a
JSON number or a decimal string (required for values beyond 2^53), e.g.
`{"id": 7, "key": "170141183460469231731687303715884105727"}`.

## Design

- **Memory budget by resident records** — run generation buffers at most
  `budget` records before spilling a sorted segment; the k-way merge holds
  at most one record per open segment, so merge fan-in is capped at
  `budget` and multi-pass merging keeps the same bound.
- **Stability** — every record carries its input sequence number; the sort
  key is `(key, seq)`, so ties preserve input order and input ids keep
  their original relative order.
- **Bad lines abort** — the first malformed line (invalid JSON, missing
  `key`, non-integer key) throws `BadLineError` with the line number; the
  CLI exits 1 and no output is published.
- **Atomic publish** — the sorted stream is written to `<output>.tmp` and
  renamed over `<output>` only after it is fully flushed; a failed write
  removes the partial tmp file.
- **Resumable temp segments** — `tmpDir/manifest.json` is updated after
  every spilled segment and every merge pass. With `--resume`, a run
  interrupted by a crash or an IO error continues from the surviving
  segments instead of re-reading the input. The manifest is only reused
  when input path, size, mtime and budget all match.

## Layout

- `src/sorter.ts` — external sort core (`externalSort`), parsing, heap merge
- `src/io.ts` — injectable file-system abstraction (failure injection in tests)
- `src/cli.ts` — argument parsing and exit codes
- `test/sorter.test.ts` — node:test suite (see below)
- `types/node-shims.d.ts` — minimal Node typings (offline sandbox, no `@types/node`)

## Tests

`npm test` compiles and runs the suite covering: low-budget external sort
vs. in-memory stable sort, stability of equal keys, bigint keys beyond
2^53, single-run and empty inputs, bad-line aborts with no published
output, injected segment-write and output-write failures with resume, and
the CLI end to end.
