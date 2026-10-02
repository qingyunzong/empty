# replan — 可复现实验计划器

在固定算力预算内，从带历史失败率的任务依赖图（DAG）中选出**可复现任务的最优子集**，
输出可执行计划、预算消耗与失败后的恢复点。Node.js 22，仅标准库，测试基于 `node:test`。

## 快速开始

```bash
node bin/replan.js plan dag.json budget.json
node bin/replan.js run --simulate dag.json budget.json --state state.json
node bin/replan.js checkpoint state.json <task>
node bin/replan.js resume state.json
node bin/replan.js explain dag.json budget.json [task]
node --test   # 全量测试
```

## 输入格式

`dag.json`：

```json
{
  "tasks": [
    {
      "id": "train",
      "deps": ["clean"],
      "cpu": 4, "mem": 8, "wall": 20,
      "failRate": 0.2,
      "maxRetries": 3,
      "value": 1
    }
  ]
}
```

- `deps` 默认 `[]`；`maxRetries` 默认 2；`value` 默认 1。
- `cpu` / `mem` / `wall` / `failRate` 为 `null`（或缺省）表示**未知**。

`budget.json`：`{"cpu": 8, "mem": 16, "wall": 40}`，维度为 `null` 表示该维度不约束。

## 核心语义

- **DAG 校验**：成环（含自环）报 `E_CYCLE` 并给出环路径；未知依赖、重复 id 等报 `E_INPUT`。
- **增量就绪集**：`ReadySet` 维护各任务未满足依赖计数，任务完成时只更新其直接后继，
  新就绪任务按 id 字典序弹出（确定性），不整图重扫。
- **NULL 资源 = 保守上界，非无穷**：未知消耗按该维度**整个预算**计入求和（任何可运行
  任务不可能超过总预算）。因此：单个 NULL-cpu 任务恰好占满 cpu 预算（边界可行）；两个
  NULL-cpu 任务或 NULL+已知消耗不能共存。预算维度为 NULL 时该维度不约束。
- **未知失败率进入区间**：`failRate: null` 按区间 `[0,1]` 参与成功率/期望尝试次数
  区间计算（模拟执行时用 `--assume-fail-rate`，默认 0.5），**绝不因此不可调度**。
- **预算模型**：消耗为累计模型——计划内各任务单次执行的有效消耗逐维求和，须 `<=` 预算
  （边界恰好相等可行）。重试在运行时额外消耗，超支即报 `E_BUDGET` 并保存恢复点。
- **最优计划**：目标为最大化选中任务的 value 之和，约束为依赖闭包 + 三维预算。
  精确枚举（分支限界，支持 ≤30 任务）；**并列最优全部列出**，按确定性键
  （选中任务 id 排序后逗号连接的字典序）排序，无任何随机性。
- **重试与检查点**：每次尝试（无论成败）都写检查点 `state.json.checkpoints/<task>.<attempt>.json`，
  每个尝试边界都是恢复点；状态文件 `state.json` 自包含（内嵌 DAG 与预算快照）。
- **崩溃恢复不重复副作用**：任务在写检查点后、标记完成前崩溃（`--crash-after-checkpoint`），
  `resume` 从检查点直接 finalize，副作用（`effects` 日志）不重复应用；
  检查点文件丢失或损坏报 `E_LOST_CKPT`。
- **撤销重排**：`plan --drop a,b` 将任务移出候选集（其依赖者因闭包约束自动排除），
  释放预算后重新求最优。

## CLI

| 命令 | 说明 |
| --- | --- |
| `plan <dag> <budget> [--require a,b] [--drop a,b] [--json]` | 输出全部并列最优计划、消耗、可复现性区间、恢复点 |
| `run --simulate <dag> <budget> [--state p] [--plan-index N] [--seed N] [--assume-fail-rate X] [--crash-after-checkpoint T] [--require-unique] [--json]` | 确定性模拟执行（种子 PRNG），写状态与检查点 |
| `resume <state> [--crash-after-checkpoint T] [--json]` | 从状态文件恢复执行；终态幂等 |
| `checkpoint <state> <task> [--json]` | 为已完成任务手动写快照检查点 |
| `explain <dag> <budget> [task] [--json]` | 解释计划：未选原因、失败率区间、期望尝试区间、恢复点 |

任务名支持唯一前缀；前缀命中多个任务报 `E_AMBIG`。`run` 默认取并列最优中键最小者
（`--plan-index` 可选其他），`--require-unique` 下存在并列即报 `E_AMBIG`。

## 错误码与退出码

| 错误 | 退出码 | 触发 |
| --- | --- | --- |
| `E_CYCLE` | 2 | 依赖图成环 |
| `E_BUDGET` | 3 | `--require` 闭包超预算；运行时（含重试）累计消耗超预算 |
| `E_LOST_CKPT` | 4 | 恢复时待 finalize 任务的检查点丢失/损坏 |
| `E_AMBIG` | 5 | 任务前缀不唯一；`--require-unique` 下存在并列最优 |
| `E_INPUT` | 6 | 输入文件/字段非法 |
| 模拟崩溃 | 75 | `--crash-after-checkpoint` 触发，状态已保存，可 `resume` |

## 验收对照（见测试）

1. `test/planner.test.js`：≤20 任务随机 DAG，与独立穷举（自闭位掩码枚举）对照最优值与全部并列计划键。
2. 同文件：预算恰好等于需求边界可行，减 1 不可行。
3. `test/runner.test.js`：检查点后、完成前崩溃，恢复后副作用恰好一次、消耗不重复。
4. `test/planner.test.js` + `test/cli.test.js`：撤销已选任务释放预算并触发重排。

## 布局

```
bin/replan.js   CLI 入口
src/dag.js      解析/校验、环检测、增量就绪集
src/resources.js 三维资源算术（NULL 上界）、失败率区间
src/planner.js  精确最优规划（分支限界 + 并列枚举）
src/runner.js   模拟执行、重试、检查点、崩溃/恢复
src/report.js   explain 报告
src/cli.js      命令分发
test/           node:test 套件
```
