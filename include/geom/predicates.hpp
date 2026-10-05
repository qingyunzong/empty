// Exact geometric predicates for integer-coordinate points.
//
// Strategy (Shewchuk-style adaptive evaluation):
//   1. A fast double-precision floating-point filter with a rigorous error
//      bound answers the easy cases.
//   2. When the filter cannot certify the sign, an exact integer evaluation
//      is used (__int128 when the value provably fits, arbitrary-precision
//      BigInt otherwise).
//   3. Degenerate (exactly zero) orientation is resolved deterministically
//      by a Simulation-of-Simplicity style ID rule: the sign is the parity
//      of the permutation that sorts (id_a, id_b, id_c) into increasing
//      order (even -> CCW/positive, odd -> CW/negative). This never returns
//      zero, so downstream algorithms see a consistent non-degenerate input.
//
// Every predicate reports whether the exact branch was taken, so callers
// can audit how often floating point alone was insufficient.
//
// Input domain: coordinates are int64_t with |coord| <= 2^62 (so that
// coordinate differences never overflow int64_t).
#pragma once

#include <cstdint>
#include "geom/bigint.hpp"

namespace geom {

struct Point {
    std::int64_t x = 0;
    std::int64_t y = 0;
    std::int64_t id = 0; // unique id, used by the degenerate-case ID rule
};

enum class Sign : int { negative = -1, zero = 0, positive = 1 };

struct PredicateResult {
    Sign sign;
    bool used_exact; // true iff the floating-point filter was inconclusive
};

// Orientation of the triple (a, b, c).
// positive = counter-clockwise, negative = clockwise.
// Exactly-collinear triples are resolved by the ID rule (never returns zero
// unless sos_tiebreak is false).
PredicateResult orient2d(const Point& a, const Point& b, const Point& c,
                         bool sos_tiebreak = true);

// Incircle test: is d inside the circle through (a, b, c)?
// positive = inside, negative = outside, assuming (a, b, c) is CCW
// (the sign is automatically corrected if (a, b, c) is CW).
// Exactly-cocircular quadruples return zero; sos_tiebreak resolves them
// with the same ID-parity rule applied to (a, b, c, d).
PredicateResult incircle(const Point& a, const Point& b, const Point& c,
                         const Point& d, bool sos_tiebreak = true);

// ---- Arbitrary-precision reference model (always exact, always BigInt) ----
// Used by the tests to cross-check the adaptive predicates, including the
// near-collinear / near-cocircular extreme cases.
Sign orient2d_model(const Point& a, const Point& b, const Point& c);
Sign incircle_model(const Point& a, const Point& b, const Point& c, const Point& d);

} // namespace geom
