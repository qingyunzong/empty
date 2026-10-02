# RESULTS

环境: Node.js v22.22.1, 仅标准库, 测试框架 node:test。
日期: 2026-10-02T14:07:04Z

## 1. 全量测试: \`node --test\`

真实输出 (TAP):

```
TAP version 13
# Subtest: test/dag.test.js
ok 1 - test/dag.test.js
  ---
  duration_ms: 1637.53362
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
# duration_ms 1715.95128
exit=0
```

## 2. 逐条用例: \`node --test-reporter=spec test/dag.test.js\`

```
✔ random DAGs (<=20 nodes): invalidation set matches topological reference (506.19907ms)
✔ correcting a leaf never touches its siblings (7.464279ms)
✔ cycle and missing input raise fixed error codes (7.369839ms)
✔ tampered evidence chain fails audit with BAD_CERT (5.06927ms)
✔ forged certificate reference fails audit with BAD_CERT (2.922011ms)
✔ audit result is identical before and after gc (183.538856ms)
✔ cache key binds code version, input hash and ancestor vector (4.439836ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 866.730236
```

## 3. CLI 端到端演示 (add/run/invalidate/audit/gc, JSON 输入)

```
$ node cli.js --state /tmp/demo-state-8715.json add {"id":"extract","codeVersion":"1"}
{
  "id": "extract",
  "corrected": false,
  "invalidated": []
}
$ node cli.js --state /tmp/demo-state-8715.json add {"id":"train","codeVersion":"3","inputs":["extract"],"params":{"lr":0.1}}
{
  "id": "train",
  "corrected": false,
  "invalidated": []
}
$ node cli.js --state /tmp/demo-state-8715.json add {"id":"eval","codeVersion":"1","inputs":["train"]}
{
  "id": "eval",
  "corrected": false,
  "invalidated": []
}
$ node cli.js --state /tmp/demo-state-8715.json run {"all":true}
[
  {
    "id": "extract",
    "key": "cd66222a6541cb19b7514c202780c5119ac925a5eb577285809a14659951f928",
    "cert": "13dc0505d44963f09d7e8fd77dabcc98b61bc81cf821caae65a18bffb1677792"
  },
  {
    "id": "train",
    "key": "2d357ca9ed932842d424e33a5a917d658a07bbe72220bc5c1e2872c649400a73",
    "cert": "ac9bb3c51259704944913bff05fec5ec938dfd592021434800fc18e923aff073"
  },
  {
    "id": "eval",
    "key": "2b77cf57f1e7fc04e977868cb5d8a84b659ec8c892bd476c2c8bcef9dd2cdec4",
    "cert": "ab1cc4fbe8f6c87a93070395752c28545eed9689d3c27ec91d20639256a4a226"
  }
]
$ node cli.js --state /tmp/demo-state-8715.json audit
{
  "ok": true,
  "checked": 3,
  "leaves": [
    "eval"
  ],
  "chainLength": 3
}
# correct ancestor "train": only train+eval invalidated, extract untouched
$ node cli.js --state /tmp/demo-state-8715.json add {"id":"train","codeVersion":"4","inputs":["extract"],"params":{"lr":0.1}}
{
  "id": "train",
  "corrected": true,
  "invalidated": [
    "eval",
    "train"
  ]
}
$ node cli.js --state /tmp/demo-state-8715.json gc
{
  "removed": [
    "eval",
    "train"
  ],
  "reachable": [
    "extract"
  ]
}
$ node cli.js --state /tmp/demo-state-8715.json audit
{
  "ok": true,
  "checked": 1,
  "leaves": [],
  "chainLength": 3
}
$ node cli.js --state /tmp/demo-state-8715.json add {"id":"broken","inputs":["ghost"]}
{"error":{"code":"MISSING_INPUT","message":"node broken depends on missing input ghost"}}
exit=1
```

## 验收对照

| 验收项 | 用例 | 结果 |
|---|---|---|
| 随机 ≤20 节点 DAG, 失效集与拓扑枚举参考比对 | random DAGs (<=20 nodes): invalidation set matches topological reference (50 个随机 DAG x 每节点) | PASS |
| 改叶不影响兄弟 | correcting a leaf never touches its siblings | PASS |
| 环与缺输入报固定错 CYCLE / MISSING_INPUT | cycle and missing input raise fixed error codes | PASS |
| gc 前后 audit 结果一致 | audit result is identical before and after gc (20 个随机 DAG) | PASS |
| 证据证书哈希链篡改检测 BAD_CERT | tampered evidence chain / forged certificate reference | PASS |
| 缓存键含代码版本+输入哈希+祖先向量 | cache key binds code version, input hash and ancestor vector | PASS |
