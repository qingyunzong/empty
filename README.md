# audio_resample:有理采样率流式重采样库

C++20 标准库实现的有理采样率(L/M)音频重采样器,固定整数 FIR 系数、多相结构。

## 设计要点

- **多相 FIR**:系数 `h[0..N-1]`(约定 `y = sum_i h[i] * x[n-i]`)分解为 L 个分支,
  分支 `p` 使用 `h[p + k*L]`。长度不足 L 的整数倍时尾部补零系数。
- **跨块相位保持**:`phase_`(多相分支)与 `idx_`(绝对输入下标)为内部状态,
  每个输出后 `phase += M; idx += phase / L; phase %= L`。状态与切块方式无关,
  因此任意切块与一次性输入产生**逐样本完全一致**的输出与相同的总延迟。
- **半偶舍入 + 饱和**:定点累加值除以 `scale` 时按 round-half-to-even 取整
  (0.5→0, 1.5→2, 2.5→2,负数对称),再饱和到 `int16_t`。
- **仅按指定零填尾**:起始不隐含补零(等窗口被真实输入填满才开始输出);
  结束时仅 `finish(zeroPad)` 恰好补 `zeroPad` 个零并排空,此外无任何隐含补零。
- **输出样本数闭式**:总可用输入 `T`(含补零)时输出数为
  `floor(((T - taps) * L - 1) / M) + 1`(其中 `taps = ceil(N/L)`,`T > taps - 1`)。

## API 摘要

```cpp
#include "audio_resample/resampler.hpp"
using namespace audio_resample;

Resampler r(/*up=*/3, /*down=*/2, coeffs /*int32 定点*/, /*scale=*/1 << 15);
std::vector<int16_t> out;
r.process(block, out);   // 任意大小块,可多次调用
r.finish(zeroPad, out);  // 恰好补 zeroPad 个零并排空,之后流关闭
```

`quantizeHalfEven(acc, scale)` 独立暴露,便于直接测试舍入与饱和。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

测试用例(每个对应一个 CTest 项):

| 测试 | 内容 |
| --- | --- |
| `quantize` | 半偶舍入 18 例(含负数、恰半、饱和边界) |
| `identity` | L=M=1、单抽头时输出逐样本等于输入 |
| `chunk_invariance` | 7 种采样率比 × 7 种切块大小,与一次性输入及独立参考实现逐样本一致,输出数符合闭式 |
| `zero_tail` | 不同 `zeroPad` 的前缀性质;与参考实现一致;手动补零等价 |
| `impulse_delay` | 线性相位 FIR 冲激响应峰值位置/幅度跨切块一致且符合理论值 |
| `saturation` | 超界输出饱和到 32767 / -32768 |
| `guards` | finish 后 process、重复 finish、非法参数均抛异常 |

实际运行结果见 [TEST_RESULTS.md](TEST_RESULTS.md)。
