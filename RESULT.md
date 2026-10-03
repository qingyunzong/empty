# RESULT

- 环境：Node.js v22.22.1，仅标准库，单机离线
- 命令：`node --test`（测试框架：node:test）
- 运行时间：2026-10-03（Asia/Shanghai）
- 真实结果：**14/14 通过，0 失败**

## `node --test` 汇总输出（真实记录）

```
✔ test/acceptance.test.js
✔ test/cli.test.js
✔ test/errors.test.js
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## 逐条用例（`node <file>` 逐文件运行，真实记录）

### test/acceptance.test.js — 验收 A/B/C/D
```
ok 1 - A: life-rescue task overrides restricted-zone deny with dual authorization, fully audited
ok 2 - B: revocation segments by time; occupying task keeps temp pass, new task denied
ok 3 - C: out-of-order events resolved by Lamport causality (grant must be seen before dispatch)
ok 4 - D: <=10 tasks, enumerate reachable zones and cross-check against brute force
# tests 4
# pass 4
# fail 0
```

### test/errors.test.js — 错误码 exit 22/23/24
```
ok 1 - exit 22: clock references missing parent event
ok 2 - exit 22: lamport clock not greater than parent
ok 3 - exit 23: shelf coordinate out of bounds in map
ok 4 - exit 23: task target coordinate out of bounds
ok 5 - exit 24: dual authorization with the same person twice
ok 6 - rescue without dual authorization is denied, not overridden
# tests 6
# pass 6
# fail 0
```

### test/cli.test.js — CLI 端到端与退出码
```
ok 1 - CLI end-to-end: writes plan.jsonl and deny.jsonl
ok 2 - CLI exit 23 on out-of-bounds task coordinate
ok 3 - CLI exit 22 on missing parent event
ok 4 - CLI exit 24 on dual authorization by the same person
# tests 4
# pass 4
# fail 0
```

## 验收点对照

- **A 救援破例审计**：`T-rescue` 无授权进入禁区，凭 `dualAuth:["alice","bob"]` 破例放行，
  plan 记录 `exception:{type:"life-rescue-override", authorizers, overriddenReason}`；
  同优先级普通任务仍被 deny（优先级不可破例）。
- **B 撤销期间新旧任务差异**：`T-old`（t=100 派单，occupyUntil=600）在 t=500 撤销后保留
  `tempPass{until:600, revokedBy:["r1"]}`；`T-new`（t=550 派单）deny，
  并给出反例 `removeRevocation:"r1"`。
- **C 乱序事件因果判定**：lamport=9 但因果上未见授权的派单以 `grant-not-visible` 拒绝；
  经 e5 中继的派单放行，输出因果链 `["e1","e5","e10"]`。
- **D ≤10 任务枚举对照**：10 个任务逐一与测试内独立实现的暴力判定对照一致；
  `enumerateReachableZones` 输出与暴力展开的可达区域集合逐一 deepEqual。
