# recalc — 带预算的增量重算器

节点有 `cost`、`value`、`deps`（前驱依赖）。`upd` 使节点及其传递后继变
dirty；`run <budget>` 在预算内选择 dirty 节点的子集重算，使重算后已干净
节点的 value 总和最大。

## 运行环境

Python 3.11+（仅标准库），无第三方依赖。

## CLI 用法

```
python -m recalc [script-file]     # 无参数时从 stdin 读命令
```

命令（每行一条，`#` 开头为注释）：

| 命令 | 含义 |
| --- | --- |
| `set <id> <cost> <value> [dep1,dep2,...]` | 定义/重定义节点，节点及传递后继变 dirty |
| `upd <id> <cost>` | 更新 cost，节点及传递后继变 dirty |
| `run <budget>` | 计算最优重算集合并执行（选中节点变干净） |
| `best <budget>` | 只打印最优计划，不改变状态 |
| `status` | 打印当前 dirty 节点 |

`run`/`best` 输出格式：`selected: a,b value: 9 cost: 5`（空集为
`selected: - value: 0 cost: 0`）。

实际运行示例：

```
$ printf 'set a 2 5\nset b 3 4 a\nset c 1 10 b\nbest 5\nrun 5\nstatus\nrun 1\nstatus\n' | python3 -m recalc
selected: a,b value: 9 cost: 5
selected: a,b value: 9 cost: 5
dirty: c
selected: c value: 10 cost: 1
dirty: -
```

## 语义

1. `upd`（以及 `set` 重定义）使节点及传递后继 dirty。
2. `run` 在 budget 内选择 dirty 节点子集：重算某节点必先重算其所有
   dirty 前驱（已干净的前驱无需重算）。
3. 目标：最大化已干净节点 value 和（等价于最大化选中节点 value 和）；
   费用为所选节点 cost 之和，不得超支（`cost <= budget` 即可选，预算
   等于 cost 的边界可选）。
4. 并列最优时，选节点 id 升序序列字典序最小者；若一序列是另一序列的
   严格前缀则视为并列（这使下一条规则有意义），仍并列选总 cost 更小
   者；再并列选节点数更少者（保证唯一确定）。
5. budget 不足任何单节点时选空集，不做部分执行。

## 求解方法

问题等价于带依赖闭包约束的 0-1 背包（NP-hard）。求解器对 dirty 子图做
DFS 枚举：包含某节点时强制包含其全部 dirty 祖先，排除某节点时强制排除
其全部 dirty 后继，并用正 value 后缀和做上界剪枝；并列比较用 id 升序位
掩码 O(1) 完成。`tests/test_bruteforce.py` 用独立的 0-1 全枚举（2^20）
对照验证最优集一致。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常 |
| 1 | 用法/IO 错误（未知命令、参数个数错误、非整数等） |
| 2 | 负 cost 或负 budget |
| 3 | 依赖环（`set` 引入环时拒绝并回滚） |
| 4 | 未知节点（`upd` 或依赖引用未定义节点） |

## 项目结构

```
recalc/core.py   # 图模型 + 求解器（RecalcGraph.best/run）
recalc/cli.py    # 命令行解析与退出码
tests/           # unittest 测试
```

## 测试

```
python -m unittest discover -s tests -v
```

覆盖验收项：

- A 预算边界：`BudgetBoundaryTest`（budget == cost 可选；不足任一单节点
  选空集）。
- B 依赖链：`DependencyChainTest`（不能只算子不算父；前驱已干净则无需
  重算）。
- C 并列最优：`TieBreakTest`（字典序、前缀并列回退 cost、多组并列唯一）。
- D 随机对照：`BruteForceComparisonTest`（20 节点随机图与 2^20 全枚举
  对照，另有 14/8 节点多组种子）。

### 真实运行记录

在本仓库实际执行 `python -m unittest discover -s tests -v`
（Python 3.14.4，Linux）：

```
Ran 29 tests in 11.774s

OK
```

结果：29 个测试全部通过，失败 0，错误 0。
