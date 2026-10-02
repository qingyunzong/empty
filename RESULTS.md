# RESULTS

环境：Node.js v22.22.1，仅标准库，单机离线。

## 测试运行（node --test）

```
$ node --test
TAP version 13
# Subtest: test/apply.test.js
ok 1 - test/apply.test.js
  ---
  duration_ms: 1304.411169
  type: 'test'
  ...
# Subtest: test/budget.test.js
ok 2 - test/budget.test.js
  ---
  duration_ms: 1254.444369
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 3 - test/cli.test.js
  ---
  duration_ms: 7624.951861
  type: 'test'
  ...
# Subtest: test/inspect.test.js
ok 4 - test/inspect.test.js
  ---
  duration_ms: 1324.225337
  type: 'test'
  ...
# Subtest: test/plan.test.js
ok 5 - test/plan.test.js
  ---
  duration_ms: 1286.219647
  type: 'test'
  ...
# Subtest: test/source.test.js
ok 6 - test/source.test.js
  ---
  duration_ms: 1071.127449
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7833.371655
```

## 测试文件汇总（spec reporter）

```
$ node --test --test-reporter=spec
✔ test/apply.test.js (1644.067316ms)
✔ test/budget.test.js (2160.039319ms)
✔ test/cli.test.js (22749.560006ms)
✔ test/inspect.test.js (1627.611493ms)
✔ test/plan.test.js (2830.959522ms)
✔ test/source.test.js (1569.644771ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 23001.328241
```
## CLI 实测（node cli.js …）

```
$ head -c 96 /dev/urandom > payload.bin
$ node cli.js create arc 32 < payload.bin
{
  "created": "arc",
  "blocks": 3
}
$ # 损坏 arc 的 1 号块后：
$ node cli.js verify arc
{
  "archive": "arc",
  "ok": false,
  "damaged": [
    1
  ]
}
exit=1
$ node cli.js planRepair arc good 1024
{
  "version": 1,
  "archive": "/tmp/arc-demo2/arc",
  "budget": {
    "maxBytes": 1024,
    "usedBytes": 32
  },
  "repairs": [
    {
      "index": 1,
      "length": 32,
      "sha256": "c6833b0bd76f8ae44f82e6e7fb909e64bbb68c810555f95c22ac439afc7fdeb9",
      "source": "/tmp/arc-demo2/good/blocks/000001.bin",
      "bytes": 32
    }
  ],
  "skipped": []
}
$ node cli.js applyPlan arc plan.json
{
  "archive": "/tmp/arc-demo2/arc",
  "applied": 1,
  "bytes": 32
}
$ node cli.js verify arc
{
  "archive": "arc",
  "ok": true,
  "damaged": []
}
exit=0
$ node cli.js planRepair arc good -5
{"error":{"code":"ERR_BUDGET","message":"maxBytes must be a non-negative integer, got: -5"}}
exit=2
```
