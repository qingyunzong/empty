#pragma once

#include <cstdint>
#include <numeric>

namespace spatial {

#if defined(__SIZEOF_INT128__)
__extension__ typedef __int128 WideInt;
#else
typedef long long WideInt;  // fallback: coordinates must stay small
#endif

// Exact rational number: num/den with den > 0, kept in lowest terms.
struct Rational {
  std::int64_t num = 0;
  std::int64_t den = 1;
};

inline Rational make_rational(std::int64_t n, std::int64_t d) {
  if (d < 0) {
    n = -n;
    d = -d;
  }
  std::int64_t g = std::gcd(n, d);
  if (g < 0) g = -g;
  if (g > 1) {
    n /= g;
    d /= g;
  }
  return {n, d};
}

// Three-way comparison via 128-bit cross multiplication (exact, no FP).
inline int compare(Rational a, Rational b) {
  const WideInt lhs = static_cast<WideInt>(a.num) * b.den;
  const WideInt rhs = static_cast<WideInt>(b.num) * a.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

inline bool operator==(Rational a, Rational b) { return compare(a, b) == 0; }
inline bool operator!=(Rational a, Rational b) { return compare(a, b) != 0; }
inline bool operator<(Rational a, Rational b) { return compare(a, b) < 0; }
inline bool operator<=(Rational a, Rational b) { return compare(a, b) <= 0; }
inline bool operator>(Rational a, Rational b) { return compare(a, b) > 0; }
inline bool operator>=(Rational a, Rational b) { return compare(a, b) >= 0; }

}  // namespace spatial
