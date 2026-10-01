# recompute — 带预算的增量重算器

节点有 `cost`、`value`、`deps` 三种属性与 dirty/clean 状态。`upd` 使节点及其
传递后继变 dirty；`run <budget>` 在预算内挑选一个 dirty 节点子集重算，使重算后
已干净节点的 value 总和最大。

纯 Python 3.11+ 标准库实现，无第三方依赖。

## 用法

```bash
python -m recompute [--state PATH] <command> [args]
```

状态以 JSON 持久化（默认 `./recompute_state.json`，可用 `--state PATH` 或环境变量
`RECOMPUTE_STATE` 覆盖）。

| 命令 | 说明 |
| --- | --- |
| `set <node> <cost> <value> [dep ...]` | 定义/重定义节点（初始为 dirty） |
| `upd <node> <cost>` | 更新 cost；节点及其传递后继变 dirty |
| `run <budget>` | 选出预算内最优集合并重算（写回状态） |
| `best <budget>` | 与 `run` 相同的最优计划，但只打印不执行（dry run） |
| `status` | 打印所有节点及 dirty 标志 |

`run`/`best` 输出：`selected`（选中的节点 id，升序）、`cost`（选中 cost 和）、
`value`（选中 value 和）、`clean_value`（计划执行后已干净节点的 value 总和）。

## 语义

1. `upd` 使节点及传递后继 dirty。
2. `run` 在 budget 内选择 dirty 节点子集；重算某节点必先重算其所有 dirty 前驱
   （选中集合对 dirty 前驱封闭）。
3. 目标：最大化重算后已干净节点 value 和（等价于最大化选中节点 value 和）；
   费用为选中 cost 和，不得超过 budget。
4. 并列最优时，选节点 id 升序序列字典序最小者；仍并列（同一集合）选总 cost
   更小者。id 按字符串序比较。
5. budget 不足任何单节点时选空集，绝不部分执行某个节点。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 用法错误 / 负 cost / 负 budget / 非整数参数 |
| 3 | 依赖环（含自环） |
| 4 | 未知节点（`upd` 或 `deps` 引用了不存在的节点） |

## 求解算法

`recompute/core.py` 中的 `Graph.select` 是精确分支定界：

- 对 dirty 子图做拓扑排序（前驱在前），依次决定每个节点选/不选；
- 不选某节点时，其全部传递 dirty 后继被禁止（保证封闭性）；
- 用「剩余正 value 后缀和」作上界剪枝，预算即时剪枝；
- 用统一的关键函数 `(-value, 升序id元组, cost)` 比较候选，保证并列规则唯一确定。

最坏情况指数级（预算约束的最大权闭包是 NP-hard）；测试规模（≤20 个 dirty
节点）下为毫秒级。

## 演示（真实运行）

```console
$ python -m recompute set a 2 5 && python -m recompute set b 3 7 a && python -m recompute set c 1 4
$ python -m recompute status
a cost=2 value=5 dirty deps=-
b cost=3 value=7 dirty deps=a
c cost=1 value=4 dirty deps=-
$ python -m recompute best 3
selected: a c
cost: 3
value: 9
clean_value: 9
$ python -m recompute run 3        # 与 best 一致，并写回状态
selected: a c
cost: 3
value: 9
clean_value: 9
$ python -m recompute upd a 4 && python -m recompute status
a cost=4 value=5 dirty deps=-
b cost=3 value=7 dirty deps=a
c cost=1 value=4 clean deps=-
$ python -m recompute run 6        # b 需要 a，{a,b} 费用 7 超预算，只能选 {a}
selected: a
cost: 4
value: 5
clean_value: 9
$ python -m recompute set x -1 5; echo $?
error: negative cost for node 'x': -1
2
$ python -m recompute upd ghost 1; echo $?
error: unknown node: ghost
4
```

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖验收点：

- **A 预算边界**：budget 恰好等于 cost 可选（`BudgetBoundaryTests`）；
- **B 依赖链**：不能只算子不算父（`DependencyClosureTests`）；
- **C 并列唯一**：多组并列按字典序/cost 规则唯一确定（`TieBreakTests`）；
- **D 暴力对照**：随机 20 节点图（全 dirty 与部分 dirty）与 0-1 枚举暴力
  最优集完全一致，另有 8 个种子 × 12 节点的多预算对照
  （`BruteForceCrossCheckTests`）；
- 错误码：负 cost/budget → 2，环 → 3，未知节点 → 4（`ExitCodeTests`、
  `ErrorTests`）。

### 真实运行结果（2026-10-01，Python 3.14.4）

```text
Ran 37 tests in 2.313s

OK
```

37 个测试全部通过，0 失败。首次开发中曾出现 24 个失败，定位为测试侧暴力
枚举器的可行性递推 bug（`feasible[prev]` 为假不代表加入新节点后不可行），
修复为「并集前驱 ⊆ 子集」判定后全部通过；求解器本身无需改动。

## 结构

```text
recompute/
  __init__.py   # 包导出
  __main__.py   # python -m recompute 入口
  core.py       # Graph/Node 模型、dirty 传播、分支定界求解器、错误类型
  cli.py        # 命令解析、JSON 状态持久化、退出码
tests/
  test_core.py  # 语义、并列规则、错误、暴力对照
  test_cli.py   # 端到端流程、退出码、子进程冒烟
```
