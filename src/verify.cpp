#include "verify.hpp"

#include <cstdint>
#include <deque>
#include <set>
#include <utility>

namespace {

using ConcreteEnv = std::vector<std::uint8_t>; // indexed like Program::varNames
using ConcreteState = std::pair<int, ConcreteEnv>;

bool evalCmp(CmpOp op, int lhs, int imm) {
    switch (op) {
        case CmpOp::Lt: return lhs < imm;
        case CmpOp::Le: return lhs <= imm;
        case CmpOp::Eq: return lhs == imm;
        case CmpOp::Ne: return lhs != imm;
        case CmpOp::Ge: return lhs >= imm;
        case CmpOp::Gt: return lhs > imm;
    }
    return false;
}

} // namespace

VerifyResult verifyConcrete(const Program& prog, const AnalysisResult& res) {
    VerifyResult out;
    const int n = static_cast<int>(prog.code.size());
    const size_t nVars = prog.varNames.size();

    auto varIndex = [&](const std::string& name) -> int {
        for (size_t i = 0; i < nVars; ++i)
            if (prog.varNames[i] == name) return static_cast<int>(i);
        return -1;
    };

    ConcreteEnv initial(nVars, 0); // matches the analysis entry state
    std::set<ConcreteState> visited;
    std::deque<ConcreteState> queue;
    queue.emplace_back(0, initial);
    visited.emplace(0, initial);

    auto checkInclusion = [&](const ConcreteState& st) {
        const AbstractEnv& abs = res.at[st.first];
        for (size_t i = 0; i < nVars; ++i) {
            auto it = abs.find(prog.varNames[i]);
            IntervalSet set = it == abs.end() ? IntervalSet::bottom() : it->second;
            if (!set.contains(st.second[i])) {
                out.ok = false;
                out.violations.push_back(
                    "pc " + std::to_string(st.first) + ": variable '" + prog.varNames[i] +
                    "' = " + std::to_string(st.second[i]) + " not covered by abstract set " +
                    set.toString());
            }
        }
    };

    auto step = [&](const ConcreteState& st) {
        const Instruction& ins = prog.code[st.first];
        ConcreteEnv env = st.second;
        int fallThrough = st.first + 1;
        auto push = [&](int pc, ConcreteEnv e) {
            ConcreteState next{pc, std::move(e)};
            if (visited.insert(next).second) queue.push_back(std::move(next));
        };
        switch (ins.kind) {
            case Instruction::Kind::AssignConst:
                env[varIndex(ins.var)] = static_cast<std::uint8_t>(ins.imm & 0xFF);
                if (fallThrough < n) push(fallThrough, std::move(env));
                break;
            case Instruction::Kind::AssignVar:
                env[varIndex(ins.var)] = env[varIndex(ins.src)];
                if (fallThrough < n) push(fallThrough, std::move(env));
                break;
            case Instruction::Kind::AddConst:
                env[varIndex(ins.var)] =
                    static_cast<std::uint8_t>((env[varIndex(ins.src)] + ins.imm) & 0xFF);
                if (fallThrough < n) push(fallThrough, std::move(env));
                break;
            case Instruction::Kind::SubConst:
                env[varIndex(ins.var)] =
                    static_cast<std::uint8_t>((env[varIndex(ins.src)] - ins.imm) & 0xFF);
                if (fallThrough < n) push(fallThrough, std::move(env));
                break;
            case Instruction::Kind::CondGoto:
                if (evalCmp(ins.cmp, env[varIndex(ins.var)], ins.imm))
                    push(prog.labelPc(ins.target), env);
                else if (fallThrough < n)
                    push(fallThrough, std::move(env));
                break;
            case Instruction::Kind::Goto:
                push(prog.labelPc(ins.target), std::move(env));
                break;
            case Instruction::Kind::Halt:
                break;
        }
    };

    while (!queue.empty()) {
        ConcreteState st = std::move(queue.front());
        queue.pop_front();
        ++out.statesVisited;
        checkInclusion(st);
        step(st);
    }
    return out;
}
