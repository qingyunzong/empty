#include <fstream>
#include <iostream>
#include <string>

#include "solver.hpp"

namespace {

void printUsage(const char* argv0) {
    std::cout <<
        "usage: " << argv0 << " [options] [input-file]   (reads stdin if no file)\n"
        "options:\n"
        "  --budget N     max decision nodes before aborting with bounds (default 2000000)\n"
        "  --undirected   treat edges as undirected\n"
        "  --verify       cross-check against full 2^m edge-state enumeration\n"
        "  --dot FILE     write the decision diagram in Graphviz DOT format\n"
        "  -h, --help     show this help\n"
        "input format:\n"
        "  n m            vertex count, edge count (m <= 20)\n"
        "  s t            source, target\n"
        "  u v p          m lines; p = edge-present probability as a/b, integer, or decimal\n"
        "exit codes: 0 exact, 2 budget exceeded (bounds printed), 1 bad input, 3 verify mismatch\n";
}

}  // namespace

int main(int argc, char** argv) {
    uint64_t budget = 2000000;
    bool undirected = false;
    bool verify = false;
    std::string dotPath, inputPath;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--budget" && i + 1 < argc) {
            budget = std::stoull(argv[++i]);
        } else if (a == "--undirected") {
            undirected = true;
        } else if (a == "--verify") {
            verify = true;
        } else if (a == "--dot" && i + 1 < argc) {
            dotPath = argv[++i];
        } else if (a == "-h" || a == "--help") {
            printUsage(argv[0]);
            return 0;
        } else if (!a.empty() && a[0] != '-') {
            inputPath = a;
        } else {
            std::cerr << "unknown option: " << a << "\n";
            return 1;
        }
    }

    try {
        sreach::Problem prob;
        if (inputPath.empty()) {
            prob = sreach::parseProblem(std::cin, undirected);
        } else {
            std::ifstream f(inputPath);
            if (!f) {
                std::cerr << "error: cannot open " << inputPath << "\n";
                return 1;
            }
            prob = sreach::parseProblem(f, undirected);
        }

        sreach::Solver solver(std::move(prob), budget);
        const sreach::Interval res = solver.solve();

        std::cout << "status: " << (solver.isExact() ? "exact" : "budget-exceeded") << "\n";
        if (solver.isExact()) {
            std::cout << "probability: " << res.lo.toString() << "\n";
        } else {
            std::cout << "lower: " << res.lo.toString() << "\n";
            std::cout << "upper: " << res.hi.toString() << "\n";
        }
        std::cout << "nodes: " << solver.decisionNodeCount() << "\n";

        if (!dotPath.empty()) {
            std::ofstream f(dotPath);
            if (!f) {
                std::cerr << "error: cannot write " << dotPath << "\n";
                return 1;
            }
            f << solver.toDot();
            std::cout << "dot: " << dotPath << "\n";
        }

        if (verify) {
            const sreach::Rational exact = sreach::enumerateReachability(solver.problem());
            const size_t m = solver.problem().edges.size();
            const bool ok = solver.isExact()
                                ? exact == res.lo
                                : sreach::compare(exact, res.lo) >= 0 &&
                                      sreach::compare(exact, res.hi) <= 0;
            if (ok) {
                std::cout << "verify: OK (enumeration over 2^" << m << " states";
                if (!solver.isExact()) std::cout << ", exact " << exact.toString() << " within bounds";
                std::cout << ")\n";
            } else {
                std::cout << "verify: MISMATCH enum=" << exact.toString() << "\n";
                return 3;
            }
        }
        return solver.isExact() ? 0 : 2;
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
