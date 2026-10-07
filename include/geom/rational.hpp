#pragma once

#include <cstdint>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>

namespace geom {

// Exact rational number with normalized (reduced, denominator > 0) storage.
// Arithmetic is carried out in 128-bit integers and reduced on every step.
class Rational {
public:
    Rational() = default;
    Rational(std::int64_t n) : num_(n), den_(1) {}
    Rational(std::int64_t n, std::int64_t d) {
        if (d == 0) throw std::invalid_argument("Rational: zero denominator");
        num_ = n;
        den_ = d;
        normalize();
    }

    std::int64_t num() const { return num_; }
    std::int64_t den() const { return den_; }

    friend bool operator==(const Rational&, const Rational&) = default;
    friend auto operator<=>(const Rational& a, const Rational& b) {
        const __int128 lhs = static_cast<__int128>(a.num_) * b.den_;
        const __int128 rhs = static_cast<__int128>(b.num_) * a.den_;
        return lhs <=> rhs;
    }

    friend Rational operator+(const Rational& a, const Rational& b) {
        return from_parts(static_cast<__int128>(a.num_) * b.den_ +
                              static_cast<__int128>(b.num_) * a.den_,
                          static_cast<__int128>(a.den_) * b.den_);
    }
    friend Rational operator-(const Rational& a, const Rational& b) {
        return from_parts(static_cast<__int128>(a.num_) * b.den_ -
                              static_cast<__int128>(b.num_) * a.den_,
                          static_cast<__int128>(a.den_) * b.den_);
    }
    friend Rational operator-(const Rational& a) { return Rational(-a.num_, a.den_); }
    friend Rational operator*(const Rational& a, const Rational& b) {
        return from_parts(static_cast<__int128>(a.num_) * b.num_,
                          static_cast<__int128>(a.den_) * b.den_);
    }
    friend Rational operator/(const Rational& a, const Rational& b) {
        if (b.num_ == 0) throw std::domain_error("Rational: division by zero");
        return from_parts(static_cast<__int128>(a.num_) * b.den_,
                          static_cast<__int128>(a.den_) * b.num_);
    }

    Rational& operator+=(const Rational& o) { return *this = *this + o; }
    Rational& operator-=(const Rational& o) { return *this = *this - o; }
    Rational& operator*=(const Rational& o) { return *this = *this * o; }
    Rational& operator/=(const Rational& o) { return *this = *this / o; }

    friend Rational abs(const Rational& r) {
        return r.num_ < 0 ? Rational(-r.num_, r.den_) : r;
    }

    double to_double() const {
        return static_cast<double>(num_) / static_cast<double>(den_);
    }

    std::string to_string() const {
        if (den_ == 1) return std::to_string(num_);
        return std::to_string(num_) + "/" + std::to_string(den_);
    }

private:
    static Rational from_parts(__int128 n, __int128 d) {
        if (d == 0) throw std::domain_error("Rational: zero denominator");
        if (d < 0) {
            n = -n;
            d = -d;
        }
        const __int128 g = gcd128(n < 0 ? -n : n, d);
        n /= g;
        d /= g;
        if (n > std::numeric_limits<std::int64_t>::max() ||
            n < std::numeric_limits<std::int64_t>::min() ||
            d > std::numeric_limits<std::int64_t>::max())
            throw std::overflow_error("Rational: value out of int64 range");
        Rational r;
        r.num_ = static_cast<std::int64_t>(n);
        r.den_ = static_cast<std::int64_t>(d);
        return r;
    }

    static __int128 gcd128(__int128 a, __int128 b) {
        while (b != 0) {
            const __int128 t = a % b;
            a = b;
            b = t;
        }
        return a == 0 ? static_cast<__int128>(1) : a;
    }

    void normalize() {
        if (den_ < 0) {
            num_ = -num_;
            den_ = -den_;
        }
        const std::int64_t g = std::gcd(num_, den_);
        num_ /= g;
        den_ /= g;
    }

    std::int64_t num_ = 0;
    std::int64_t den_ = 1;
};

} // namespace geom
