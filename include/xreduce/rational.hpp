#pragma once

#include <stdexcept>
#include <string>
#include <utility>

#include "bigint.hpp"

namespace xreduce {

// Exact rational number, always kept normalized: den > 0 and
// gcd(|num|, den) == 1. Zero is 0/1.
class Rational {
public:
  Rational() : num_(0), den_(1) {}
  Rational(long long v) : num_(v), den_(1) {}
  Rational(BigInt num) : num_(std::move(num)), den_(1) {}
  Rational(BigInt num, BigInt den)
      : num_(std::move(num)), den_(std::move(den)) {
    normalize();
  }

  const BigInt &num() const { return num_; }
  const BigInt &den() const { return den_; }

  friend bool operator==(const Rational &, const Rational &) = default;

  friend Rational operator+(const Rational &a, const Rational &b) {
    // a = n1/d1, b = n2/d2, g = gcd(d1, d2):
    // sum = (n1*(d2/g) + n2*(d1/g)) / (d1*(d2/g))
    BigInt g = BigInt::gcd(a.den_, b.den_);
    BigInt d2q = BigInt::div(b.den_, g);
    BigInt d1q = BigInt::div(a.den_, g);
    BigInt n = a.num_ * d2q + b.num_ * d1q;
    BigInt d = a.den_ * d2q;
    return Rational(std::move(n), std::move(d));
  }

  friend Rational operator-(const Rational &a, const Rational &b) {
    return a + Rational(-b.num_, b.den_);
  }

  friend Rational operator*(const Rational &a, const Rational &b) {
    return Rational(a.num_ * b.num_, a.den_ * b.den_);
  }

  std::string to_string() const {
    return num_.to_string() + "/" + den_.to_string();
  }

private:
  BigInt num_;
  BigInt den_;

  void normalize() {
    if (den_.is_zero())
      throw std::invalid_argument("Rational: zero denominator");
    if (den_.is_negative()) {
      num_ = -num_;
      den_ = -den_;
    }
    if (num_.is_zero()) {
      den_ = BigInt(1);
      return;
    }
    BigInt g = BigInt::gcd(num_.abs(), den_);
    if (!(g == BigInt(1))) {
      num_ = BigInt::div(num_, g);
      den_ = BigInt::div(den_, g);
    }
  }
};

} // namespace xreduce
