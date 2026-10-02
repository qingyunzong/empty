# RESULTS

环境：Node.js v22.22.1，仅标准库，测试框架 node:test，单机离线。

## 全部测试（`node --test`）

```
TAP version 13
# Subtest: test/wxblk.test.js
ok 1 - test/wxblk.test.js
  ---
  duration_ms: 2401.693372
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
# duration_ms 2521.851662
```

## CLI 示例：append → correct → decode → undo → decode → verify → scan

```
$ node cli.js append /tmp/results-demo.wx --payload temp=20.1 --ts 1000
{
  "blockId": 0,
  "type": "data"
}
$ node cli.js append /tmp/results-demo.wx --payload temp=20.4 --ts 2000
{
  "blockId": 1,
  "type": "data"
}
$ node cli.js correct /tmp/results-demo.wx --id 0 --payload temp=21.1 --ts 3000
{
  "blockId": 2,
  "type": "correction"
}
$ node cli.js decode /tmp/results-demo.wx
[
  {
    "id": 0,
    "timestamp": 3000,
    "corrected": true,
    "correctedBy": 2,
    "payload": "temp=21.1"
  },
  {
    "id": 1,
    "timestamp": 2000,
    "corrected": false,
    "correctedBy": null,
    "payload": "temp=20.4"
  }
]
$ node cli.js undo /tmp/results-demo.wx --correct-id 2 --ts 4000
{
  "blockId": 3,
  "type": "undo"
}
$ node cli.js decode /tmp/results-demo.wx --from 0 --to 1
[
  {
    "id": 0,
    "timestamp": 1000,
    "corrected": false,
    "correctedBy": null,
    "payload": "temp=20.1"
  },
  {
    "id": 1,
    "timestamp": 2000,
    "corrected": false,
    "correctedBy": null,
    "payload": "temp=20.4"
  }
]
$ node cli.js verify /tmp/results-demo.wx
{
  "file": "/tmp/results-demo.wx",
  "ok": true,
  "blocksChecked": 4,
  "crcErrors": [],
  "chainBreaks": [],
  "truncated": null,
  "indexDiffs": []
}
$ node cli.js scan /tmp/results-demo.wx
{
  "file": "/tmp/results-demo.wx",
  "blocks": [
    {
      "blockId": 0,
      "type": "data",
      "timestamp": 1000,
      "replacesId": null,
      "offset": 8,
      "blockLen": 85,
      "crcOk": true,
      "chainOk": true,
      "payloadPreview": "temp=20.1"
    },
    {
      "blockId": 1,
      "type": "data",
      "timestamp": 2000,
      "replacesId": null,
      "offset": 125,
      "blockLen": 85,
      "crcOk": true,
      "chainOk": true,
      "payloadPreview": "temp=20.4"
    },
    {
      "blockId": 2,
      "type": "correction",
      "timestamp": 3000,
      "replacesId": 0,
      "offset": 242,
      "blockLen": 85,
      "crcOk": true,
      "chainOk": true,
      "payloadPreview": "temp=21.1"
    },
    {
      "blockId": 3,
      "type": "undo",
      "timestamp": 4000,
      "replacesId": 2,
      "offset": 359,
      "blockLen": 76,
      "crcOk": true,
      "chainOk": true,
      "payloadPreview": ""
    }
  ],
  "truncated": null,
  "indexDiffs": [],
  "rebuiltIndex": [
    {
      "blockId": 0,
      "offset": 8,
      "blockLen": 85
    },
    {
      "blockId": 1,
      "offset": 125,
      "blockLen": 85
    },
    {
      "blockId": 2,
      "offset": 242,
      "blockLen": 85
    },
    {
      "blockId": 3,
      "offset": 359,
      "blockLen": 76
    }
  ]
}
```

## 错误路径：ERR_RANGE（未知更正 id）与字节翻转后的 verify（ERR_CRC 定位块 + ERR_CHAIN 失败）

```
$ node cli.js undo /tmp/results-demo.wx --correct-id 99 ; echo exit=$?
{"error":"ERR_RANGE","message":"no correction with id 99","details":{"correctId":99}}
exit=1
# flipped one payload byte in block 1
$ node cli.js verify /tmp/results-flip.wx ; echo exit=$?
{"error":"ERR_CHAIN","message":"hash chain broken at block 2","details":{"file":"/tmp/results-flip.wx","ok":false,"blocksChecked":3,"crcErrors":[{"code":"ERR_CRC","block":1,"offset":121,"stored":545046213,"computed":142562951}],"chainBreaks":[{"block":2,"offset":234}],"truncated":null,"indexDiffs":[]}}
exit=1
```
