#pragma once

#include "statlib/bigint.hpp"

#include <iosfwd>
#include <string>

namespace statlib {

// Exact rational number, always kept in lowest terms with a positive
// denominator. All statistics are reported through this type; no floating
// point is involved anywhere.
class Rational {
public:
    Rational() = default;  // 0/1
    Rational(BigInt num) : num_(std::move(num)), den_(BigInt(1)) {}
    Rational(BigInt num, BigInt den);  // normalizes; throws if den == 0

    const BigInt& num() const { return num_; }
    const BigInt& den() const { return den_; }

    Rational operator-() const { return Rational(-num_, den_); }

    Rational& operator+=(const Rational& rhs);
    Rational& operator-=(const Rational& rhs);
    Rational& operator*=(const Rational& rhs);
    Rational& operator/=(const Rational& rhs);

    friend Rational operator+(Rational a, const Rational& b) { return a += b; }
    friend Rational operator-(Rational a, const Rational& b) { return a -= b; }
    friend Rational operator*(Rational a, const Rational& b) { return a *= b; }
    friend Rational operator/(Rational a, const Rational& b) { return a /= b; }

    bool operator==(const Rational&) const = default;
    auto operator<=>(const Rational& rhs) const { return num_ * rhs.den_ <=> rhs.num_ * den_; }

    std::string to_string() const;  // "n" if integral, else "n/d"
    friend std::ostream& operator<<(std::ostream& os, const Rational& v);

private:
    BigInt num_;
    BigInt den_ = BigInt(1);
};

}  // namespace statlib
