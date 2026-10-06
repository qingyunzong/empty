#pragma once

// Minimal exact signed big integer (sign-magnitude, base 2^32, little-endian).
// Only the operations needed by the CRT reconstruction and decimal output are
// implemented.

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace conv {

struct BigInt {
    bool neg = false;
    std::vector<uint32_t> d;  // little-endian limbs, no trailing zeros; empty == 0

    BigInt() = default;

    static BigInt from_u64(uint64_t v) {
        BigInt r;
        if (v) {
            r.d.push_back(static_cast<uint32_t>(v));
            if (v >> 32) r.d.push_back(static_cast<uint32_t>(v >> 32));
        }
        return r;
    }

    bool is_zero() const { return d.empty(); }

    void trim() {
        while (!d.empty() && d.back() == 0) d.pop_back();
        if (d.empty()) neg = false;
    }

    static int cmp_mag(const BigInt& a, const BigInt& b) {
        if (a.d.size() != b.d.size()) return a.d.size() < b.d.size() ? -1 : 1;
        for (size_t i = a.d.size(); i-- > 0;)
            if (a.d[i] != b.d[i]) return a.d[i] < b.d[i] ? -1 : 1;
        return 0;
    }

    int cmp(const BigInt& o) const {
        if (neg != o.neg) return neg ? -1 : 1;
        int c = cmp_mag(*this, o);
        return neg ? -c : c;
    }

    bool operator==(const BigInt& o) const { return neg == o.neg && d == o.d; }
    bool operator!=(const BigInt& o) const { return !(*this == o); }

    void add_mag(const BigInt& o) {  // |*this| += |o|
        if (d.size() < o.d.size()) d.resize(o.d.size(), 0);
        uint64_t carry = 0;
        for (size_t i = 0; i < o.d.size(); ++i) {
            uint64_t s = static_cast<uint64_t>(d[i]) + o.d[i] + carry;
            d[i] = static_cast<uint32_t>(s);
            carry = s >> 32;
        }
        for (size_t i = o.d.size(); carry; ++i) {
            if (i == d.size()) d.push_back(0);
            uint64_t s = static_cast<uint64_t>(d[i]) + carry;
            d[i] = static_cast<uint32_t>(s);
            carry = s >> 32;
        }
    }

    void sub_mag(const BigInt& o) {  // |*this| -= |o|, requires |*this| >= |o|
        int64_t borrow = 0;
        for (size_t i = 0; i < d.size(); ++i) {
            int64_t v = static_cast<int64_t>(d[i]) - borrow -
                        (i < o.d.size() ? static_cast<int64_t>(o.d[i]) : 0);
            if (v < 0) {
                v += int64_t{1} << 32;
                borrow = 1;
            } else {
                borrow = 0;
            }
            d[i] = static_cast<uint32_t>(v);
        }
        trim();
    }

    void add(const BigInt& o) {  // signed +=
        if (o.is_zero()) return;
        if (is_zero()) {
            *this = o;
            return;
        }
        if (neg == o.neg) {
            add_mag(o);
            return;
        }
        int c = cmp_mag(*this, o);
        if (c == 0) {
            d.clear();
            neg = false;
        } else if (c > 0) {
            sub_mag(o);
        } else {
            BigInt t = o;
            t.sub_mag(*this);
            *this = std::move(t);
        }
    }

    void sub(const BigInt& o) {  // signed -=
        BigInt t = o;
        if (!t.is_zero()) t.neg = !t.neg;
        add(t);
    }

    void mul_u32(uint32_t m) {  // *= m, keeps sign
        if (m == 0 || is_zero()) {
            d.clear();
            neg = false;
            return;
        }
        uint64_t carry = 0;
        for (auto& limb : d) {
            uint64_t v = static_cast<uint64_t>(limb) * m + carry;
            limb = static_cast<uint32_t>(v);
            carry = v >> 32;
        }
        if (carry) d.push_back(static_cast<uint32_t>(carry));
    }

    void add_mul_u32(uint32_t t, const BigInt& p) {  // *this += t * p (p >= 0)
        if (t == 0 || p.is_zero()) return;
        BigInt prod;
        prod.d.resize(p.d.size());
        uint64_t carry = 0;
        for (size_t i = 0; i < p.d.size(); ++i) {
            uint64_t v = static_cast<uint64_t>(p.d[i]) * t + carry;
            prod.d[i] = static_cast<uint32_t>(v);
            carry = v >> 32;
        }
        if (carry) prod.d.push_back(static_cast<uint32_t>(carry));
        add(prod);
    }

    void mul_u64(uint64_t m) {  // *= m, keeps sign
        BigInt lo = *this;
        lo.mul_u32(static_cast<uint32_t>(m));
        BigInt hi = *this;
        hi.mul_u32(static_cast<uint32_t>(m >> 32));
        if (!hi.d.empty()) hi.d.insert(hi.d.begin(), 0);  // << 32
        *this = std::move(lo);
        add(hi);
    }

    // Unsigned product of two 64-bit magnitudes.
    static BigInt mul_u64x64(uint64_t x, uint64_t y) {
        BigInt r = BigInt::from_u64(x);
        r.mul_u64(y);
        return r;
    }

    // Signed product of two int64_t values (exact, handles INT64_MIN).
    static BigInt from_i64_product(int64_t x, int64_t y) {
        uint64_t ax = x < 0 ? 0ull - static_cast<uint64_t>(x) : static_cast<uint64_t>(x);
        uint64_t ay = y < 0 ? 0ull - static_cast<uint64_t>(y) : static_cast<uint64_t>(y);
        BigInt r = mul_u64x64(ax, ay);
        if (!r.is_zero()) r.neg = (x < 0) != (y < 0);
        return r;
    }

    uint32_t mod_small(uint32_t m) const {  // |*this| mod m
        uint64_t r = 0;
        for (size_t i = d.size(); i-- > 0;) r = ((r << 32) | d[i]) % m;
        return static_cast<uint32_t>(r);
    }

    uint32_t divmod_small(uint32_t m) {  // |*this| /= m, returns remainder
        uint64_t r = 0;
        for (size_t i = d.size(); i-- > 0;) {
            uint64_t cur = (r << 32) | d[i];
            d[i] = static_cast<uint32_t>(cur / m);
            r = cur % m;
        }
        trim();
        return static_cast<uint32_t>(r);
    }

    std::string to_string() const {
        if (is_zero()) return "0";
        BigInt t = *this;
        t.neg = false;
        std::string s;
        while (!t.is_zero()) {
            uint32_t r = t.divmod_small(1000000000u);
            char buf[16];
            int len;
            if (t.is_zero()) {  // most significant chunk: no zero padding
                std::snprintf(buf, sizeof buf, "%u", r);
            } else {
                std::snprintf(buf, sizeof buf, "%09u", r);
            }
            len = static_cast<int>(std::char_traits<char>::length(buf));
            s.insert(s.begin(), buf, buf + len);  // prepend (chunks come out LS-first)
        }
        if (neg) s.insert(s.begin(), '-');
        return s;
    }
};

}  // namespace conv
