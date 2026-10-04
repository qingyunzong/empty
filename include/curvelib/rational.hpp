#pragma once

// Exact rational arithmetic for intersection coordinates.
//
// Numerator and denominator are stored as int64_t in lowest terms with a
// positive denominator. All intermediate products are evaluated in __int128,
// so results are exact as long as the *reduced* values fit in int64_t.
// For input segment endpoints with |coordinate| <= C, any intersection
// coordinate has |num|, den <= 24*C^3, i.e. C up to ~7e5 is safe.

#include <cstdint>
#include <cstdlib>
#include <ostream>
#include <string>

namespace curvelib {

using WideInt = __int128;

namespace detail {
constexpr WideInt wideAbs(WideInt v) { return v < 0 ? -v : v; }

constexpr WideInt wideGcd(WideInt a, WideInt b) {
  a = wideAbs(a);
  b = wideAbs(b);
  while (b != 0) {
    WideInt t = a % b;
    a = b;
    b = t;
  }
  return a;
}
} // namespace detail

class Rational {
public:
  Rational() : num_(0), den_(1) {}
  Rational(std::int64_t n) : num_(n), den_(1) {}
  Rational(WideInt n, WideInt d) { assign(n, d); }

  std::int64_t num() const { return num_; }
  std::int64_t den() const { return den_; }

  bool isZero() const { return num_ == 0; }
  bool isInteger() const { return den_ == 1; }
  int sign() const { return (num_ > 0) - (num_ < 0); }

  Rational operator+(const Rational& o) const {
    return Rational(static_cast<WideInt>(num_) * o.den_ +
                        static_cast<WideInt>(o.num_) * den_,
                    static_cast<WideInt>(den_) * o.den_);
  }
  Rational operator-(const Rational& o) const {
    return Rational(static_cast<WideInt>(num_) * o.den_ -
                        static_cast<WideInt>(o.num_) * den_,
                    static_cast<WideInt>(den_) * o.den_);
  }
  Rational operator*(const Rational& o) const {
    return Rational(static_cast<WideInt>(num_) * o.num_,
                    static_cast<WideInt>(den_) * o.den_);
  }
  Rational operator/(const Rational& o) const {
    return Rational(static_cast<WideInt>(num_) * o.den_,
                    static_cast<WideInt>(den_) * o.num_);
  }
  Rational operator-() const { return Rational(-static_cast<WideInt>(num_), den_); }

  bool operator==(const Rational& o) const {
    return num_ == o.num_ && den_ == o.den_;
  }
  bool operator!=(const Rational& o) const { return !(*this == o); }
  bool operator<(const Rational& o) const {
    return static_cast<WideInt>(num_) * o.den_ <
           static_cast<WideInt>(o.num_) * den_;
  }
  bool operator<=(const Rational& o) const { return *this < o || *this == o; }
  bool operator>(const Rational& o) const { return o < *this; }
  bool operator>=(const Rational& o) const { return o <= *this; }

  double toDouble() const {
    return static_cast<double>(num_) / static_cast<double>(den_);
  }

  std::string toString() const {
    if (den_ == 1) return std::to_string(num_);
    return std::to_string(num_) + "/" + std::to_string(den_);
  }

private:
  void assign(WideInt n, WideInt d) {
    if (d < 0) {
      n = -n;
      d = -d;
    }
    WideInt g = detail::wideGcd(n, d);
    if (g == 0) g = 1; // 0/0 should not occur; keep 0/1
    num_ = static_cast<std::int64_t>(n / g);
    den_ = static_cast<std::int64_t>(d / g);
  }

  std::int64_t num_;
  std::int64_t den_;
};

inline std::ostream& operator<<(std::ostream& os, const Rational& r) {
  return os << r.toString();
}

} // namespace curvelib
