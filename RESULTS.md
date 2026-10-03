# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test`, offline.
All outputs below are real, captured from the commands shown.

## 1. Test suite (`node --test`)

```
TAP version 13
# Subtest: test/apply.test.js
ok 1 - test/apply.test.js
# Subtest: test/delta.test.js
ok 2 - test/delta.test.js
# Subtest: test/helpers.js
ok 3 - test/helpers.js
# Subtest: test/scan.test.js
ok 4 - test/scan.test.js
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Individual tests (run per file, TAP summary lines):

```
== node test/delta.test.js ==
ok 1 - 1: small tree add/delete/modify round-trips byte-for-byte
ok 2 - 2: duplicate content stored once with correct reference counts
ok 3 - 5: empty-to-empty delta has deterministic root
ok 4 - 5b: empty-to-nonempty and nonempty-to-empty deltas
== node test/apply.test.js ==
ok 1 - 3: interrupted apply (after journal) recovers on next run
ok 2 - 3b: stale staging without journal is discarded, target untouched
ok 3 - 3c: apply is idempotent
ok 4 - 3d: wrong base state is rejected with ERR_STATE
ok 5 - 3e: tampered literal chunk fails with ERR_HASH and does not pollute target
ok 6 - 4: delta with illegal paths is rejected with ERR_PATH
== node test/scan.test.js ==
ok 1 - 4a: case-conflicting file names are rejected with ERR_PATH
ok 2 - 4b: case-conflicting directory names are rejected with ERR_PATH
ok 3 - 4c: backslash and NUL in file names are rejected with ERR_PATH
ok 4 - 4d: symlinks are rejected with ERR_PATH
ok 5 - 4e: normalizePath rejects illegal paths
ok 6 - scan is deterministic and chunk entries carry path/mode/offset/sha256
ok 7 - certify reports ERR_GAP for uncovered bytes
```

17/17 tests pass. Acceptance mapping:

- AC1 (add/delete/modify vs reference): `delta.test.js` test 1
- AC2 (duplicate content ref counts): `delta.test.js` test 2
- AC3 (apply interruption recovery): `apply.test.js` tests 3, 3b, 3c
- AC4 (case conflict / illegal path rejection): `scan.test.js` 4a-4e, `apply.test.js` test 4
- AC5 (empty-to-empty deterministic root): `delta.test.js` tests 5, 5b

## 2. CLI end-to-end demo

Demo tree: `src/{a.txt, keep.txt, sub/b.txt}` -> target modifies `a.txt`,
deletes `sub/b.txt`, adds `new/c.txt`. `DELTA_CHUNK_SIZE=16` to force
multi-chunk files.

```
$ node cli.js scan src --out src.manifest.json
{"written":"src.manifest.json"}
$ node cli.js scan tgt --out tgt.manifest.json
{"written":"tgt.manifest.json"}
$ node cli.js makeDelta src tgt --out delta.json
{"written":"delta.json"}
$ cp -r src work
$ node cli.js applyDelta delta.json work
{
  "status": "applied",
  "root": "5a26c10b51939942747599fe1db01c4686bd4bf62fc7e787c2b9862b7f320abd"
}
```

### `node cli.js certify work delta.json`

```
{
  "root": "5a26c10b51939942747599fe1db01c4686bd4bf62fc7e787c2b9862b7f320abd",
  "files": 3,
  "bytes": 73,
  "coverage": "complete",
  "coverageHash": "a0d841264b569785d0ffd628eb4fcab780c28f7e2a9f179255c7581bee3868a7",
  "proof": [
    { "path": "a.txt", "size": 35, "spans": [[0, 16], [16, 16], [32, 3]] },
    { "path": "keep.txt", "size": 14, "spans": [[0, 14]] },
    { "path": "new/c.txt", "size": 24, "spans": [[0, 16], [16, 8]] }
  ]
}
```

### Delta package contents (excerpt)

```
{
  "version": 1,
  "chunkSize": 16,
  "baseRoot": "6cf51116ac2f30410963e0a4e9fe2c589f7d8652de7a301d7a180cdba90100bc",
  "targetRoot": "5a26c10b51939942747599fe1db01c4686bd4bf62fc7e787c2b9862b7f320abd",
  "deletes": ["sub/b.txt"],
  "reuse": {
    "86f5c8aea5c4...": { "path": "a.txt", "offset": 32, "size": 3, "refs": 1 },
    "2f53f2a9b7ec...": { "path": "keep.txt", "offset": 0, "size": 14, "refs": 1 }
  },
  "literals": {
    "aaaec32459dd...": { "size": 16, "refs": 1, "data": "aGVsbG8gd29ybGQsIE1PRA==" },
    ...
  },
  "files": [ ... ]
}
```

## 3. Error channel (stderr JSON, exit code 1)

```
$ node cli.js certify src delta.json        # wrong tree
{"error":"ERR_HASH","message":"target root hash mismatch","details":{"expected":"5a26c10b...","actual":"6cf51116..."}}
exit=1

$ node cli.js scan conflict                 # Foo.txt + foo.txt
{"error":"ERR_PATH","message":"duplicate or case-conflicting path","details":{"a":"Foo.txt","b":"foo.txt"}}
exit=1

$ node cli.js applyDelta delta.json random  # neither base nor target state
{"error":"ERR_STATE","message":"target directory does not match delta base state","details":{"expected":"6cf51116...","actual":"34be3899..."}}
exit=1
```
