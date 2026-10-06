#include "analysis.h"

#include <queue>

CmpOp negate(CmpOp op) {
    switch (op) {
        case CmpOp::Lt: return CmpOp::Ge;
        case CmpOp::Le: return CmpOp::Gt;
        case CmpOp::Eq: return CmpOp::Ne;
        case CmpOp::Ne: return CmpOp::Eq;
        case CmpOp::Ge: return CmpOp::Lt;
        case CmpOp::Gt: return CmpOp::Le;
    }
    return CmpOp::Eq;
}

IntervalSet filterSet(const IntervalSet& s, CmpOp op, uint16_t c) {
    switch (op) {
        case CmpOp::Lt: return c > 0 ? s.intersect(0, c - 1) : IntervalSet();
        case CmpOp::Le: return s.intersect(0, c);
        case CmpOp::Eq: return s.intersect(c, c);
        case CmpOp::Ne: {
            IntervalSet lo = c > 0 ? s.intersect(0, c - 1) : IntervalSet();
            IntervalSet hi = c < 255 ? s.intersect(c + 1, 255) : IntervalSet();
            return lo.join(hi);
        }
        case CmpOp::Ge: return s.intersect(c, 255);
        case CmpOp::Gt: return c < 255 ? s.intersect(c + 1, 255) : IntervalSet();
    }
    return IntervalSet();
}

AbstractState joinState(const AbstractState& a, const AbstractState& b) {
    if (!a.reachable) return b;
    if (!b.reachable) return a;
    AbstractState r;
    r.reachable = true;
    r.vals.resize(a.vals.size());
    for (size_t i = 0; i < a.vals.size(); ++i) r.vals[i] = a.vals[i].join(b.vals[i]);
    return r;
}

std::vector<std::pair<int, AbstractState>> transfer(const Program& p, int pc,
                                                    const AbstractState& st) {
    std::vector<std::pair<int, AbstractState>> out;
    if (!st.reachable) return out;
    const Instr& in = p.instrs[pc];
    int n = (int)p.instrs.size();
    int vi = p.varIndex(in.var);
    int si = p.varIndex(in.src);

    auto fall = [&](AbstractState s) {
        if (pc + 1 < n) out.emplace_back(pc + 1, std::move(s));
    };

    switch (in.kind) {
        case Instr::Kind::AssignConst: {
            AbstractState s = st;
            s.vals[vi] = IntervalSet::single(in.imm);
            fall(std::move(s));
            break;
        }
        case Instr::Kind::AssignCopy: {
            AbstractState s = st;
            s.vals[vi] = s.vals[si];
            fall(std::move(s));
            break;
        }
        case Instr::Kind::AssignAdd: {
            AbstractState s = st;
            s.vals[vi] = s.vals[si].addWrap(in.imm);
            fall(std::move(s));
            break;
        }
        case Instr::Kind::AssignSub: {
            AbstractState s = st;
            s.vals[vi] = s.vals[si].subWrap(in.imm);
            fall(std::move(s));
            break;
        }
        case Instr::Kind::Input: {
            AbstractState s = st;
            s.vals[vi] = IntervalSet::full();
            fall(std::move(s));
            break;
        }
        case Instr::Kind::CondGoto: {
            AbstractState t = st, f = st;
            t.vals[vi] = filterSet(t.vals[vi], in.cmp, in.imm);
            f.vals[vi] = filterSet(f.vals[vi], negate(in.cmp), in.imm);
            out.emplace_back(in.target, std::move(t));
            fall(std::move(f));
            break;
        }
        case Instr::Kind::Goto:
            out.emplace_back(in.target, st);
            break;
        case Instr::Kind::Halt:
            break;
    }
    return out;
}

AnalysisResult analyze(const Program& p) {
    size_t n = p.instrs.size();
    size_t nv = p.vars.size();
    AnalysisResult res;
    res.states.assign(n, AbstractState{std::vector<IntervalSet>(nv), false});

    AbstractState init{std::vector<IntervalSet>(nv, IntervalSet::single(0)), true};
    res.states[0] = init;

    std::queue<int> wl;
    std::vector<bool> inq(n, false);
    wl.push(0);
    inq[0] = true;
    while (!wl.empty()) {
        int pc = wl.front();
        wl.pop();
        inq[pc] = false;
        ++res.iterations;
        for (auto& [succ, st] : transfer(p, pc, res.states[pc])) {
            AbstractState joined = joinState(res.states[succ], st);
            if (!(joined == res.states[succ])) {
                res.states[succ] = std::move(joined);
                if (!inq[succ]) {
                    wl.push(succ);
                    inq[succ] = true;
                }
            }
        }
    }
    return res;
}
