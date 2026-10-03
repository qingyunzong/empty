# RESULTS

Environment: Node.js v22.22.1, standard library only (`node:test`, `node:fs`, `node:crypto`), offline.

## `node --test` (real output)

```text
TAP version 13
# Subtest: test/main.test.js
ok 1 - test/main.test.js
  ---
  duration_ms: 678.288169
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 731.147847
```

## Per-test detail (`node test/main.test.js`, real output)

```text
ok 1 - 1. random intervals match brute-force sequential scan
ok 2 - 2. flipped index bitmap is detected (verify fails, bloom miss)
ok 3 - 3. deleting the last block gives deterministic boundary behavior
ok 4 - 4. boundary N values: N=1 and N greater than block count
ok 5 - 5. repair after index tampering reproduces identical index bytes
ok 6 - out-of-range reads return ERR_RANGE, never empty success
ok 7 - corrupt block payload fails with ERR_CRC
ok 8 - CLI flow: build + read 100 37 + verify
# tests 8
# pass 8
# fail 0
```

## Real CLI run (`node cli.js read f idx 100 37`)

```text
$ node cli.js build src.bin f idx 64 4
{"ok":true,"blockCount":16,"dataSize":1000,"blockSize":64,"n":4}
$ node cli.js read f idx 100 37 | xxd
00000000: abb7 1ce2 dcf3 661e fe3e 3780 84ec 7e55  ......f..>7...~U
00000010: ab26 972b 36bb 8fcc 9726 91d1 e6e7 5654  .&.+6....&....VT
00000020: 5b7d 3efa 51                             [}>.Q
$ cmp <(read) <(dd skip=100 count=37) && echo MATCH
MATCH
$ node cli.js verify f idx
{"ok":true}
$ node cli.js read f idx 1000 1  (out of range)
{"error":"ERR_RANGE","message":"range out of bounds","offset":1000,"len":1,"dataSize":1000}
exit=1
$ node cli.js repair f idx
{"ok":true,"blockCount":16,"dataSize":1000,"blockSize":64,"n":4}
```

## Acceptance mapping

1. Random intervals vs brute force: test 1 (500 random ranges + edge ranges, byte-exact).
2. Flipped index bitmap detected: test 2 (`verify` -> ERR_INDEX, `read` -> ERR_BLOOM direct miss).
3. Last block deleted: test 3 (reads before the gap succeed; reads touching it deterministically fail with ERR_CRC).
4. N=1 and N > blockCount: test 4 (3 checkpoints vs 1 checkpoint, reads and verify OK).
5. Repair reproducibility: test 5 (tampered index repaired to byte-identical original; data file untouched).

Note: the sandbox forbids spawning child processes, so tests drive the CLI
in-process via the exported `run(argv, io)` from `cli.js`; the real
`node cli.js ...` commands above were executed directly in the shell.
