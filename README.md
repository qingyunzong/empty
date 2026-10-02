# kiln-scheduler

材料发现平台的烧结排程器：在有限炉次内选择配方实验矩阵，证明排程可行，
或在预算耗尽时给出当前最好界。Node.js 22，仅标准库，测试用 `node:test`。

## 模型

- **配方（变量）**：有限域温度档 `temps`、气氛 `atmospheres`、时长档
  `durations`；另有 `priority`、`crucible`、`gasPerHour`、`rampRequired`。
  求解变量 = 每个配方的 (炉次, 温度档, 气氛, 时长档) 或“不排程”。
- **资源**：每炉次炉位 `slotsPerRun`、每炉次坩埚库存 `crucibles`、
  全局气体总量 `gasBudget`（耗气 = 时长 × gasPerHour）。
- **约束**：
  - 升温曲线兼容：炉次的可用升温曲线集合与配方 `rampRequired` 求交；
  - 同炉温度差：同炉次任意两配方温度差 ≤ `tempDelta`；
  - 危险气氛互斥：同炉次不允许两种不同的危险气氛（`hazardous`）；
  - 每日炉次上限：`days × maxRunsPerDay` 个炉次，按天下标均分；
  - 优先级覆盖：已排程优先级之和 ≥ `minCoverage`（硬约束）。
- **目标**：先满足全部硬约束（含 lock 必须排程），再最大化优先级加权和；
  并列时按配方 ID 字典序（再按取值）取最小者。

## 求解

传播阶段计算资源剖面下界（覆盖缺口所需的最小气体量与最小新增炉次，
分数松弛）与目标上界，用于剪枝；回溯按 优先级降序+ID 分配炉次，
对称性破缺（新炉次取最小空闲下标）。三类预算：传播 `propagation`、
回溯 `backtrack`、目标改进 `improvement`。任一耗尽返回 `PENDING` 与
当前最好界（`bound` 与已找到的 `weight`），绝不误报 `UNSAT`。
`UNSAT` 时输出删除法求得的最小配方集 `core`（按包含关系极小）。

## CLI

```sh
node cli.js configure  --data '{"days":2,"maxRunsPerDay":2,"minCoverage":8}'
node cli.js add_recipe --data '{"id":"R1","priority":5,"temps":[700,800],
  "atmospheres":["air","H2"],"durations":[1,2],"crucible":"alumina","gasPerHour":1}'
node cli.js lock_slot  --recipe R1 --run 0 --temp 800 --atmosphere H2 --duration 1
node cli.js unlock_slot --recipe R1
node cli.js snapshot                       # => {"snapshot": 1}
node cli.js restore --id 1                 # 之后拍摄的快照全部失效
node cli.js optimize [--budgets '{"propagation":1000}'] [--enumerate]
```

- 状态存于 `--state` 指定的 JSON 文件（默认 `kiln.state.json`）。
- `snapshot`/`restore` 为栈式：`restore` 弹出目标快照，目标及其之后的
  快照全部失效；不带 `--id` 时恢复栈顶。
- `lock_slot` 只许作用于未排程变量（上次 `optimize` 未被排程的配方），
  且取值必须落在配方域内；`unlock_slot` 使旧解失效并触发完全重排。
- `optimize --enumerate` 用独立暴力枚举器求解（供 n≤9 对照）。

## 退出码

| code | 含义 |
| ---- | ---- |
| 0 | OPTIMAL / 命令成功 |
| 2 | UNSAT（输出含最小配方集 `core`） |
| 3 | PENDING（预算耗尽，输出当前最好界） |
| 4 | 用法 / 输入 / 状态错误 |

## 测试

```sh
node --test
```

覆盖：unlock 等价重算、嵌套快照恢复、危险互斥 UNSAT 最小配方集、
n≤9 随机实例与枚举器对照、三类预算的 PENDING 语义、CLI 端到端退出码。
