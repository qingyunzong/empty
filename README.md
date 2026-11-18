推理运行时需要可嵌入的C++20量化组件，按对称与非对称方式计算缩放与零点并编码张量，处理逐通道与裁剪。缩放由实际极值精确确定，裁剪值与零点在公开整数界内，解码往返误差有界且确定。用小张量穷举校准方案，对照朴素高精度计算核对每值编码与误差，通道切换与裁剪交错时不越界。

## 用法

头文件库，直接包含 `include/dlks_formal.hpp`（C++20）：

```cpp
#include "dlks_formal.hpp"
using namespace dlks_formal;

// 逐张量：由实际极值校准（非对称自动把零点纳入公开整数界）
auto qz = make_quantizer<std::int8_t>(quant_mode::asymmetric, -2.0, 3.0);
std::int8_t q = qz.encode(1.25);   // 裁剪到 [-2, 3] 后编码
double x = qz.decode(q);           // |x - 1.25| <= qz.error_bound()

// 带裁剪窗口（与观测范围求交，不会越界）
auto qc = make_quantizer<std::int8_t>(quant_mode::symmetric, -4.0, 4.0, -2.0, 2.0);

// 逐通道（channel-major）校准与编码
std::vector<double> tensor = /* C * N */;
auto quants = calibrate_per_channel<std::int8_t>(tensor, C, N, quant_mode::asymmetric);
auto enc = encode_per_channel<std::int8_t>(tensor, quants, N);
```

对称模式要求有符号整数类型（`static_assert` 保证）；非对称模式对任意整数类型可用。

## 测试

```sh
cmake -S . -B build && cmake --build build && ctest --test-dir build
```

`tests/test_quant.cpp` 在小张量上穷举校准方案（含裁剪窗口与逐通道交错），
逐值对照朴素参考编码，并用高精度（long double）核对解码往返误差界。
