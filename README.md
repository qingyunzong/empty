# rknni — 有理向量的精确前 K 分支定界索引

纯 Python 3.11 标准库实现（仅依赖 `fractions` / `heapq` / `bisect` / `json` /
`unittest` 等），面向"必须给出可证明的精确前 K 结果"的向量检索场景：
所有坐标、距离与剪枝界均为 `fractions.Fraction` 精确有理数，拒绝 float 输入，
近似候选永远不会被当作精确答案返回。

## 特性

- **精确算术**：欧氏平方距离、包围盒下界全部用 `Fraction` 计算与比较；
  支持 `10**18` 级大坐标与任意精度有理数（`"p/q"` 字符串或 `[num, den]`）。
- **动态索引**：R 树式平衡层次，支持点插入、删除、按版本替换
  （`upsert` 要求版本严格递增，过期写入抛 `StaleVersionError`）。
- **标签布尔过滤**：`{"tag": ...}` / `{"and": [...]}` / `{"or": [...]}` /
  `{"not": ...}` 任意嵌套。节点维护保守摘要（`tags_any` 为并集超集、
  `tags_all` 为交集子集），`may_match` 只会误"可能"不会误"不可能"，剪枝安全。
- **安全的边界维护**：删除后叶节点边界精确重算，内部节点边界延迟收缩
  （保持超集），任何时刻都不会收缩过头；分裂时按子节点精确重算。
- **精确前 K 查询**：最佳优先分支定界；距离剪枝使用严格大于，
  边界等距与重复坐标不会丢失（按 `(distance, id)` 全序返回）。
- **预算与证书**：`budget` 限制访问节点数。耗尽时返回 `status="partial"`
  （`complete=false`）与已找到候选——unknown 不会冒充精确 KNN；
  证书列出每个未访问子树的包围盒与精确距离下界。
- **独立验证器**：`rknni.verify` 不信任索引，用全量数据暴力复核：
  命中存在性/过滤匹配/距离精确性/排序、证书下界重算、精确结果的
  top-K 一致性、部分结果的覆盖性。篡改任何字段都会被拒绝。
- **快照与持久化**：`snapshot()` 深拷贝隔离；`save()/load()` JSON 存取；
  `cursor()` 绑定创建时的数据版本，索引变更后运行抛 `StaleCursorError`。

## 库用法

```python
from rknni import Index, verify

idx = Index(dim=2, capacity=8, fanout=8)
idx.insert("a", ["1/2", "3/4"], tags=["x"], version=1)
idx.insert("b", [2, 1], tags=["y"], version=1)
idx.upsert("a", [1, 1], tags=["x", "z"], version=2)   # 版本必须递增
idx.delete("b")

res = idx.query([0, 0], k=5, filter={"tag": "x"}, budget=1000)
res.status            # "exact" | "partial"
res.complete          # 仅 exact 为 True
res.items             # [(id, Fraction距离)], 按 (距离, id) 排序
res.cert_entries      # 未访问子树的 {node_id, bbox, bound} 下界证书
res.stats             # visited_nodes / point_evals / filter_pruned / distance_pruned

verify(idx.points(), [0, 0], 5, {"tag": "x"}, res)    # 独立核验, 失败抛 VerificationError

snap = idx.snapshot()      # 独立快照
cur = idx.cursor([0, 0], 5)  # 绑定当前数据版本
cur.run()                  # 索引变更后调用抛 StaleCursorError
idx.save("/tmp/idx.json"); idx2 = Index.load("/tmp/idx.json")
```

## JSON CLI

从 stdin 读入操作脚本，向 stdout 输出每个操作的结果（单操作失败不中断脚本）：

```bash
echo '{"ops": [
  {"op": "new", "dim": 2, "capacity": 4},
  {"op": "insert", "id": "a", "vector": ["1/2", "3/4"], "tags": ["x"], "version": 1},
  {"op": "insert", "id": "b", "vector": [2, 1], "tags": ["y"], "version": 1},
  {"op": "query", "vector": [0, 0], "k": 2, "filter": {"tag": "x"}},
  {"op": "query", "vector": [0, 0], "k": 2, "budget": 0},
  {"op": "stats"},
  {"op": "save", "path": "/tmp/idx.json"}
]}' | python3.11 -m rknni
```

支持的操作：`new` / `insert` / `upsert` / `delete` / `query` / `verify` /
`stats` / `save` / `load`。`verify` 用当前索引中的数据独立核验给定的
查询结果（含证书）。

## 目录结构

```
rknni/
  exact.py     精确有理数、距离、包围盒运算
  filters.py   布尔过滤器与保守摘要剪枝 (may_match)
  tree.py      索引结构: 插入/删除/版本替换/分裂/快照/持久化
  query.py     最佳优先分支定界查询、预算、证书、版本游标
  verify.py    独立验证器与暴力 top-K
  cli.py       JSON CLI (python3.11 -m rknni)
tests/         unittest 测试套件
```

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：小数据每种过滤组合与暴力全扫描交叉核对、边界等距、重复坐标、
超出 float 精度的极大分数、删除最近点、标签摘要失效（过期摘要下查询仍正确）、
K 大于命中数、零预算与小预算部分结果、证书下界性质、篡改证书/距离/排序/
状态标志均被验证器拒绝、快照隔离、保存恢复、游标版本绑定、大样例真实
访问节点统计。

最近一次运行记录（Python 3.11.16）：

```
Ran 71 tests in ~6.5s
OK

[large/unfiltered] n=3000 dim=6 k=10 status=exact visited_nodes=312/598 point_evals=1335/3000 distance_pruned=270
[large/filtered]   n=3000 dim=6 k=8  status=exact visited_nodes=316/598 point_evals=362/3000 filter_pruned=85 distance_pruned=193
[large/budget=150] status=partial returned=10/10 cert_entries=360 visited_nodes=150
```
