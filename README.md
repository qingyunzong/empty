# arrangement — 有理坐标线段平面排列构造器

将大量相交/重叠的线段拆成可遍历的平面网络（planar arrangement）。
纯 Python 3.11 标准库实现，所有坐标为 `Fraction`，全部比较精确，
无任何浮点谓词（角度排序用半平面 + 叉积符号，禁止 `atan`）。

## 功能

- **扫描线求交**：Bentley–Ottmann 事件队列 + 活动顺序表（非逐对求交），
  精确处理竖线、共享端点、多线共点；竖线通过对状态结构的精确
  y 区间查询处理。
- **共线重叠规范化**：`atomic_decomposition` 先把同线重叠合并为带
  来源集合（source ids）的规范原子段，再在所有交点处切分。
- **半边结构（DCEL）**：顶点出边按精确角度谓词排序缝合 `next/prev`，
  遍历得到面环；负面积环为外部面；支持悬挂边、孤立点、多连通分量。
- **增量更新**：`insert` / `delete` 事务式执行——先验证、重建成功才
  提交，失败输入不破坏旧拓扑；顶点与边 id 按内容键持久化，未变化
  的边保持原 id；每次更新报告受影响区域（新增/删除/来源变化的边）。
- **独立核验** `verify_all`：原线段被原子边完整覆盖、半边成对且
  next/prev 一致、面环闭合且每半边恰属一面、角度缝合一致、
  欧拉关系 `V - E + F == C + C_e`。
- **保存/恢复**：`to_json` / `from_json` 精确往返（分数编码为
  整数或 `"p/q"` 字符串），恢复后 id 与拓扑完全一致。

## 库用法

```python
from arrangement import Arrangement, verify_all, to_json, from_json

arr = Arrangement([
    [[0, 0], [4, 0]], [[4, 0], [4, 4]],
    [[4, 4], [0, 4]], [[0, 4], [0, 0]],
    [[0, 0], [4, 4]],        # 对角线
    [[2, -1], [2, 5]],       # 竖线
])
print(verify_all(arr)["ok"])   # True
arr.insert([[[0, 2], [4, 2]]]) # 事务式插入
arr.delete([5])                # 删除对角线
data = to_json(arr)            # 保存
arr2 = from_json(data)         # 恢复，id 与拓扑一致
```

坐标接受 `int`、有限小数（按十进制解释）或 `"p/q"` 字符串。

## JSON CLI

```bash
echo '{"segments": [[[0,0],[4,0]], [[2,-1],[2,3]]]}' | python3.11 -m arrangement build
echo '{"segments": [[[0,0],[1,1]]]}'                 | python3.11 -m arrangement verify
echo '{"segments": [...], "ops": [{"delete": [2]}]}' | python3.11 -m arrangement roundtrip
```

输出包含顶点、边（稳定 id + 来源集合）、面（含外部面标记与面积）、
交点列表与核验报告；`roundtrip` 额外执行保存/恢复一致性检查。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

测试覆盖：精确谓词（含超出 float64 分辨率的角度序）、T 形连接、
十字多点共点、重叠链、嵌套闭环、删除分割面的边、零长度点段、
保存恢复、增量 id 稳定性与失败回滚；并以逐对精确求交 + 全量
重建的独立 oracle（`tests/oracle.py`）对照扫描线结果（含随机用例）。

## 布局

- `arrangement/geometry.py` — 精确数与谓词（orient、line_key、angle_cmp…）
- `arrangement/sweep.py` — 原子段分解、扫描线求交、切分
- `arrangement/dcel.py` — 半边结构、角度缝合、面提取、连通分量
- `arrangement/arrangement.py` — 增量 `Arrangement`（事务、稳定 id）
- `arrangement/verify.py` — 独立核验
- `arrangement/serialize.py` — JSON 保存/恢复
- `arrangement/__main__.py` — JSON CLI
- `tests/` — unittest 套件与 brute-force oracle
