# RESULTS

Environment: Node.js `v22.22.1` (standard library only, `node:test`), offline, Linux x86_64.
Date: `2026-10-02T21:03:07.422Z`. All commands run from the repository root.

## Test suite

```console
$ node --test
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 17477.046137
  type: 'test'
  ...
# Subtest: test/crc32c.test.js
ok 2 - test/crc32c.test.js
  ---
  duration_ms: 2920.866098
  type: 'test'
  ...
# Subtest: test/store.test.js
ok 3 - test/store.test.js
  ---
  duration_ms: 3054.995997
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 17838.612863
```

node test/crc32c.test.js / node test/store.test.js / node test/acceptance.test.js (per-test names):

ok 1 - crc32c known vectors

ok 1 - append creates file with magic and sequential ids
ok 2 - correct and undo basic flow
ok 3 - undo of already revoked correction is a no-op
ok 4 - ERR_RANGE on unknown / wrong-type targets
ok 5 - ERR_CONFLICT: cannot undo a correction another correction depends on
ok 6 - decode time window and ERR_RANGE
ok 7 - refusing to append to a damaged file
ok 8 - hash chain break is detected even when CRCs are fixed up
ok 9 - corrupted index footnote is rebuilt from block scan with diffs reported
ok 10 - corrupted index field with repaired footnote CRC reports exact diff

ok 1 - acceptance 1: append-correct-undo decode equals enumerated reference
ok 2 - acceptance 2: flipped payload byte is localised to its block number
ok 3 - acceptance 2b: a flip anywhere inside a block record names that block
ok 4 - acceptance 3: truncation recovery differs between mid-block and boundary cuts
ok 5 - acceptance 4: random history, brute-force replay matches final view
ok 6 - cli: verify/append/correct/undo/decode happy path and error JSON
ok 7 - cli: ERR_CONFLICT exit code and stderr JSON
ok 8 - cli: verify warns on CRC damage but passes; fails with ERR_CHAIN on header tamper

## CLI demo session (real output)

Files were created in a scratch directory and `cli.js` was invoked by absolute path (shortened to `node cli.js` below for readability).
Stderr is shown merged with stdout (`2>&1`); the exit code follows each command.

### 1. append / correct / undo / decode

$ node cli.js append demo.wx --payload temp=21.3 hum=55 --ts 1000
{
  "ok": true,
  "id": 0,
  "offset": 8,
  "length": 144
}
(exit 0)

$ node cli.js append demo.wx --payload temp=22.0 hum=54 --ts 2000
{
  "ok": true,
  "id": 1,
  "offset": 152,
  "length": 144
}
(exit 0)

$ node cli.js append demo.wx --payload wind=3.1 --ts 3000
{
  "ok": true,
  "id": 2,
  "offset": 296,
  "length": 136
}
(exit 0)

$ node cli.js correct demo.wx 0 --payload temp=20.9 hum=55
{
  "ok": true,
  "id": 3,
  "offset": 432,
  "length": 144
}
(exit 0)

$ node cli.js decode demo.wx
{
  "records": [
    {
      "rootId": 0,
      "blockId": 3,
      "type": "CORRECT",
      "timestamp": 1000,
      "corrected": true,
      "payload": "temp=20.9 hum=55"
    },
    {
      "rootId": 1,
      "blockId": 1,
      "type": "DATA",
      "timestamp": 2000,
      "corrected": false,
      "payload": "temp=22.0 hum=54"
    },
    {
      "rootId": 2,
      "blockId": 2,
      "type": "DATA",
      "timestamp": 3000,
      "corrected": false,
      "payload": "wind=3.1"
    }
  ],
  "truncated": false,
  "skippedBlocks": []
}
(exit 0)

$ node cli.js undo demo.wx 3
{
  "ok": true,
  "id": 3,
  "undone": true,
  "undoBlockId": 4
}
(exit 0)

$ node cli.js decode demo.wx --start 1500 --end 2500
{
  "records": [
    {
      "rootId": 1,
      "blockId": 1,
      "type": "DATA",
      "timestamp": 2000,
      "corrected": false,
      "payload": "temp=22.0 hum=54"
    }
  ],
  "truncated": false,
  "skippedBlocks": []
}
(exit 0)

### 2. scan / verify

$ node cli.js scan demo.wx
{
  "file": "demo.wx",
  "blocks": [
    {
      "index": 0,
      "id": 0,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "offset": 8,
      "length": 144,
      "payloadLength": 16,
      "crcOk": true,
      "prevHashOk": true
    },
    {
      "index": 1,
      "id": 1,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "offset": 152,
      "length": 144,
      "payloadLength": 16,
      "crcOk": true,
      "prevHashOk": true
    },
    {
      "index": 2,
      "id": 2,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 3000,
      "offset": 296,
      "length": 136,
      "payloadLength": 8,
      "crcOk": true,
      "prevHashOk": true
    },
    {
      "index": 3,
      "id": 3,
      "type": "CORRECT",
      "targetId": 0,
      "timestamp": 1000,
      "offset": 432,
      "length": 144,
      "payloadLength": 16,
      "crcOk": true,
      "prevHashOk": true
    },
    {
      "index": 4,
      "id": 4,
      "type": "UNDO",
      "targetId": 3,
      "timestamp": 1790974913581,
      "offset": 576,
      "length": 128,
      "payloadLength": 0,
      "crcOk": true,
      "prevHashOk": true
    }
  ],
  "truncated": false,
  "errors": [],
  "warnings": []
}
(exit 0)

$ node cli.js verify demo.wx
{
  "file": "demo.wx",
  "ok": true,
  "blocks": 5,
  "truncated": false,
  "errors": [],
  "warnings": [],
  "indexRebuilt": false,
  "indexDiffs": [],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 144,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "payloadLength": 16
    },
    {
      "id": 1,
      "offset": 152,
      "length": 144,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "payloadLength": 16
    },
    {
      "id": 2,
      "offset": 296,
      "length": 136,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 3000,
      "payloadLength": 8
    },
    {
      "id": 3,
      "offset": 432,
      "length": 144,
      "type": "CORRECT",
      "targetId": 0,
      "timestamp": 1000,
      "payloadLength": 16
    },
    {
      "id": 4,
      "offset": 576,
      "length": 128,
      "type": "UNDO",
      "targetId": 3,
      "timestamp": 1790974913581,
      "payloadLength": 0
    }
  ]
}
(exit 0)

### 3. ERR_CONFLICT: undo of a correction another correction depends on

$ node cli.js append conflict.wx --payload temp=21.3 --ts 1000
{
  "ok": true,
  "id": 0,
  "offset": 8,
  "length": 137
}
(exit 0)

$ node cli.js correct conflict.wx 0 --payload temp=20.9
{
  "ok": true,
  "id": 1,
  "offset": 145,
  "length": 137
}
(exit 0)

$ node cli.js correct conflict.wx 1 --payload temp=20.7
{
  "ok": true,
  "id": 2,
  "offset": 282,
  "length": 137
}
(exit 0)

$ node cli.js undo conflict.wx 1
{"error":{"code":"ERR_CONFLICT","message":"cannot undo correction 1: correction(s) 2 depend on it","details":{"id":1,"dependents":[2]}}}
(exit 6)

$ node cli.js undo conflict.wx 2
{
  "ok": true,
  "id": 2,
  "undone": true,
  "undoBlockId": 3
}
(exit 0)

$ node cli.js undo conflict.wx 1
{
  "ok": true,
  "id": 1,
  "undone": true,
  "undoBlockId": 4
}
(exit 0)

$ node cli.js decode conflict.wx
{
  "records": [
    {
      "rootId": 0,
      "blockId": 0,
      "type": "DATA",
      "timestamp": 1000,
      "corrected": false,
      "payload": "temp=21.3"
    }
  ],
  "truncated": false,
  "skippedBlocks": []
}
(exit 0)

### 4. byte flip localised to its block (ERR_CRC warning, chain intact)

(flipped byte at offset 207, inside block 1 payload)

$ node cli.js verify flip.wx
{
  "file": "flip.wx",
  "ok": true,
  "blocks": 3,
  "truncated": false,
  "errors": [],
  "warnings": [
    {
      "code": "ERR_CRC",
      "index": 1,
      "id": 1,
      "offset": 141,
      "message": "block 1: payload CRC32C mismatch (stored 2358591673, computed 496003857); block skipped"
    }
  ],
  "indexRebuilt": false,
  "indexDiffs": [],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "payloadLength": 5
    },
    {
      "id": 1,
      "offset": 141,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "payloadLength": 5
    },
    {
      "id": 2,
      "offset": 274,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 3000,
      "payloadLength": 5
    }
  ]
}
(exit 0)

$ node cli.js decode flip.wx
{
  "records": [
    {
      "rootId": 0,
      "blockId": 0,
      "type": "DATA",
      "timestamp": 1000,
      "corrected": false,
      "payload": "obs-A"
    },
    {
      "rootId": 2,
      "blockId": 2,
      "type": "DATA",
      "timestamp": 3000,
      "corrected": false,
      "payload": "obs-C"
    }
  ],
  "truncated": false,
  "skippedBlocks": [
    1
  ]
}
(exit 0)

### 5. truncation: boundary cut vs mid-block cut

(full file 540 bytes; boundary cut at 407; mid-block cut at 444)

$ node cli.js verify trunc-boundary.wx
{
  "file": "trunc-boundary.wx",
  "ok": true,
  "blocks": 3,
  "truncated": false,
  "errors": [],
  "warnings": [],
  "indexRebuilt": false,
  "indexDiffs": [],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "payloadLength": 5
    },
    {
      "id": 1,
      "offset": 141,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "payloadLength": 5
    },
    {
      "id": 2,
      "offset": 274,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 3000,
      "payloadLength": 5
    }
  ]
}
(exit 0)

$ node cli.js verify trunc-mid.wx
{
  "file": "trunc-mid.wx",
  "ok": false,
  "blocks": 3,
  "truncated": true,
  "errors": [
    {
      "code": "ERR_FORMAT",
      "index": 3,
      "offset": 407,
      "message": "truncated tail: 37 byte(s) of an incomplete block at offset 407"
    }
  ],
  "warnings": [],
  "indexRebuilt": false,
  "indexDiffs": [],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "payloadLength": 5
    },
    {
      "id": 1,
      "offset": 141,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "payloadLength": 5
    },
    {
      "id": 2,
      "offset": 274,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 3000,
      "payloadLength": 5
    }
  ]
}
{"error":{"code":"ERR_FORMAT","message":"verify failed: truncated tail: 37 byte(s) of an incomplete block at offset 407","details":{"errors":1}}}
(exit 2)

$ node cli.js decode trunc-mid.wx
{
  "records": [
    {
      "rootId": 0,
      "blockId": 0,
      "type": "DATA",
      "timestamp": 1000,
      "corrected": false,
      "payload": "obs-0"
    },
    {
      "rootId": 1,
      "blockId": 1,
      "type": "DATA",
      "timestamp": 2000,
      "corrected": false,
      "payload": "obs-1"
    },
    {
      "rootId": 2,
      "blockId": 2,
      "type": "DATA",
      "timestamp": 3000,
      "corrected": false,
      "payload": "obs-2"
    }
  ],
  "truncated": true,
  "skippedBlocks": []
}
(exit 0)

### 6. hash chain break (header tamper with repaired CRC) fails verify

(tampered block 0 header timestamp, repaired its CRC)

$ node cli.js verify chain.wx
{
  "file": "chain.wx",
  "ok": false,
  "blocks": 2,
  "truncated": false,
  "errors": [
    {
      "code": "ERR_CHAIN",
      "index": 1,
      "id": 1,
      "offset": 140,
      "message": "block 1: hash chain broken (prevHash does not match hash of previous block)"
    }
  ],
  "warnings": [],
  "indexRebuilt": true,
  "indexDiffs": [
    {
      "index": 0,
      "id": 0,
      "field": "timestamp",
      "expected": 999,
      "actual": 1
    }
  ],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 132,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 999,
      "payloadLength": 4
    },
    {
      "id": 1,
      "offset": 140,
      "length": 132,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2,
      "payloadLength": 4
    }
  ]
}
{"error":{"code":"ERR_CHAIN","message":"verify failed: block 1: hash chain broken (prevHash does not match hash of previous block)","details":{"errors":1}}}
(exit 4)

$ node cli.js decode chain.wx
{"error":{"code":"ERR_CHAIN","message":"block 1: hash chain broken (prevHash does not match hash of previous block)","details":{"code":"ERR_CHAIN","index":1,"id":1,"offset":140,"message":"block 1: hash chain broken (prevHash does not match hash of previous block)"}}}
(exit 4)

### 7. damaged index footnote rebuilt from block scan

(corrupted footnote offset field of block 1)

$ node cli.js verify index.wx
{
  "file": "index.wx",
  "ok": true,
  "blocks": 2,
  "truncated": false,
  "errors": [],
  "warnings": [],
  "indexRebuilt": true,
  "indexDiffs": [
    {
      "index": 1,
      "id": 1,
      "field": "footnote",
      "expected": "valid CRC32C",
      "actual": "mismatch"
    }
  ],
  "index": [
    {
      "id": 0,
      "offset": 8,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 1000,
      "payloadLength": 5
    },
    {
      "id": 1,
      "offset": 141,
      "length": 133,
      "type": "DATA",
      "targetId": -1,
      "timestamp": 2000,
      "payloadLength": 5
    }
  ]
}
(exit 0)
