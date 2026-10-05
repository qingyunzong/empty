#include "rational_resampler.hpp"

#include <numeric>
#include <stdexcept>

namespace audiolib {

std::int64_t round_half_even_div(std::int64_t numerator, std::int64_t divisor) {
    if (divisor <= 0) throw std::invalid_argument("divisor must be positive");
    std::int64_t q = numerator / divisor;  // 向零截断
    std::int64_t r = numerator % divisor;  // 符号与 numerator 一致
    std::int64_t twice = 2 * (r >= 0 ? r : -r);
    if (twice > divisor || (twice == divisor && (q & 1))) {
        q += (numerator >= 0) ? 1 : -1;
    }
    return q;
}

std::int16_t saturate_int16(std::int64_t value) {
    if (value > INT16_MAX) return INT16_MAX;
    if (value < INT16_MIN) return INT16_MIN;
    return static_cast<std::int16_t>(value);
}

RationalResampler::RationalResampler(std::int64_t up, std::int64_t down,
                                     std::vector<std::int32_t> coeffs,
                                     std::int64_t scale)
    : up_(up), down_(down), scale_(scale), coeffs_(std::move(coeffs)) {
    if (up_ <= 0 || down_ <= 0) throw std::invalid_argument("up/down must be positive");
    if (scale_ <= 0) throw std::invalid_argument("scale must be positive");
    if (coeffs_.empty()) throw std::invalid_argument("coeffs must be non-empty");
    const std::int64_t g = std::gcd(up_, down_);
    up_ /= g;
    down_ /= g;
    max_phase_taps_ = (static_cast<std::int64_t>(coeffs_.size()) + up_ - 1) / up_;
}

std::int64_t RationalResampler::total_outputs(std::int64_t n_in,
                                              std::int64_t zero_tail,
                                              std::int64_t up,
                                              std::int64_t down) {
    const std::int64_t num = (n_in + zero_tail) * up;
    return (num + down - 1) / down;  // ceil，要求 num >= 0
}

void RationalResampler::emit_ready() {
    // 输出 m 可确定当且仅当 m*down < in_count_*up（中心样本 c 已就绪）。
    while (out_count_ * down_ < in_count_ * up_) {
        const std::int64_t t = out_count_ * down_;
        const std::int64_t p = t % up_;
        const std::int64_t c = t / up_;
        std::int64_t acc = 0;
        for (std::int64_t k = 0;; ++k) {
            const std::int64_t j = p + k * up_;
            if (j >= static_cast<std::int64_t>(coeffs_.size())) break;
            const std::int64_t idx = c - k;
            std::int16_t x = 0;  // 头部与填尾区域隐式为零
            if (idx >= base_ && idx < in_count_ &&
                idx < base_ + static_cast<std::int64_t>(hist_.size())) {
                x = hist_[static_cast<std::size_t>(idx - base_)];
            }
            acc += static_cast<std::int64_t>(coeffs_[static_cast<std::size_t>(j)]) * x;
        }
        last_out_.push_back(saturate_int16(round_half_even_div(acc, scale_)));
        ++out_count_;
        // 剪枝：小于 c - max_phase_taps_ + 1 的样本之后不再被任何输出使用。
        const std::int64_t keep_from = c - max_phase_taps_ + 1;
        while (base_ < keep_from && !hist_.empty()) {
            hist_.pop_front();
            ++base_;
        }
    }
}

std::vector<std::int16_t> RationalResampler::process(const std::int16_t* data,
                                                     std::size_t count) {
    if (flushed_) throw std::logic_error("process after flush");
    for (std::size_t i = 0; i < count; ++i) hist_.push_back(data[i]);
    in_count_ += static_cast<std::int64_t>(count);
    last_out_.clear();
    emit_ready();
    return last_out_;
}

std::vector<std::int16_t> RationalResampler::process(
    const std::vector<std::int16_t>& block) {
    return process(block.data(), block.size());
}

std::vector<std::int16_t> RationalResampler::flush(std::size_t zero_tail) {
    if (flushed_) throw std::logic_error("flush called twice");
    flushed_ = true;
    // 填尾零：只推进输入计数，历史缓冲区中隐式为零。
    in_count_ += static_cast<std::int64_t>(zero_tail);
    last_out_.clear();
    emit_ready();
    return last_out_;
}

}  // namespace audiolib
