#pragma once

#include "ast.hpp"

#include <cstddef>
#include <functional>
#include <ostream>

namespace ar {

struct ReduceOptions {
  size_t max_trials = 100000;   // hard bound on predicate evaluations
  bool validate_syntax = true;  // re-parse every candidate before trying it
};

struct ReduceResult {
  Node tree;
  size_t trials = 0;
  size_t passes = 0;
  bool limit_hit = false;
};

using PredicateFn = std::function<bool(const Node&)>;

// Greedy fixpoint reduction. Every trial is syntactically valid (optionally
// re-verified by re-parsing) and a candidate is kept only if the predicate
// confirms the failure still reproduces. When the loop exits without hitting
// the trial limit, the result is 1-minimal: no single local transformation
// from enumerate_candidates() preserves the predicate. The full trial trace
// is written to `trace` as JSON Lines.
ReduceResult reduce(const Node& input, const PredicateFn& pred,
                    std::ostream& trace, const ReduceOptions& opts = {});

} // namespace ar
