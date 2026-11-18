# dlks_formal

可嵌入的 C++20 游程压缩位图索引，单头文件实现，无第三方依赖。

## 语义

- `BitmapIndex(universe_size)` 创建固定全集上的空位图。
- 游程统一规范化为有序、互不重叠、互不相邻的半开区间 `[begin, end)`。
- `&`、`|`、`-`（AND-NOT）、`^` 要求两个位图具有相同全集大小。
- `~` 只在当前位图的全集 `[0, universe_size())` 内取反，结果全集不变。
- `count()` / `cardinality()` 始终等于 `to_bits()` 中 `true` 的数量。
- 空集、空全集和满集均为一等输入；修改操作与位运算可以任意交错。

## 使用

```cpp
#include <dlks_formal.hpp>

dlks_formal::BitmapIndex left({true, false, true, true, false});
dlks_formal::BitmapIndex right({false, true, true, false, false});

auto intersection = left & right;   // {2}
auto union_set = left | right;      // {0, 1, 2, 3}
auto difference = left - right;     // {0, 3}
auto complement = ~left;            // {1, 4}

auto count = union_set.cardinality();  // 4
```

也提供 `from_bits`、`from_indices`、`from_runs`、`full`、`test`、`contains`、
`set_range`、`reset_range`、`flip_range` 和 `runs()`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试对全集大小 0 到 6 的所有位图两两执行 AND、OR、NOT、AND-NOT 与 XOR，
对小域三元谓词组合检查恒等式，并用确定性交错序列将压缩位图与朴素布尔数组
逐位核对。
