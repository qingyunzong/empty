# crashreplay

Replays a CLI event log of `write` / `sync` / `crash` events and verifies
recovery invariants against every legal crash-recovery outcome.

## Model

- `write k=v` buffers a write; `sync` flushes all buffered writes to durable
  storage; `crash` restarts the system.
- On crash, every synced write survives and each unsynced write survives
  independently — so the recovered state is the durable state plus **any
  subset** of the pending writes, applied in log order.
- At every crash the checker enumerates all `2^n` persistent subsets of the
  `n` unsynced writes (default budget `2^18`, i.e. up to 18 writes) and
  checks the invariant on each. Enumeration order is deliberately scrambled
  (a bijective affine map) but exhaustive.
- The implementation under test (`Storage.Recover`) keeps a seeded,
  deterministic subset; the checker verifies this *actual* recovery result
  is a legal persistent subset and reports it alongside the verdict.

## Verdicts

- `ok` — every persistent subset satisfies the invariant.
- `counterexample` — the first violating recovered state is returned,
  together with the actual recovery result.
- `unknown` — the budget cannot cover `2^n` subsets (more than 18 unsynced
  writes with the default budget); the actual recovery result is still
  reported.

## Usage

Events are JSON lines on stdin (or `-file`), and may be published out of
order — they are sorted by `seq` before replay (duplicate seqs rejected):

```sh
printf '%s\n' \
  '{"seq":3,"op":"crash"}' \
  '{"seq":1,"op":"write","key":"a","value":"1"}' \
  '{"seq":2,"op":"sync"}' \
  | go run ./cmd/crashreplay -require a=1
```

Flags: `-require k=v,...` (recovery invariant), `-budget N`, `-seed S`,
`-shuffle`. Exit codes: 0 ok, 1 counterexample, 2 unknown, 3 usage error.

## Test

```sh
go test ./...
```
