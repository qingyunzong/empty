# Test results

Recorded from an actual run on 2026-10-05.

Environment:

- Node.js v22.22.1 (`node:test` runner, built-in)
- TypeScript 7.0.2 (`tsc` on PATH, no npm dependencies installed)
- Platform: linux x64

## `npm test`

`npm test` runs `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`.

```
ok 1 - dist/test/parser.test.js
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 478.863983
```

## Per-test detail

`node dist/test/parser.test.js` (same compiled suite, per-test TAP):

```
ok 1 - keeps sent bytes, echo and program output apart
ok 2 - applies control sequences from the public finite table
ok 3 - marks truncated commands as incomplete
ok 4 - marks a truncated escape sequence as incomplete
ok 5 - consumes unknown escape sequences without visible-text effects
ok 6 - segment offsets address the original received bytes
ok 7 - arbitrary chunking and whole-buffer parsing agree (exhaustive 2-splits)
ok 8 - arbitrary chunking and whole-buffer parsing agree (random multi-splits)
ok 9 - byte-at-a-time feeding agrees with whole-buffer parsing
ok 10 - the control table is public, finite and consistently defined
# tests 10
# pass 10
# fail 0
```

Notes on what the chunk-invariance tests cover:

- Test 7 replays the session split at **every** possible two-piece split
  point of the received byte stream.
- Test 8 replays it 200 times with seeded random splits into 2-8 pieces,
  including an interleaved truncated command (`send` without terminator).
- Test 9 feeds the stream byte-at-a-time.
- All three compare the full segment list (kind, text, original offsets,
  completeness), the command records, and the visible/output/echo text
  against whole-buffer parsing.
