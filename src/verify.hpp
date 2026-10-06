#pragma once

#include <string>
#include <vector>

#include "analysis.hpp"
#include "program.hpp"

struct VerifyResult {
    bool ok = true;
    long statesVisited = 0;      // concrete (pc, environment) pairs explored
    std::vector<std::string> violations; // human-readable inclusion failures
};

// Enumerates every concrete reachable state (variables are 8-bit, so the
// state space is finite) and checks that the abstract fixpoint contains each
// of them. This validates the over-approximation with no guessed trip count.
VerifyResult verifyConcrete(const Program& prog, const AnalysisResult& res);
