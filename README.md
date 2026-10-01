# dynhull — 有理数二维动态凸包

精确有理数（`fractions.Fraction`）二维动态凸包库。**全程不产生浮点数**：
浮点输入（Python `float` / JSON 小数）一律被拒绝。仅依赖 Python 3.11 标准库。

## 数据结构

- 点按 `(x, y, id)` 排序存入**持久化 treap**（优先级取自 SHA-256，确定性、跨运行稳定）。
- 每个节点缓存其子树的**可合并摘要**：上凸链与下凸链。节点摘要由左右子摘要加自身关键点
  合并（候选点排序后做单调链扫描），合并代价只取决于凸链长度，**绝不重扫全部点**。
- 更新走**路径复制**（path copying）：每次增删只新建 O(log n) 个节点，旧根保持有效，
  因此快照就是保存一个根引用，嵌套快照 / 回滚 / 回滚后分叉都是 O(1) 外加写时复制的字典。
- `stats` 计数器记录每次更新**访问节点数**（`visited`）与**新建节点数**（`created`）；
  全量重算会是 Θ(n) 级别，局部维护实测每次更新约 10–60 个节点（见 `tests/test_locality.py`）。

## 功能与约定

- `insert(id, x, y)` / `delete(id)`：坐标接受 `Fraction`、`int`、`"p/q"` 字符串或 `(num, den)`。
  id 唯一；同一坐标可由多个 id 占据（多重集），**删除最后一个同坐标点才改变几何**。
- `vertices()`：逆时针规范顶点（从最小 `(x, y, id)` 顶点起）。**共线边只输出端点**。
- `hull()`：顶点 + 每条边的半平面证据 `(a, b, c)`，满足对所有活动点 `a*x + b*y + c >= 0`，
  两端点取等号。退化情形：1 点无边；2 点输出双向两条边。
- `extreme(dx, dy)`：方向极值（支撑函数），沿上下凸链三分搜索，O(log h) 级别。
- `tangents(qx, qy)`：返回 `(left, right)` 两个切点；`right` 满足整个凸包位于射线
  q→t 左侧。q 在包内或边界上时返回 `None`；退化包（≤2 点）返回端点。
- `checkpoint()` / `rollback()` / `commit()`：嵌套快照（LIFO 栈）。
- `save(path)` / `load(path)`：JSON 持久化（分数以 `"p/q"` 最简形式存储）。
- `dynhull.verify(points, hull_obj)`：**独立检查器**——确认每个顶点真实存在于活动点中、
  顶点环严格凸且逆时针规范、每条边半平面证据覆盖全部活动点。
- `dynhull.brute_*`：**独立全枚举支撑线**参照实现（O(n³)），供测试交叉核对。

### 并列规则（确定性）

- 同坐标多点：凸包顶点由该坐标处**最大 id** 代表；
- 方向极值并列：先取点积最大，再取**最小 (x, y)**，再取该坐标处**最小 id**；
- 切点共线并列：取**最小 (x, y)**，再取该坐标处**最小 id**。

## JSON CLI

```
python3.11 -m dynhull
```

stdin 每行一条 JSON 命令，stdout 每行一条响应 `{"ok": true, "result": ...}`。
命令：`insert` / `delete` / `hull` / `extreme` / `tangent` / `checkpoint` / `rollback` /
`commit` / `save` / `load` / `verify` / `stats` / `reset`。示例：

```
{"op": "insert", "id": 1, "x": "1/2", "y": 3}
{"op": "hull"}
{"op": "extreme", "dx": 1, "dy": "2/3"}
```

## 测试

```
python3.11 -m unittest discover -s tests -v
```

覆盖：随机增删对拍暴力枚举、全共线、重复点、删除桥接上下凸链的极点、
极近分数点（1e-12/1e-15 级差异精确区分）、嵌套快照回滚后分叉、保存重载、
切线/极值对拍与并列规则、检查器防篡改、长序列更新节点访问计数（局部性）。
