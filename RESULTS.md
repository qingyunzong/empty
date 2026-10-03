# RESULTS

环境: Node.js v22.22.1, 仅标准库, 单机离线。测试命令: `node --test`。

## 测试汇总 (真实输出)

```
$ node --test
ok 1 - test/accept.test.js
ok 2 - test/cli.test.js
ok 3 - test/edge.test.js
ok 4 - test/equiv.test.js
ok 5 - test/repair.test.js
# tests 5
# pass 5
# fail 0
```

共 26 个断言级子测试, 全部通过 (accept 3 / repair 6 / edge 8 / equiv 4 / cli 5)。

## 验收对照

### A. 合法流程通过且路径可重放

- 测试: `A: legal log accepted and witness path replays exactly` — ok
- 流程 `(apply review release post)+ (reverse post?)?`, 8 事件日志 accept=true,
  见证状态路径长度 = 事件数 + 1; 用 `simulate()` 从初态独立重放, 状态序列与见证完全一致。
- 中文事件名 (申请/复核/放行/入账/冲正) 归一化后同样通过。

### B. 缺失复核给插入修复

- 测试: `B: missing review yields a single insert repair` — ok
- 流程 `apply review release post`, 日志 `apply release post`:
  唯一最优修复 `cost=1, ops=[{op:"insert", event:"review", pos:1}]`,
  修复结果 `apply review release post`。

### C. 并列最优修复全部列出

- 测试: `C: all tied optimal repairs listed in lexicographic order` — ok
- 流程 `(apply|review) post`, 日志 `apply review post`:
  两个 cost=1 方案按事件名字典序并列输出
  (`delete apply@0` 先于 `delete review@1`)。
- 替换按删除+插入计价 (cost=2), 方案数上限 10 条。

### D. 等价判定 + 独立枚举器复现 (长度≤7, 事件5种)

- 测试: `D: distinguishing witness reproduced by independent enumerator` — ok
- `apply (review)? release` vs `apply release`:
  区分见证 `apply review release` (仅左侧接受);
  独立枚举器在 5 事件字母表上按长度-字典序枚举 (bound = 状态数乘积 = 12),
  复现同一见证, `reproduced=true`。
- 等价对 `apply (review)? release` vs `apply review release | apply release`
  判定 equiv=true, 枚举器在界内找不到任何区分串。

### E. 超过 K=6 报 NO_REPAIR_WITHIN_K

- 测试: `E: repair beyond K=6 reports NO_REPAIR_WITHIN_K, not unsatisfiable` — ok
- 流程 `apply review release post apply review release post`, 空日志:
  `repairError = {code:"NO_REPAIR_WITHIN_K", minCost:8, K:6}`, 而非不可满足。
- K 超过 6 时钳制到 6。

## 边界行为

- 空日志仅在正则接受空串时通过 (`(apply review)?` 接受, `apply review` 拒绝)。
- 冲正不能撤销未入账: 全局监控自动机与流程自动机做乘积,
  `apply reverse` 拒绝并给出 `REVERSAL_WITHOUT_POSTING@1`。
- 未知事件立即拒绝: `apply fly` 拒绝, `UNKNOWN_EVENT@1`, 见证停在失败点。
- 错误码: `EMPTY_ALPHABET` (纯正则无事件), `LOG_TOO_LONG` (>200 事件),
  `NO_REPAIR_WITHIN_K` (最小编辑距离 > K), `NONTERM_AUTOMATON` (无可达接受态)。

## CLI 实测

```
$ node cli.js check flow.re ok.jsonl     # exit 0
{ "accept": true, "witness": { "accepted": true, "states": [0,1,2,3,4], ... }, ... }

$ node cli.js check flow.re bad.jsonl    # exit 1
{ "accept": false, "witness": { "failIndex": 1, "event": "release", ... },
  "repairs": [ { "cost": 1, "ops": [ { "op": "insert", "event": "review", "pos": 1 } ],
                 "result": ["apply","review","release","post"] } ], ... }

$ node cli.js equiv left.re right.re     # exit 1
{ "equiv": false, "witness": { "events": ["apply","review","release"], "acceptedBy": "left" },
  "enumerator": { "bound": 12, "witness": { ...同上... }, "reproduced": true } }
```

退出码: 0 = accept/equiv, 1 = reject/非等价, 2 = 领域错误 (错误码见 JSON `error` 字段)。
