# RESULTS

所有输出均为真实运行结果（Node v22.22.1，仅标准库）。

## `node --test`

退出码 0。4 个测试文件全部通过（33 个用例：单元、四条验收、CLI 退出码）。

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 11652.774459
  type: 'test'
  ...
# Subtest: test/catalog.test.js
ok 2 - test/catalog.test.js
  ---
  duration_ms: 9233.293895
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 3 - test/cli.test.js
  ---
  duration_ms: 32996.146012
  type: 'test'
  ...
# Subtest: test/solver.test.js
ok 4 - test/solver.test.js
  ---
  duration_ms: 7220.445861
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 34211.684776
```

各文件用例数：`test/catalog.test.js` 9，`test/solver.test.js` 9，
`test/acceptance.test.js` 4，`test/cli.test.js` 11。

## 验收对照

1. **更正触发连锁重分配并输出冲突解释** — `test/acceptance.test.js`
   "acceptance 1" 通过；下方 `examples/cascade.jsonl` 演示中，seq=4 的
   `correct_obs` 在 `effects.cascade` 输出连锁重分配（C 让出 bin 0，因为
   A 占用），seq=6 的更正在 `effects.conflicts` 输出冲突解释
   （`exclusive_attribution`: B 与 C 同时钉在 bin 2），seq=7 求解给出
   UNSAT 核心（事件 `[1,2,3,4]`、约束名）。
2. **撤销到中间检查点后继续求解 == 从头重放** — "acceptance 2" 通过；
   下方演示 seq=8 `undo_to` 之后 seq=9 的 SAT 模型与 seq=5 完全一致。
3. **n<=9 随机事件与内置枚举器逐状态对照** — "acceptance 3" 通过
   （400 条种子化随机事件流，逐状态比对 SAT/UNSAT、校验模型、校验核心
   最小性）。
4. **预算边界返回 PENDING 而非 UNSAT** — "acceptance 4" 通过；下方
   `examples/pending.jsonl` 演示中 seq=2 为 PENDING（`BUDGET_EXCEEDED`，
   保留已传播事实 `facts`），同一实例加大预算后 seq=3 为 SAT。

## CLI 演示（真实输出）

### `node src/cli.js examples/cascade.jsonl` → exit=3 (UNSAT)

```
{"seq":0,"type":"ack","event":"add_obs","ok":true,"log_index":0,"effects":{"changes":[{"star":"A","field":"coord","from":null,"to":[0]},{"star":"A","field":"mag","from":null,"to":[0]},{"star":"A","field":"cred","from":null,"to":[0]}],"cascade":[],"conflicts":[]}}
{"seq":1,"type":"ack","event":"add_obs","ok":true,"log_index":1,"effects":{"changes":[{"star":"B","field":"coord","from":null,"to":[2]},{"star":"B","field":"mag","from":null,"to":[1]},{"star":"B","field":"cred","from":null,"to":[1]}],"cascade":[],"conflicts":[]}}
{"seq":2,"type":"ack","event":"add_obs","ok":true,"log_index":2,"effects":{"changes":[{"star":"C","field":"coord","from":null,"to":[1,2]},{"star":"C","field":"mag","from":null,"to":[0]},{"star":"C","field":"cred","from":null,"to":[0]}],"cascade":[{"star":"C","field":"coord","removed":2,"because":{"star":"B","coord":2}}],"conflicts":[]}}
{"seq":3,"type":"ack","event":"checkpoint","ok":true,"name":"before-fix","depth":1}
{"seq":4,"type":"ack","event":"correct_obs","ok":true,"log_index":3,"effects":{"changes":[{"star":"C","field":"coord","from":[1,2],"to":[0,1]}],"cascade":[{"star":"C","field":"coord","removed":0,"because":{"star":"A","coord":0}}],"conflicts":[]}}
{"seq":5,"type":"solve_result","status":"SAT","model":{"A":{"coord":0,"mag":0,"cred":0},"B":{"coord":2,"mag":1,"cred":1},"C":{"coord":1,"mag":0,"cred":0}},"budget":{"propagation":{"used":1,"limit":100000},"backtracking":{"used":0,"limit":100000}}}
{"seq":6,"type":"ack","event":"correct_obs","ok":true,"log_index":4,"effects":{"changes":[{"star":"C","field":"coord","from":[0,1],"to":[2]}],"cascade":[],"conflicts":[{"constraint":"exclusive_attribution","message":"stars 'B' and 'C' are both pinned to coord bin 2"}]}}
{"seq":7,"type":"solve_result","status":"UNSAT","constraints":["exclusive_attribution"],"budget":{"propagation":{"used":0,"limit":100000},"backtracking":{"used":0,"limit":100000}},"core":{"events":[1,2,3,4],"obs":["o2","o3"],"constraints":["exclusive_attribution"]}}
{"seq":8,"type":"ack","event":"undo_to","ok":true,"name":"before-fix","depth":0}
{"seq":9,"type":"solve_result","status":"SAT","model":{"A":{"coord":0,"mag":0,"cred":0},"B":{"coord":2,"mag":1,"cred":1},"C":{"coord":1,"mag":0,"cred":0}},"budget":{"propagation":{"used":1,"limit":100000},"backtracking":{"used":0,"limit":100000}}}
```

### `node src/cli.js examples/pending.jsonl` → exit=4 (PENDING)

```
{"seq":0,"type":"ack","event":"add_obs","ok":true,"log_index":0,"effects":{"changes":[{"star":"A","field":"coord","from":null,"to":[0,1]},{"star":"A","field":"mag","from":null,"to":[0]},{"star":"A","field":"cred","from":null,"to":[0]}],"cascade":[],"conflicts":[]}}
{"seq":1,"type":"ack","event":"add_obs","ok":true,"log_index":1,"effects":{"changes":[{"star":"B","field":"coord","from":null,"to":[0,1]},{"star":"B","field":"mag","from":null,"to":[1]},{"star":"B","field":"cred","from":null,"to":[1]}],"cascade":[],"conflicts":[]}}
{"seq":2,"type":"solve_result","status":"PENDING","reason":"BUDGET_EXCEEDED","exhausted":"backtracking","facts":{"A":{"coord":[0,1],"mag":[0],"cred":[0]},"B":{"coord":[0,1],"mag":[1],"cred":[1]}},"budget":{"propagation":{"used":0,"limit":100},"backtracking":{"used":0,"limit":0}}}
{"seq":3,"type":"solve_result","status":"SAT","model":{"A":{"coord":0,"mag":0,"cred":0},"B":{"coord":1,"mag":1,"cred":1}},"budget":{"propagation":{"used":1,"limit":100},"backtracking":{"used":1,"limit":4}}}
```

### `node src/cli.js examples/invalid.jsonl` → exit=2 (非法输入，JSON error)

```
{"seq":0,"type":"ack","event":"add_obs","ok":true,"log_index":0,"effects":{"changes":[{"star":"A","field":"coord","from":null,"to":[0]},{"star":"A","field":"mag","from":null,"to":[0]},{"star":"A","field":"cred","from":null,"to":[0]}],"cascade":[],"conflicts":[]}}
{"seq":1,"type":"error","error":{"code":"UNKNOWN_ID","message":"retract_obs: unknown observation id 'ghost'"}}
```
