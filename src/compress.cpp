#include "compress.hpp"

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>

namespace comp {

namespace {

struct Best {
    bool ok = false;
    long long cost = 0;
    std::vector<std::string> seq; // suffix segmentation from the current position
};

// Prefer lower cost; break ties by lexicographically smaller fragment sequence.
void improve(Best& cur, long long cost, std::vector<std::string> seq) {
    if (!cur.ok || cost < cur.cost || (cost == cur.cost && seq < cur.seq)) {
        cur.ok = true;
        cur.cost = cost;
        cur.seq = std::move(seq);
    }
}

class Solver {
public:
    Solver(const std::string& s, CostModel model, std::size_t max_distinct)
        : s_(s), model_(model), max_distinct_(max_distinct) {
        // A fragment can only ever be referenced more than once if its string
        // occurs at least twice in s. All other fragments ("singletons") always
        // pay dict+ref and only consume a slot of the distinct-type budget, so
        // the DP state tracks them as a count instead of an explicit set.
        const std::size_t n = s_.size();
        reusable_.assign(n, std::vector<bool>(n + 1, false));
        for (std::size_t i = 0; i < n; ++i) {
            for (std::size_t len = 1; i + len <= n; ++len) {
                std::string_view frag(s_.data() + i, len);
                std::size_t first = s_.find(frag);
                bool twice = first != std::string::npos &&
                             s_.find(frag, first + 1) != std::string::npos;
                if (twice) {
                    reusable_[i][len] = true;
                    id_of_.emplace(s_.substr(i, len), 0); // placeholder, ids assigned below
                }
            }
        }
        std::size_t next_id = 0;
        for (auto& [frag, id] : id_of_) id = next_id++; // map keeps keys sorted
    }

    Solution run() {
        std::vector<std::size_t> used; // sorted ids of reusable fragments used so far
        Best best = dfs(0, 0, used);
        Solution sol;
        sol.ok = best.ok;
        sol.cost = best.cost;
        sol.pieces = std::move(best.seq);
        return sol;
    }

private:
    // Best (cost, sequence) for s[pos..], given the set of reusable fragments
    // already in the dictionary and the number of singleton fragments used.
    Best dfs(std::size_t pos, std::size_t singletons, std::vector<std::size_t>& used) {
        if (pos == s_.size()) return Best{true, 0, {}};

        std::string key = make_key(pos, singletons, used);
        if (auto it = memo_.find(key); it != memo_.end()) return it->second;

        Best best;
        const std::size_t remaining = s_.size() - pos;
        for (std::size_t len = 1; len <= remaining; ++len) {
            std::string frag = s_.substr(pos, len);
            long long piece_cost = model_.ref_flat + model_.ref_per_char * (long long)len;

            std::size_t next_singletons = singletons;
            bool inserted = false;
            std::size_t id = 0;
            if (reusable_[pos][len]) {
                id = id_of_.at(frag);
                auto it = std::lower_bound(used.begin(), used.end(), id);
                if (it == used.end() || *it != id) {
                    if (used.size() + singletons >= max_distinct_) continue;
                    piece_cost += model_.dict_flat + model_.dict_per_char * (long long)len;
                    used.insert(it, id);
                    inserted = true;
                }
            } else {
                if (used.size() + singletons >= max_distinct_) continue;
                piece_cost += model_.dict_flat + model_.dict_per_char * (long long)len;
                next_singletons = singletons + 1;
            }

            Best sub = dfs(pos + len, next_singletons, used);
            if (inserted) used.erase(std::lower_bound(used.begin(), used.end(), id));

            if (sub.ok) {
                std::vector<std::string> seq;
                seq.reserve(sub.seq.size() + 1);
                seq.push_back(std::move(frag));
                seq.insert(seq.end(), sub.seq.begin(), sub.seq.end());
                improve(best, piece_cost + sub.cost, std::move(seq));
            }
        }

        return memo_.emplace(std::move(key), best).first->second;
    }

    static std::string make_key(std::size_t pos, std::size_t singletons,
                                const std::vector<std::size_t>& used) {
        std::string key;
        key.reserve(8 + used.size() * 3);
        key.append(reinterpret_cast<const char*>(&pos), sizeof(pos));
        key.append(reinterpret_cast<const char*>(&singletons), sizeof(singletons));
        for (std::size_t id : used) {
            key.append(reinterpret_cast<const char*>(&id), sizeof(id));
        }
        return key;
    }

    const std::string& s_;
    CostModel model_;
    std::size_t max_distinct_;
    std::vector<std::vector<bool>> reusable_;          // reusable_[pos][len]
    std::map<std::string, std::size_t> id_of_;         // reusable fragment -> id
    std::unordered_map<std::string, Best> memo_;
};

} // namespace

Solution solve(const std::string& s, CostModel model, std::size_t max_distinct) {
    return Solver(s, model, max_distinct).run();
}

Solution solve_brute(const std::string& s, CostModel model, std::size_t max_distinct) {
    const std::size_t n = s.size();
    Solution best;
    if (n == 0) return Solution{true, 0, {}};
    // Enumerate all compositions via cut masks over the n-1 gaps.
    for (std::uint64_t mask = 0; mask < (std::uint64_t{1} << (n - 1)); ++mask) {
        std::vector<std::string> pieces;
        std::size_t start = 0;
        for (std::size_t i = 0; i < n; ++i) {
            if (i + 1 == n || (mask >> i) & 1) {
                pieces.push_back(s.substr(start, i + 1 - start));
                start = i + 1;
            }
        }
        std::set<std::string> distinct(pieces.begin(), pieces.end());
        if (distinct.size() > max_distinct) continue;
        long long cost = 0;
        for (const auto& p : pieces)
            cost += model.ref_flat + model.ref_per_char * (long long)p.size();
        for (const auto& p : distinct)
            cost += model.dict_flat + model.dict_per_char * (long long)p.size();
        if (!best.ok || cost < best.cost || (cost == best.cost && pieces < best.pieces)) {
            best.ok = true;
            best.cost = cost;
            best.pieces = std::move(pieces);
        }
    }
    return best;
}

} // namespace comp
