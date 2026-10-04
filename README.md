# curvelib — 2D 折线段精确求交库

C++20 标准库实现（仅头文件），处理二维折线段的精确求交：

- **点交**：交点以有理数（`Rational`，最简分数）精确表示；同一交点去重，
  并保留经过该点的所有来源边 id。
- **共线重叠段**：返回极大共享子段（端点恰为输入整数端点），保留来源边对。
- **增量更新**：`addEdges` 批更新只检查涉及新边的边对；
  `recomputeAll()` 全量重建，二者结果必然一致（有测试保证）。
- **精确证书**：`certifyAll` 用纯有理数运算验证每个报告点落在其全部来源
  边上（严格模式下来源集合恰好完备），每个重叠段端点落在两条来源边上、
  两边共线且端点极大。
- 支持退化（零长度）边；所有比较均为精确运算，中间量使用 `__int128`。

## 结构

- `include/curvelib/rational.hpp` — 精确有理数（int64 存储，`__int128` 中间量）
- `include/curvelib/geometry.hpp` — 线段对求交（点交 / 共线重叠 / 无交）
- `include/curvelib/curve_library.hpp` — 增量曲线库（去重 + 来源边）
- `include/curvelib/certificate.hpp` — 精确证书检查
- `tests/` — CTest 测试（含小坐标枚举验收，参考实现独立推导）

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

实际测试结果见 [RESULTS.md](RESULTS.md)。
