#include "spatial_audio/fft.hpp"

#include <cmath>
#include <stdexcept>
#include <utility>

namespace spatial_audio {

namespace {

int log2Exact(std::size_t value) {
    if (value == 0 || (value & (value - 1)) != 0) {
        throw std::invalid_argument("FFT size must be a positive power of two");
    }
    int exponent = 0;
    while (std::size_t(1) << exponent < value) {
        ++exponent;
    }
    return exponent;
}

} // namespace

FftPlan::FftPlan(std::size_t size)
    : size_(size),
      log2_size_(log2Exact(size)),
      reversal_(size),
      twiddle_(log2_size_) {
    for (std::size_t index = 0; index < size_; ++index) {
        std::size_t reversed = 0;
        for (int bit = 0; bit < log2_size_; ++bit) {
            if (index & (std::size_t(1) << bit)) {
                reversed |= std::size_t(1) << (log2_size_ - 1 - bit);
            }
        }
        reversal_[index] = reversed;
    }

    constexpr double kPi = 3.141592653589793238462643383279502884;
    for (int stage = 0; stage < log2_size_; ++stage) {
        const std::size_t half = std::size_t(1) << stage;
        twiddle_[stage].resize(half);
        for (std::size_t j = 0; j < half; ++j) {
            const double angle = -2.0 * kPi * static_cast<double>(j)
                                 / static_cast<double>(2 * half);
            twiddle_[stage][j] = Complex(std::cos(angle), std::sin(angle));
        }
    }
}

void FftPlan::forward(std::vector<Complex>& data) const {
    if (data.size() != size_) {
        throw std::invalid_argument("FFT input buffer has wrong length");
    }
    execute(data, -1.0);
}

void FftPlan::inverse(std::vector<Complex>& data) const {
    if (data.size() != size_) {
        throw std::invalid_argument("FFT input buffer has wrong length");
    }
    execute(data, 1.0);
    const double normalization = 1.0 / static_cast<double>(size_);
    for (Complex& sample : data) {
        sample *= normalization;
    }
}

void FftPlan::execute(std::vector<Complex>& data, double sign) const {
    for (std::size_t index = 0; index < size_; ++index) {
        const std::size_t reversed = reversal_[index];
        if (index < reversed) {
            std::swap(data[index], data[reversed]);
        }
    }

    for (int stage = 0; stage < log2_size_; ++stage) {
        const std::size_t half = std::size_t(1) << stage;
        const std::size_t span = 2 * half;
        const std::vector<Complex>& roots = twiddle_[stage];
        for (std::size_t base = 0; base < size_; base += span) {
            for (std::size_t j = 0; j < half; ++j) {
                Complex root = roots[j];
                if (sign > 0.0) {
                    root = Complex(root.real(), -root.imag());
                }
                const Complex even = data[base + j];
                const Complex odd = data[base + j + half] * root;
                data[base + j] = even + odd;
                data[base + j + half] = even - odd;
            }
        }
    }
}

} // namespace spatial_audio
