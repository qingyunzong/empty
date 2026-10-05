#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <span>
#include <vector>

namespace audio_resample {

// 将定点累加值 acc 除以 scale,按"半偶舍入"(round-half-to-even)取整,
// 并饱和到 int16_t 范围。scale 必须为正。
std::int16_t quantizeHalfEven(std::int64_t acc, std::int64_t scale);

// 有理采样率 L/M 的流式重采样器:
//   - 固定整数 FIR 系数(定点),按多相结构分解为 L 个分支;
//   - 相位与输入位置为内部绝对状态,跨 process() 块累计保持,
//     因此任意切块与一次性输入产生逐样本完全一致的输出;
//   - 每个输出样本经半偶舍入并饱和到 int16_t;
//   - 流结束时仅按 finish(zeroPad) 指定的个数补零并排空,此外不隐含任何补零。
//
// 系数约定:标准 FIR y = sum_i h[i] * x[n - i]。多相分支 p(0 <= p < L)
// 使用系数 h[p + k*L](k = 0..taps-1),与绝对输入位置 idx 对齐为
// h[p + k*L] * x[idx - k]。长度不足 L 的整数倍时在尾部补零系数。
class Resampler {
public:
    // up = L(内插因子), down = M(抽取因子), scale 为定点系数缩放。
    Resampler(int up, int down, std::vector<std::int32_t> coeffs, std::int64_t scale);

    // 处理一个输入块,把新产生的输出样本追加到 out,返回追加个数。
    // finish() 之后调用会抛 std::logic_error。
    std::size_t process(std::span<const std::int16_t> in, std::vector<std::int16_t>& out);

    // 结束输入流:恰好补 zeroPad 个零并排空所有可产生的输出,之后流关闭。
    std::size_t finish(std::size_t zeroPad, std::vector<std::int16_t>& out);

    bool finished() const { return finished_; }
    std::int64_t inputCount() const { return inputCount_; }     // 真实输入样本数(不含补零)
    std::int64_t zeroPadCount() const { return zeroPadCount_; } // finish 补零个数
    std::int64_t outputCount() const { return outputCount_; }   // 已产生输出样本数

    int up() const { return up_; }
    int down() const { return down_; }
    int tapsPerPhase() const { return taps_; }
    const std::vector<std::int32_t>& coeffs() const { return coeffs_; } // 补齐后的系数

private:
    std::size_t drain(std::vector<std::int16_t>& out);

    int up_;
    int down_;
    std::int64_t scale_;
    std::vector<std::int32_t> coeffs_; // 长度 = taps_ * up_
    int taps_;

    int phase_ = 0;        // 当前多相分支,0 <= phase_ < up_
    std::int64_t idx_;     // 下一输出所需最新输入样本的绝对下标
    std::deque<std::int16_t> hist_; // 输入历史(绝对下标 base_ 起)
    std::int64_t base_ = 0;

    bool finished_ = false;
    std::int64_t inputCount_ = 0;
    std::int64_t zeroPadCount_ = 0;
    std::int64_t outputCount_ = 0;
};

} // namespace audio_resample
