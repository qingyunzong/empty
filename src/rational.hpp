#pragma once

#include "bigint.hpp"

namespace sreach {

// Exact non-negative rational, always normalized (den > 0, gcd(num, den) == 1).
class Rational {
public:
    BigInt num, den;

    Rational() : num(0), den(1) {}
    explicit Rational(uint64_t v) : num(v), den(1) {}
    Rational(BigInt n, BigInt d) {
        if (d.isZero()) throw std::invalid_argument("zero denominator");
        if (n.isZero()) {
            num = BigInt(0);
            den = BigInt(1);
            return;
        }
        BigInt g = BigInt::gcd(n, d);
        num = n / g;
        den = d / g;
    }

    static Rational one() { return Rational(BigInt(1), BigInt(1)); }

    std::string toString() const { return num.toString() + "/" + den.toString(); }

    friend bool operator==(const Rational& a, const Rational& b) {
        return a.num == b.num && a.den == b.den;
    }

    friend Rational operator+(const Rational& a, const Rational& b) {
        return Rational(a.num * b.den + b.num * a.den, a.den * b.den);
    }

    friend Rational operator*(const Rational& a, const Rational& b) {
        return Rational(a.num * b.num, a.den * b.den);
    }
};

// -1 / 0 / +1
inline int compare(const Rational& a, const Rational& b) {
    BigInt l = a.num * b.den;
    BigInt r = b.num * a.den;
    if (l < r) return -1;
    if (r < l) return 1;
    return 0;
}

}  // namespace sreach
