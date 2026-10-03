# mold-sched — 注塑车间夜班离线排产

Node.js 22，仅标准库，无第三方依赖。给定订单（交期/工时/能耗/模具）、
模具更换时间矩阵与班次能耗预算，输出字典序最优 `(makespan, energy,
tardiness)` 的可行序列，或带最小反例证书的 `UNSAT`，或 `UNKNOWN`
（搜索预算耗尽，**绝不**冒充 UNSAT）。

## 模型

- 单机顺序加工，t=0 开始；相邻订单模具不同则花费 `setup[prev][next]` 时间，
  同时等量计入能耗（1 时间单位换模 = 1 能耗单位）。
- 序列能耗 = Σ 订单能耗 + Σ 换模时间；可行 ⟺ 最小可达能耗 ≤ `energyBudget`。
- 目标字典序：先最小化 makespan，再能耗，再总 tardiness（Σ max(0, Cᵢ−dueᵢ)）。
- 交期是软约束（进入目标），能耗预算是硬约束（决定可行性）。

## 用法

```bash
node cli.mjs <input.json> [--all]   # 或: cat input.json | node cli.mjs -
node --test                          # 运行全部测试
```

输入：

```json
{
  "jobs": [{"id": "order-101", "due": 8, "work": 3, "energy": 4, "mold": "A"}],
  "setup": {"A": {"B": 2}, "B": {"A": 2}},
  "energyBudget": 60
}
```

退出码：`0` = 已求解（FEASIBLE/UNSAT/UNKNOWN）；`2` = 输入非法
（stderr 打印 `ERR_SCHEMA:` / `ERR_INPUT:`）。

## 库 API

- `src/schema.mjs` — `normalizeInstance(raw)`：校验并规范化输入。
- `src/solver.mjs` — `solveNormalized(norm, {nodeLimit, cache, stats})`：
  两阶段精确求解。阶段 1 子集 DP 求最优 (makespan, energy)，与交期无关、
  可跨求解缓存；阶段 2 分支限界枚举全部达到最优 (makespan, energy) 的
  序列，取最小 tardiness 并**保留全部并列最优**（换模下界剪枝）。
- `src/scheduler.mjs` — `Scheduler`：增量编辑 + undo/redo。
  `editJob(id, patch)` 只失效"剩余集合含被改订单"的缓存子问题
  （改 due 时阶段 1 缓存全部命中，只重算受影响的 tardiness 阶段）；
  `undo()`/`redo()` 快照栈可还原到任一编辑点。
- `src/certificate.mjs` — `buildUnsatCertificate` / `verifyUnsatCertificate`：
  删除最小化得到极小不可行核（删除核中任一订单即可行），附 Held-Karp
  枚举表的 SHA-256 `enumHash` 与 `instanceHash`，可独立复验。
- `src/cli-main.mjs` — CLI 逻辑（可在进程内测试）。

## 真实输出摘要

`node cli.mjs examples/sample.json`（6 订单 3 模具，预算 60）：

```
status: FEASIBLE
objective: { "makespan": 22, "energy": 27, "tardiness": 3 }
schedule: order-101(A) → order-104(A) → order-102(B) → order-105(B)
          → order-103(C) → order-106(C)，含 2 次换模（A→B=2, B→C=1）
ties: 2   # 并列最优序列数
```

`node cli.mjs examples/unsat.json`（3 订单各能耗 10，预算 25）：

```
status: UNSAT, minEnergy: 30
certificate.jobs: ["a","b","c"]          # 极小核
certificate.removals: 删任一订单后 minEnergy=20 ≤ 25
certificate.enumHash: 73a3c73808e0fd4f…  # 枚举表 SHA-256，可复验
```

`node cli.mjs examples/invalid-setup.json`：

```
stderr: ERR_SCHEMA: setup["A"]["B"] must be a non-negative finite number
exit code: 2
```

## 测试（`node --test`，Node v22.22.1 实测）

```
# tests 4   # 4 个测试文件，共 15 个子测试
# pass 4
# fail 0
# duration_ms ≈ 2900
```

子测试清单（全部通过；标注 SKIP 的仅在本沙箱禁止 fork 子进程时跳过，
正常环境下真实 spawn CLI 验证退出码）：

- `test/solver.test.mjs`
  - ok 12 jobs: solver matches brute-force objective and every tied optimum
    （12 订单 4 参数类 ×3，暴力枚举 12!/(3!⁴)=369600 种类级序列并展开
    全部 id 级并列解，目标值与并列解集合完全一致；p2Nodes=690361 ≪ 12!）
  - ok solver schedule detail is consistent with the objective
- `test/unsat.test.mjs`
  - ok 超能耗预算返回 UNSAT 且证书可复验（极小核 + enumHash）
  - ok certificate verification rejects tampering（篡改 hash/预算/删除项均判伪）
  - ok UNKNOWN is never reported as UNSAT（nodeLimit=1 → UNKNOWN）
- `test/incremental.test.mjs`
  - ok 改 due 后增量结果与全量一致（目标与并列解集合相同，阶段 1 缓存命中 >0，
    重算状态数严格小于冷启动）
  - ok work/energy 编辑只失效受影响子问题且结果精确
  - ok undo 两次恢复原编辑点，redo 重放
  - ok 预算编辑可翻转 FEASIBLE/UNSAT 且可撤销
- `test/cli.test.mjs`
  - ok 合法输入 exit 0 输出 FEASIBLE JSON
  - ok UNSAT 输入 exit 0 附证书
  - ok 5 种非法 setup 均 ERR_SCHEMA + exit 2
  - ok 非法 JSON / 文件缺失 exit 2
  - ok stdin 读取（路径 `-`）
  - ok 真实子进程退出码验证（沙箱禁 fork 时 SKIP）

## 限制

- 精确求解上限 20 个订单（超出返回 UNKNOWN）；证书核 ≤ 18 个订单。
- 默认节点上限 5×10⁶，超出返回 UNKNOWN（可用 `nodeLimit` 调整）。
