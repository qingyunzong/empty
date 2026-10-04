#pragma once

#include <cstdint>
#include <algorithm>
#include <ostream>
#include <string>

namespace curve2d {

using i128 = __int128_t;
using u128 = __uint128_t;

inline i128 abs128(i128 v) { return v < 0 ? -v : v; }

inline i128 gcd128(i128 a, i128 b) {
  a = abs128(a);
  b = abs128(b);
  while (b != 0) {
    i128 t = a % b;
    a = b;
    b = t;
  }
  return a == 0 ? 1 : a;
}

inline std::string toString128(i128 v) {
  if (v == 0) return "0";
  bool neg = v < 0;
  u128 u = neg ? static_cast<u128>(-v) : static_cast<u128>(v);
  std::string s;
  while (u != 0) {
    s.push_back(static_cast<char>('0' + u % 10));
    u /= 10;
  }
  if (neg) s.push_back('-');
  std::reverse(s.begin(), s.end());
  return s;
}

// Exact rational number, always kept normalized: den > 0, gcd(|num|, den) == 1.
class Rational {
public:
  Rational() : num_(0), den_(1) {}
  Rational(int64_t v) : num_(v), den_(1) {}
  Rational(i128 n, i128 d) { assign(n, d); }

  i128 num() const { return num_; }
  i128 den() const { return den_; }

  bool isZero() const { return num_ == 0; }
  int sign() const { return num_ > 0 ? 1 : (num_ < 0 ? -1 : 0); }

  Rational operator+(const Rational& o) const {
    return Rational(num_ * o.den_ + o.num_ * den_, den_ * o.den_);
  }
  Rational operator-(const Rational& o) const {
    return Rational(num_ * o.den_ - o.num_ * den_, den_ * o.den_);
  }
  Rational operator*(const Rational& o) const {
    return Rational(num_ * o.num_, den_ * o.den_);
  }
  Rational operator/(const Rational& o) const {
    return Rational(num_ * o.den_, den_ * o.num_);
  }
  Rational operator-() const { return Rational(-num_, den_); }

  bool operator==(const Rational& o) const {
    return num_ == o.num_ && den_ == o.den_;
  }
  bool operator!=(const Rational& o) const { return !(*this == o); }
  bool operator<(const Rational& o) const { return num_ * o.den_ < o.num_ * den_; }
  bool operator<=(const Rational& o) const { return num_ * o.den_ <= o.num_ * den_; }
  bool operator>(const Rational& o) const { return o < *this; }
  bool operator>=(const Rational& o) const { return o <= *this; }

  std::string toString() const {
    if (den_ == 1) return toString128(num_);
    return toString128(num_) + "/" + toString128(den_);
  }

private:
  void assign(i128 n, i128 d) {
    if (d < 0) {
      n = -n;
      d = -d;
    }
    i128 g = gcd128(n, d);
    num_ = n / g;
    den_ = d / g;
  }

  i128 num_;
  i128 den_;
};

inline std::ostream& operator<<(std::ostream& os, const Rational& r) {
  return os << r.toString();
}

} // namespace curve2d
