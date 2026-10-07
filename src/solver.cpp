#include "solver.hpp"

#include <queue>
#include <sstream>
#include <stdexcept>

namespace sreach {

namespace {

struct Dsu {
    std::vector<int> p;
    explicit Dsu(int n) : p(static_cast<size_t>(n)) {
        for (int i = 0; i < n; ++i) p[static_cast<size_t>(i)] = i;
    }
    int find(int x) {
        while (p[static_cast<size_t>(x)] != x) {
            p[static_cast<size_t>(x)] = p[static_cast<size_t>(p[static_cast<size_t>(x)])];
            x = p[static_cast<size_t>(x)];
        }
        return x;
    }
    void unite(int a, int b) { p[static_cast<size_t>(find(a))] = find(b); }
};

Rational oneMinus(const Rational& p) { return Rational(p.den - p.num, p.den); }

}  // namespace

Rational enumerateReachability(const Problem& prob) {
    const size_t m = prob.edges.size();
    if (m > 20) throw std::invalid_argument("enumeration requires at most 20 edges");
    Rational acc;
    const uint32_t total = 1u << m;
    for (uint32_t mask = 0; mask < total; ++mask) {
        std::vector<char> seen(static_cast<size_t>(prob.n), 0);
        std::queue<int> q;
        seen[static_cast<size_t>(prob.s)] = 1;
        q.push(prob.s);
        while (!q.empty()) {
            int c = q.front();
            q.pop();
            for (size_t i = 0; i < m; ++i) {
                if (!((mask >> i) & 1u)) continue;
                const Edge& e = prob.edges[i];
                if (e.u == c && !seen[static_cast<size_t>(e.v)]) {
                    seen[static_cast<size_t>(e.v)] = 1;
                    q.push(e.v);
                }
                if (prob.undirected && e.v == c && !seen[static_cast<size_t>(e.u)]) {
                    seen[static_cast<size_t>(e.u)] = 1;
                    q.push(e.u);
                }
            }
        }
        if (!seen[static_cast<size_t>(prob.t)]) continue;
        Rational state = Rational::one();
        for (size_t i = 0; i < m; ++i) {
            const Rational& p = prob.edges[i].p;
            state = state * (((mask >> i) & 1u) ? p : oneMinus(p));
        }
        acc = acc + state;
    }
    return acc;
}

Solver::Solver(Problem prob, uint64_t maxDecisionNodes)
    : prob_(std::move(prob)), budget_(maxDecisionNodes) {
    if (prob_.edges.size() > 31) throw std::invalid_argument("too many edges (max 31)");
    if (prob_.s < 0 || prob_.s >= prob_.n || prob_.t < 0 || prob_.t >= prob_.n)
        throw std::invalid_argument("source/target out of range");
    for (const auto& e : prob_.edges) {
        if (e.u < 0 || e.u >= prob_.n || e.v < 0 || e.v >= prob_.n)
            throw std::invalid_argument("edge endpoint out of range");
        if (e.p.den < e.p.num) throw std::invalid_argument("edge probability exceeds 1");
    }
    nodes_.push_back({-1, 0, 0});  // kFalse
    nodes_.push_back({-1, 0, 0});  // kTrue
    nodes_.push_back({-1, 0, 0});  // kUnknown
}

uint32_t Solver::build(uint32_t contracted, uint32_t deleted) {
    const uint64_t key = (uint64_t{contracted} << 32) | deleted;
    if (auto it = memo_.find(key); it != memo_.end()) return it->second;

    const auto& edges = prob_.edges;
    Dsu dsu(prob_.n);
    for (size_t i = 0; i < edges.size(); ++i)
        if ((contracted >> i) & 1u) dsu.unite(edges[i].u, edges[i].v);
    const int cs = dsu.find(prob_.s);
    const int ct = dsu.find(prob_.t);
    if (cs == ct) return kTrue;

    // BFS over contraction components through non-deleted edges.
    std::vector<int> parentEdge(static_cast<size_t>(prob_.n), -1);
    std::vector<char> seen(static_cast<size_t>(prob_.n), 0);
    std::queue<int> q;
    seen[static_cast<size_t>(cs)] = 1;
    q.push(cs);
    bool reached = false;
    while (!q.empty() && !reached) {
        int c = q.front();
        q.pop();
        for (size_t i = 0; i < edges.size(); ++i) {
            if ((deleted >> i) & 1u) continue;
            int a = dsu.find(edges[i].u);
            int b = dsu.find(edges[i].v);
            int to = -1;
            if (a == c && !seen[static_cast<size_t>(b)])
                to = b;
            else if (prob_.undirected && b == c && !seen[static_cast<size_t>(a)])
                to = a;
            if (to < 0) continue;
            seen[static_cast<size_t>(to)] = 1;
            parentEdge[static_cast<size_t>(to)] = static_cast<int>(i);
            if (to == ct) {
                reached = true;
                break;
            }
            q.push(to);
        }
    }
    if (!reached) return kFalse;

    if (decisionNodes_ >= budget_) {
        usedUnknown_ = true;
        return kUnknown;
    }

    // The edge that discovered ct lies on an s-t path and is undecided.
    const int e = parentEdge[static_cast<size_t>(ct)];
    const uint32_t bit = 1u << e;
    const uint32_t hi = build(contracted | bit, deleted);
    const uint32_t lo = build(contracted, deleted | bit);
    if (decisionNodes_ >= budget_) {  // children may have consumed the budget
        usedUnknown_ = true;
        return kUnknown;
    }
    if (hi == lo) {
        if (hi != kUnknown) memo_[key] = hi;
        return hi;
    }
    const uint32_t id = static_cast<uint32_t>(nodes_.size());
    nodes_.push_back({e, hi, lo});
    ++decisionNodes_;
    if (hi != kUnknown && lo != kUnknown) memo_[key] = id;
    return id;
}

Interval Solver::solve() {
    root_ = build(0, 0);
    std::vector<char> done(nodes_.size(), 0);
    std::vector<Interval> memo(nodes_.size());
    return eval(root_, done, memo);
}

Interval Solver::eval(uint32_t id, std::vector<char>& done, std::vector<Interval>& memo) const {
    if (done[id]) return memo[id];
    done[id] = 1;
    if (id == kFalse) return memo[id] = Interval{Rational(0), Rational(0)};
    if (id == kTrue) return memo[id] = Interval{Rational(1), Rational(1)};
    if (id == kUnknown) return memo[id] = Interval{Rational(0), Rational(1)};
    const Node& nd = nodes_[id];
    const Interval ih = eval(nd.hi, done, memo);
    const Interval il = eval(nd.lo, done, memo);
    const Rational& p = prob_.edges[static_cast<size_t>(nd.var)].p;
    const Rational q = oneMinus(p);
    return memo[id] = Interval{p * ih.lo + q * il.lo, p * ih.hi + q * il.hi};
}

std::string Solver::toDot() const {
    std::ostringstream os;
    os << "digraph bdd {\n";
    os << "  t0 [shape=box,label=\"0\"];\n";
    os << "  t1 [shape=box,label=\"1\"];\n";
    if (usedUnknown_) os << "  unk [shape=box,label=\"?\"];\n";
    for (size_t i = 3; i < nodes_.size(); ++i) {
        const Edge& e = prob_.edges[static_cast<size_t>(nodes_[i].var)];
        os << "  n" << i << " [label=\"e" << nodes_[i].var << ": " << e.u << "->" << e.v
           << "\"];\n";
    }
    auto ref = [](uint32_t c) -> std::string {
        if (c == kFalse) return "t0";
        if (c == kTrue) return "t1";
        if (c == kUnknown) return "unk";
        return "n" + std::to_string(c);
    };
    for (size_t i = 3; i < nodes_.size(); ++i) {
        os << "  n" << i << " -> " << ref(nodes_[i].hi) << " [label=\"up\"];\n";
        os << "  n" << i << " -> " << ref(nodes_[i].lo) << " [style=dashed,label=\"down\"];\n";
    }
    os << "  root [shape=point];\n";
    os << "  root -> " << ref(root_) << ";\n";
    os << "}\n";
    return os.str();
}

namespace {

Rational parseProbability(const std::string& tok) {
    const auto slash = tok.find('/');
    if (slash != std::string::npos) {
        return Rational(BigInt::fromString(tok.substr(0, slash)),
                        BigInt::fromString(tok.substr(slash + 1)));
    }
    const auto dot = tok.find('.');
    if (dot != std::string::npos) {
        std::string whole = tok.substr(0, dot);
        std::string frac = tok.substr(dot + 1);
        if (frac.empty()) throw std::invalid_argument("bad probability: " + tok);
        BigInt den(1);
        for (size_t i = 0; i < frac.size(); ++i) den = den * BigInt(10);
        BigInt num = BigInt::fromString(whole.empty() ? "0" : whole) * den +
                     BigInt::fromString(frac);
        return Rational(num, den);
    }
    return Rational(BigInt::fromString(tok), BigInt(1));
}

}  // namespace

Problem parseProblem(std::istream& in, bool undirected) {
    std::string all((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    std::string clean;
    std::istringstream lines(all);
    std::string line;
    while (std::getline(lines, line)) {
        clean += line.substr(0, line.find('#'));
        clean += '\n';
    }
    std::istringstream ss(clean);
    Problem prob;
    prob.undirected = undirected;
    size_t m = 0;
    if (!(ss >> prob.n >> m)) throw std::invalid_argument("expected header: <n> <m>");
    if (prob.n < 1) throw std::invalid_argument("need at least 1 vertex");
    if (m > 20) throw std::invalid_argument("too many edges (max 20)");
    if (!(ss >> prob.s >> prob.t)) throw std::invalid_argument("expected: <s> <t>");
    for (size_t i = 0; i < m; ++i) {
        Edge e;
        std::string ps;
        if (!(ss >> e.u >> e.v >> ps))
            throw std::invalid_argument("expected edge line: <u> <v> <p>");
        e.p = parseProbability(ps);
        prob.edges.push_back(std::move(e));
    }
    return prob;
}

}  // namespace sreach
