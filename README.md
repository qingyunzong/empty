# statlib

区间统计库（C++20）：支持区间加整数、查询任意区间的均值与方差，结果全部为
精确有理数，全程无浮点运算。

## 特性

- **区间加**：`add(l, r, v)` 给 `[l, r)` 每个元素加任意精度整数 `v`
- **精确查询**：`sum` / `sumsq` 返回大整数；`mean` / `variance` 返回最简有理数
  （方差按定义 `E[x²] − E[x]²` 用有理数精确计算，不做浮点平方差）
- **任意精度**：自带 `BigInt`（无第三方依赖），值与计数可远超 64 位
- **快照分支**：`fork()` O(1) 复制快照；底层为持久化（路径拷贝）懒标记线段树，
  节点不可变、分支间共享，任何分支的修改都不会污染其他分支
- **核验**：测试用小数组朴素模型按 `Σx`、`Σx²` 重算，与线段树逐项对照

## 结构

- `include/statlib/bigint.hpp` — 任意精度有符号整数（加减乘除、移位、gcd、十进制转换）
- `include/statlib/rational.hpp` — 精确有理数（自动约分、分母恒正）
- `include/statlib/stats_tree.hpp` — 持久化懒标记线段树，维护 `Σx` 与 `Σx²`

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

三个 CTest 可执行测试：`bigint`（大整数运算）、`rational`（有理数）、
`stats`（区间加/查询、快照隔离、超 64 位值、随机小数组对拍）。

## 示例

```cpp
#include "statlib/stats_tree.hpp"
using namespace statlib;

StatsTree t({BigInt(1), BigInt(2), BigInt(4)});
t.add(1, 3, BigInt(3));                 // [1, 5, 7]
Rational m = t.mean(0, 3);              // 13/3
Rational v = t.variance(0, 3);          // 56/9

StatsTree branch = t.fork();            // 快照分支
branch.add(0, 3, BigInt::pow2(100));    // 不影响 t
```
