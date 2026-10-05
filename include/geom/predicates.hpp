#pragma once

// Robust geometric predicates for integer-coordinate points.
//
// Evaluation tiers:
//   1. kFloatFilter  - double arithmetic with a Shewchuk-style error bound;
//                      only a filter, never trusted when the result is
//                      uncertain or inputs are not exactly representable.
//   2. kExactI128    - exact 128-bit integer arithmetic (when coordinates
//                      are small enough that no overflow is possible).
//   3. kExactBigInt  - arbitrary-precision integer arithmetic (always exact).
//
// Degenerate (exactly zero) results are resolved deterministically by an
// ID rule: the sign is the parity of the permutation that sorts the point
// IDs (Simulation-of-Simplicity style tie-breaking). The rule is
// antisymmetric: swapping any two arguments flips the sign.

#include <cstdint>
#include <initializer_list>

namespace geom {

struct Point {
    std::int64_t id;
    std::int64_t x;
    std::int64_t y;
};

enum class Method {
    kFloatFilter,
    kExactI128,
    kExactBigInt,
};

struct PredicateResult {
    int sign;        // +1 or -1; never 0 (degeneracy resolved by the ID rule)
    bool degenerate; // true when the exact value was zero and the ID rule fired
    Method method;   // which tier produced the answer

    bool used_exact() const { return method != Method::kFloatFilter; }
};

// Positive when c is left of the directed line a->b (a,b,c counterclockwise).
PredicateResult orient2d(const Point& a, const Point& b, const Point& c);

// Positive when d is strictly inside the circle through a,b,c.
// Assumes a,b,c are counterclockwise; negate the sign for clockwise input.
PredicateResult incircle(const Point& a, const Point& b, const Point& c,
                         const Point& d);

// Arbitrary-precision reference models (ground truth). Return -1/0/+1 with
// NO ID-rule tie-breaking, so tests can compare against the exact tiers.
int orient2d_model(const Point& a, const Point& b, const Point& c);
int incircle_model(const Point& a, const Point& b, const Point& c,
                   const Point& d);

// The ID rule itself, exposed for testing: +1 for even, -1 for odd
// permutation parity of the given ID sequence (IDs must be distinct).
int id_rule(std::initializer_list<std::int64_t> ids);

}  // namespace geom
