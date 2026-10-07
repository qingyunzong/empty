#pragma once

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace sreach {

// Minimal non-negative arbitrary-precision integer (little-endian 64-bit limbs).
class BigInt {
public:
    BigInt() = default;
    BigInt(uint64_t v) {
        if (v) limbs_.push_back(v);
    }

    static BigInt fromString(const std::string& s) {
        if (s.empty()) throw std::invalid_argument("empty number");
        BigInt r;
        for (char c : s) {
            if (c < '0' || c > '9') throw std::invalid_argument("bad number: " + s);
            r.mulAddSmall(10, static_cast<uint64_t>(c - '0'));
        }
        return r;
    }

    bool isZero() const { return limbs_.empty(); }

    friend bool operator==(const BigInt& a, const BigInt& b) { return a.limbs_ == b.limbs_; }
    friend bool operator<(const BigInt& a, const BigInt& b) {
        if (a.limbs_.size() != b.limbs_.size()) return a.limbs_.size() < b.limbs_.size();
        for (size_t i = a.limbs_.size(); i-- > 0;)
            if (a.limbs_[i] != b.limbs_[i]) return a.limbs_[i] < b.limbs_[i];
        return false;
    }
    friend bool operator<=(const BigInt& a, const BigInt& b) { return !(b < a); }

    friend BigInt operator+(const BigInt& a, const BigInt& b) {
        BigInt r;
        size_t n = std::max(a.limbs_.size(), b.limbs_.size());
        r.limbs_.resize(n);
        uint64_t carry = 0;
        for (size_t i = 0; i < n; ++i) {
            uint64_t x = i < a.limbs_.size() ? a.limbs_[i] : 0;
            uint64_t y = i < b.limbs_.size() ? b.limbs_[i] : 0;
            uint64_t s = x + y;
            uint64_t c = s < x;
            uint64_t s2 = s + carry;
            c |= s2 < s;
            r.limbs_[i] = s2;
            carry = c;
        }
        if (carry) r.limbs_.push_back(carry);
        return r;
    }

    // Requires a >= b.
    friend BigInt operator-(const BigInt& a, const BigInt& b) {
        BigInt r;
        r.limbs_.resize(a.limbs_.size());
        uint64_t borrow = 0;
        for (size_t i = 0; i < a.limbs_.size(); ++i) {
            uint64_t x = a.limbs_[i];
            uint64_t y = i < b.limbs_.size() ? b.limbs_[i] : 0;
            uint64_t d = x - y;
            uint64_t bo = x < y;
            uint64_t d2 = d - borrow;
            bo |= d < borrow;
            r.limbs_[i] = d2;
            borrow = bo;
        }
        r.trim();
        return r;
    }

    friend BigInt operator*(const BigInt& a, const BigInt& b) {
        if (a.isZero() || b.isZero()) return BigInt();
        BigInt r;
        r.limbs_.assign(a.limbs_.size() + b.limbs_.size(), 0);
        for (size_t i = 0; i < a.limbs_.size(); ++i) {
            __uint128_t carry = 0;
            size_t j = 0;
            for (; j < b.limbs_.size(); ++j) {
                __uint128_t cur =
                    static_cast<__uint128_t>(a.limbs_[i]) * b.limbs_[j] + r.limbs_[i + j] + carry;
                r.limbs_[i + j] = static_cast<uint64_t>(cur);
                carry = cur >> 64;
            }
            for (size_t k = i + j; carry; ++k) {
                __uint128_t cur = static_cast<__uint128_t>(r.limbs_[k]) + static_cast<uint64_t>(carry);
                r.limbs_[k] = static_cast<uint64_t>(cur);
                carry = cur >> 64;
            }
        }
        r.trim();
        return r;
    }

    static std::pair<BigInt, BigInt> divmod(const BigInt& a, const BigInt& b) {
        if (b.isZero()) throw std::domain_error("division by zero");
        if (a < b) return {BigInt(), a};
        BigInt q, r;
        size_t nbits = a.bitLength();
        for (size_t i = nbits; i-- > 0;) {
            r.shl1();
            if (a.testBit(i)) r.setBit0();
            if (!(r < b)) {
                r = r - b;
                q.setBit(i);
            }
        }
        return {q, r};
    }

    friend BigInt operator/(const BigInt& a, const BigInt& b) { return divmod(a, b).first; }
    friend BigInt operator%(const BigInt& a, const BigInt& b) { return divmod(a, b).second; }

    static BigInt gcd(BigInt a, BigInt b) {
        while (!b.isZero()) {
            BigInt r = divmod(a, b).second;
            a = b;
            b = r;
        }
        return a;
    }

    std::string toString() const {
        if (isZero()) return "0";
        const uint64_t kBase = 10000000000000000000ULL;  // 1e19
        BigInt x = *this;
        std::vector<uint64_t> chunks;
        while (!x.isZero()) {
            auto [q, r] = x.divmodSmall(kBase);
            chunks.push_back(r);
            x = q;
        }
        std::string s = std::to_string(chunks.back());
        for (size_t i = chunks.size() - 1; i-- > 0;) {
            std::string part = std::to_string(chunks[i]);
            s.append(19 - part.size(), '0');
            s += part;
        }
        return s;
    }

private:
    std::vector<uint64_t> limbs_;

    void trim() {
        while (!limbs_.empty() && limbs_.back() == 0) limbs_.pop_back();
    }

    void mulAddSmall(uint64_t m, uint64_t a) {
        __uint128_t carry = a;
        for (auto& l : limbs_) {
            __uint128_t cur = static_cast<__uint128_t>(l) * m + carry;
            l = static_cast<uint64_t>(cur);
            carry = cur >> 64;
        }
        while (carry) {
            limbs_.push_back(static_cast<uint64_t>(carry));
            carry >>= 64;
        }
    }

    std::pair<BigInt, uint64_t> divmodSmall(uint64_t d) const {
        BigInt q;
        q.limbs_.resize(limbs_.size());
        __uint128_t rem = 0;
        for (size_t i = limbs_.size(); i-- > 0;) {
            __uint128_t cur = (rem << 64) | limbs_[i];
            q.limbs_[i] = static_cast<uint64_t>(cur / d);
            rem = cur % d;
        }
        q.trim();
        return {q, static_cast<uint64_t>(rem)};
    }

    void shl1() {
        uint64_t carry = 0;
        for (auto& l : limbs_) {
            uint64_t nc = l >> 63;
            l = (l << 1) | carry;
            carry = nc;
        }
        if (carry) limbs_.push_back(carry);
    }

    bool testBit(size_t i) const {
        size_t w = i / 64;
        return w < limbs_.size() && ((limbs_[w] >> (i % 64)) & 1);
    }

    void setBit(size_t i) {
        size_t w = i / 64;
        if (w >= limbs_.size()) limbs_.resize(w + 1, 0);
        limbs_[w] |= 1ULL << (i % 64);
    }

    void setBit0() {
        if (limbs_.empty())
            limbs_.push_back(1);
        else
            limbs_[0] |= 1;
    }

    size_t bitLength() const {
        if (limbs_.empty()) return 0;
        uint64_t top = limbs_.back();
        return 64 * (limbs_.size() - 1) + (64 - static_cast<size_t>(__builtin_clzll(top)));
    }
};

}  // namespace sreach
