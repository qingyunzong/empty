# intervalmap — 带来源与覆盖次数的持久区间映射

为排期服务设计的半开区间 `[lo, hi)` 映射：每个点携带**来源多重集**
（source → 覆盖次数），删除某个来源只影响该来源的覆盖，不会误删其他
来源仍覆盖的时间。端点为精确有理数（`fractions.Fraction`），支持
`inf` / `-inf` 无穷端点。仅依赖 Python 3.11 标准库。

## 结构

- `intervalmap/endpoints.py` — 端点规范化、全序比较、长度与 JSON 格式
- `intervalmap/treap.py` — 可分裂/合并的持久平衡区间树（路径复制 treap，
  优先级为端点的确定性哈希；节点缓存子树大小与聚合长度）
- `intervalmap/core.py` — `IntervalMap`：不可变持久映射，所有操作返回新值
- `intervalmap/workspace.py` — `Workspace`：嵌套事务 + 命名历史快照
- `intervalmap/checker.py` — 独立检查器（规范形式 + 阈值查询核验）
- `intervalmap/model.py` — 独立扫描线参考模型（有限端点坐标）
- `intervalmap/cli.py` — JSON CLI（`python3.11 -m intervalmap`）

## 语义

- **规范输出**：相邻段仅当来源多重集完全相同才合并；零长度输入为
  no-op；`lo > hi` 抛出 `ValueError`，任何索引（树、引用计数、聚合
  长度）保持不变。
- **批量修改只触及相交节点**：`add` 在区间两端 `split_at`，仅重建与
  `[lo, hi)` 相交的中段，再 `concat` 回去（边界段来源相同则合并）。
- **引用计数**：`refcount(source)` = 该来源在全图各段上的覆盖次数之和；
  与树、聚合长度同属一个不可变状态，回滚时一起恢复。
- **组合运算**：`union`（来源计数相加）、`intersection`（双方共同覆盖
  的区域，证明为计数之和）、`difference`（仅自身覆盖的区域）。
- **阈值查询**：`covered_by_at_least(k)` 返回 `(lo, hi, proof)`，proof
  即该段的来源多重集；`count_mode=True` 时按覆盖次数而非不同来源数。
- **事务与快照**：`Workspace.transaction()` 支持嵌套，异常即回滚；
  `snapshot(name)` / `restore(name)` 支持回滚分叉（恢复旧快照后继续
  修改，其他分支不受影响）。
- **保存恢复**：`to_json()` / `from_json()` 往返保持段、引用计数与
  聚合长度一致。

## 库用法

```python
from fractions import Fraction
from intervalmap import IntervalMap, Workspace, NEG_INF, POS_INF, verify_threshold

m = IntervalMap().add(0, Fraction(3, 2), "job-a").add(1, 2, "job-b")
m.segments()            # [(0,1,{a:1}), (1,3/2,{a:1,b:1}), (3/2,2,{b:1})]
res = m.covered_by_at_least(2)
assert verify_threshold(m, 2, res) == []   # 独立检查器核验

ws = Workspace(m)
with ws.transaction():  # 嵌套事务，异常自动回滚
    ws.add(NEG_INF, 0, "job-c")
ws.snapshot("v1"); ws.restore("v1")  # 历史快照 / 回滚分叉
```

## JSON CLI

从文件或 stdin 读取 JSON 命令数组，输出逐条结果：

```sh
echo '[{"op":"add","lo":"0","hi":"3/2","source":"a"},
       {"op":"add","lo":"1","hi":"2","source":"b"},
       {"op":"threshold","k":2}]' | python3.11 -m intervalmap
```

支持的 op：`add` / `revoke`（`count` 省略则全部撤销）/ `union` /
`intersection` / `difference`（`map` 为序列化映射）/ `begin` /
`commit` / `rollback` / `snapshot` / `restore` / `segments` /
`threshold`（含独立 `verified` 核验）/ `sources_at` / `total_length` /
`refcount` / `check` / `save` / `load`。端点写法：`0`、`"3/2"`、
`"inf"`、`"-inf"`。出错命令返回 `{"ok": false, "error": ...}` 且状态不变。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

测试覆盖：同端点进出、零长度输入、无穷端点、完全包含、同来源重复
添加再部分撤销、事务中拆分后失败回滚、回滚分叉、保存恢复、非法端点
顺序不改变任何索引；并以有限端点坐标的独立扫描线模型对随机操作序列
（8 种子 × 300 步，含事务/快照/组合运算）逐操作对照，每步核验规范
形式、聚合长度与阈值查询证明。

实测结果（Python 3.11.16）：**Ran 41 tests — OK**（41/41 通过）。
