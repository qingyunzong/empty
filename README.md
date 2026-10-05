# intmesh

整数三角网格库（C++20，仅标准库）。

## 功能

- **整数顶点与三角形**：顶点为 `Vec3i`（`int64_t` 三分量），三角形为三个顶点索引。
- **诊断**
  - `duplicateEdges()`：报告非流形边（出现次数 > 2）以及同向重复半边（绕向不一致）。
  - `zeroAreaFaces()`：整数叉积恰为 `(0,0,0)` 的面（退化重复索引或共线顶点）。
- **面组聚合法线**：`faceNormal(i)` 为未归一化的整数叉积；`vertexNormal(v)` 为相邻面法线的整数求和，全程精确、无浮点。
- **点移动增量更新**：`moveVertex(v, delta)` 只重算与 `v` 相邻的面法线及受影响顶点的聚合法线。
- **旧快照寿命安全**：`snapshot()` 返回深拷贝的 `MeshSnapshot`，源网格修改或销毁后仍有效。
- **独立全网格重算核对**：`verifyNormals()` 从零全量重算所有法线并与增量维护的状态逐一比较；`computeNormals()` 可独立调用做交叉核对。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 布局

- `include/mesh/mesh.hpp` — 公共 API
- `src/mesh.cpp` — 实现
- `tests/mesh_tests.cpp` — CTest 用例（重复边 / 零面积 / 法线聚合 / 增量移动 / 快照寿命）
