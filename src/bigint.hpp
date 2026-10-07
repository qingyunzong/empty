#pragma once
// Minimal arbitrary-precision integer arithmetic (no external dependencies).
// BigUInt: unsigned, little-endian 32-bit limbs.
// BigInt:  sign-magnitude wrapper.

#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

class BigUInt {
public:
    std::vector<uint32_t> limbs;  // little-endian, no trailing zero limbs

    BigUInt() = default;
    BigUInt(uint64_t v) {
        if (v) {
            limbs.push_back(static_cast<uint32_t>(v));
            if (v >> 32) limbs.push_back(static_cast<uint32_t>(v >> 32));
        }
    }

    static BigUInt fromString(const std::string& s) {
        if (s.empty()) throw std::invalid_argument("empty integer");
        BigUInt r;
        for (char c : s) {
            if (c < '0' || c > '9') throw std::invalid_argument("bad integer: " + s);
            r = mulSmall(r, 10);
            r = addSmall(r, static_cast<uint32_t>(c - '0'));
        }
        return r;
    }

    bool isZero() const { return limbs.empty(); }
    bool isOne() const { return limbs.size() == 1 && limbs[0] == 1; }

    void trim() {
        while (!limbs.empty() && limbs.back() == 0) limbs.pop_back();
    }

    size_t bitLength() const {
        if (limbs.empty()) return 0;
        uint32_t top = limbs.back();
        return 32 * (limbs.size() - 1) + (32 - __builtin_clz(top));
    }

    bool testBit(size_t i) const {
        size_t w = i / 32;
        return w < limbs.size() && ((limbs[w] >> (i % 32)) & 1u);
    }

    // ---- comparisons ----
    friend int cmp(const BigUInt& a, const BigUInt& b) {
        if (a.limbs.size() != b.limbs.size())
            return a.limbs.size() < b.limbs.size() ? -1 : 1;
        for (size_t i = a.limbs.size(); i-- > 0;)
            if (a.limbs[i] != b.limbs[i]) return a.limbs[i] < b.limbs[i] ? -1 : 1;
        return 0;
    }
    friend bool operator==(const BigUInt& a, const BigUInt& b) { return cmp(a, b) == 0; }
    friend bool operator!=(const BigUInt& a, const BigUInt& b) { return cmp(a, b) != 0; }
    friend bool operator<(const BigUInt& a, const BigUInt& b) { return cmp(a, b) < 0; }
    friend bool operator<=(const BigUInt& a, const BigUInt& b) { return cmp(a, b) <= 0; }
    friend bool operator>(const BigUInt& a, const BigUInt& b) { return cmp(a, b) > 0; }
    friend bool operator>=(const BigUInt& a, const BigUInt& b) { return cmp(a, b) >= 0; }

    // ---- small-operand helpers ----
    static BigUInt addSmall(BigUInt a, uint32_t s) {
        uint64_t carry = s;
        for (size_t i = 0; carry; ++i) {
            if (i == a.limbs.size()) a.limbs.push_back(0);
            uint64_t t = static_cast<uint64_t>(a.limbs[i]) + carry;
            a.limbs[i] = static_cast<uint32_t>(t);
            carry = t >> 32;
        }
        return a;
    }

    static BigUInt mulSmall(const BigUInt& a, uint32_t m) {
        if (m == 0 || a.isZero()) return BigUInt();
        BigUInt r;
        r.limbs.resize(a.limbs.size());
        uint64_t carry = 0;
        for (size_t i = 0; i < a.limbs.size(); ++i) {
            uint64_t t = static_cast<uint64_t>(a.limbs[i]) * m + carry;
            r.limbs[i] = static_cast<uint32_t>(t);
            carry = t >> 32;
        }
        if (carry) r.limbs.push_back(static_cast<uint32_t>(carry));
        return r;
    }

    // returns quotient, sets rem
    static BigUInt divmodSmall(const BigUInt& a, uint32_t d, uint32_t& rem) {
        BigUInt q;
        q.limbs.resize(a.limbs.size());
        uint64_t r = 0;
        for (size_t i = a.limbs.size(); i-- > 0;) {
            uint64_t cur = (r << 32) | a.limbs[i];
            q.limbs[i] = static_cast<uint32_t>(cur / d);
            r = cur % d;
        }
        q.trim();
        rem = static_cast<uint32_t>(r);
        return q;
    }

    // ---- full arithmetic ----
    friend BigUInt operator+(const BigUInt& a, const BigUInt& b) {
        BigUInt r;
        size_t n = std::max(a.limbs.size(), b.limbs.size());
        r.limbs.resize(n);
        uint64_t carry = 0;
        for (size_t i = 0; i < n; ++i) {
            uint64_t t = carry;
            if (i < a.limbs.size()) t += a.limbs[i];
            if (i < b.limbs.size()) t += b.limbs[i];
            r.limbs[i] = static_cast<uint32_t>(t);
            carry = t >> 32;
        }
        if (carry) r.limbs.push_back(static_cast<uint32_t>(carry));
        return r;
    }

    // requires a >= b
    friend BigUInt operator-(const BigUInt& a, const BigUInt& b) {
        BigUInt r;
        r.limbs.resize(a.limbs.size());
        int64_t borrow = 0;
        for (size_t i = 0; i < a.limbs.size(); ++i) {
            int64_t t = static_cast<int64_t>(a.limbs[i]) - borrow -
                        (i < b.limbs.size() ? static_cast<int64_t>(b.limbs[i]) : 0);
            if (t < 0) {
                t += (int64_t{1} << 32);
                borrow = 1;
            } else {
                borrow = 0;
            }
            r.limbs[i] = static_cast<uint32_t>(t);
        }
        r.trim();
        return r;
    }

    friend BigUInt operator*(const BigUInt& a, const BigUInt& b) {
        if (a.isZero() || b.isZero()) return BigUInt();
        BigUInt r;
        r.limbs.assign(a.limbs.size() + b.limbs.size(), 0);
        for (size_t i = 0; i < a.limbs.size(); ++i) {
            uint64_t carry = 0;
            for (size_t j = 0; j < b.limbs.size(); ++j) {
                uint64_t t = static_cast<uint64_t>(a.limbs[i]) * b.limbs[j] +
                             r.limbs[i + j] + carry;
                r.limbs[i + j] = static_cast<uint32_t>(t);
                carry = t >> 32;
            }
            size_t k = i + b.limbs.size();
            while (carry) {
                uint64_t t = static_cast<uint64_t>(r.limbs[k]) + carry;
                r.limbs[k] = static_cast<uint32_t>(t);
                carry = t >> 32;
                ++k;
                if (k == r.limbs.size() && carry) r.limbs.push_back(0);
            }
        }
        r.trim();
        return r;
    }

    BigUInt& operator+=(const BigUInt& o) { return *this = *this + o; }
    BigUInt& operator*=(const BigUInt& o) { return *this = *this * o; }

    BigUInt shlBits(size_t n) const {
        if (isZero()) return BigUInt();
        size_t words = n / 32, bits = n % 32;
        BigUInt r;
        r.limbs.assign(words, 0);
        uint32_t carry = 0;
        for (uint32_t l : limbs) {
            r.limbs.push_back((l << bits) | carry);
            carry = bits ? (l >> (32 - bits)) : 0;
        }
        if (carry) r.limbs.push_back(carry);
        return r;
    }

    BigUInt shrBits(size_t n) const {
        size_t words = n / 32, bits = n % 32;
        if (words >= limbs.size()) return BigUInt();
        BigUInt r;
        for (size_t i = words; i < limbs.size(); ++i) {
            uint32_t v = limbs[i] >> bits;
            if (bits && i + 1 < limbs.size()) v |= limbs[i + 1] << (32 - bits);
            r.limbs.push_back(v);
        }
        r.trim();
        return r;
    }

    // binary long division; returns {quotient, remainder}
    friend std::pair<BigUInt, BigUInt> divmod(const BigUInt& a, const BigUInt& b) {
        if (b.isZero()) throw std::domain_error("division by zero");
        if (a < b) return {BigUInt(), a};
        BigUInt q, r;
        size_t n = a.bitLength();
        q.limbs.assign(n / 32 + 1, 0);
        for (size_t i = n; i-- > 0;) {
            // r = (r << 1) | bit i of a
            r = r.shlBits(1);
            if (a.testBit(i)) {
                if (r.limbs.empty()) r.limbs.push_back(1);
                else r.limbs[0] |= 1u;
            }
            if (r >= b) {
                r = r - b;
                q.limbs[i / 32] |= (1u << (i % 32));
            }
        }
        q.trim();
        return {q, r};
    }

    friend BigUInt operator/(const BigUInt& a, const BigUInt& b) { return divmod(a, b).first; }
    friend BigUInt operator%(const BigUInt& a, const BigUInt& b) { return divmod(a, b).second; }

    // binary (Stein) gcd: shifts and subtractions only
    friend BigUInt gcd(BigUInt a, BigUInt b) {
        if (a.isZero()) return b;
        if (b.isZero()) return a;
        auto ctz = [](const BigUInt& x) {
            size_t i = 0;
            while (!x.testBit(i)) ++i;
            return i;
        };
        size_t shift = std::min(ctz(a), ctz(b));
        a = a.shrBits(ctz(a));
        while (!b.isZero()) {
            b = b.shrBits(ctz(b));
            if (a > b) std::swap(a, b);
            b = b - a;
        }
        return a.shlBits(shift);
    }

    std::string toString() const {
        if (isZero()) return "0";
        std::string out;
        BigUInt cur = *this;
        const uint32_t BASE = 1000000000u;
        while (!cur.isZero()) {
            uint32_t rem;
            cur = divmodSmall(cur, BASE, rem);
            char buf[10];
            if (cur.isZero())
                snprintf(buf, sizeof buf, "%u", rem);
            else
                snprintf(buf, sizeof buf, "%09u", rem);
            out = std::string(buf) + out;
        }
        return out;
    }
};

class BigInt {
public:
    BigUInt mag;
    bool neg = false;  // meaningless when mag == 0 (canonical: neg=false)

    BigInt() = default;
    BigInt(int64_t v) {
        if (v < 0) {
            neg = true;
            mag = BigUInt(static_cast<uint64_t>(-(v + 1)) + 1);
        } else {
            mag = BigUInt(static_cast<uint64_t>(v));
        }
    }
    BigInt(BigUInt m, bool ng = false) : mag(std::move(m)), neg(ng) {
        if (mag.isZero()) neg = false;
    }

    static BigInt fromString(const std::string& s) {
        if (!s.empty() && s[0] == '-') return BigInt(BigUInt::fromString(s.substr(1)), true);
        return BigInt(BigUInt::fromString(s), false);
    }

    bool isZero() const { return mag.isZero(); }

    friend int cmp(const BigInt& a, const BigInt& b) {
        if (a.neg != b.neg) return a.neg ? -1 : 1;
        int c = cmp(a.mag, b.mag);
        return a.neg ? -c : c;
    }
    friend bool operator==(const BigInt& a, const BigInt& b) { return cmp(a, b) == 0; }
    friend bool operator!=(const BigInt& a, const BigInt& b) { return cmp(a, b) != 0; }
    friend bool operator<(const BigInt& a, const BigInt& b) { return cmp(a, b) < 0; }
    friend bool operator<=(const BigInt& a, const BigInt& b) { return cmp(a, b) <= 0; }
    friend bool operator>(const BigInt& a, const BigInt& b) { return cmp(a, b) > 0; }
    friend bool operator>=(const BigInt& a, const BigInt& b) { return cmp(a, b) >= 0; }

    friend BigInt operator-(const BigInt& a) {
        BigInt r = a;
        if (!r.isZero()) r.neg = !r.neg;
        return r;
    }

    friend BigInt operator+(const BigInt& a, const BigInt& b) {
        if (a.neg == b.neg) return BigInt(a.mag + b.mag, a.neg);
        if (a.mag >= b.mag) return BigInt(a.mag - b.mag, a.neg);
        return BigInt(b.mag - a.mag, b.neg);
    }

    friend BigInt operator-(const BigInt& a, const BigInt& b) { return a + (-b); }

    friend BigInt operator*(const BigInt& a, const BigInt& b) {
        return BigInt(a.mag * b.mag, a.neg != b.neg);
    }

    // truncating division (like C++ integers)
    friend BigInt operator/(const BigInt& a, const BigInt& b) {
        return BigInt(a.mag / b.mag, a.neg != b.neg);
    }

    BigInt& operator+=(const BigInt& o) { return *this = *this + o; }
    BigInt& operator*=(const BigInt& o) { return *this = *this * o; }

    std::string toString() const { return neg ? "-" + mag.toString() : mag.toString(); }
};
