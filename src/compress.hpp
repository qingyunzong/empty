#pragma once

#include <string>
#include <vector>

// Cost model for dictionary-based segmentation compression:
//   total = dict_cost * (#distinct fragment types used)
//         + sum over each piece occurrence of (ref_cost + len_cost * piece_length)
struct CostParams {
    long long dict_cost = 0; // paid once per distinct fragment type
    long long ref_cost = 0;  // paid per reference (piece occurrence)
    long long len_cost = 0;  // paid per character of each occurrence
};

struct CompressResult {
    bool feasible = false;          // false when s cannot be tiled by candidates
    long long cost = 0;             // minimal total cost when feasible
    std::vector<std::string> pieces; // lexicographically smallest optimal sequence
};

// Exact solver. Constraints: s.size() <= 30, candidates.size() <= 18 (after
// deduplication). Runs an O(n * 2^m * m) subset DP over (position, used-types
// mask), then greedily reconstructs the lexicographically smallest optimal
// piece sequence.
CompressResult compress_min_cost(const std::string& s,
                                 std::vector<std::string> candidates,
                                 const CostParams& params);

// Reference implementation: exhaustively enumerates every segmentation of s
// into candidate fragments. Exponential; intended for verifying
// compress_min_cost on small inputs.
CompressResult compress_brute_force(const std::string& s,
                                    std::vector<std::string> candidates,
                                    const CostParams& params);
