# RESULTS

日期: 2026-10-03 07:02:24 CST  Node: v22.22.1

## 1. 测试套件: `node --test`

```
TAP version 13
# Subtest: test/archive.test.js
ok 1 - test/archive.test.js
  ---
  duration_ms: 4020.503407
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
# duration_ms 4160.659676
```

## 2. 逐条用例: `node test/archive.test.js`

```
TAP version 13
# Subtest: inspect: exhaustive corruption positions over all subsets
ok 1 - inspect: exhaustive corruption positions over all subsets
  ---
  duration_ms: 215.505799
  type: 'test'
  ...
# Subtest: inspect: weak checksum collision does not clear strong hash failure
ok 2 - inspect: weak checksum collision does not clear strong hash failure
  ---
  duration_ms: 4.11632
  type: 'test'
  ...
# Subtest: planRepair: budget boundary exact and minus one byte
ok 3 - planRepair: budget boundary exact and minus one byte
  ---
  duration_ms: 39.798281
  type: 'test'
  ...
# Subtest: planRepair: deterministic JSON sorted by chunk index
ok 4 - planRepair: deterministic JSON sorted by chunk index
  ---
  duration_ms: 13.125742
  type: 'test'
  ...
# Subtest: planRepair: conflicting sources raise ERR_SOURCE
ok 5 - planRepair: conflicting sources raise ERR_SOURCE
  ---
  duration_ms: 9.141618
  type: 'test'
  ...
# Subtest: applyPlan: injected failure leaves archive byte-identical
ok 6 - applyPlan: injected failure leaves archive byte-identical
  ---
  duration_ms: 39.558985
  type: 'test'
  ...
# Subtest: planRepair: intact archive yields empty plan
ok 7 - planRepair: intact archive yields empty plan
  ---
  duration_ms: 14.845012
  type: 'test'
  ...
# Subtest: inspect: broken manifest raises ERR_CRC, missing dir raises ERR_IO
ok 8 - inspect: broken manifest raises ERR_CRC, missing dir raises ERR_IO
  ---
  duration_ms: 4.660778
  type: 'test'
  ...
# Subtest: applyPlan: source content mismatch raises ERR_SOURCE before touching archive
ok 9 - applyPlan: source content mismatch raises ERR_SOURCE before touching archive
  ---
  duration_ms: 23.192267
  type: 'test'
  ...
# Subtest: cli: planRepair / applyPlan / verify round trip
ok 10 - cli: planRepair / applyPlan / verify round trip
  ---
  duration_ms: 26.939917
  type: 'test'
  ...
# Subtest: cli: errors are JSON on stderr with non-zero exit
ok 11 - cli: errors are JSON on stderr with non-zero exit
  ---
  duration_ms: 5.125824
  type: 'test'
  ...
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 665.090585
```

## 3. CLI 实测（真实 shell 会话，fixture: 3 块归档，块 1 翻转 1 字节）

### `node cli.js inspect arc`
```json
{
  "archive": "/tmp/demo/arc",
  "ok": true,
  "total": 3,
  "corruptCount": 0,
  "corrupt": [],
  "chunks": [
    {
      "index": 0,
      "file": "chunks/chunk-000000.bin",
      "status": "ok",
      "reason": null
    },
    {
      "index": 1,
      "file": "chunks/chunk-000001.bin",
      "status": "ok",
      "reason": null
    },
    {
      "index": 2,
      "file": "chunks/chunk-000002.bin",
      "status": "ok",
      "reason": null
    }
  ]
}
```
### `node cli.js inspect arc`（块 1 已损坏）
```json
{
  "archive": "/tmp/demo2/arc",
  "ok": false,
  "total": 3,
  "corruptCount": 1,
  "corrupt": [
    1
  ],
  "chunks": [
    {
      "index": 0,
      "file": "chunks/chunk-000000.bin",
      "status": "ok",
      "reason": null
    },
    {
      "index": 1,
      "file": "chunks/chunk-000001.bin",
      "status": "corrupt",
      "reason": "checksum"
    },
    {
      "index": 2,
      "file": "chunks/chunk-000002.bin",
      "status": "ok",
      "reason": null
    }
  ]
}
```

### `node cli.js planRepair arc good 1024`
```json
{
  "archive": "/tmp/demo2/arc",
  "knownGood": "/tmp/demo2/good",
  "maxBytes": 1024,
  "totalBytes": 13,
  "repairs": [
    {
      "index": 1,
      "bytes": 13,
      "sha256": "31aff80fa7d18c04e2583a6e21f33c004d269c81b45327f3ddab47ecd8727879",
      "source": "/tmp/demo2/good/chunks/chunk-000001.bin"
    }
  ]
}
```

### `node cli.js verify arc`（修复前，退出码 1）
```json
{
  "archive": "/tmp/demo2/arc",
  "ok": false,
  "corrupt": [
    1
  ]
}
```
退出码: 1（实测，见下方说明）

### `node cli.js applyPlan arc plan.json`
```json
{
  "archive": "/tmp/demo2/arc",
  "ok": true,
  "applied": [
    1
  ]
}
```

### `node cli.js verify arc`（修复后，退出码 0）
```json
{
  "archive": "/tmp/demo2/arc",
  "ok": true,
  "corrupt": []
}
```
退出码: 0

### 错误输出示例：`node cli.js planRepair arc good -1`（stderr JSON，退出码 1）
```json
{"error":"ERR_BUDGET","message":"invalid maxBytes: -1"}
```

## 4. 退出码实测（独立 fixture /tmp/demo3，真实 shell）

```
verify(修复前)  -> 退出码 1
applyPlan       -> 退出码 0
verify(修复后)  -> 退出码 0
planRepair -1   -> 退出码 1, stderr: {"error":"ERR_BUDGET","message":"invalid maxBytes: -1"}
```
