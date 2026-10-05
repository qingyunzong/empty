// Minimal signed arbitrary-precision integer, standard C++20 only.
// Used as the ground-truth "arbitrary precision model" and as the exact
// fallback when 128-bit arithmetic cannot hold a determinant.
#pragma once

#include <cstdint>
#include <vector>
#include <compare>
#include <string>

namespace geom {

class BigInt {
public:
    BigInt() = default;

    BigInt(std::int64_t v) {
        if (v < 0) { sign_ = -1; mag_ = {~static_cast<std::uint64_t>(v) + 1u}; }
        else       { mag_ = {static_cast<std::uint64_t>(v)}; }
        normalize();
    }

    BigInt(__int128 v) {
        unsigned __int128 u;
        if (v < 0) { sign_ = -1; u = ~static_cast<unsigned __int128>(v) + 1u; }
        else       { u = static_cast<unsigned __int128>(v); }
        mag_ = {static_cast<std::uint64_t>(u), static_cast<std::uint64_t>(u >> 64)};
        normalize();
    }

    bool is_zero() const { return mag_.empty(); }
    int sign() const { return is_zero() ? 0 : sign_; }

    std::strong_ordering operator<=>(const BigInt& o) const {
        if (sign() != o.sign()) return sign() <=> o.sign();
        int cmp = cmp_mag(*this, o);
        if (sign_ < 0) cmp = -cmp;
        return cmp <=> 0;
    }
    bool operator==(const BigInt& o) const = default;

    BigInt operator-() const { BigInt r = *this; if (!r.is_zero()) r.sign_ = -r.sign_; return r; }

    friend BigInt operator+(const BigInt& a, const BigInt& b) {
        if (a.is_zero()) return b;
        if (b.is_zero()) return a;
        BigInt r;
        if (a.sign_ == b.sign_) {
            r.mag_ = add_mag(a.mag_, b.mag_);
            r.sign_ = a.sign_;
        } else {
            int cmp = cmp_mag(a, b);
            if (cmp == 0) return BigInt{};
            if (cmp > 0) { r.mag_ = sub_mag(a.mag_, b.mag_); r.sign_ = a.sign_; }
            else         { r.mag_ = sub_mag(b.mag_, a.mag_); r.sign_ = b.sign_; }
        }
        r.normalize();
        return r;
    }
    friend BigInt operator-(const BigInt& a, const BigInt& b) { return a + (-b); }

    friend BigInt operator*(const BigInt& a, const BigInt& b) {
        if (a.is_zero() || b.is_zero()) return BigInt{};
        BigInt r;
        r.mag_.assign(a.mag_.size() + b.mag_.size(), 0);
        for (std::size_t i = 0; i < a.mag_.size(); ++i) {
            unsigned __int128 carry = 0;
            for (std::size_t j = 0; j < b.mag_.size(); ++j) {
                unsigned __int128 cur = r.mag_[i + j] + carry +
                    static_cast<unsigned __int128>(a.mag_[i]) * b.mag_[j];
                r.mag_[i + j] = static_cast<std::uint64_t>(cur);
                carry = cur >> 64;
            }
            std::size_t k = i + b.mag_.size();
            while (carry) {
                unsigned __int128 cur = static_cast<unsigned __int128>(r.mag_[k]) + carry;
                r.mag_[k] = static_cast<std::uint64_t>(cur);
                carry = cur >> 64;
                if (++k == r.mag_.size() && carry) r.mag_.push_back(0);
            }
        }
        r.sign_ = a.sign_ * b.sign_;
        r.normalize();
        return r;
    }

    std::string to_string() const; // defined in predicates.cpp

private:
    void normalize() {
        while (!mag_.empty() && mag_.back() == 0) mag_.pop_back();
        if (mag_.empty()) sign_ = 1;
    }
    static int cmp_mag(const BigInt& a, const BigInt& b) {
        if (a.mag_.size() != b.mag_.size()) return a.mag_.size() < b.mag_.size() ? -1 : 1;
        for (std::size_t i = a.mag_.size(); i-- > 0;)
            if (a.mag_[i] != b.mag_[i]) return a.mag_[i] < b.mag_[i] ? -1 : 1;
        return 0;
    }
    static std::vector<std::uint64_t> add_mag(const std::vector<std::uint64_t>& a,
                                              const std::vector<std::uint64_t>& b) {
        std::vector<std::uint64_t> r(std::max(a.size(), b.size()) + 1, 0);
        unsigned __int128 carry = 0;
        for (std::size_t i = 0; i + 1 < r.size(); ++i) {
            unsigned __int128 cur = carry;
            if (i < a.size()) cur += a[i];
            if (i < b.size()) cur += b[i];
            r[i] = static_cast<std::uint64_t>(cur);
            carry = cur >> 64;
        }
        r.back() = static_cast<std::uint64_t>(carry);
        return r;
    }
    // requires mag(a) >= mag(b)
    static std::vector<std::uint64_t> sub_mag(const std::vector<std::uint64_t>& a,
                                              const std::vector<std::uint64_t>& b) {
        std::vector<std::uint64_t> r = a;
        std::uint64_t borrow = 0;
        for (std::size_t i = 0; i < r.size(); ++i) {
            std::uint64_t bi = i < b.size() ? b[i] : 0;
            std::uint64_t sub = bi + borrow;
            // borrow out if (bi + borrow) overflowed or a[i] < sub
            borrow = (borrow && sub == 0) || r[i] < sub ? 1 : 0;
            r[i] -= sub;
        }
        return r;
    }

    int sign_ = 1;                   // -1 or +1 (zero is stored as empty mag_)
    std::vector<std::uint64_t> mag_; // little-endian 64-bit limbs
};

} // namespace geom
