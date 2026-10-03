# RESULTS

Date: 2026-10-03 01:15:56 UTC  |  Node: v22.22.1  |  Platform: linux/x64

## 1. Full test run (`node --test`)

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 4637.414588
  type: 'test'
  ...
# Subtest: test/snapshot.test.js
ok 2 - test/snapshot.test.js
  ---
  duration_ms: 3649.688671
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4825.956582
```

## 2. Spec reporter (`node --test --test-reporter=spec`)

```
✔ test/cli.test.js (1106.451031ms)
✔ test/snapshot.test.js (2782.652174ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2995.592117
```

## 3. CLI demo (real output)

Covers: write -> resume(clean) -> injected crash (SNAP_FAULT=index-no-fsync) -> ERR_CRASH/ERR_DIRTY on stderr -> resume(recovered) -> rewrite -> diff -> verify -> materialize.

```
$ node cli.js write /tmp/cliresult/repo /tmp/cliresult/src
{"version":1,"created":true,"globalHash":"a4efa20e25dc9970c4f35132523b714eebf2a13103629cb2d3e71a8dfba17464"}
$ node cli.js resume /tmp/cliresult/repo
{"status":"clean","version":1}
$ echo two > src/a.txt && SNAP_FAULT=index-no-fsync node cli.js write repo src   # inject crash
{"error":"ERR_CRASH","message":"simulated power loss at crash point: index-no-fsync","details":{"point":"index-no-fsync"}}
exit=1
$ node cli.js verify /tmp/cliresult/repo
{"error":"ERR_DIRTY","message":"repo has uncommitted state (crash detected); run resume first","details":{"journal":true,"indexTmp":true,"tempChunks":0}}
exit=1
$ node cli.js resume /tmp/cliresult/repo
{"status":"recovered","version":1,"discardedVersion":2,"removedTempChunks":0}
$ node cli.js write /tmp/cliresult/repo /tmp/cliresult/src
{"version":2,"created":true,"globalHash":"463164e1b331c6ebb30967d3fdaebdae1c0b3e1c8c42c15755dcb086cdccde56"}
$ node cli.js diff /tmp/cliresult/repo 1 2
[{"op":"modified","path":"a.txt"}]
$ node cli.js verify /tmp/cliresult/repo
{"ok":true,"chunks":3,"versions":2}
$ node cli.js materialize /tmp/cliresult/repo 2 /tmp/cliresult/out
{"version":2,"filesWritten":2,"filesReused":0,"filesRemoved":0,"chunksRead":2}
$ cat /tmp/cliresult/out/a.txt
two
```

## 4. Acceptance criteria mapping

| Criterion | Where verified |
|---|---|
| 1. Three crash classes recover deterministically | `test/snapshot.test.js`: `fault chunk-partial/journal-uncommitted/index-no-fsync` (each scenario run twice, repo bytes compared identical) |
| 2. Exhaustive pairwise diff on small dir | `diff matches independently computed deltas for all version pairs` (4 versions x 12 ordered pairs, byte-order sorted) |
| 3. Corrupt unreferenced old chunk | `corrupt unreferenced old chunk: materialize unaffected, verify reports ERR_CHUNK` |
| 4. Empty + duplicate snapshot idempotent | `empty snapshot and repeated snapshots are idempotent` |
| Incremental decode reads only changed chunks, global checksum covers all | `incremental materialize reads only changed chunks, global checksum covers everything` |
| CLI `node cli.js resume repo` | section 3 above + `test/cli.test.js` |
