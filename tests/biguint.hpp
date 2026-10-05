#pragma once

// Minimal arbitrary-precision unsigned integer used by the reference
// interval checker. Standard library only; limbs are little-endian
// uint64 words with no trailing zero limbs.

#include <cstdint>
#include <utility>
#include <vector>

namespace ref {

// Full 64x64 -> 128 bit product via 32-bit decomposition (portable,
// no compiler extensions).
inline std::pair<std::uint64_t, std::uint64_t>
mul64x64(std::uint64_t a, std::uint64_t b) {
    const std::uint64_t al = a & 0xffffffffULL, ah = a >> 32;
    const std::uint64_t bl = b & 0xffffffffULL, bh = b >> 32;
    const std::uint64_t ll = al * bl;
    const std::uint64_t lh = al * bh;
    const std::uint64_t hl = ah * bl;
    const std::uint64_t hh = ah * bh;
    const std::uint64_t mid = lh + hl;          // may carry into bit 96
    const std::uint64_t mid_carry = (mid < lh) ? 1 : 0;
    const std::uint64_t lo = ll + (mid << 32);
    const std::uint64_t lo_carry = (lo < ll) ? 1 : 0;
    const std::uint64_t hi = hh + (mid >> 32) + lo_carry + (mid_carry << 32);
    return {lo, hi};
}

class BigUint {
public:
    BigUint() = default;
    BigUint(std::uint64_t v) {
        if (v != 0)
            limbs_.push_back(v);
    }

    static BigUint from_u64(std::uint64_t v) { return BigUint(v); }

    void add(const BigUint& other) {
        const std::size_t n = other.limbs_.size();
        if (limbs_.size() < n)
            limbs_.resize(n, 0);
        std::uint64_t carry = 0;
        std::size_t i = 0;
        for (; i < n; ++i) {
            const std::uint64_t a = limbs_[i];
            const std::uint64_t b = other.limbs_[i];
            const std::uint64_t s = a + b;
            const std::uint64_t c1 = (s < a) ? 1 : 0;
            const std::uint64_t s2 = s + carry;
            const std::uint64_t c2 = (s2 < s) ? 1 : 0;
            limbs_[i] = s2;
            carry = c1 | c2;
        }
        while (carry) {
            if (i == limbs_.size()) {
                limbs_.push_back(carry);
                break;
            }
            const std::uint64_t s = limbs_[i] + 1;
            carry = (s == 0) ? 1 : 0;
            limbs_[i] = s;
            ++i;
        }
    }

    void add_u64(std::uint64_t v) { add(BigUint(v)); }

    void mul_u64(std::uint64_t m) {
        if (m == 0 || limbs_.empty()) {
            limbs_.clear();
            return;
        }
        std::uint64_t carry = 0;
        for (auto& limb : limbs_) {
            const auto [lo, hi] = mul64x64(limb, m);
            const std::uint64_t s = lo + carry;
            const std::uint64_t c = (s < lo) ? 1 : 0;
            limb = s;
            carry = hi + c; // hi <= 2^64 - 2, so this cannot wrap
        }
        if (carry)
            limbs_.push_back(carry);
    }

    int compare(const BigUint& other) const {
        if (limbs_.size() != other.limbs_.size())
            return limbs_.size() < other.limbs_.size() ? -1 : 1;
        for (std::size_t i = limbs_.size(); i-- > 0;) {
            if (limbs_[i] != other.limbs_[i])
                return limbs_[i] < other.limbs_[i] ? -1 : 1;
        }
        return 0;
    }

    bool operator>(const BigUint& o) const { return compare(o) > 0; }
    bool operator<=(const BigUint& o) const { return compare(o) <= 0; }

    // Precondition: value fits in uint64.
    std::uint64_t to_u64() const {
        return limbs_.empty() ? 0 : limbs_[0];
    }

private:
    std::vector<std::uint64_t> limbs_;
};

} // namespace ref
