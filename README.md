# units — 精确有理数单位换算库 (C++20)

头文件库：`include/units/units.hpp`，仅依赖标准库。

## 模型

- `Rational`：精确分数，构造时按 gcd 约分，分母恒正；零分母抛 `std::domain_error`，
  运算用 `__int128` 中间值并检查溢出（`std::overflow_error`）。
- `Dims`：7 维 SI 指数向量 (L, M, T, I, Θ, N, J)，每个指数限制在 ±16，
  越界抛 `std::overflow_error`。
- `Quantity`：基准单位下的精确量值 + 量纲。加减要求量纲完全一致
  （否则 `std::invalid_argument`），乘除对量纲向量做加减，幂做标量乘。

## 表达式语法

```
expr    := term (('+' | '-') term)*
term    := factor (('*' | '/') factor)*
factor  := primary ('^' 有符号整数)?     // 指数范围 ±16
primary := '(' expr ')' | '-' primary | 整数 | 单位标识符
```

内置单位：`m km cm mm`、`kg g`、`s min h`、`A K mol cd`、`Hz N Pa J W L`。

## 示例

```cpp
#include <units/units.hpp>
using namespace units;

Quantity q = parse("2*km + 300*m");      // 2300 m
Rational v = convert(q, "km");           // 23/10
Quantity e = parse("kg*(m/s)^2");        // 量纲 L^2 M T^-2
convert(parse("90*min"), "h");           // 3/2
```

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试（`tests/test_units.cpp`）包含一个有理数/量纲/解析/拒绝规则的直接测试，
以及一个独立的“符号代数小模型”：随机生成表达式 AST，用模型求值并渲染成字符串，
再用库解析，要求两边结果一致或同时拒绝（4000 个用例，固定种子）。
