#include "compress.hpp"

#include <algorithm>
#include <limits>
#include <stdexcept>

namespace {

constexpr long long kInf = std::numeric_limits<long long>::max() / 4;

// Deduplicates, drops empty fragments, and sorts so that greedy
// reconstruction yields the lexicographically smallest piece sequence.
std::vector<std::string> normalize(std::vector<std::string> candidates) {
    candidates.erase(
        std::remove_if(candidates.begin(), candidates.end(),
                       [](const std::string& c) { return c.empty(); }),
        candidates.end());
    std::sort(candidates.begin(), candidates.end());
    candidates.erase(std::unique(candidates.begin(), candidates.end()),
                     candidates.end());
    return candidates;
}

// Indices of candidates matching s at pos, in ascending (sorted) order.
std::vector<std::vector<int>> match_table(const std::string& s,
                                          const std::vector<std::string>& cand) {
    const int n = static_cast<int>(s.size());
    std::vector<std::vector<int>> table(n);
    for (int pos = 0; pos < n; ++pos) {
        for (int i = 0; i < static_cast<int>(cand.size()); ++i) {
            const std::string& c = cand[i];
            if (c.size() <= static_cast<size_t>(n - pos) &&
                s.compare(pos, c.size(), c) == 0) {
                table[pos].push_back(i);
            }
        }
    }
    return table;
}

long long piece_cost(int index, size_t mask, size_t length,
                     const CostParams& p) {
    long long cost = p.ref_cost + p.len_cost * static_cast<long long>(length);
    if ((mask & (size_t{1} << index)) == 0) cost += p.dict_cost;
    return cost;
}

} // namespace

CompressResult compress_min_cost(const std::string& s,
                                 std::vector<std::string> candidates,
                                 const CostParams& params) {
    const std::vector<std::string> cand = normalize(std::move(candidates));
    const int n = static_cast<int>(s.size());
    const int m = static_cast<int>(cand.size());
    if (m > 18) {
        throw std::invalid_argument("compress_min_cost: at most 18 candidates");
    }

    const auto matches = match_table(s, cand);
    const size_t states = size_t{1} << m;

    // dp[pos][mask]: min cost to tile s[pos..n) given types in mask are paid.
    std::vector<long long> dp((static_cast<size_t>(n) + 1) * states, kInf);
    auto at = [&](int pos, size_t mask) -> long long& {
        return dp[static_cast<size_t>(pos) * states + mask];
    };
    for (size_t mask = 0; mask < states; ++mask) at(n, mask) = 0;

    for (int pos = n - 1; pos >= 0; --pos) {
        for (size_t mask = 0; mask < states; ++mask) {
            long long best = kInf;
            for (int i : matches[pos]) {
                const size_t next_mask = mask | (size_t{1} << i);
                const long long sub = at(pos + cand[i].size(), next_mask);
                if (sub == kInf) continue;
                best = std::min(best,
                                piece_cost(i, mask, cand[i].size(), params) + sub);
            }
            at(pos, mask) = best;
        }
    }

    CompressResult result;
    if (at(0, 0) == kInf) return result; // infeasible
    result.feasible = true;
    result.cost = at(0, 0);

    // Greedy reconstruction: candidates are sorted, so the first candidate
    // that can still reach the optimum gives the lexicographically smallest
    // piece at each step.
    int pos = 0;
    size_t mask = 0;
    while (pos < n) {
        bool advanced = false;
        for (int i : matches[pos]) {
            const size_t next_mask = mask | (size_t{1} << i);
            const int next_pos = pos + static_cast<int>(cand[i].size());
            if (piece_cost(i, mask, cand[i].size(), params) + at(next_pos, next_mask) ==
                at(pos, mask)) {
                result.pieces.push_back(cand[i]);
                pos = next_pos;
                mask = next_mask;
                advanced = true;
                break;
            }
        }
        if (!advanced) throw std::logic_error("compress_min_cost: reconstruction failed");
    }
    return result;
}

CompressResult compress_brute_force(const std::string& s,
                                    std::vector<std::string> candidates,
                                    const CostParams& params) {
    const std::vector<std::string> cand = normalize(std::move(candidates));
    const int n = static_cast<int>(s.size());
    const auto matches = match_table(s, cand);

    CompressResult best;
    long long best_cost = kInf;
    std::vector<std::string> current;

    // pos/mask/cost are mutated along the recursion path.
    auto dfs = [&](auto&& self, int pos, size_t mask, long long cost) -> void {
        if (cost > best_cost) return; // prune: cannot improve
        if (pos == n) {
            if (cost < best_cost || current < best.pieces) {
                best_cost = cost;
                best.feasible = true;
                best.cost = cost;
                best.pieces = current;
            }
            return;
        }
        for (int i : matches[pos]) {
            current.push_back(cand[i]);
            self(self, pos + static_cast<int>(cand[i].size()),
                 mask | (size_t{1} << i),
                 cost + piece_cost(i, mask, cand[i].size(), params));
            current.pop_back();
        }
    };
    dfs(dfs, 0, 0, 0);
    return best;
}
