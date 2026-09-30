# intervalmap — 持久化来源覆盖区间映射

排期服务用的半开区间 `[lo, hi)` 映射：每个区间段记录**来源多重集**
（来源 → 覆盖层数），端点为精确有理数（`Fraction`）或 `±inf`。
删除某个来源只移除它自己的覆盖层，不会误删其他来源仍覆盖的时间。

## 结构

- `intervalmap/tree.py` — 可分裂合并的持久平衡区间树（treap，路径复制）。
  批量修改用 `split_at(lo)/split_at(hi)` 隔离区间，**只触及相交节点**；
  相邻段仅在来源集合完全相同时才合并（`merge_canonical`）。
  每个节点缓存子树聚合长度。
- `intervalmap/core.py` — `IntervalMap` 与不可变 `Version`
  （树根 + 来源引用计数 + 端点事件 + 聚合长度）。
  快照 O(1)；嵌套事务 `begin/commit/rollback`；回滚时引用计数、
  端点事件、聚合长度随版本一起恢复。
- `intervalmap/model.py` — 独立扫描线参考模型：只保存操作记录，
  用有限端点坐标逐点重算覆盖，用于逐操作对照。
- `intervalmap/checker.py` — 独立检查器：仅通过公开区间输出逐端点
  核验覆盖、事件、引用计数与总长度，并验证阈值查询的来源证明。
- `intervalmap/cli.py` — JSON Lines CLI。

## API 摘要

```python
from intervalmap import IntervalMap

m = IntervalMap()
m.add("source-a", "1/3", "5/6")      # 精确有理数端点
m.add("source-b", "-inf", "+inf")    # 无穷端点
m.intervals()                        # 最大化合并的规范区间（带来源证明）
m.covered_at_least(2)                # 覆盖阈值查询（带来源证明）
m.remove_source("source-a")          # 按来源撤销（可选 lo/hi 限定范围）
m.union(other); m.intersection(other); m.difference(other)
v = m.snapshot(); m.restore(v)       # 历史快照 / 回滚分叉
m.begin(); m.commit(); m.rollback()  # 嵌套事务
m.events(); m.refcounts(); m.length()
```

非法端点顺序（`lo > hi`）抛出 `ValueError`，不改变任何索引；
零长度输入是无副作用的空操作。

## CLI

每行一个 JSON 命令，每行一个 JSON 结果：

```sh
printf '%s\n' \
  '{"op":"add","source":"a","lo":"0","hi":"10"}' \
  '{"op":"add","source":"b","lo":"5","hi":"+inf"}' \
  '{"op":"threshold","k":2}' \
  '{"op":"check","k":2}' | python3.11 -m intervalmap.cli
```

支持 `add / remove_source / union / intersection / difference /
begin / commit / rollback / save / restore / intervals / threshold /
length / refcounts / events / check / reset`。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

70 个测试：端点解析、树分裂合并与持久性、规范合并、来源撤销、
嵌套事务与快照分叉、集合运算、脚本化边界情形（同端点进出、零长度、
无穷端点、完全包含、同来源重复添加再部分撤销、事务中拆分后失败、
回滚分叉、保存恢复）、12 路随机操作流与扫描线模型逐操作对照、
检查器正负用例、CLI 子进程端到端。
