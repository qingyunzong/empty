# rect_union — 轴对齐整数矩形并集工具

按 ID 增删轴对齐整数矩形，实时查询并集的**面积**与**周长**：

- 矩形为半开区间 `[x1, x2) x [y1, y2)`，坐标自动规范化（允许角点乱序）。
- 零面积矩形（`x1 == x2` 或 `y1 == y2`）被忽略，`add` 返回 `false`。
- 重叠与贴边的矩形自动合并，内部边不计入周长（角对角接触不合并）。
- 坐标 ±10⁶，全程 `int64_t` 精确整数计算（面积最大 4×10¹²，无溢出）。

## 算法

扫描线 + 坐标压缩线段树。线段树在压缩后的 y 基本区间上维护覆盖计数、
覆盖长度、覆盖连通段数与左右边界标志：

- 面积 = 相邻事件 x 间距 × 当前覆盖长度，逐 slab 累加。
- 水平边 = 2 × 覆盖连通段数 × slab 宽度。
- 竖直边 = 每个事件 x 处覆盖集合的对称差长度；同一 x 的事件按
  "先进入 (+1) 后离开 (-1)" 排序，使覆盖长度先单调升至峰值再单调下降，
  竖直边 = (峰值 − 之前) + (峰值 − 之后)。

每次增删后整体重扫，复杂度 O(n log n)，查询 O(1)。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试（`tests/test_rect_union.cpp`）包含确定性用例（重叠、贴边、角接触、
嵌套、带孔框架、删除恢复、±10⁶ 大坐标）以及 300 轮 × 200 次随机增删，
每次变更后与短坐标栅格模型（逐单元格暴力计算面积/周长）比对。

## CLI

`rect_tool` 从标准输入读命令：

```
add <id> <x1> <y1> <x2> <y2>   -> OK | IGNORED（零面积）| EXISTS（ID 已存在）
remove <id>                    -> OK | NOT_FOUND
query                          -> "<area> <perimeter>"
count                          -> 当前矩形数
quit
```

## 库接口

见 `include/geom/rect_union.h`：`geom::RectUnion` 提供
`add / remove / contains / size / area / perimeter`。
