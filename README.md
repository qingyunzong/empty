# 空间音频流式分区卷积组件

一个无第三方依赖的 C++20 流式线性卷积库。复数 FFT 为自行实现的迭代
基-2 Cooley–Tukey 算法，卷积采用**均匀分区重叠相加（UPOLS）**，支持比
输入块长得多的脉冲响应，以及运行中在精确样点边界切换滤波器。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试可执行文件 `build/test_streaming_convolver` 会逐条打印每个用例的
实测最大绝对误差与声明误差界。

## 公开接口

```cpp
#include "spatial_audio/streaming_convolver.hpp"
using spatial_audio::StreamingConvolver;

StreamingConvolver conv(/*partition P*/ 64, /*max response*/ 4096);
conv.set_initial_response(ir);                 // 首次推流前必须设置
conv.push(any_size_block);                     // 块大小任意，空块为空操作
conv.switch_response(new_ir, switch_sample);   // 在绝对样点处切换
conv.finish();                                 // 排空滤波器尾
std::vector<double> out;
std::size_t n = conv.pull(out, 256);           // n==0 表示暂无数据（背压）
```

## 算法与正确性要点

### 线性卷积，绝不退化为循环卷积

- 分区长度 `P` 必须为正的二次幂；FFT 长度固定为 `2P`。
- 每个输入分区（`P` 点）与每个响应分区（`P` 点）的线性卷积长度为
  `2P-1 < 2P`，在 `2P` 点 DFT 内严格无环绕。
- 频域逐分区相乘后 IFFT，再按分区偏移在时域**重叠相加**，并维护一个
  `P` 点 overlap 缓冲承接上一块 `D_{b-1}` 的后半段。这正是标准 UPOLS，
  整体等价于完整的线性卷积。

### 流控与输出长度

- `push` 接受任意长度（含 0），内部累积成 `P` 点处理块。
- `pull` 从输出 FIFO 取数；返回 0 表示当前无数据，调用方可稍后重试，
  天然支持消费端背压，输入不会丢失。
- `finish` 后排空滤波器尾，**总输出恰为 `N + M - 1`**（`N` 为输入
  总样点，`M` 为最后启用响应的长度）；空输入输出为空。

### 样点级滤波器切换与历史热启动

- `switch_response(ir, s)` 调度：输出样点 `n < s` 用旧滤波器，
  `n >= s` 用新滤波器，边界精确到单个样点，不要求落在分区边界。
- 新响应不得超过构造时给出的最大长度，否则抛出 `std::invalid_argument`。
- 每个响应是一条独立 lane。新 lane 首次在块 `b` 输出时，用**保留下来的
  历史输入频谱**做热启动：其初始 overlap 取
  `D_{b-1} = IFFT(Σ_q X_{b-1-q}·H_q)` 的后半段（包含 `q=0` 主项），
  因此切换瞬间新滤波器能立即用到所需的全部历史输入，而不是从零重置。
- 历史频谱保存在深度 `K_max + 1` 的环形缓冲中，`K_max` 为最长响应的
  分区数，足以覆盖任意合法新滤波器的热启动回溯范围。
- 块内切换时，同一处理块分别计算相关 lane，再按样点偏移拼接，保证
  splice 两侧各自是对应滤波器的完整线性卷积。
- `finish` 时以最后生效的响应长度决定尾部长度与排空块数。

## 数值误差界

头文件声明单位幅度工作负载的绝对误差界：

```cpp
constexpr double kUnitAmplitudeErrorBound = 1e-9;
double kScaledErrorBound(double amplitude, std::size_t max_response_length);
```

误差随信号幅度与响应长度线性缩放，测试断言
`max|实测 - 时域参考| <= kScaledErrorBound(...)`。双精度下实测误差通常
在 `1e-16 ~ 1e-14` 量级，远低于声明界。

## 测试覆盖

测试以**直接 O(NM) 时域分段卷积**为参考，覆盖：

- 自定义 FFT 对照朴素 DFT 及正反变换往返误差；
- 空输入、基础线性卷积（多种分区长度）、单位冲激/δ 响应；
- 长于输入、跨多分区的长尾响应；
- 精确分区边界切换、块内多次切换（含需要历史的新滤波器）、流末尾切换；
- 消费暂停与背压、零长度推送/拉取；
- 参数非法时的异常路径；
- 40 组随机分区/长度/切换点模糊测试，逐点比对并断言误差界。
