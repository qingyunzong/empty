#include "solver.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

const char* kUsage = R"(usage: patrol [--verify] [input_file]

Directed inspection patrol (rural postman) solver for small graphs.
Reads from input_file, or stdin when omitted.

Input format (1-based vertices, '#' starts a comment):
  n m s            n vertices (1..10), m edges, start vertex s
  u v w required   m lines: edge u->v, non-negative cost w,
                   required = 1 (must patrol) or 0

Limits: n <= 10, at most 20 required edges (exact state-space search).

Options:
  --verify   cross-check the optimum with an independent reference solver
  --help     show this message
)";

struct ParseResult {
    bool ok = false;
    std::string error;
    patrol::Instance inst;
};

ParseResult parse(std::istream& in) {
    // Strip comments, keep tokens.
    std::string all, line;
    while (std::getline(in, line)) {
        const auto hash = line.find('#');
        if (hash != std::string::npos)
            line.erase(hash);
        all += line;
        all += '\n';
    }
    std::istringstream toks(all);

    ParseResult pr;
    long long n, m, s;
    if (!(toks >> n >> m >> s)) {
        pr.error = "expected header: n m s";
        return pr;
    }
    if (n < 1 || n > patrol::kMaxVertices) {
        pr.error = "n must be in [1, " + std::to_string(patrol::kMaxVertices) + "]";
        return pr;
    }
    if (m < 0) {
        pr.error = "m must be non-negative";
        return pr;
    }
    if (s < 1 || s > n) {
        pr.error = "start vertex out of range";
        return pr;
    }
    pr.inst.n = static_cast<int>(n);
    pr.inst.start = static_cast<int>(s) - 1;

    int required = 0;
    for (long long i = 0; i < m; ++i) {
        long long u, v, w, r;
        if (!(toks >> u >> v >> w >> r)) {
            pr.error = "edge " + std::to_string(i + 1) + ": expected 'u v w required'";
            return pr;
        }
        if (u < 1 || u > n || v < 1 || v > n) {
            pr.error = "edge " + std::to_string(i + 1) + ": vertex out of range";
            return pr;
        }
        if (w < 0) {
            pr.error = "edge " + std::to_string(i + 1) + ": cost must be non-negative";
            return pr;
        }
        if (r != 0 && r != 1) {
            pr.error = "edge " + std::to_string(i + 1) + ": required flag must be 0 or 1";
            return pr;
        }
        required += static_cast<int>(r);
        pr.inst.edges.push_back({static_cast<int>(u) - 1, static_cast<int>(v) - 1,
                                 w, r == 1});
    }
    if (required > patrol::kMaxRequiredEdges) {
        pr.error = "too many required edges (max " +
                   std::to_string(patrol::kMaxRequiredEdges) + ")";
        return pr;
    }
    pr.ok = true;
    return pr;
}

void print_result(const patrol::Instance& inst, const patrol::SolveResult& res) {
    if (!res.feasible) {
        std::cout << "status unreachable\n";
        for (const auto& p : res.problems)
            std::cout << "problem: " << p << "\n";
        return;
    }
    std::cout << "status ok\n";
    std::cout << "cost " << res.cost << "\n";
    std::cout << "steps " << res.path_edges.size() << "\n";
    for (size_t k = 0; k < res.path_edges.size(); ++k) {
        const int ei = res.path_edges[k];
        const auto& e = inst.edges[ei];
        std::cout << "step " << k + 1 << ": edge " << ei + 1 << "  "
                  << e.from + 1 << "->" << e.to + 1 << "  w=" << e.cost
                  << (e.required ? "  required" : "") << "\n";
    }
    std::cout << "coverage\n";
    for (size_t i = 0; i < inst.edges.size(); ++i) {
        const auto& e = inst.edges[i];
        if (!e.required)
            continue;
        std::cout << "edge " << i + 1 << ": " << e.from + 1 << "->" << e.to + 1
                  << " w=" << e.cost << " covered " << res.coverage[i] << "\n";
    }
}

} // namespace

int main(int argc, char** argv) {
    bool verify = false;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--verify")
            verify = true;
        else if (arg == "--help" || arg == "-h") {
            std::cout << kUsage;
            return 0;
        } else if (!arg.empty() && arg[0] == '-') {
            std::cerr << "unknown option: " << arg << "\n" << kUsage;
            return 2;
        } else if (path.empty())
            path = arg;
        else {
            std::cerr << "unexpected extra argument: " << arg << "\n";
            return 2;
        }
    }

    ParseResult pr;
    if (path.empty()) {
        pr = parse(std::cin);
    } else {
        std::ifstream f(path);
        if (!f) {
            std::cerr << "cannot open input file: " << path << "\n";
            return 2;
        }
        pr = parse(f);
    }
    if (!pr.ok) {
        std::cerr << "input error: " << pr.error << "\n";
        return 2;
    }

    const patrol::SolveResult res = patrol::solve(pr.inst);
    print_result(pr.inst, res);

    if (verify && res.feasible) {
        const long long ref = patrol::reference_cost(pr.inst);
        if (ref != res.cost) {
            std::cout << "verify FAILED: reference cost " << ref << " != "
                      << res.cost << "\n";
            return 1;
        }
        std::cout << "verify ok (reference cost " << ref << ")\n";
    }
    return 0;
}
