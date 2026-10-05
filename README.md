# rational_resampler

C++20 有理采样率重采样库：多相 FIR、整数定点、跨块相位连续。

## 语义定义

输出样本 `m`（全局从 0 计）：

```
t = m * down          有理时刻（单位 1/up 输入样本）
p = t % up            多相相位
c = t / up            输入中心索引（向下取整）
y[m] = sat_int16( round_half_even( sum_k h[p + k*up] * x[c-k] / scale ) )
```

- `x[i] = 0`（`i < 0` 或 `i >= N + zero_tail`），头部与填尾隐式为零；
- 总输出数 `= ceil((N + zero_tail) * up / down)`；
- 状态仅依赖全局输入/输出索引，因此任意切块与一次性输入逐样本一致；
- 舍入为半偶舍入（round-half-to-even），输出饱和到 `int16_t`。

## 用法

```cpp
#include "rational_resampler.hpp"
audiolib::RationalResampler r(/*up=*/3, /*down=*/2, coeffs, /*scale=*/32768);
auto out1 = r.process(block1);          // 任意切块
auto out2 = r.process(block2);
auto tail = r.flush(/*zero_tail=*/4);   // 结束：仅按指定零点数填尾
```

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
cd build && ctest --output-on-failure
```

测试用例：`rounding`（半偶舍入）、`saturation`（饱和）、`identity_delay`
（恒等与整数延迟）、`chunked_vs_oneshot`（7 种比率/滤波器 × 8 种随机切块，
逐样本对照暴力参考实现）、`zero_tail`（零填尾语义与输出数闭式）、
`dc`（直流保持）。实际结果见 `TEST_RESULTS.md`。
