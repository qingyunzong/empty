#pragma once

#include <compare>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>

namespace geom {

// Exact rational number, always stored in lowest terms with a positive
// denominator. Arithmetic uses 128-bit intermediates to limit overflow.
class Rational {
public:
    using Int = std::int64_t;

    Rational() : num_(0), den_(1) {}
    Rational(Int value) : num_(value), den_(1) {}
    Rational(Int num, Int den) : num_(num), den_(den) {
        if (den_ == 0)
            throw std::invalid_argument("Rational: zero denominator");
        reduce();
    }

    Int num() const { return num_; }
    Int den() const { return den_; }

    friend Rational operator+(const Rational& a, const Rational& b) {
        return from_parts((__int128)a.num_ * b.den_ + (__int128)b.num_ * a.den_,
                          (__int128)a.den_ * b.den_);
    }
    friend Rational operator-(const Rational& a, const Rational& b) {
        return from_parts((__int128)a.num_ * b.den_ - (__int128)b.num_ * a.den_,
                          (__int128)a.den_ * b.den_);
    }
    friend Rational operator*(const Rational& a, const Rational& b) {
        return from_parts((__int128)a.num_ * b.num_, (__int128)a.den_ * b.den_);
    }
    friend Rational operator/(const Rational& a, const Rational& b) {
        if (b.num_ == 0)
            throw std::domain_error("Rational: division by zero");
        return from_parts((__int128)a.num_ * b.den_, (__int128)a.den_ * b.num_);
    }
    Rational operator-() const { return Rational(-num_, den_); }

    friend bool operator==(const Rational&, const Rational&) = default;
    friend std::strong_ordering operator<=>(const Rational& a, const Rational& b) {
        __int128 lhs = (__int128)a.num_ * b.den_;
        __int128 rhs = (__int128)b.num_ * a.den_;
        return lhs <=> rhs;
    }

    std::string to_string() const {
        if (den_ == 1)
            return std::to_string(num_);
        return std::to_string(num_) + "/" + std::to_string(den_);
    }

private:
    static Rational from_parts(__int128 num, __int128 den) {
        if (den < 0) {
            num = -num;
            den = -den;
        }
        __int128 g = gcd128(num < 0 ? -num : num, den);
        return Rational(static_cast<Int>(num / g), static_cast<Int>(den / g));
    }
    static __int128 gcd128(__int128 a, __int128 b) {
        while (b != 0) {
            __int128 t = a % b;
            a = b;
            b = t;
        }
        return a;
    }
    void reduce() {
        if (den_ < 0) {
            num_ = -num_;
            den_ = -den_;
        }
        Int g = std::gcd(num_, den_);
        num_ /= g;
        den_ /= g;
    }

    Int num_, den_;
};

inline Rational abs(const Rational& r) { return r < 0 ? -r : r; }

} // namespace geom
