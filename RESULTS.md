# RESULTS — 真实运行输出

运行环境: Node.js v22.22.1, 单机离线, 仅标准库。以下输出为 2026-10-03 实际运行采集。

## 1. 单元与属性测试 (`node --test`)

```
$ node --test
ok 1 - test/boundary.test.js
ok 2 - test/cli.test.js
ok 3 - test/concurrency.test.js
ok 4 - test/property.test.js
ok 5 - test/scope.test.js
ok 6 - test/types.test.js
# tests 6
# pass 6
# fail 0
```

各文件覆盖:

- `test/scope.test.js` — 验收 1: 三层审批嵌套(branch 800000 / region 500000 / manager 400000),
  内层 `cap loan 600000` 放大上限静态报 `E_SCOPE`; shadowing 只读覆盖; 运行时逐级 cap 强制
- `test/types.test.js` — 静态类型分离 limit/frozen/available, 冻结额当可用额报 `E_TYPE`
- `test/boundary.test.js` — 验收 2: 冻结等于可用、到期日 00:00、负解冻(`E_CAP`)、
  解冻只释放未使用部分、超可用不部分扣减
- `test/concurrency.test.js` — 验收 3: 同额同时刻两冻结, (ts, id, 行号) tie-break,
  打乱输入顺序结果不变, 只有一个成功
- `test/property.test.js` — 验收 4: 5 个种子 × 400 条随机事件,
  与独立枚举参考实现对照最终 available/frozen/used 三额一致, 且满足不变式 三额之和 == limit
- `test/cli.test.js` — CLI apply/replay 端到端、编译错误退出码、篡改状态回放失败

## 2. CLI 端到端 (`examples/`)

```
$ ./quota apply examples/script.qta examples/events.jsonl --out state.json
applied 6/10 events (4 failed), business day: 2026-10-23
  #6 e7 draw loan -> E_EXPIRED: freeze 'REQ-0003' already expired
  #7 e8 unfreeze loan -> E_EXPIRED: freeze 'REQ-0003' already expired
  #8 e9 freeze loan -> E_CAP: freeze amount must be a positive integer, got -5
  #9 e10 freeze loan -> E_NOTE: note 'BADNOTE' rejected by note whitelist
final buckets:
  loan: limit=1000000 available=750000 frozen=200000 used=50000
  card: limit=200000 available=195000 frozen=0 used=5000
state written to state.json

$ ./quota replay state.json
REPLAY OK: 10 events re-applied, final state matches (buckets/freezes/scopes/log)
final buckets:
  loan: limit=1000000 available=750000 frozen=200000 used=50000
  card: limit=200000 available=195000 frozen=0 used=5000
```

示例事件覆盖: 作用域内合法冻结(e1/e2/e3)、manager cap 占满后越权冻结被拒(e3 改由 region 层放行)、
部分动用后解冻只释放未使用部分(e4/e5)、到期日 00:00 批量结算后动用/解冻报 `E_EXPIRED`(e7/e8)、
负金额报 `E_CAP`(e9)、备注白名单拒绝报 `E_NOTE`(e10)。
