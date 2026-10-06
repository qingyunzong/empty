#pragma once

#include <algorithm>
#include <bit>
#include <compare>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace detreduce {

// Arbitrary-precision signed integer (exact arithmetic).
// Magnitude stored little-endian in 64-bit limbs, normalized (no zero
// high limbs; zero is never negative).
class bigint {
public:
    bigint() = default;
    bigint(int v) : bigint(static_cast<long long>(v)) {}
    bigint(long v) : bigint(static_cast<long long>(v)) {}
    bigint(unsigned long v) : bigint(static_cast<unsigned long long>(v)) {}
    bigint(long long v) {
        if (v < 0) {
            neg_ = true;
            mag_ = {static_cast<std::uint64_t>(-(v + 1)) + 1};
        } else if (v > 0) {
            mag_ = {static_cast<std::uint64_t>(v)};
        }
    }
    bigint(unsigned long long v) {
        if (v != 0) mag_ = {v};
    }

    bool is_zero() const { return mag_.empty(); }
    int sign() const { return mag_.empty() ? 0 : (neg_ ? -1 : 1); }

    bigint abs() const {
        bigint r = *this;
        r.neg_ = false;
        return r;
    }

    friend bigint operator-(const bigint& a) {
        bigint r = a;
        if (!r.is_zero()) r.neg_ = !r.neg_;
        return r;
    }

    friend bigint operator+(const bigint& a, const bigint& b) {
        bigint r;
        if (a.neg_ == b.neg_) {
            r.mag_ = add_mag(a.mag_, b.mag_);
            r.neg_ = a.neg_;
        } else {
            const int c = cmp_mag(a.mag_, b.mag_);
            if (c == 0) return bigint{};
            if (c > 0) {
                r.mag_ = sub_mag(a.mag_, b.mag_);
                r.neg_ = a.neg_;
            } else {
                r.mag_ = sub_mag(b.mag_, a.mag_);
                r.neg_ = b.neg_;
            }
        }
        r.normalize();
        return r;
    }

    friend bigint operator-(const bigint& a, const bigint& b) { return a + (-b); }

    friend bigint operator*(const bigint& a, const bigint& b) {
        bigint r;
        r.mag_ = mul_mag(a.mag_, b.mag_);
        r.neg_ = !r.mag_.empty() && (a.neg_ != b.neg_);
        return r;
    }

    // Truncated division (quotient rounds toward zero, like C++ integers).
    friend bigint operator/(const bigint& a, const bigint& b) {
        if (b.is_zero()) throw std::domain_error("bigint: division by zero");
        bigint q, r;
        divmod_mag(a.mag_, b.mag_, q.mag_, r.mag_);
        q.neg_ = !q.mag_.empty() && (a.neg_ != b.neg_);
        return q;
    }

    // Remainder has the sign of the dividend (matches truncated division).
    friend bigint operator%(const bigint& a, const bigint& b) {
        if (b.is_zero()) throw std::domain_error("bigint: modulo by zero");
        bigint q, r;
        divmod_mag(a.mag_, b.mag_, q.mag_, r.mag_);
        r.neg_ = !r.mag_.empty() && a.neg_;
        return r;
    }

    bigint& operator+=(const bigint& o) { return *this = *this + o; }
    bigint& operator-=(const bigint& o) { return *this = *this - o; }
    bigint& operator*=(const bigint& o) { return *this = *this * o; }
    bigint& operator/=(const bigint& o) { return *this = *this / o; }
    bigint& operator%=(const bigint& o) { return *this = *this % o; }

    friend bool operator==(const bigint&, const bigint&) = default;

    friend std::strong_ordering operator<=>(const bigint& a, const bigint& b) {
        if (a.neg_ != b.neg_)
            return a.neg_ ? std::strong_ordering::less : std::strong_ordering::greater;
        int c = cmp_mag(a.mag_, b.mag_);
        if (a.neg_) c = -c;
        return c <=> 0;
    }

    // Greatest common divisor; result is always non-negative.
    static bigint gcd(bigint a, bigint b) {
        a.neg_ = false;
        b.neg_ = false;
        while (!b.is_zero()) {
            bigint r = a % b;
            a = std::move(b);
            b = std::move(r);
        }
        return a;
    }

    std::string to_string() const {
        if (mag_.empty()) return "0";
        constexpr std::uint64_t kBase = 10000000000000000000ull;  // 1e19
        std::string s;
        vec cur = mag_;
        while (!cur.empty()) {
            vec q;
            const std::uint64_t rem = divmod_small(q, cur, kBase);
            cur = std::move(q);
            char buf[24];
            if (cur.empty())
                std::snprintf(buf, sizeof buf, "%llu", static_cast<unsigned long long>(rem));
            else
                std::snprintf(buf, sizeof buf, "%019llu", static_cast<unsigned long long>(rem));
            s.insert(0, buf);
        }
        if (neg_) s.insert(s.begin(), '-');
        return s;
    }

    static std::optional<bigint> from_string(std::string_view s) {
        bool neg = false;
        std::size_t i = 0;
        if (i < s.size() && (s[i] == '-' || s[i] == '+')) {
            neg = s[i] == '-';
            ++i;
        }
        if (i == s.size()) return std::nullopt;
        bigint r;
        for (; i < s.size(); ++i) {
            if (s[i] < '0' || s[i] > '9') return std::nullopt;
            r = r * 10 + (s[i] - '0');
        }
        if (neg && !r.is_zero()) r.neg_ = true;
        return r;
    }

private:
    using limb = std::uint64_t;
    using vec = std::vector<limb>;

    vec mag_;  // little-endian, normalized
    bool neg_ = false;

    void normalize() {
        norm_vec(mag_);
        if (mag_.empty()) neg_ = false;
    }

    static void norm_vec(vec& v) {
        while (!v.empty() && v.back() == 0) v.pop_back();
    }

    static int cmp_mag(const vec& a, const vec& b) {
        if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
        for (std::size_t i = a.size(); i-- > 0;)
            if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
        return 0;
    }

    static vec add_mag(const vec& a, const vec& b) {
        vec r;
        r.reserve(std::max(a.size(), b.size()) + 1);
        limb carry = 0;
        std::size_t i = 0;
        const std::size_t common = std::min(a.size(), b.size());
        for (; i < common; ++i) {
            const unsigned __int128 s = static_cast<unsigned __int128>(a[i]) + b[i] + carry;
            r.push_back(static_cast<limb>(s));
            carry = static_cast<limb>(s >> 64);
        }
        const vec& rest = a.size() > b.size() ? a : b;
        for (; i < rest.size(); ++i) {
            const unsigned __int128 s = static_cast<unsigned __int128>(rest[i]) + carry;
            r.push_back(static_cast<limb>(s));
            carry = static_cast<limb>(s >> 64);
        }
        if (carry) r.push_back(carry);
        return r;
    }

    // Requires a >= b (magnitude).
    static vec sub_mag(const vec& a, const vec& b) {
        vec r;
        r.reserve(a.size());
        limb borrow = 0;
        for (std::size_t i = 0; i < a.size(); ++i) {
            const limb bi = i < b.size() ? b[i] : 0;
            const unsigned __int128 d =
                static_cast<unsigned __int128>(a[i]) - bi - borrow;
            r.push_back(static_cast<limb>(d));
            borrow = static_cast<limb>(d >> 64) != 0 ? 1 : 0;
        }
        norm_vec(r);
        return r;
    }

    static vec mul_mag(const vec& a, const vec& b) {
        if (a.empty() || b.empty()) return {};
        vec r(a.size() + b.size(), 0);
        for (std::size_t i = 0; i < a.size(); ++i) {
            unsigned __int128 carry = 0;
            for (std::size_t j = 0; j < b.size(); ++j) {
                const unsigned __int128 t =
                    static_cast<unsigned __int128>(a[i]) * b[j] + r[i + j] + carry;
                r[i + j] = static_cast<limb>(t);
                carry = t >> 64;
            }
            r[i + b.size()] = static_cast<limb>(carry);
        }
        norm_vec(r);
        return r;
    }

    static std::size_t bit_length(const vec& v) {
        if (v.empty()) return 0;
        return (v.size() - 1) * 64 + std::bit_width(v.back());
    }

    static bool test_bit(const vec& v, std::size_t i) {
        const std::size_t idx = i / 64;
        return idx < v.size() && ((v[idx] >> (i % 64)) & 1);
    }

    static void set_bit(vec& v, std::size_t i) {
        const std::size_t idx = i / 64;
        if (v.size() <= idx) v.resize(idx + 1, 0);
        v[idx] |= limb{1} << (i % 64);
    }

    static void shl1(vec& v) {
        limb carry = 0;
        for (auto& x : v) {
            const limb next = x >> 63;
            x = (x << 1) | carry;
            carry = next;
        }
        if (carry) v.push_back(carry);
    }

    // Bitwise long division on magnitudes: u = q * v + r, 0 <= r < v.
    static void divmod_mag(const vec& u, const vec& v, vec& q, vec& r) {
        q.clear();
        r.clear();
        if (cmp_mag(u, v) < 0) {
            r = u;
            return;
        }
        const std::size_t nbits = bit_length(u);
        for (std::size_t i = nbits; i-- > 0;) {
            shl1(r);
            if (test_bit(u, i)) {
                if (r.empty())
                    r.push_back(1);
                else
                    r[0] |= 1;
            }
            if (cmp_mag(r, v) >= 0) {
                r = sub_mag(r, v);
                set_bit(q, i);
            }
        }
        norm_vec(q);
        norm_vec(r);
    }

    // Divides magnitude a by small d; stores quotient, returns remainder.
    static limb divmod_small(vec& q_out, const vec& a, limb d) {
        vec q(a.size());
        unsigned __int128 rem = 0;
        for (std::size_t i = a.size(); i-- > 0;) {
            const unsigned __int128 cur = (rem << 64) | a[i];
            q[i] = static_cast<limb>(cur / d);
            rem = cur % d;
        }
        norm_vec(q);
        q_out = std::move(q);
        return static_cast<limb>(rem);
    }
};

}  // namespace detreduce
