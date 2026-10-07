#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace sigconv {

// Minimal non-negative arbitrary-precision integer, little-endian base 2^32.
// Only the operations needed for CRT reconstruction and decimal output.
class BigUInt {
public:
    BigUInt() = default;
    BigUInt(uint64_t v) {
        while (v != 0) {
            d_.push_back(static_cast<uint32_t>(v));
            v >>= 32;
        }
    }

    bool is_zero() const { return d_.empty(); }

    static BigUInt mul_u64(const BigUInt& a, uint64_t b) {
        BigUInt r;
        if (b == 0 || a.d_.empty()) return r;
        r.d_.resize(a.d_.size() + 2, 0);
        uint64_t carry = 0;
        for (size_t i = 0; i < a.d_.size(); ++i) {
            __uint128_t cur = static_cast<__uint128_t>(a.d_[i]) * b + carry;
            r.d_[i] = static_cast<uint32_t>(cur);
            carry = static_cast<uint64_t>(cur >> 32);
        }
        size_t i = a.d_.size();
        while (carry != 0) {
            r.d_[i++] = static_cast<uint32_t>(carry);
            carry >>= 32;
        }
        r.trim();
        return r;
    }

    void add(const BigUInt& o) {
        if (d_.size() < o.d_.size()) d_.resize(o.d_.size(), 0);
        uint64_t carry = 0;
        for (size_t i = 0; i < d_.size(); ++i) {
            uint64_t cur = static_cast<uint64_t>(d_[i]) + carry + (i < o.d_.size() ? o.d_[i] : 0u);
            d_[i] = static_cast<uint32_t>(cur);
            carry = cur >> 32;
        }
        if (carry) d_.push_back(static_cast<uint32_t>(carry));
    }

    // Requires *this >= o.
    void sub(const BigUInt& o) {
        int64_t borrow = 0;
        for (size_t i = 0; i < d_.size(); ++i) {
            int64_t cur = static_cast<int64_t>(d_[i]) - borrow - (i < o.d_.size() ? o.d_[i] : 0);
            if (cur < 0) {
                cur += (int64_t{1} << 32);
                borrow = 1;
            } else {
                borrow = 0;
            }
            d_[i] = static_cast<uint32_t>(cur);
        }
        trim();
    }

    int cmp(const BigUInt& o) const {
        if (d_.size() != o.d_.size()) return d_.size() < o.d_.size() ? -1 : 1;
        for (size_t i = d_.size(); i-- > 0;) {
            if (d_[i] != o.d_[i]) return d_[i] < o.d_[i] ? -1 : 1;
        }
        return 0;
    }

    uint32_t mod_u32(uint32_t m) const {
        uint64_t rem = 0;
        for (size_t i = d_.size(); i-- > 0;) rem = ((rem << 32) | d_[i]) % m;
        return static_cast<uint32_t>(rem);
    }

    std::string to_string() const {
        if (d_.empty()) return "0";
        std::vector<uint32_t> t = d_;
        std::string out;
        char buf[16];
        while (!t.empty()) {
            uint64_t rem = 0;
            for (size_t i = t.size(); i-- > 0;) {
                uint64_t cur = (rem << 32) | t[i];
                t[i] = static_cast<uint32_t>(cur / 1000000000u);
                rem = cur % 1000000000u;
            }
            while (!t.empty() && t.back() == 0) t.pop_back();
            if (t.empty()) {
                std::snprintf(buf, sizeof(buf), "%u", static_cast<unsigned>(rem));
            } else {
                std::snprintf(buf, sizeof(buf), "%09u", static_cast<unsigned>(rem));
            }
            out.insert(0, buf);
        }
        return out;
    }

private:
    void trim() {
        while (!d_.empty() && d_.back() == 0) d_.pop_back();
    }

    std::vector<uint32_t> d_;
};

// Signed big integer: sign + magnitude.
struct BigInt {
    bool neg = false;
    BigUInt mag;

    std::string to_string() const {
        if (mag.is_zero()) return "0";
        return neg ? "-" + mag.to_string() : mag.to_string();
    }
};

} // namespace sigconv
