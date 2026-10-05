#pragma once

// Minimal arbitrary-precision signed integer, C++20 standard library only.
// Used as the exact-arithmetic fallback tier and as the ground-truth model.

#include <cstdint>
#include <string>
#include <vector>

namespace geom {

class BigInt {
public:
    BigInt() = default;

    BigInt(std::int64_t value) {
        std::uint64_t v;
        if (value < 0) {
            neg_ = true;
            v = static_cast<std::uint64_t>(-(value + 1)) + 1;  // INT64_MIN safe
        } else {
            v = static_cast<std::uint64_t>(value);
        }
        while (v != 0) {
            mag_.push_back(static_cast<std::uint32_t>(v & 0xffffffffu));
            v >>= 32;
        }
    }

    int sign() const {
        if (mag_.empty()) return 0;
        return neg_ ? -1 : 1;
    }

    friend BigInt operator+(const BigInt& lhs, const BigInt& rhs) {
        if (lhs.mag_.empty()) return rhs;
        if (rhs.mag_.empty()) return lhs;
        if (lhs.neg_ == rhs.neg_) {
            BigInt r;
            r.neg_ = lhs.neg_;
            r.mag_ = add_mag(lhs.mag_, rhs.mag_);
            return r;
        }
        int cmp = cmp_mag(lhs.mag_, rhs.mag_);
        if (cmp == 0) return BigInt{};
        BigInt r;
        if (cmp > 0) {
            r.mag_ = sub_mag(lhs.mag_, rhs.mag_);
            r.neg_ = lhs.neg_;
        } else {
            r.mag_ = sub_mag(rhs.mag_, lhs.mag_);
            r.neg_ = rhs.neg_;
        }
        return r;
    }

    friend BigInt operator-(const BigInt& lhs, const BigInt& rhs) {
        BigInt neg = rhs;
        if (!neg.mag_.empty()) neg.neg_ = !neg.neg_;
        return lhs + neg;
    }

    friend BigInt operator*(const BigInt& lhs, const BigInt& rhs) {
        BigInt r;
        if (lhs.mag_.empty() || rhs.mag_.empty()) return r;
        r.mag_.assign(lhs.mag_.size() + rhs.mag_.size(), 0);
        for (std::size_t i = 0; i < lhs.mag_.size(); ++i) {
            std::uint64_t carry = 0;
            for (std::size_t j = 0; j < rhs.mag_.size(); ++j) {
                std::uint64_t cur = r.mag_[i + j] + carry +
                                    static_cast<std::uint64_t>(lhs.mag_[i]) * rhs.mag_[j];
                r.mag_[i + j] = static_cast<std::uint32_t>(cur);
                carry = cur >> 32;
            }
            std::size_t k = i + rhs.mag_.size();
            while (carry != 0) {
                std::uint64_t cur = r.mag_[k] + carry;
                r.mag_[k] = static_cast<std::uint32_t>(cur);
                carry = cur >> 32;
                ++k;
            }
        }
        r.neg_ = lhs.neg_ != rhs.neg_;
        r.trim();
        return r;
    }

    std::string to_string() const {
        if (mag_.empty()) return "0";
        // Chunked decimal conversion by repeated division is overkill here;
        // hex dump is sufficient for diagnostics.
        std::string s = neg_ ? "-0x" : "0x";
        const char* digits = "0123456789abcdef";
        bool leading = true;
        for (auto it = mag_.rbegin(); it != mag_.rend(); ++it) {
            for (int shift = 28; shift >= 0; shift -= 4) {
                char c = digits[(*it >> shift) & 0xf];
                if (leading && c == '0') continue;
                leading = false;
                s += c;
            }
        }
        return s;
    }

private:
    using Mag = std::vector<std::uint32_t>;  // little-endian base 2^32

    static Mag add_mag(const Mag& a, const Mag& b) {
        Mag r(std::max(a.size(), b.size()) + 1, 0);
        std::uint64_t carry = 0;
        for (std::size_t i = 0; i < r.size(); ++i) {
            std::uint64_t cur = carry;
            if (i < a.size()) cur += a[i];
            if (i < b.size()) cur += b[i];
            r[i] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
        }
        while (r.size() > 1 && r.back() == 0) r.pop_back();
        if (r.size() == 1 && r[0] == 0) r.clear();
        return r;
    }

    // Requires |a| >= |b|.
    static Mag sub_mag(const Mag& a, const Mag& b) {
        Mag r = a;
        std::int64_t borrow = 0;
        for (std::size_t i = 0; i < r.size(); ++i) {
            std::int64_t cur = static_cast<std::int64_t>(r[i]) - borrow -
                               (i < b.size() ? static_cast<std::int64_t>(b[i]) : 0);
            if (cur < 0) {
                cur += (std::int64_t{1} << 32);
                borrow = 1;
            } else {
                borrow = 0;
            }
            r[i] = static_cast<std::uint32_t>(cur);
        }
        while (!r.empty() && r.back() == 0) r.pop_back();
        return r;
    }

    static int cmp_mag(const Mag& a, const Mag& b) {
        if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
        for (std::size_t i = a.size(); i-- > 0;) {
            if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
        }
        return 0;
    }

    void trim() {
        while (!mag_.empty() && mag_.back() == 0) mag_.pop_back();
        if (mag_.empty()) neg_ = false;
    }

    Mag mag_;
    bool neg_ = false;
};

}  // namespace geom
