#pragma once

#include <cstdint>
#include <cstdio>
#include <algorithm>
#include <string>
#include <string_view>
#include <vector>
#include <compare>
#include <stdexcept>
#include <utility>

namespace exact_stats {

// Arbitrary precision signed integer, sign-magnitude, base 2^32 limbs
// stored little-endian with no trailing zero limbs.
class BigInt {
public:
    BigInt() = default;

    BigInt(long long value) {
        if (value < 0) {
            neg_ = true;
            // Careful with LLONG_MIN.
            unsigned long long mag = static_cast<unsigned long long>(-(value + 1)) + 1;
            set_mag(mag);
        } else {
            set_mag(static_cast<unsigned long long>(value));
        }
    }

    static BigInt from_decimal(std::string_view text) {
        BigInt result;
        std::size_t pos = 0;
        bool neg = false;
        if (pos < text.size() && (text[pos] == '+' || text[pos] == '-')) {
            neg = text[pos] == '-';
            ++pos;
        }
        if (pos == text.size()) throw std::invalid_argument("empty BigInt literal");
        for (; pos < text.size(); ++pos) {
            char c = text[pos];
            if (c < '0' || c > '9') throw std::invalid_argument("bad BigInt literal");
            result.mul_small(10);
            result.add_small(static_cast<std::uint32_t>(c - '0'));
        }
        if (neg && !result.is_zero()) result.neg_ = true;
        return result;
    }

    static BigInt from_u64(unsigned long long v) {
        BigInt r;
        r.set_mag(v);
        return r;
    }

    static BigInt pow10(unsigned exp) {
        BigInt result(1);
        BigInt ten(10);
        for (unsigned i = 0; i < exp; ++i) result = result * ten;
        return result;
    }

    bool is_zero() const { return limbs_.empty(); }
    bool is_negative() const { return neg_; }
    BigInt abs() const { BigInt r = *this; r.neg_ = false; return r; }
    BigInt operator-() const { BigInt r = *this; if (!r.is_zero()) r.neg_ = !r.neg_; return r; }

    friend bool operator==(const BigInt& a, const BigInt& b) {
        return a.neg_ == b.neg_ && a.limbs_ == b.limbs_;
    }
    friend std::strong_ordering operator<=>(const BigInt& a, const BigInt& b) {
        if (a.neg_ != b.neg_) return a.neg_ ? std::strong_ordering::less
                                            : std::strong_ordering::greater;
        int c = cmp_abs(a, b);
        if (a.neg_) c = -c;
        return c < 0 ? std::strong_ordering::less
             : c > 0 ? std::strong_ordering::greater
                     : std::strong_ordering::equal;
    }

    BigInt& operator+=(const BigInt& other) { return *this = *this + other; }
    BigInt& operator-=(const BigInt& other) { return *this = *this - other; }
    BigInt& operator*=(const BigInt& other) { return *this = *this * other; }

    friend BigInt operator+(const BigInt& a, const BigInt& b) {
        BigInt r;
        if (a.neg_ == b.neg_) {
            r.limbs_ = add_abs(a.limbs_, b.limbs_);
            r.neg_ = a.neg_ && !r.limbs_.empty();
        } else {
            int c = cmp_abs(a, b);
            if (c == 0) return r;
            if (c > 0) { r.limbs_ = sub_abs(a.limbs_, b.limbs_); r.neg_ = a.neg_; }
            else       { r.limbs_ = sub_abs(b.limbs_, a.limbs_); r.neg_ = b.neg_; }
        }
        return r;
    }

    friend BigInt operator-(const BigInt& a, const BigInt& b) { return a + (-b); }

    friend BigInt operator*(const BigInt& a, const BigInt& b) {
        BigInt r;
        if (a.is_zero() || b.is_zero()) return r;
        std::vector<std::uint32_t> out(a.limbs_.size() + b.limbs_.size(), 0);
        for (std::size_t i = 0; i < a.limbs_.size(); ++i) {
            std::uint64_t carry = 0;
            for (std::size_t j = 0; j < b.limbs_.size(); ++j) {
                std::uint64_t cur = static_cast<std::uint64_t>(a.limbs_[i]) * b.limbs_[j]
                                  + out[i + j] + carry;
                out[i + j] = static_cast<std::uint32_t>(cur);
                carry = cur >> 32;
            }
            std::size_t k = i + b.limbs_.size();
            while (carry) {
                std::uint64_t cur = static_cast<std::uint64_t>(out[k]) + carry;
                out[k] = static_cast<std::uint32_t>(cur);
                carry = cur >> 32;
                ++k;
            }
        }
        trim(out);
        r.limbs_ = std::move(out);
        r.neg_ = a.neg_ != b.neg_ && !r.limbs_.empty();
        return r;
    }

    // Euclidean division: q = trunc toward zero pair adjusted so that
    // a == q*b + r with 0 <= r < |b| when b > 0. Here we only need
    // division of non-negative values (gcd, printing), so both must be >= 0.
    friend std::pair<BigInt, BigInt> divmod(const BigInt& a, const BigInt& b) {
        if (b.is_zero()) throw std::domain_error("BigInt division by zero");
        if (a.neg_ || b.neg_) throw std::invalid_argument("divmod expects non-negative operands");
        BigInt q, r;
        if (cmp_abs(a, b) < 0) return {q, a};
        std::size_t nbits = a.bit_length();
        q.limbs_.assign((nbits + 31) / 32, 0);
        for (std::size_t i = nbits; i-- > 0;) {
            r.shl1();
            if (a.test_bit(i)) {
                if (r.limbs_.empty()) r.limbs_.push_back(1u);
                else r.limbs_[0] |= 1u;
            }
            if (cmp_abs(r, b) >= 0) {
                r.limbs_ = sub_abs(r.limbs_, b.limbs_);
                q.limbs_[i / 32] |= (1u << (i % 32));
            }
        }
        trim(q.limbs_);
        return {q, r};
    }

    // Truncated division (C++ semantics): the quotient rounds toward zero
    // and the remainder carries the dividend's sign.
    friend BigInt operator/(const BigInt& a, const BigInt& b) {
        BigInt q = divmod(a.abs(), b.abs()).first;
        if (!q.is_zero() && a.neg_ != b.neg_) q.neg_ = true;
        return q;
    }
    friend BigInt operator%(const BigInt& a, const BigInt& b) {
        BigInt r = divmod(a.abs(), b.abs()).second;
        if (!r.is_zero()) r.neg_ = a.neg_;
        return r;
    }

    friend BigInt gcd(BigInt a, BigInt b) {
        a = a.abs();
        b = b.abs();
        while (!b.is_zero()) {
            BigInt r = a % b;
            a = std::move(b);
            b = std::move(r);
        }
        return a;
    }

    std::string to_string() const {
        if (is_zero()) return "0";
        std::string out;
        BigInt cur = this->abs();
        const BigInt base = BigInt::from_decimal("1000000000");
        while (!cur.is_zero()) {
            auto [q, r] = divmod(cur, base);
            std::uint32_t chunk = r.limbs_.empty() ? 0u : r.limbs_[0];
            char buf[10];
            std::snprintf(buf, sizeof buf, "%09u", chunk);
            out = std::string(buf) + out;
            cur = std::move(q);
        }
        // Strip the zero padding of the most significant chunk.
        std::size_t first = out.find_first_not_of('0');
        if (first == std::string::npos) return "0";
        out.erase(0, first);
        if (neg_) out.insert(out.begin(), '-');
        return out;
    }

private:
    std::vector<std::uint32_t> limbs_;
    bool neg_ = false;

    void set_mag(unsigned long long v) {
        limbs_.clear();
        while (v) { limbs_.push_back(static_cast<std::uint32_t>(v)); v >>= 32; }
    }

    static void trim(std::vector<std::uint32_t>& v) {
        while (!v.empty() && v.back() == 0) v.pop_back();
    }

    static int cmp_abs(const BigInt& a, const BigInt& b) {
        if (a.limbs_.size() != b.limbs_.size())
            return a.limbs_.size() < b.limbs_.size() ? -1 : 1;
        for (std::size_t i = a.limbs_.size(); i-- > 0;) {
            if (a.limbs_[i] != b.limbs_[i])
                return a.limbs_[i] < b.limbs_[i] ? -1 : 1;
        }
        return 0;
    }

    static std::vector<std::uint32_t> add_abs(const std::vector<std::uint32_t>& a,
                                              const std::vector<std::uint32_t>& b) {
        std::vector<std::uint32_t> out;
        out.reserve(std::max(a.size(), b.size()) + 1);
        std::uint64_t carry = 0;
        for (std::size_t i = 0; i < std::max(a.size(), b.size()); ++i) {
            std::uint64_t cur = carry;
            if (i < a.size()) cur += a[i];
            if (i < b.size()) cur += b[i];
            out.push_back(static_cast<std::uint32_t>(cur));
            carry = cur >> 32;
        }
        if (carry) out.push_back(static_cast<std::uint32_t>(carry));
        return out;
    }

    // Requires a >= b (magnitude).
    static std::vector<std::uint32_t> sub_abs(const std::vector<std::uint32_t>& a,
                                              const std::vector<std::uint32_t>& b) {
        std::vector<std::uint32_t> out = a;
        std::int64_t borrow = 0;
        for (std::size_t i = 0; i < out.size(); ++i) {
            std::int64_t cur = static_cast<std::int64_t>(out[i]) - borrow
                             - (i < b.size() ? static_cast<std::int64_t>(b[i]) : 0);
            if (cur < 0) { cur += (std::int64_t{1} << 32); borrow = 1; }
            else borrow = 0;
            out[i] = static_cast<std::uint32_t>(cur);
        }
        trim(out);
        return out;
    }

    std::size_t bit_length() const {
        if (limbs_.empty()) return 0;
        std::uint32_t top = limbs_.back();
        std::size_t bits = (limbs_.size() - 1) * 32;
        while (top) { ++bits; top >>= 1; }
        return bits;
    }

    bool test_bit(std::size_t i) const {
        return (limbs_[i / 32] >> (i % 32)) & 1u;
    }

    void shl1() {
        std::uint32_t carry = 0;
        for (auto& limb : limbs_) {
            std::uint32_t next = limb >> 31;
            limb = (limb << 1) | carry;
            carry = next;
        }
        if (carry) limbs_.push_back(carry);
    }

    void mul_small(std::uint32_t m) {
        std::uint64_t carry = 0;
        for (auto& limb : limbs_) {
            std::uint64_t cur = static_cast<std::uint64_t>(limb) * m + carry;
            limb = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
        }
        while (carry) { limbs_.push_back(static_cast<std::uint32_t>(carry)); carry >>= 32; }
    }

    void add_small(std::uint32_t v) {
        std::uint64_t carry = v;
        std::size_t i = 0;
        while (carry) {
            if (i == limbs_.size()) limbs_.push_back(0);
            std::uint64_t cur = static_cast<std::uint64_t>(limbs_[i]) + carry;
            limbs_[i] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
            ++i;
        }
    }
};

} // namespace exact_stats
