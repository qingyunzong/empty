#pragma once

#include <cstdint>
#include <istream>
#include <string>
#include <unordered_map>
#include <vector>

#include "rational.hpp"

namespace sreach {

struct Edge {
    int u = 0, v = 0;
    Rational p;  // probability the edge is present (0 <= p <= 1)
};

struct Problem {
    int n = 0;  // vertices 0..n-1
    int s = 0, t = 0;
    bool undirected = false;
    std::vector<Edge> edges;  // at most 20
};

struct Interval {
    Rational lo, hi;
    bool exact() const { return lo == hi; }
};

// Exact reachability probability by enumerating all 2^m edge states.
// Requires edges.size() <= 20.
Rational enumerateReachability(const Problem& prob);

// Parses the CLI input format (see README). Throws std::invalid_argument on bad input.
Problem parseProblem(std::istream& in, bool undirected);

// Builds a binary decision diagram over edge-presence variables via
// contract/delete Shannon expansion with memoization. If the decision-node
// budget is exhausted, unfinished leaves become "unknown" and the evaluated
// probability is a sound [lower, upper] interval (monotone structure function).
class Solver {
public:
    static constexpr uint32_t kFalse = 0;
    static constexpr uint32_t kTrue = 1;
    static constexpr uint32_t kUnknown = 2;

    struct Node {
        int var;      // edge index decided at this node
        uint32_t hi;  // child when the edge is present (contracted)
        uint32_t lo;  // child when the edge is absent (deleted)
    };

    Solver(Problem prob, uint64_t maxDecisionNodes);

    Interval solve();
    bool isExact() const { return !usedUnknown_; }
    uint64_t decisionNodeCount() const { return decisionNodes_; }
    const std::vector<Node>& nodes() const { return nodes_; }
    const Problem& problem() const { return prob_; }
    std::string toDot() const;

private:
    uint32_t build(uint32_t contracted, uint32_t deleted);
    Interval eval(uint32_t id, std::vector<char>& done, std::vector<Interval>& memo) const;

    Problem prob_;
    uint64_t budget_;
    uint64_t decisionNodes_ = 0;
    bool usedUnknown_ = false;
    std::vector<Node> nodes_;  // slots 0..2 are the terminals
    uint32_t root_ = kFalse;
    std::unordered_map<uint64_t, uint32_t> memo_;
};

}  // namespace sreach
