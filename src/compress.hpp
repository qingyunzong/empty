#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace comp {

// Cost model:
//   total = sum over distinct fragment types  (dict_flat + dict_per_char * len)
//         + sum over all fragment occurrences (ref_flat  + ref_per_char * len)
struct CostModel {
    long long dict_per_char = 1; // one-time dictionary fee per char of a new fragment
    long long ref_per_char  = 1; // reference fee per char, paid on every occurrence
    long long dict_flat     = 0; // one-time flat fee per new fragment type
    long long ref_flat      = 0; // flat fee per reference (occurrence)
};

struct Solution {
    bool ok = false;                 // false if no segmentation satisfies the constraints
    long long cost = 0;              // minimal total cost
    std::vector<std::string> pieces; // lexicographically smallest sequence among optima
};

// Solve the optimal dictionary-fragment segmentation of `s` (|s| <= 30).
// At most `max_distinct` distinct fragment types may be used.
Solution solve(const std::string& s, CostModel model = {}, std::size_t max_distinct = 18);

// Reference brute force over all 2^(n-1) segmentations (for verification/tests).
Solution solve_brute(const std::string& s, CostModel model = {}, std::size_t max_distinct = 18);

} // namespace comp
