# fdsolver — 可增删约束的有限域求解器

纯 Python 3.11 标准库实现，提供 JSON CLI 与库 API。

- **变量**：整数有限集合。
- **约束**：允许元组表约束（valid-tuple 支持集维护，GAC）与
  `allDifferent`（Régin 算法：二部图最大匹配 + 交替路径 + 强连通分量分解，
  剔除所有不属于任何完整匹配的边，而非仅处理已赋值变量）。
- **传播**：队列驱动，所有约束传播到共同不动点；`propagate()` 返回 `True`
  仅表示"未被证伪"，不代表可满足。
- **回溯**：嵌套 `push()`/`pop()`，基于 trail 完整恢复被删的值、
  表约束的元组支持信息、以及本层添加的约束/变量（不是只清空队列）。
- **搜索**：可暂停、可序列化恢复的迭代 DFS。结论三选一：
  - `sat` + 完整见证（`witness`）；
  - `unsat` + 可独立重放的分支冲突树（`certificate`）；
  - `unknown` + 可恢复状态（`state`）——节点预算耗尽只能得到 `unknown`。
- **健壮性**：坏引用、重复变量等非法输入在修改前原子拒绝；
  JSON 输出键排序、字节级确定。

## 问题格式（JSON）

```json
{
  "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
  "constraints": [
    {"type": "alldifferent", "scope": ["a", "b", "c"]},
    {"type": "table", "scope": ["x", "y"], "tuples": [[1, 2], [2, 1]]}
  ]
}
```

## CLI 示例

```bash
# 求解（Hall 集：a,b ∈ {1,2} 迫使 c ∈ {1,2,3} 收缩为 {3}）
python3.11 -m fdsolver solve examples/hall.json
# -> {"status": "sat", "witness": {"a": 1, "b": 2, "c": 3}, ...}

# 弧一致但全局无解：输出 unsat 与冲突树证书
python3.11 -m fdsolver solve examples/pairwise_unsat.json

# 独立重放验证 UNSAT 证书（退出码 0 = 有效，1 = 无效/被篡改）
python3.11 -m fdsolver verify examples/pairwise_unsat.json cert.json

# 校验 SAT 见证
python3.11 -m fdsolver check examples/hall.json witness.json

# 节点预算：耗尽只会得到 unknown，并可保存状态、之后恢复续搜
python3.11 -m fdsolver solve examples/send_more_money.json --budget 3 --save-state state.json
python3.11 -m fdsolver solve examples/send_more_money.json --resume state.json
```

## 库 API

```python
from fdsolver import Solver, Searcher, solve, verify_unsat, check_witness

solver = Solver.from_spec(spec)
solver.propagate()          # False = 已证伪；True 仅表示未证伪
solver.push()               # 嵌套层级
solver.add_alldifferent(["a", "b", "c"])   # 运行中增约束（原子校验）
solver.assign("a", 1)
solver.pop()                # 完整撤销：域、元组支持、新增约束全部恢复

result = solve(spec, budget=1000)          # 一次性求解
searcher = Searcher(spec)
result = searcher.run(budget=10)           # 可暂停
state = result["state"]                    # JSON 可序列化
searcher = Searcher.from_state(spec, state)  # 恢复后续搜，结论一致

ok = verify_unsat(spec, result["certificate"])  # 独立重放冲突树
ok = check_witness(spec, result["witness"])
```

## 冲突树证书格式

内部节点 `{"var": 名, "children": {"值": 子树}}`，叶子 `{"conflict": true}`。
验证器在全新求解器上重放：每个内部节点的子分支必须恰好覆盖该变量当时
（传播后）的整个域；每个叶子必须在指派后真实传播失败。删分支、改值、
改变量名、伪造叶子等篡改均验证失败。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

实测结果（2026-10-04，Python 3.11.16）：

```
Ran 20 tests in 3.340s

OK
```

覆盖：Hall 集裁剪、弧一致但全局无解、两层回滚与撤销 allDifferent 后域恢复、
表约束支持信息恢复、逐节点保存/重启与连续搜索结论一致、坏引用原子拒绝、
JSON 确定性、60 个随机网络（≤6 变量、域 ≤4）与独立全枚举逐一核对解集及
每个删值的正确性、篡改证书必验证失败。
