# spatial_aabb

整数 AABB 空间库（C++20，仅标准库）。

## 特性

- **整数 AABB 树**：`Snapshot` 构建平衡二叉 AABB 树（最长轴中位切分，叶子容量 4）。
- **批量移动原子发布**：`SpatialDb::applyBatch` 在侧旁构建全新不可变快照，通过
  `std::atomic<std::shared_ptr<const Snapshot>>` 单次原子存储发布；读者持有的旧快照
  永久有效且内容不变。
- **精确有理数射线参数**：射线与 AABB 求交使用 slab 法，`t` 以 `__int128` 分子/分母
  精确表示，比较经交叉相乘，无浮点误差；`tEnter` 钳制到 `t >= 0`。
- **边界接触包含**：擦面、擦棱、单点接触（进入区间与退出区间恰好相接）均计为命中。
- **候选 + 实际命中**：`query` 返回宽相候选（命中叶子内全部对象，是命中的超集）与
  窄相精确命中（对每个候选做精确有理数测试）。
- **随机移动 + 全对象扫描核对**：测试在每批随机移动后，用暴力全扫描
  (`bruteForceHits`) 逐射线核对树的命中集合，并验证候选 ⊇ 命中。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

## 测试

| 测试 | 内容 |
|---|---|
| `rational` | 有理数比较精确性（含 2^100 级大数、符号归一化） |
| `ray_aabb` | 精确 t 值、擦面/擦棱/单点接触、零方向分量、盒在射线后方、原点在内、退化射线、10^18 级坐标 |
| `tree_vs_scan` | 300 对象 × 40 批随机移动 × 60 随机射线，树命中 == 全扫描，候选 ⊇ 命中 |
| `snapshot` | 发布后旧快照候选/命中/对象完全不变，新快照整体反映整批移动 |
| `concurrency` | 1 写线程发布 150 批移动，4 读线程并发校验快照与全扫描一致 |

实际结果见 `TEST_RESULTS.md`。

## 文件

- `include/spatial/spatial.hpp` — 公开 API
- `src/spatial.cpp` — 实现
- `tests/` — CTest 测试与公共测试工具 `test_util.hpp`
