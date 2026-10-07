# exact_stats

C++20 header-only 统计库：区间加整数、精确均值/方差查询，全程任意精度
有理数运算，不使用任何浮点（包括浮点平方差）。

## 组件

- `exact_stats/bigint.hpp` — 任意精度有符号整数（加减乘除、gcd、十进制解析/输出）
- `exact_stats/rational.hpp` — 自动约分的精确有理数
- `exact_stats/stats_array.hpp` — 统计数组

## 特性

- `range_add(l, r, delta)`：区间 [l, r) 加任意精度整数
- `mean(l, r)` / `variance(l, r)`：返回 `Rational`，方差按
  `(n·Σx² − (Σx)²) / n²` 精确计算（总体方差）
- 值与计数均可超 64 位；`mean_of` / `variance_of` 静态接口接受
  `BigInt` 计数，可用于跨分片合并的超大规模计数
- `snapshot()`：O(1) 写时复制快照，各分支修改互不影响

## 示例

```cpp
#include "exact_stats/stats_array.hpp"
using namespace exact_stats;

StatsArray a = StatsArray::from_values({BigInt(1), BigInt(2), BigInt(3), BigInt(4)});
StatsArray snap = a.snapshot();      // 独立分支
a.range_add(1, 3, BigInt::from_decimal("100000000000000000000"));
a.mean();      // Rational，精确
a.variance();  // (n·Σx² − (Σx)²) / n²，无浮点
```

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

测试包含：BigInt/Rational 单元测试、小数组随机操作对照模型按
Σx/Σx² 重算核验、快照分支隔离、超 64 位数值与计数。
