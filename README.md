# dfa-migration-verifier

设备科维护工单状态机迁移校验工具。给定旧规程与新规程两个 DFA（确定性有限自动机），
在积自动机上判定两者在风险分级上是否等价；不等价时输出最短区分串（迁移见证），
把差异状态映射为人工确认任务，并在预算内求最小费用覆盖。纯 Node.js 22 标准库实现，
单机离线，无第三方依赖。

## 运行

```sh
node --test                                  # 全部测试
node cli.js old.json new.json budget         # 分析并输出 JSON
node cli.js old.json new.json budget --m 6   # 只检查 <=6 步的操作序列
node cli.js old.json new.json budget --save plan.json   # 原子保存迁移计划
node cli.js load plan.json                   # 载入并校验迁移计划
```

## 输入格式（old.json / new.json）

```json
{
  "states": ["received", "verified"],
  "alphabet": ["inspect", "repair"],
  "start": "received",
  "risk": { "received": "low", "verified": "high" },
  "transitions": {
    "received": { "inspect": "verified", "repair": "received" },
    "verified": { "inspect": "verified", "repair": "verified" }
  },
  "costs": { "verified": 3 }
}
```

- `risk`：每个状态的风险分级，两机分级一致才算等价；每个状态都必须有分级。
- `transitions`：完全函数，每个状态对每个操作符号都必须有转移，目标状态必须已声明。
- `costs`：可选。该状态被映射为人工确认任务时的费用，必须是非负整数；缺省为 1。
- 两台机器的 `alphabet` 必须相同。
- `budget`：非负整数。

## 输出

成功时向 stdout 输出 JSON：

- `equal`：在步数上界 `m`（默认无界）内两机风险分级是否一致。
- `witness`：最短区分串（操作符号数组），`equal=true` 时为 `null`。
- `tasks`：选中的人工确认任务 `[{id, cost}]`，按 id 排序；id 形如 `old:状态` / `new:状态`。
- `cost`：选中任务总费用。
- `planHash`：对 `{equal, witness, tasks, cost}` 规范化 JSON 的 SHA-256。

## 退出码

- `0`：正常完成（含 `equal=true` 与成功给出任务集）。
- `7`：输入非法——预算为负或非整数、状态缺失（start/转移目标/risk 未声明）、成本非整数、
  字母表不一致、JSON 无法解析、plan 文件损坏或哈希不符。
- `8`：预算不足——最小覆盖费用超过预算，stdout 输出 `INFEASIBLE`，绝不假装完成。
- `2`：命令行用法错误。`1`：未预期错误。

## 核心机制

- **等价判定**：在积自动机 `(old_state, new_state)` 上从初始对做 BFS（字母表排序保证确定性），
  任一对风险分级不同即为差异。BFS 首次到达差异对的路径即最短区分串；`--m N` 限制搜索深度，
  即只覆盖所有 ≤m 步操作序列。
- **任务映射**：每个可达差异对 `(qo, qn)` 必须被覆盖；状态 `s` 生成任务 `old:s` / `new:s`，
  覆盖所有含该状态的差异对，费用取自对应机器的 `costs`（缺省 1）。
- **最小覆盖**：精确分支定界求最小费用集合覆盖。并列最优时按排序后的 id 列表字典序取最小，
  保证多次运行结果确定一致。最小费用超过预算即 `INFEASIBLE`（退出码 8）。
- **迁移计划**：`plan.json` 含 `version/equal/witness/tasks/cost/planHash`。保存先写临时文件、
  fsync 后原子 rename——**恢复点定义为 plan.json 原子替换成功后**。载入时校验 JSON、
  模式与哈希，半截或篡改的 plan 一律拒绝（退出码 7），`PlanStore` 保留上一份有效计划。

## 真实运行结果（examples/）

`examples/old.json` 与 `examples/new.json` 仅在第 3 步（`verified`/`confirmed`）风险分级不同：

```sh
$ node cli.js examples/old.json examples/new.json 5
{
  "equal": false,
  "witness": ["inspect", "inspect", "inspect"],
  "tasks": [{ "id": "new:confirmed", "cost": 2 }],
  "cost": 2,
  "planHash": "426bfa826dc4c24261ffca7d8e872ebe6646fd46324133404a4fae962c0dc954"
}
# exit=0

$ node cli.js examples/old.json examples/new.json 1
INFEASIBLE
# stderr: minimum cover cost 2 exceeds budget 1
# exit=8
```

测试结果（`node --test`，Node v22.22.1）：4 个测试文件、17 个用例全部通过，
覆盖验收项：重命名等价机 `equal=true`；第 3 步差异 witness 长度 3；并列最优任务集多次运行
确定性一致；`m≤6` 与枚举全部操作序列的暴力对照（多组随机种子）；半截 plan 拒绝载入并保持旧计划。

## 目录结构

- `cli.js`：命令行入口。
- `src/dfa.js`：DFA / 预算解析与校验（`ValidationError`）。
- `src/equivalence.js`：积自动机 BFS、最短区分串、差异对收集。
- `src/tasks.js`：差异对 → 任务映射、最小费用覆盖（精确、确定性并列处理）。
- `src/plan.js`：plan 哈希、原子保存、校验载入、`PlanStore`。
- `src/index.js`：库 API（`analyze` 等）。
- `test/`：`node:test` 测试；`helpers/testing.js`：测试辅助（含暴力枚举对照）。
