# 无主键行指纹增量

遗留表同步需要可嵌入 C++ 多重集差分组件，对规范化整行生成强摘要并保留重复计数。新旧快照按摘要和原始值双重确认计算增删 multiplicity，hash 碰撞不能合并；大分区可外排，结果与内存计数模型一致。

## 组件说明

`dataeng` 静态库（C++20，头文件 `dataeng.hpp`）提供无主键表的多重集差分：

- **强摘要**：`StrongHasher` 对规范化整行计算 MurmurHash3 x64 128 位摘要（`Digest{hi, lo}`）。
- **双重确认**：行按 `(digest, row)` 排序与比较，摘要仅作预过滤，原始值精确比对，hash 碰撞不会合并不同行。
- **重复计数**：`MultisetCounter` 保留每个 distinct 行的 multiplicity；`DiffResult` 输出增删两侧净 multiplicity。
- **外排一致**：`diff_snapshots_external` 将快照溢写为有序运行文件（`ExternalOptions::spill_dir`，建议 `$TMPDIR`），多路归并后与内存模型共用同一段 merge-join 逻辑，结果逐字节一致。

## 用法

```cpp
#include "dataeng.hpp"

// 内存路径
auto diff = dataeng::diff_snapshots(old_rows.begin(), old_rows.end(),
                                    new_rows.begin(), new_rows.end());

// 大分区外排路径
dataeng::ExternalOptions opts;
opts.spill_dir = std::filesystem::temp_directory_path();  //  honoring $TMPDIR
opts.memory_budget_bytes = 64ull << 20;
auto diff2 = dataeng::diff_snapshots_external(
    old_rows.begin(), old_rows.end(), new_rows.begin(), new_rows.end(), opts);

for (const auto& rc : diff.inserts) { /* 新增行 rc.row，净增 rc.count 次 */ }
for (const auto& rc : diff.deletes) { /* 删除行 rc.row，净减 rc.count 次 */ }
```

两种路径的 `DiffResult` 均按 `(digest, row)` 排序，可直接 `==` 比较。摘要算法可通过模板参数替换（如测试中的 `ConstantHasher` 用于强制碰撞）。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```
