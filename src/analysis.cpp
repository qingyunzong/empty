#include "analysis.hpp"

#include <deque>

IntervalSet cmpSatisfyingSet(CmpOp op, int imm) {
    switch (op) {
        case CmpOp::Lt: return IntervalSet::range(0, imm - 1);
        case CmpOp::Le: return IntervalSet::range(0, imm);
        case CmpOp::Eq:
            if (imm < 0 || imm > 255) return IntervalSet::bottom();
            return IntervalSet::constant(imm);
        case CmpOp::Ne:
            if (imm < 0 || imm > 255) return IntervalSet::top();
            return IntervalSet::range(0, imm - 1).join(IntervalSet::range(imm + 1, 255));
        case CmpOp::Ge: return IntervalSet::range(imm, 255);
        case CmpOp::Gt: return IntervalSet::range(imm + 1, 255);
    }
    return IntervalSet::bottom();
}

AbstractEnv filterEnv(const Program& prog, const AbstractEnv& env,
                      const std::string& var, CmpOp op, int imm) {
    AbstractEnv out = env;
    IntervalSet allowed = cmpSatisfyingSet(op, imm);
    IntervalSet current = IntervalSet::bottom();
    auto it = env.find(var);
    if (it != env.end()) current = it->second;
    out[var] = current.intersect(allowed);
    (void)prog;
    return out;
}

namespace {

AbstractEnv bottomEnv(const Program& prog) {
    AbstractEnv env;
    for (const std::string& v : prog.varNames) env[v] = IntervalSet::bottom();
    return env;
}

AbstractEnv joinEnv(const AbstractEnv& a, const AbstractEnv& b) {
    AbstractEnv out = a;
    for (const auto& [var, set] : b) out[var] = out[var].join(set);
    return out;
}

AbstractEnv transfer(const Instruction& ins, const AbstractEnv& in) {
    AbstractEnv out = in;
    auto read = [&](const std::string& v) -> IntervalSet {
        auto it = in.find(v);
        return it == in.end() ? IntervalSet::bottom() : it->second;
    };
    switch (ins.kind) {
        case Instruction::Kind::AssignConst:
            out[ins.var] = IntervalSet::constant(ins.imm);
            break;
        case Instruction::Kind::AssignVar:
            out[ins.var] = read(ins.src);
            break;
        case Instruction::Kind::AddConst:
            out[ins.var] = read(ins.src).addWrap(ins.imm);
            break;
        case Instruction::Kind::SubConst:
            out[ins.var] = read(ins.src).addWrap(-ins.imm);
            break;
        default:
            break; // branches/halt do not modify the environment
    }
    return out;
}

} // namespace

AnalysisResult analyze(const Program& prog) {
    const int n = static_cast<int>(prog.code.size());
    AnalysisResult result;
    result.at.assign(n, bottomEnv(prog));

    // Entry: every variable starts at 0.
    AbstractEnv entry = bottomEnv(prog);
    for (const std::string& v : prog.varNames) entry[v] = IntervalSet::constant(0);
    result.at[0] = entry;

    std::deque<int> worklist{0};
    std::vector<bool> inQueue(n, false);
    inQueue[0] = true;

    auto propagate = [&](int pc, const AbstractEnv& env) {
        AbstractEnv merged = joinEnv(result.at[pc], env);
        if (merged != result.at[pc]) {
            result.at[pc] = std::move(merged);
            if (!inQueue[pc]) {
                worklist.push_back(pc);
                inQueue[pc] = true;
            }
        }
    };

    while (!worklist.empty()) {
        int pc = worklist.front();
        worklist.pop_front();
        inQueue[pc] = false;
        ++result.iterations;

        const Instruction& ins = prog.code[pc];
        const AbstractEnv& pre = result.at[pc];
        AbstractEnv post = transfer(ins, pre);
        int fallThrough = pc + 1;

        switch (ins.kind) {
            case Instruction::Kind::CondGoto: {
                int target = prog.labelPc(ins.target);
                propagate(target, filterEnv(prog, post, ins.var, ins.cmp, ins.imm));
                if (fallThrough < n)
                    propagate(fallThrough,
                              filterEnv(prog, post, ins.var, negate(ins.cmp), ins.imm));
                break;
            }
            case Instruction::Kind::Goto:
                propagate(prog.labelPc(ins.target), post);
                break;
            case Instruction::Kind::Halt:
                break;
            default:
                if (fallThrough < n) propagate(fallThrough, post);
                break;
        }
    }
    return result;
}
