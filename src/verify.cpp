#include "verify.h"

#include <cstring>
#include <queue>
#include <unordered_set>

static bool evalCond(CmpOp op, int x, int c) {
    switch (op) {
        case CmpOp::Lt: return x < c;
        case CmpOp::Le: return x <= c;
        case CmpOp::Eq: return x == c;
        case CmpOp::Ne: return x != c;
        case CmpOp::Ge: return x >= c;
        case CmpOp::Gt: return x > c;
    }
    return false;
}

VerifyResult verify(const Program& p, const std::vector<AbstractState>& states,
                    size_t maxStates) {
    VerifyResult res;
    const size_t nv = p.vars.size();
    const int n = (int)p.instrs.size();
    res.concrete.assign(n, std::vector<std::set<int>>(nv));

    using Env = std::vector<uint8_t>;
    std::queue<std::pair<int, Env>> wl;
    std::unordered_set<std::string> seen;

    auto keyOf = [&](int pc, const Env& e) {
        std::string k(sizeof pc + e.size(), '\0');
        std::memcpy(k.data(), &pc, sizeof pc);
        if (!e.empty()) std::memcpy(k.data() + sizeof pc, e.data(), e.size());
        return k;
    };
    auto push = [&](int pc, Env e) {
        if (seen.insert(keyOf(pc, e)).second) wl.emplace(pc, std::move(e));
    };

    push(0, Env(nv, 0));
    while (!wl.empty()) {
        if (seen.size() > maxStates) {
            res.complete = false;
            res.ok = false;
            break;
        }
        auto [pc, env] = std::move(wl.front());
        wl.pop();

        for (size_t i = 0; i < nv; ++i) {
            res.concrete[pc][i].insert(env[i]);
            bool contained = states[pc].reachable && states[pc].vals[i].contains(env[i]);
            if (!contained) {
                res.ok = false;
                ++res.violationCount;
                if (res.violations.size() < 10) {
                    res.violations.push_back(
                        "L" + std::to_string(pc) + ": " + p.vars[i] + "=" +
                        std::to_string(env[i]) + " not in " +
                        (states[pc].reachable ? states[pc].vals[i].toString()
                                              : "(bottom)"));
                }
            }
        }

        const Instr& in = p.instrs[pc];
        int vi = p.varIndex(in.var);
        int si = p.varIndex(in.src);
        auto fall = [&](Env e) {
            if (pc + 1 < n) push(pc + 1, std::move(e));
        };

        switch (in.kind) {
            case Instr::Kind::AssignConst: {
                Env e = env;
                e[vi] = (uint8_t)in.imm;
                fall(std::move(e));
                break;
            }
            case Instr::Kind::AssignCopy: {
                Env e = env;
                e[vi] = e[si];
                fall(std::move(e));
                break;
            }
            case Instr::Kind::AssignAdd: {
                Env e = env;
                e[vi] = (uint8_t)(e[si] + in.imm); // uint8_t wrap-around
                fall(std::move(e));
                break;
            }
            case Instr::Kind::AssignSub: {
                Env e = env;
                e[vi] = (uint8_t)(e[si] - in.imm);
                fall(std::move(e));
                break;
            }
            case Instr::Kind::Input: {
                if (pc + 1 < n)
                    for (int v = 0; v < 256; ++v) {
                        Env e = env;
                        e[vi] = (uint8_t)v;
                        push(pc + 1, std::move(e));
                    }
                break;
            }
            case Instr::Kind::CondGoto:
                if (evalCond(in.cmp, env[vi], in.imm)) push(in.target, env);
                else fall(env);
                break;
            case Instr::Kind::Goto:
                push(in.target, env);
                break;
            case Instr::Kind::Halt:
                break;
        }
    }
    res.statesEnumerated = seen.size();
    return res;
}
