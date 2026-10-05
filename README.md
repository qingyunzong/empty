# spatial — 整数 AABB 空间库 (C++20)

仅依赖 C++20 标准库的头文件库，提供：

- **整数 AABB 树**：对象坐标为 `int64_t`，每次发布构建一棵不可变 BVH
  （按质心最长轴中位切分）。
- **批量移动原子发布**：`Space::move_batch` 在写锁内应用全部移动后，
  通过 `std::atomic<std::shared_ptr<const Snapshot>>` 一次原子替换发布；
  读者 `snapshot()` 原子加载，持有的旧快照在其生命周期内持续有效
  （RCU 风格，旧查询快照保留）。
- **精确有理数射线参数**：`ray_intersect` 用 slab 法在 `Rational{num,den}`
  上计算 `t_enter/t_exit`，比较用 `__int128` 交叉相乘，无浮点误差；
  边界接触（enter == exit 的擦边/擦角）判定为命中（包含边界）。
- **候选与命中分离**：`query_ray` 返回 `candidates`（宽相：内部节点精确
  测试后到达的叶子）与 `hits`（窄相：对候选包围盒逐一做精确有理测试，
  按 `(t_enter, id)` 排序）。

## 结构

- `include/spatial/rational.hpp` — 精确有理数与 128 位比较
- `include/spatial/aabb.hpp` — 整数 AABB、射线、精确 slab 求交
- `include/spatial/tree.hpp` — 不可变 `Snapshot`（BVH 查询 + 全对象扫描参考实现）
- `include/spatial/space.hpp` — `Space`：增删、批量移动、原子发布快照

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

## 测试（CTest）

- `test_rational` — 有理数规范化、比较、大数（>2^62）交叉相乘精确性
- `test_ray` — 精确 t 值（如 1/3、5/2）、面/棱/角接触包含、平行射线、
  t_max 裁剪、盒内起点
- `test_tree_scan` — 随机微分测试：50 轮 × 20 个随机批量移动，每轮 30 条
  随机射线，树查询结果与全对象扫描逐一比对（命中集合与 t 值完全一致、
  候选 ⊇ 命中、命中按 t 排序）
- `test_snapshot` — 批量移动原子可见；旧快照保留旧几何查询结果
- `test_concurrent` — 4 个读线程在写线程连续发布 300 轮批量移动期间，
  每个获取到的快照均自洽（树查询 == 该快照全扫描）

## 实际测试结果

环境：GCC 15.2.0，CMake 4.2.3，`-O3`（Release），编译零警告
（`-Wall -Wextra -Wpedantic`）。

```
$ ctest --output-on-failure
1/5 Test #1: test_rational ....................   Passed    0.00 sec
2/5 Test #2: test_ray .........................   Passed    0.01 sec
3/5 Test #3: test_tree_scan ...................   Passed    0.12 sec
4/5 Test #4: test_snapshot ....................   Passed    0.01 sec
5/5 Test #5: test_concurrent ..................   Passed    0.03 sec
100% tests passed, 0 tests failed out of 5
```

各测试输出：

```
test_rational: all checks passed
test_ray: all checks passed
random differential: rounds=50 rays=1500 total_candidates=47621 total_hits=21340
test_tree_scan: all checks passed
test_snapshot: all checks passed
concurrent: consistent_queries=3827 mismatches=0
test_concurrent: all checks passed
```

即：1500 条随机射线 × 50 轮随机移动下，树查询与全对象扫描的 21340 次
命中（含精确有理 t 值）完全一致；并发冒烟测试中 3827 次快照查询全部
自洽、0 次不一致。
