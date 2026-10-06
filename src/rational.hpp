#pragma once

#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>

namespace score {

// Reduced rational number used for exact beat arithmetic.
struct Rational {
    std::int64_t num = 0;
    std::int64_t den = 1;

    Rational() = default;
    Rational(std::int64_t n, std::int64_t d = 1) { assign(n, d); }

    void assign(std::int64_t n, std::int64_t d) {
        if (d == 0) throw std::invalid_argument("rational: zero denominator");
        if (d < 0) { n = -n; d = -d; }
        std::int64_t g = std::gcd(n < 0 ? -n : n, d);
        num = n / g;
        den = d / g;
    }

    Rational operator+(const Rational& o) const {
        return Rational(num * o.den + o.num * den, den * o.den);
    }
    Rational operator-(const Rational& o) const {
        return Rational(num * o.den - o.num * den, den * o.den);
    }
    Rational operator*(const Rational& o) const {
        return Rational(num * o.num, den * o.den);
    }
    Rational operator/(const Rational& o) const {
        if (o.num == 0) throw std::invalid_argument("rational: division by zero");
        return Rational(num * o.den, den * o.num);
    }

    bool operator==(const Rational& o) const = default;
    bool operator<(const Rational& o) const { return num * o.den < o.num * den; }

    bool is_zero() const { return num == 0; }

    std::string str() const {
        if (den == 1) return std::to_string(num);
        return std::to_string(num) + "/" + std::to_string(den);
    }
};

} // namespace score
