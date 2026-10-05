#pragma once

// 有理采样率重采样器（多相 FIR，整数定点实现）。
//
// 特性：
//  - 指定有理采样率比 up/down 与固定整数 FIR 系数；
//  - 跨块保持累计相位（输入/输出全局索引为唯一状态基准）；
//  - 输出采用“逐步半偶舍入”(round-half-to-even) 并饱和到 int16_t；
//  - 结束时仅按调用方指定的零点数填尾（flush(zero_tail)）；
//  - 任意切块输入与一次性输入产生逐样本完全一致的输出与延迟。
//
// 数学定义（输出样本 m，全局从 0 计）：
//   t = m * down            （以 1/up 个输入样本为单位的有理时刻）
//   p = t % up              （多相相位）
//   c = t / up              （输入中心索引，向下取整）
//   y[m] = sat( rne( sum_k h[p + k*up] * x[c - k] / scale ) )
// 其中 x[i] = 0（i < 0 或 i >= N + zero_tail），N 为实际输入样本数。
// 总输出样本数 = ceil((N + zero_tail) * up / down)。

#include <cstddef>
#include <cstdint>
#include <deque>
#include <vector>

namespace audiolib {

// 有符号整数除法的半偶舍入（round-half-to-even），divisor 必须为正。
std::int64_t round_half_even_div(std::int64_t numerator, std::int64_t divisor);

// 饱和到 int16_t。
std::int16_t saturate_int16(std::int64_t value);

class RationalResampler {
public:
    // up/down：有理采样率比（均须为正，构造时约分）。
    // coeffs：固定整数 FIR 系数（非空）。
    // scale：归一化除数（正数，例如系数之和或 2 的幂）。
    RationalResampler(std::int64_t up, std::int64_t down,
                      std::vector<std::int32_t> coeffs, std::int64_t scale);

    // 处理一块输入样本，返回本块产生的输出样本。
    std::vector<std::int16_t> process(const std::int16_t* data, std::size_t count);
    std::vector<std::int16_t> process(const std::vector<std::int16_t>& block);

    // 结束输入：按指定零点数 zero_tail 填尾，返回剩余全部输出。
    // 调用后对象不可再使用（除查询外）。
    std::vector<std::int16_t> flush(std::size_t zero_tail);

    // 查询：已消费输入样本数（不含填尾零）、已产生输出样本数。
    std::int64_t input_count() const { return in_count_; }
    std::int64_t output_count() const { return out_count_; }

    // 给定总输入 N 与填尾零点数 Z，总输出数的闭式：ceil((N+Z)*up/down)。
    static std::int64_t total_outputs(std::int64_t n_in, std::int64_t zero_tail,
                                      std::int64_t up, std::int64_t down);

    std::int64_t up() const { return up_; }
    std::int64_t down() const { return down_; }
    std::int64_t scale() const { return scale_; }
    const std::vector<std::int32_t>& coeffs() const { return coeffs_; }

private:
    void emit_ready();  // 依据当前 in_count_ 产生所有可确定的输出

    std::int64_t up_, down_, scale_;
    std::vector<std::int32_t> coeffs_;
    std::int64_t max_phase_taps_;  // ceil(coeffs.size() / up)

    std::deque<std::int16_t> hist_;  // x[base_ .. in_count_-1]
    std::int64_t base_ = 0;          // hist_ 队首对应的全局输入索引
    std::int64_t in_count_ = 0;      // 已接收输入（flush 后含填尾零）
    std::int64_t out_count_ = 0;     // 已产生输出
    bool flushed_ = false;
    std::vector<std::int16_t> last_out_;  // 最近一次 process/flush 的输出
};

}  // namespace audiolib
