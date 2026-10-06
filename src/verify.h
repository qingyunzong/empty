#pragma once

#include "analysis.h"
#include "program.h"

#include <set>
#include <string>
#include <vector>

struct VerifyResult {
    bool ok = true;       // every concrete state is contained in the abstract one
    bool complete = true; // false if the enumeration safety cap was hit
    size_t statesEnumerated = 0;
    size_t violationCount = 0;
    std::vector<std::string> violations;               // first few, for display
    std::vector<std::vector<std::set<int>>> concrete;  // [pc][var] values seen
};

// Exhaustively enumerate every reachable concrete configuration (pc, env)
// and check that each variable's concrete value is contained in the
// abstract interval set at that program point. No bound is guessed for
// loop trip counts: the 8-bit state space is finite and fully explored.
VerifyResult verify(const Program& p, const std::vector<AbstractState>& states,
                    size_t maxStates = 20000000);
