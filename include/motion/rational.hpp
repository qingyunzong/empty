#pragma once

// Exact rational arithmetic with checked 64-bit storage.
//
// All intermediate products are evaluated in 128-bit arithmetic and every
// result is reduced to lowest terms; any result that does not fit into
// 64-bit storage throws std::overflow_error, so values are always exact.

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

namespace motion {

class Rational {
public:
  using i128 = __int128_t;

  Rational() = default;
  Rational(std::int64_t num) : num_(num), den_(1) {} // NOLINT: implicit
  Rational(std::int64_t num, std::int64_t den) { assign(num, den); }

  [[nodiscard]] std::int64_t num() const { return num_; }
  [[nodiscard]] std::int64_t den() const { return den_; }

  Rational operator+() const { return *this; }
  Rational operator-() const {
    if (num_ == std::numeric_limits<std::int64_t>::min())
      throw std::overflow_error("Rational: negation overflow");
    return Rational(-num_, den_);
  }

  friend Rational operator+(const Rational& a, const Rational& b) {
    return reduced(static_cast<i128>(a.num_) * b.den_ +
                       static_cast<i128>(b.num_) * a.den_,
                   static_cast<i128>(a.den_) * b.den_);
  }
  friend Rational operator-(const Rational& a, const Rational& b) {
    return reduced(static_cast<i128>(a.num_) * b.den_ -
                       static_cast<i128>(b.num_) * a.den_,
                   static_cast<i128>(a.den_) * b.den_);
  }
  friend Rational operator*(const Rational& a, const Rational& b) {
    return reduced(static_cast<i128>(a.num_) * b.num_,
                   static_cast<i128>(a.den_) * b.den_);
  }
  friend Rational operator/(const Rational& a, const Rational& b) {
    if (b.num_ == 0) throw std::domain_error("Rational: division by zero");
    return reduced(static_cast<i128>(a.num_) * b.den_,
                   static_cast<i128>(a.den_) * b.num_);
  }

  Rational& operator+=(const Rational& o) { return *this = *this + o; }
  Rational& operator-=(const Rational& o) { return *this = *this - o; }
  Rational& operator*=(const Rational& o) { return *this = *this * o; }
  Rational& operator/=(const Rational& o) { return *this = *this / o; }

  friend bool operator==(const Rational& a, const Rational& b) {
    return a.num_ == b.num_ && a.den_ == b.den_;
  }
  friend bool operator!=(const Rational& a, const Rational& b) { return !(a == b); }
  friend bool operator<(const Rational& a, const Rational& b) {
    return static_cast<i128>(a.num_) * b.den_ < static_cast<i128>(b.num_) * a.den_;
  }
  friend bool operator>(const Rational& a, const Rational& b) { return b < a; }
  friend bool operator<=(const Rational& a, const Rational& b) { return !(b < a); }
  friend bool operator>=(const Rational& a, const Rational& b) { return !(a < b); }

  [[nodiscard]] std::string to_string() const {
    if (den_ == 1) return std::to_string(num_);
    return std::to_string(num_) + "/" + std::to_string(den_);
  }

private:
  std::int64_t num_ = 0;
  std::int64_t den_ = 1;

  void assign(std::int64_t num, std::int64_t den) {
    *this = reduced(static_cast<i128>(num), static_cast<i128>(den));
  }

  static i128 gcd(i128 a, i128 b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b != 0) {
      i128 t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  static std::int64_t narrow(i128 v) {
    if (v > std::numeric_limits<std::int64_t>::max() ||
        v < std::numeric_limits<std::int64_t>::min())
      throw std::overflow_error("Rational: value out of 64-bit range");
    return static_cast<std::int64_t>(v);
  }

  static Rational reduced(i128 num, i128 den) {
    if (den == 0) throw std::domain_error("Rational: zero denominator");
    if (den < 0) {
      num = -num;
      den = -den;
    }
    const i128 g = gcd(num, den);
    if (g > 1) {
      num /= g;
      den /= g;
    }
    Rational r;
    r.num_ = narrow(num);
    r.den_ = narrow(den);
    return r;
  }
};

} // namespace motion
