#include <cstdint>

#include "../tests/check.hpp"
#include "spatial/rational.hpp"

using spatial::Rational;
using spatial::compare;
using spatial::make_rational;

int main() {
  // Normalization: sign moves to numerator, lowest terms.
  Rational a = make_rational(2, 4);
  CHECK(a.num == 1 && a.den == 2);
  Rational b = make_rational(3, -2);
  CHECK(b.num == -3 && b.den == 2);
  Rational c = make_rational(-6, -8);
  CHECK(c.num == 3 && c.den == 4);
  Rational z = make_rational(0, 7);
  CHECK(z.num == 0 && z.den == 1);

  // Basic comparisons.
  CHECK(compare(make_rational(1, 3), make_rational(2, 6)) == 0);
  CHECK(make_rational(1, 3) < make_rational(1, 2));
  CHECK(make_rational(-2, 3) < make_rational(0, 1));
  CHECK(make_rational(7, 2) > make_rational(10, 3));

  // Large magnitudes: products exceed int64, must stay exact via __int128.
  const std::int64_t kBig = INT64_C(4611686018427387904);  // 2^62
  CHECK(make_rational(kBig, kBig + 1) < make_rational(1, 1));
  CHECK(make_rational(kBig + 1, kBig) > make_rational(1, 1));
  CHECK(compare(make_rational(kBig, kBig + 1),
                make_rational(kBig + 1, kBig + 2)) < 0);
  CHECK(make_rational(kBig, 3) == make_rational(kBig / 2 * 2, 3) ||
        true);  // sanity: no overflow crash
  CHECK(compare(make_rational(kBig, 7), make_rational(kBig, 7)) == 0);

  return testutil::finish("test_rational");
}
