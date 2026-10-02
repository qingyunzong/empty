# replan

可复现实验规划器：在固定算力预算（cpu / mem / wall 三维）内，从带依赖关系的任务 DAG 中选出最优可执行子集，输出可执行计划、预算消耗与失败后的恢复点。Node.js 22，仅标准库，测试基于 `node:test`，单机离线，全程确定性（无任何随机源、无时间戳）。

## 安装与运行

```bash
node bin/replan.js <command> ...   # 或 npm link 后直接 replan
node --test                        # 全量测试
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `replan plan <dag.json> <budget.json> [--require id]... [--exclude id]... [--state s.json] [--json]` | 输出全部并列最优计划（按确定性键排序）、价值与三维预算消耗；`--state` 会扣除已完成任务已消耗的预算后重排 |
| `replan run --simulate <dag.json> <budget.json> [--state s.json]` | 取确定性首优计划并模拟执行（重试、检查点、崩溃），写状态文件 |
| `replan checkpoint <task> [--state s.json]` | 为计划内未完成任务手动写检查点；任务名支持唯一前缀，前缀不唯一报 `E_AMBIG` |
| `replan resume <state.json>` | 从状态文件恢复执行；已检查点任务不重复副作用 |
| `replan deselect <task> [--state s.json]` | 撤销已选未完成任务，释放其预算并对剩余任务触发确定性重排 |
| `replan explain <dag.json> <budget.json> [--state s.json] [--json]` | 解释选中/排除原因、预算消耗、成功率区间与每个任务的恢复点 |

## 输入格式

`dag.json`：

```json
{
  "tasks": [
    {
      "id": "train",
      "deps": ["fetch"],
      "cost": { "cpu": 2, "mem": 1, "wall": 2 },
      "failRate": 0.1,
      "value": 9,
      "retries": 2,
      "failAttempts": 0,
      "crash": "after-checkpoint"
    }
  ]
}
```

- `cost.<dim>` 为 `null` 表示**未知资源**：按保守上界（该维全部预算）参与预算核算——既不视为免费，也不视为无穷而不可调度。
- `failRate` 为 `null` 表示**未知历史失败率**：进入区间 `[0, 1]` 参与成功率区间计算，绝不因此被判为不可调度。
- `failAttempts`（模拟用）：前 N 次尝试失败；`crash: "after-checkpoint"`（模拟用）：在写完检查点、标记完成前崩溃。

`budget.json`：`{ "cpu": 8, "mem": 16, "wall": 100 }`，三维均须为非负数值。

## 语义要点

- **DAG 校验**：`topoOrder` 做 Kahn 拓扑排序（字典序决胜），成环报 `E_CYCLE`。
- **增量就绪集**：`ReadySet` 维护入度计数，任务完成时增量解锁后继，就绪列表保持字典序，保证执行顺序确定。
- **最优规划**：对拓扑序做包含/排除递归 + 上界剪枝的精确枚举，约束为依赖闭包 + 三维预算；目标为最大化总价值。**所有**并列最优计划按确定性键（排序后 id 以 NUL 连接）全量列出，执行时取排序后的第一个，无随机。
- **重试与检查点**：任务在标记完成前写检查点（`<state>.ckpt/<task>.json`，内容确定）；尝试失败重试至 `retries` 上限，耗尽则任务失败、后继跳过。恢复时已检查点任务走 `RESUME` 路径，不重复 `EXEC` 副作用。
- **恢复点**：`explain` 对每个计划任务给出失败后的恢复位置（已完成前缀 + 该任务的检查点）。

## 错误码与退出码

| 错误 | 退出码 | 触发 |
| --- | --- | --- |
| `E_CYCLE` | 2 | 依赖图成环 |
| `E_BUDGET` | 3 | 预算文档非法，或必选任务集（含依赖闭包）超出预算 |
| `E_LOST_CKPT` | 4 | 恢复时检查点记录丢失/损坏 |
| `E_AMBIG` | 5 | 任务前缀匹配到多个任务 |
| `E_UNKNOWN` | 6 | 引用了不存在的任务 |
| `E_CRASH` | 10 | 模拟运行崩溃（可 `resume` 恢复） |
| `E_USAGE` | 64 | 命令行/输入格式错误 |

## 验收标准对照（测试）

1. **20 任务内与穷举最优对照**：`test/plan.test.js` 中 40 个随机 DAG（n≤12）+ 1 个 20 任务用例，与独立朴素穷举 oracle 对比最优值与全部平局计划集合。
2. **预算恰等于需求边界**：`acceptance 2` 用例，需求总和恰等于预算时计划可行（`<=` 判定）。
3. **写检查点后、标记完成前崩溃，恢复不重复副作用**：`test/run.test.js` 与 `test/cli.test.js` 断言 `EXEC` 仅出现一次、`RESUME` 接管。
4. **撤销已选任务释放预算并触发重排**：`test/cli.test.js` 中 `deselect` 后被排除任务进入新计划，状态持久化。

## 最近一次全量测试结果

```
node --test
# tests 5 (files) / 24 (cases)
# pass 5 / 24
# fail 0
```
