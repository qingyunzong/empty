#include "geom/predicates.hpp"

#include <cfloat>
#include <cmath>
#include <cstdlib>
#include <iterator>

#include "geom/bigint.hpp"

#if defined(__SIZEOF_INT128__)
#define GEOM_HAS_I128 1
#endif

namespace geom {
namespace {

constexpr double kEpsilon = DBL_EPSILON / 2.0;  // 2^-53
// Shewchuk's error bounds for the float filters.
constexpr double kCcwErrboundA = (3.0 + 16.0 * kEpsilon) * kEpsilon;
constexpr double kIccErrboundA = (10.0 + 96.0 * kEpsilon) * kEpsilon;

// The float filter is only valid when every coordinate is exactly
// representable as a double (|coord| <= 2^53).
constexpr std::int64_t kFilterSafeCoord = std::int64_t{1} << 53;

// Conservative coordinate bound under which the exact determinants cannot
// overflow 128 bits (orient: |det| <= 2^62; incircle: |det| <= 2^124).
constexpr std::int64_t kI128SafeCoord = std::int64_t{1} << 29;

bool coords_within(const Point& p, std::int64_t bound) {
    return std::llabs(p.x) <= bound && std::llabs(p.y) <= bound;
}

int sign_of_permutation_parity(std::initializer_list<std::int64_t> ids) {
    int inversions = 0;
    for (auto a = ids.begin(); a != ids.end(); ++a)
        for (auto b = std::next(a); b != ids.end(); ++b)
            if (*a > *b) ++inversions;
    return (inversions % 2 == 0) ? +1 : -1;
}

#ifdef GEOM_HAS_I128
using i128 = __int128_t;

int orient2d_i128(const Point& a, const Point& b, const Point& c) {
    i128 acx = static_cast<i128>(a.x) - c.x;
    i128 acy = static_cast<i128>(a.y) - c.y;
    i128 bcx = static_cast<i128>(b.x) - c.x;
    i128 bcy = static_cast<i128>(b.y) - c.y;
    i128 det = acx * bcy - acy * bcx;
    return (det > 0) - (det < 0);
}

int incircle_i128(const Point& a, const Point& b, const Point& c,
                  const Point& d) {
    i128 adx = static_cast<i128>(a.x) - d.x;
    i128 ady = static_cast<i128>(a.y) - d.y;
    i128 bdx = static_cast<i128>(b.x) - d.x;
    i128 bdy = static_cast<i128>(b.y) - d.y;
    i128 cdx = static_cast<i128>(c.x) - d.x;
    i128 cdy = static_cast<i128>(c.y) - d.y;
    i128 alift = adx * adx + ady * ady;
    i128 blift = bdx * bdx + bdy * bdy;
    i128 clift = cdx * cdx + cdy * cdy;
    i128 det = alift * (bdx * cdy - cdx * bdy) +
               blift * (cdx * ady - adx * cdy) +
               clift * (adx * bdy - bdx * ady);
    return (det > 0) - (det < 0);
}
#endif  // GEOM_HAS_I128

}  // namespace

int id_rule(std::initializer_list<std::int64_t> ids) {
    return sign_of_permutation_parity(ids);
}

int orient2d_model(const Point& a, const Point& b, const Point& c) {
    BigInt acx = BigInt(a.x) - BigInt(c.x);
    BigInt acy = BigInt(a.y) - BigInt(c.y);
    BigInt bcx = BigInt(b.x) - BigInt(c.x);
    BigInt bcy = BigInt(b.y) - BigInt(c.y);
    return (acx * bcy - acy * bcx).sign();
}

int incircle_model(const Point& a, const Point& b, const Point& c,
                   const Point& d) {
    BigInt adx = BigInt(a.x) - BigInt(d.x);
    BigInt ady = BigInt(a.y) - BigInt(d.y);
    BigInt bdx = BigInt(b.x) - BigInt(d.x);
    BigInt bdy = BigInt(b.y) - BigInt(d.y);
    BigInt cdx = BigInt(c.x) - BigInt(d.x);
    BigInt cdy = BigInt(c.y) - BigInt(d.y);
    BigInt alift = adx * adx + ady * ady;
    BigInt blift = bdx * bdx + bdy * bdy;
    BigInt clift = cdx * cdx + cdy * cdy;
    BigInt det = alift * (bdx * cdy - cdx * bdy) +
                 blift * (cdx * ady - adx * cdy) +
                 clift * (adx * bdy - bdx * ady);
    return det.sign();
}

PredicateResult orient2d(const Point& a, const Point& b, const Point& c) {
    if (coords_within(a, kFilterSafeCoord) && coords_within(b, kFilterSafeCoord) &&
        coords_within(c, kFilterSafeCoord)) {
        double acx = static_cast<double>(a.x) - static_cast<double>(c.x);
        double acy = static_cast<double>(a.y) - static_cast<double>(c.y);
        double bcx = static_cast<double>(b.x) - static_cast<double>(c.x);
        double bcy = static_cast<double>(b.y) - static_cast<double>(c.y);
        double detleft = acx * bcy;
        double detright = acy * bcx;
        double det = detleft - detright;
        double errbound = kCcwErrboundA * (std::fabs(detleft) + std::fabs(detright));
        if (det > errbound) return {+1, false, Method::kFloatFilter};
        if (det < -errbound) return {-1, false, Method::kFloatFilter};
    }

    int exact = 0;
    Method method = Method::kExactBigInt;
#ifdef GEOM_HAS_I128
    if (coords_within(a, kI128SafeCoord) && coords_within(b, kI128SafeCoord) &&
        coords_within(c, kI128SafeCoord)) {
        exact = orient2d_i128(a, b, c);
        method = Method::kExactI128;
    } else
#endif
    {
        exact = orient2d_model(a, b, c);
        method = Method::kExactBigInt;
    }

    if (exact != 0) return {exact, false, method};
    return {id_rule({a.id, b.id, c.id}), true, method};
}

PredicateResult incircle(const Point& a, const Point& b, const Point& c,
                         const Point& d) {
    if (coords_within(a, kFilterSafeCoord) && coords_within(b, kFilterSafeCoord) &&
        coords_within(c, kFilterSafeCoord) && coords_within(d, kFilterSafeCoord)) {
        double adx = static_cast<double>(a.x) - static_cast<double>(d.x);
        double ady = static_cast<double>(a.y) - static_cast<double>(d.y);
        double bdx = static_cast<double>(b.x) - static_cast<double>(d.x);
        double bdy = static_cast<double>(b.y) - static_cast<double>(d.y);
        double cdx = static_cast<double>(c.x) - static_cast<double>(d.x);
        double cdy = static_cast<double>(c.y) - static_cast<double>(d.y);

        double bdxcdy = bdx * cdy;
        double cdxbdy = cdx * bdy;
        double cdxady = cdx * ady;
        double adxcdy = adx * cdy;
        double adxbdy = adx * bdy;
        double bdxady = bdx * ady;

        double alift = adx * adx + ady * ady;
        double blift = bdx * bdx + bdy * bdy;
        double clift = cdx * cdx + cdy * cdy;

        double det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) +
                     clift * (adxbdy - bdxady);
        double permanent = (std::fabs(bdxcdy) + std::fabs(cdxbdy)) * alift +
                           (std::fabs(cdxady) + std::fabs(adxcdy)) * blift +
                           (std::fabs(adxbdy) + std::fabs(bdxady)) * clift;
        double errbound = kIccErrboundA * permanent;
        if (det > errbound) return {+1, false, Method::kFloatFilter};
        if (det < -errbound) return {-1, false, Method::kFloatFilter};
    }

    int exact = 0;
    Method method = Method::kExactBigInt;
#ifdef GEOM_HAS_I128
    if (coords_within(a, kI128SafeCoord) && coords_within(b, kI128SafeCoord) &&
        coords_within(c, kI128SafeCoord) && coords_within(d, kI128SafeCoord)) {
        exact = incircle_i128(a, b, c, d);
        method = Method::kExactI128;
    } else
#endif
    {
        exact = incircle_model(a, b, c, d);
        method = Method::kExactBigInt;
    }

    if (exact != 0) return {exact, false, method};
    return {id_rule({a.id, b.id, c.id, d.id}), true, method};
}

}  // namespace geom
