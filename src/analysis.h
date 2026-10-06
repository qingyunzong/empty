#pragma once

#include "interval_set.h"
#include "program.h"

#include <utility>
#include <vector>

// Abstract state at one program point: one IntervalSet per variable.
// reachable == false means bottom (no concrete state reaches this point).
struct AbstractState {
    std::vector<IntervalSet> vals;
    bool reachable = false;
    bool operator==(const AbstractState&) const = default;
};

struct AnalysisResult {
    std::vector<AbstractState> states; // one per instruction
    size_t iterations = 0;             // transfer applications until fixpoint
};

IntervalSet filterSet(const IntervalSet& s, CmpOp op, uint16_t c);
CmpOp negate(CmpOp op);
AbstractState joinState(const AbstractState& a, const AbstractState& b);
std::vector<std::pair<int, AbstractState>> transfer(const Program& p, int pc,
                                                    const AbstractState& st);

// Worklist fixpoint. The domain is finite and joins only grow, so this
// always terminates; no artificial iteration cap is imposed.
AnalysisResult analyze(const Program& p);
