#pragma once

#include <array>
#include <stdexcept>
#include <string>

namespace units {

// Exponent vector over the 7 SI base dimensions
// (L, M, T, I, Theta, N, J). Two quantities are compatible (e.g. may be
// added) iff their vectors are equal. Every exponent must stay within
// [-kMaxExponent, kMaxExponent]; violations throw std::overflow_error.
struct Dimension {
    static constexpr int kMaxExponent = 16;
    static constexpr std::size_t kRank = 7;

    std::array<int, kRank> e{};

    static Dimension base(std::size_t index) {
        Dimension d;
        d.e.at(index) = 1;
        return d;
    }

    bool operator==(const Dimension& o) const { return e == o.e; }
    bool operator!=(const Dimension& o) const { return e != o.e; }

    Dimension operator+(const Dimension& o) const {
        Dimension r;
        for (std::size_t i = 0; i < kRank; ++i) r.e[i] = checked(e[i] + o.e[i]);
        return r;
    }

    Dimension operator-(const Dimension& o) const {
        Dimension r;
        for (std::size_t i = 0; i < kRank; ++i) r.e[i] = checked(e[i] - o.e[i]);
        return r;
    }

    Dimension scaled(int k) const {
        Dimension r;
        for (std::size_t i = 0; i < kRank; ++i) r.e[i] = checked(e[i] * k);
        return r;
    }

    bool is_dimensionless() const {
        for (int v : e)
            if (v != 0) return false;
        return true;
    }

    std::string to_string() const {
        static const char* names[kRank] = {"L", "M", "T", "I", "Th", "N", "J"};
        std::string out;
        for (std::size_t i = 0; i < kRank; ++i) {
            if (e[i] == 0) continue;
            if (!out.empty()) out += " ";
            out += names[i];
            if (e[i] != 1) out += "^" + std::to_string(e[i]);
        }
        return out.empty() ? std::string("1") : out;
    }

private:
    static int checked(int v) {
        if (v < -kMaxExponent || v > kMaxExponent)
            throw std::overflow_error("dimension exponent out of range (+/-" +
                                      std::to_string(kMaxExponent) + ")");
        return v;
    }
};

} // namespace units
