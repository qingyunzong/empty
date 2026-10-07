#pragma once

#include "exact_stats/bigint.hpp"

#include <compare>
#include <stdexcept>
#include <string>
#include <utility>

namespace exact_stats {

// Exact rational number, always kept in canonical form:
// denominator > 0, gcd(|num|, den) == 1, zero represented as 0/1.
class Rational {
public:
    Rational() = default;
    Rational(BigInt num) : num_(std::move(num)), den_(BigInt(1)) {}
    Rational(long long value) : num_(value), den_(BigInt(1)) {}
    Rational(BigInt num, BigInt den) : num_(std::move(num)), den_(std::move(den)) {
        if (den_.is_zero()) throw std::domain_error("Rational with zero denominator");
        normalize();
    }

    const BigInt& num() const { return num_; }
    const BigInt& den() const { return den_; }

    friend bool operator==(const Rational& a, const Rational& b) {
        return a.num_ == b.num_ && a.den_ == b.den_;
    }
    friend std::strong_ordering operator<=>(const Rational& a, const Rational& b) {
        return a.num_ * b.den_ <=> b.num_ * a.den_;
    }

    friend Rational operator+(const Rational& a, const Rational& b) {
        return Rational(a.num_ * b.den_ + b.num_ * a.den_, a.den_ * b.den_);
    }
    friend Rational operator-(const Rational& a, const Rational& b) {
        return Rational(a.num_ * b.den_ - b.num_ * a.den_, a.den_ * b.den_);
    }
    friend Rational operator*(const Rational& a, const Rational& b) {
        return Rational(a.num_ * b.num_, a.den_ * b.den_);
    }
    friend Rational operator/(const Rational& a, const Rational& b) {
        if (b.num_.is_zero()) throw std::domain_error("Rational division by zero");
        BigInt n = a.num_ * b.den_;
        BigInt d = a.den_ * b.num_;
        if (d.is_negative()) { n = -n; d = -d; }
        return Rational(std::move(n), std::move(d));
    }
    Rational operator-() const { return Rational(-num_, den_); }

    Rational& operator+=(const Rational& o) { return *this = *this + o; }
    Rational& operator-=(const Rational& o) { return *this = *this - o; }
    Rational& operator*=(const Rational& o) { return *this = *this * o; }
    Rational& operator/=(const Rational& o) { return *this = *this / o; }

    std::string to_string() const {
        if (den_ == BigInt(1)) return num_.to_string();
        return num_.to_string() + "/" + den_.to_string();
    }

private:
    BigInt num_;
    BigInt den_;

    void normalize() {
        if (den_.is_negative()) { num_ = -num_; den_ = -den_; }
        if (num_.is_zero()) { den_ = BigInt(1); return; }
        BigInt g = gcd(num_, den_);
        if (g != BigInt(1)) {
            num_ = num_ / g;
            den_ = den_ / g;
        }
    }
};

} // namespace exact_stats
