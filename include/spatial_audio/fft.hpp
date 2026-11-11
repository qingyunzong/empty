#pragma once

#include <complex>
#include <cstddef>
#include <vector>

namespace spatial_audio {

using Complex = std::complex<double>;

// Self-contained radix-2 complex FFT.
//
// The transform length must be a power of two. The plan precomputes the
// bit-reversal permutation and all twiddle factors so that repeated streaming
// transforms only pay the butterfly arithmetic. No third-party FFT library is
// used anywhere in this component.
class FftPlan {
public:
    explicit FftPlan(std::size_t size);

    std::size_t size() const noexcept { return size_; }
    int log2Size() const noexcept { return log2_size_; }

    // In-place forward (negative-sign) DFT. Throws std::invalid_argument when
    // the buffer does not match the plan length.
    void forward(std::vector<Complex>& data) const;

    // In-place inverse (positive-sign) DFT with 1/N normalization.
    void inverse(std::vector<Complex>& data) const;

private:
    void execute(std::vector<Complex>& data, double sign) const;

    std::size_t size_;
    int log2_size_;
    std::vector<std::size_t> reversal_;
    // twiddle_[stage] holds the roots of unity used by that butterfly stage
    std::vector<std::vector<Complex>> twiddle_;
};

} // namespace spatial_audio
