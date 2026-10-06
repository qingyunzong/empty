#pragma once

#include <map>
#include <string>
#include <vector>

#include "interval_set.hpp"
#include "program.hpp"

// Abstract environment: variable -> set of possible 8-bit values.
using AbstractEnv = std::map<std::string, IntervalSet>;

// Result of the fixpoint analysis: for every program point, the join of all
// abstract states observed *before* executing that instruction. This is an
// over-approximation of the reachable concrete states.
struct AnalysisResult {
    std::vector<AbstractEnv> at; // indexed by pc
    long iterations = 0;         // worklist steps until fixpoint
};

// The set of 8-bit values satisfying (x <cmp> imm).
IntervalSet cmpSatisfyingSet(CmpOp op, int imm);

// Filters an abstract environment through a condition on one variable.
AbstractEnv filterEnv(const Program& prog, const AbstractEnv& env,
                      const std::string& var, CmpOp op, int imm);

// Runs chaotic iteration until the fixpoint is reached. The abstract domain
// is finite (unions of at most 4 intervals over 256 values), so termination
// needs no widening and no guessed bound on loop trip counts.
AnalysisResult analyze(const Program& prog);
