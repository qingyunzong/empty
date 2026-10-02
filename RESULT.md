# RESULT

- 环境：Node.js v22.22.1，仅标准库，离线单机
- 测试命令：`node --test`
- 运行时间：2026-10-02（Asia/Shanghai）
- 真实结果：**6 个测试文件、25 个用例，全部通过，0 失败**

## 汇总输出（`node --test`，实际捕获）

```
ok 1 - test/acceptance-a-rescue.test.js
ok 2 - test/acceptance-b-revocation.test.js
ok 3 - test/acceptance-c-causality.test.js
ok 4 - test/acceptance-d-enumeration.test.js
ok 5 - test/cli.test.js
ok 6 - test/errors.test.js
# tests 6
# pass 6
# fail 0
# duration_ms 11381.053709
```

## 逐用例结果（逐文件直接执行，实际捕获）

### A 救援破例审计 — test/acceptance-a-rescue.test.js
```
ok 1 - A: rescue override is allowed with two distinct authorizers and audited
ok 2 - A: rescue task without two authorizers is denied, not overridden
ok 3 - A: rescue override does not apply to non-restricted zones
ok 4 - A: granted rescue task uses the grant, not the exception path
```

### B 撤销期间新旧任务差异 — test/acceptance-b-revocation.test.js
```
ok 1 - B: occupying task keeps a temporary pass until completion
ok 2 - B: new task after revocation is denied and cannot reuse the pass
ok 3 - B: task before revocation without overlap gets no temp pass
ok 4 - B: counterexample names the revocation whose deletion legalizes the task
ok 5 - B: deleting the named revocation actually flips the decision (evidence check)
```

### C 乱序事件因果判定 — test/acceptance-c-causality.test.js
```
ok 1 - C: dispatch that causally saw the grant is allowed, chain is emitted
ok 2 - C: concurrent dispatch (grant not in causal past) is denied
ok 3 - C: out-of-order arrival still resolves causality from the DAG
ok 4 - C: causal chain spans intermediate events
```

### D ≤10 任务可达区域枚举对照 — test/acceptance-d-enumeration.test.js
```
ok 1 - D: records include reachableZones when task count <= 10
ok 2 - D: enumeration cross-checks against independent per-zone decisions
ok 3 - D: shelf-level grant inherits reachability to its whole zone only via the zone kind rule
```

### CLI 集成 — test/cli.test.js
```
ok 1 - CLI: writes plan.jsonl and deny.jsonl, exit 0
ok 2 - CLI: exits 22 on missing parent event
ok 3 - CLI: exits 23 on out-of-bounds coordinate
ok 4 - CLI: exits 24 on duplicate rescue authorizer
```

### 错误码（库层） — test/errors.test.js
```
ok 1 - exit 22: clock references a missing parent event
ok 2 - exit 23: task target coordinate out of bounds
ok 3 - exit 23: map shelf coordinate out of bounds
ok 4 - exit 24: rescue dual authorization by the same person
ok 5 - exit 24 fires even when a grant exists but is expired
```

## CLI 冒烟（examples/，实际执行）

```
$ node bin/agv-scheduler.js --map examples/map.json --tasks examples/tasks.jsonl \
    --grants examples/grants.jsonl --plan /tmp/plan.jsonl --deny /tmp/deny.jsonl
planned=2 denied=1   (exit=0)
```

- T1（撤销前已占用巷道）→ allow，含 `tempPass:{until:80,revoke:"R1",reusable:false}`，因果链 `["G2","T1"]`
- T3（生命救援）→ allow，`reason:"rescue-override"`，双人授权 alice/bob 审计记录
- T2（撤销后新任务）→ deny，`reasons:["grant-revoked"]`，反例 `removeRevoke:"R1"` 则恢复合法

## 备注

- 沙箱内嵌套子进程的 stderr 管道受限（EPERM），CLI 测试改用文件重定向读取子进程 stderr，退出码 22/23/24 均按真实进程状态断言。
