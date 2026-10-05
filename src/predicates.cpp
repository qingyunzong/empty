#include "geom/predicates.hpp"

#include <cstdlib>
#include <cmath>
#include <limits>
#include <initializer_list>

namespace geom {

// ---------------------------------------------------------------------------
// BigInt decimal printing (used for diagnostics / test output)
// ---------------------------------------------------------------------------
std::string BigInt::to_string() const {
    if (is_zero()) return "0";
    std::vector<std::uint64_t> mag = mag_;
    std::string digits;
    const std::uint64_t base = 10000000000000000000ull; // 10^19
    while (!mag.empty()) {
        unsigned __int128 rem = 0;
        for (std::size_t i = mag.size(); i-- > 0;) {
            unsigned __int128 cur = (rem << 64) | mag[i];
            mag[i] = static_cast<std::uint64_t>(cur / base);
            rem = cur % base;
        }
        while (!mag.empty() && mag.back() == 0) mag.pop_back();
        std::uint64_t chunk = static_cast<std::uint64_t>(rem);
        if (mag.empty()) {
            digits = std::to_string(chunk) + digits;
        } else {
            std::string part = std::to_string(chunk);
            digits = std::string(19 - part.size(), '0') + part + digits;
        }
    }
    return sign_ < 0 ? "-" + digits : digits;
}

namespace {

constexpr double kEpsilon = 0.5 * std::numeric_limits<double>::epsilon(); // 2^-53
// Shewchuk's certified error bounds for the floating-point filters.
const double kOrientErrbound = (3.0 + 16.0 * kEpsilon) * kEpsilon;
const double kIncircleErrbound = (10.0 + 96.0 * kEpsilon) * kEpsilon;

inline Sign sign_of(int cmp) {
    return cmp > 0 ? Sign::positive : cmp < 0 ? Sign::negative : Sign::zero;
}

// Parity of the permutation that sorts ids into increasing order.
// Returns +1 for even, -1 for odd, 0 if ids are not unique (rule undefined).
int id_parity(std::initializer_list<std::int64_t> ids) {
    std::vector<std::int64_t> v(ids);
    int inversions = 0;
    for (std::size_t i = 0; i < v.size(); ++i)
        for (std::size_t j = i + 1; j < v.size(); ++j) {
            if (v[i] == v[j]) return 0;
            if (v[i] > v[j]) ++inversions;
        }
    return (inversions % 2 == 0) ? 1 : -1;
}

// ---- exact integer kernels -------------------------------------------------

// True when every |coord| <= 2^62, so coordinate differences fit in 63 bits
// and the orient determinant (degree 2) provably fits in a signed __int128.
bool fits_orient_i128(const Point& a, const Point& b, const Point& c) {
    const std::int64_t lim = std::int64_t{1} << 62;
    auto ok = [lim](const Point& p) {
        return std::abs(p.x) <= lim && std::abs(p.y) <= lim;
    };
    return ok(a) && ok(b) && ok(c);
}

Sign orient_exact_i128(const Point& a, const Point& b, const Point& c) {
    __int128 acx = static_cast<__int128>(a.x) - c.x;
    __int128 acy = static_cast<__int128>(a.y) - c.y;
    __int128 bcx = static_cast<__int128>(b.x) - c.x;
    __int128 bcy = static_cast<__int128>(b.y) - c.y;
    __int128 det = acx * bcy - acy * bcx;
    return sign_of(det > 0 ? 1 : det < 0 ? -1 : 0);
}

// True when every |coord| <= 2^30, so the incircle determinant (degree 4)
// provably fits in a signed __int128.
bool fits_incircle_i128(const Point& a, const Point& b, const Point& c, const Point& d) {
    const std::int64_t lim = std::int64_t{1} << 30;
    auto ok = [lim](const Point& p) {
        return std::abs(p.x) <= lim && std::abs(p.y) <= lim;
    };
    return ok(a) && ok(b) && ok(c) && ok(d);
}

Sign incircle_exact_i128(const Point& a, const Point& b, const Point& c, const Point& d) {
    __int128 adx = static_cast<__int128>(a.x) - d.x, ady = static_cast<__int128>(a.y) - d.y;
    __int128 bdx = static_cast<__int128>(b.x) - d.x, bdy = static_cast<__int128>(b.y) - d.y;
    __int128 cdx = static_cast<__int128>(c.x) - d.x, cdy = static_cast<__int128>(c.y) - d.y;
    __int128 abdet = adx * bdy - bdx * ady;
    __int128 bcdet = bdx * cdy - cdx * bdy;
    __int128 cadet = cdx * ady - adx * cdy;
    __int128 alift = adx * adx + ady * ady;
    __int128 blift = bdx * bdx + bdy * bdy;
    __int128 clift = cdx * cdx + cdy * cdy;
    __int128 det = alift * bcdet + blift * cadet + clift * abdet;
    return sign_of(det > 0 ? 1 : det < 0 ? -1 : 0);
}

} // namespace

// ---- arbitrary-precision reference model -----------------------------------

Sign orient2d_model(const Point& a, const Point& b, const Point& c) {
    BigInt acx = BigInt(a.x) - BigInt(c.x);
    BigInt acy = BigInt(a.y) - BigInt(c.y);
    BigInt bcx = BigInt(b.x) - BigInt(c.x);
    BigInt bcy = BigInt(b.y) - BigInt(c.y);
    BigInt det = acx * bcy - acy * bcx;
    return sign_of(det.sign());
}

Sign incircle_model(const Point& a, const Point& b, const Point& c, const Point& d) {
    BigInt adx = BigInt(a.x) - BigInt(d.x), ady = BigInt(a.y) - BigInt(d.y);
    BigInt bdx = BigInt(b.x) - BigInt(d.x), bdy = BigInt(b.y) - BigInt(d.y);
    BigInt cdx = BigInt(c.x) - BigInt(d.x), cdy = BigInt(c.y) - BigInt(d.y);
    BigInt abdet = adx * bdy - bdx * ady;
    BigInt bcdet = bdx * cdy - cdx * bdy;
    BigInt cadet = cdx * ady - adx * cdy;
    BigInt alift = adx * adx + ady * ady;
    BigInt blift = bdx * bdx + bdy * bdy;
    BigInt clift = cdx * cdx + cdy * cdy;
    BigInt det = alift * bcdet + blift * cadet + clift * abdet;
    int s = det.sign();
    // Correct for triangle winding so positive always means "inside".
    if (orient2d_model(a, b, c) == Sign::negative) s = -s;
    return sign_of(s);
}

// ---- adaptive predicates ----------------------------------------------------

PredicateResult orient2d(const Point& a, const Point& b, const Point& c, bool sos_tiebreak) {
    const double acx = static_cast<double>(a.x) - static_cast<double>(c.x);
    const double acy = static_cast<double>(a.y) - static_cast<double>(c.y);
    const double bcx = static_cast<double>(b.x) - static_cast<double>(c.x);
    const double bcy = static_cast<double>(b.y) - static_cast<double>(c.y);

    const double detleft = acx * bcy;
    const double detright = acy * bcx;
    const double det = detleft - detright;
    const double permanent = std::abs(detleft) + std::abs(detright);
    const double errbound = kOrientErrbound * permanent;

    if (det > errbound)  return {Sign::positive, false};
    if (det < -errbound) return {Sign::negative, false};

    // Filter inconclusive -> exact integer branch.
    Sign exact = fits_orient_i128(a, b, c) ? orient_exact_i128(a, b, c)
                                           : orient2d_model(a, b, c);
    if (exact != Sign::zero || !sos_tiebreak) return {exact, true};

    // Degenerate collinear: deterministic ID rule (SoS-style).
    int p = id_parity({a.id, b.id, c.id});
    return {p > 0 ? Sign::positive : p < 0 ? Sign::negative : Sign::zero, true};
}

PredicateResult incircle(const Point& a, const Point& b, const Point& c,
                         const Point& d, bool sos_tiebreak) {
    const double adx = static_cast<double>(a.x) - static_cast<double>(d.x);
    const double ady = static_cast<double>(a.y) - static_cast<double>(d.y);
    const double bdx = static_cast<double>(b.x) - static_cast<double>(d.x);
    const double bdy = static_cast<double>(b.y) - static_cast<double>(d.y);
    const double cdx = static_cast<double>(c.x) - static_cast<double>(d.x);
    const double cdy = static_cast<double>(c.y) - static_cast<double>(d.y);

    const double abdet = adx * bdy - bdx * ady;
    const double bcdet = bdx * cdy - cdx * bdy;
    const double cadet = cdx * ady - adx * cdy;
    const double alift = adx * adx + ady * ady;
    const double blift = bdx * bdx + bdy * bdy;
    const double clift = cdx * cdx + cdy * cdy;

    const double det = alift * bcdet + blift * cadet + clift * abdet;
    const double permanent =
        (std::abs(bcdet) + std::abs(cadet)) * alift +
        (std::abs(cadet) + std::abs(abdet)) * blift +
        (std::abs(abdet) + std::abs(bcdet)) * clift;
    const double errbound = kIncircleErrbound * permanent;

    // Winding correction: the determinant sign assumes CCW (a, b, c).
    // The adaptive orient filter is exact whenever the answer matters.
    const Sign winding = orient2d(a, b, c, /*sos_tiebreak=*/false).sign;

    if (det > errbound || det < -errbound) {
        Sign s = det > errbound ? Sign::positive : Sign::negative;
        if (winding == Sign::negative) s = static_cast<Sign>(-static_cast<int>(s));
        return {s, false};
    }

    // Filter inconclusive -> exact integer branch.
    Sign exact;
    if (fits_incircle_i128(a, b, c, d)) {
        exact = incircle_exact_i128(a, b, c, d);
        if (winding == Sign::negative)
            exact = static_cast<Sign>(-static_cast<int>(exact));
    } else {
        exact = incircle_model(a, b, c, d); // model applies winding itself
    }

    if (exact != Sign::zero || !sos_tiebreak) return {exact, true};

    // Degenerate cocircular: deterministic ID rule (SoS-style).
    int p = id_parity({a.id, b.id, c.id, d.id});
    return {p > 0 ? Sign::positive : p < 0 ? Sign::negative : Sign::zero, true};
}

} // namespace geom
