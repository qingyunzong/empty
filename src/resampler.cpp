#include "audio_resample/resampler.hpp"

#include <stdexcept>

namespace audio_resample {

std::int16_t quantizeHalfEven(std::int64_t acc, std::int64_t scale) {
    const bool neg = acc < 0;
    const std::uint64_t a = neg ? static_cast<std::uint64_t>(-(acc + 1)) + 1u
                                : static_cast<std::uint64_t>(acc);
    const std::uint64_t s = static_cast<std::uint64_t>(scale);
    std::uint64_t q = a / s;
    const std::uint64_t r = a % s;
    // 半偶舍入:余数超过一半进位;恰好一半时向偶数进位。
    if (2 * r > s || (2 * r == s && (q & 1u))) {
        ++q;
    }
    const std::int64_t v = neg ? -static_cast<std::int64_t>(q)
                               : static_cast<std::int64_t>(q);
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return static_cast<std::int16_t>(v);
}

Resampler::Resampler(int up, int down, std::vector<std::int32_t> coeffs, std::int64_t scale)
    : up_(up), down_(down), scale_(scale), coeffs_(std::move(coeffs)) {
    if (up_ < 1 || down_ < 1) {
        throw std::invalid_argument("up/down must be >= 1");
    }
    if (scale_ <= 0) {
        throw std::invalid_argument("scale must be positive");
    }
    if (coeffs_.empty()) {
        throw std::invalid_argument("coeffs must be non-empty");
    }
    taps_ = static_cast<int>((coeffs_.size() + static_cast<std::size_t>(up_) - 1) /
                             static_cast<std::size_t>(up_));
    coeffs_.resize(static_cast<std::size_t>(taps_) * static_cast<std::size_t>(up_), 0);
    idx_ = taps_ - 1; // 起始时不隐含补零:等窗口被真实输入填满才开始输出
}

std::size_t Resampler::process(std::span<const std::int16_t> in, std::vector<std::int16_t>& out) {
    if (finished_) {
        throw std::logic_error("process() after finish()");
    }
    for (std::int16_t s : in) {
        hist_.push_back(s);
    }
    inputCount_ += static_cast<std::int64_t>(in.size());
    return drain(out);
}

std::size_t Resampler::finish(std::size_t zeroPad, std::vector<std::int16_t>& out) {
    if (finished_) {
        throw std::logic_error("finish() called twice");
    }
    for (std::size_t i = 0; i < zeroPad; ++i) {
        hist_.push_back(0);
    }
    zeroPadCount_ += static_cast<std::int64_t>(zeroPad);
    const std::size_t produced = drain(out);
    finished_ = true;
    return produced;
}

std::size_t Resampler::drain(std::vector<std::int16_t>& out) {
    std::size_t produced = 0;
    for (;;) {
        const std::int64_t newest = base_ + static_cast<std::int64_t>(hist_.size()) - 1;
        if (idx_ > newest) {
            break;
        }
        const std::size_t off = static_cast<std::size_t>(idx_ - base_);
        std::int64_t acc = 0;
        for (int k = 0; k < taps_; ++k) {
            acc += static_cast<std::int64_t>(coeffs_[static_cast<std::size_t>(phase_) +
                                                     static_cast<std::size_t>(k) *
                                                         static_cast<std::size_t>(up_)]) *
                   hist_[off - static_cast<std::size_t>(k)];
        }
        out.push_back(quantizeHalfEven(acc, scale_));
        ++outputCount_;
        ++produced;
        // 相位累计:每输出一个样本,输入位置前进 down/up(向下取整分解)。
        phase_ += down_;
        idx_ += phase_ / up_;
        phase_ %= up_;
        // 丢弃不再需要的旧样本。
        const std::int64_t keepFrom = idx_ - taps_ + 1;
        while (base_ < keepFrom) {
            hist_.pop_front();
            ++base_;
        }
    }
    return produced;
}

} // namespace audio_resample
