// rel: exact source-to-target reachability probability for directed graphs
// with independent rational edge probabilities.
#include "enumerate.hpp"
#include "solver.hpp"
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>

static void usage(const char* prog) {
    std::cout <<
        "Usage: " << prog << " [options] [input-file]   (reads stdin if no file)\n"
        "Computes the exact probability that T is reachable from S in a directed\n"
        "graph whose edges work independently with rational probabilities.\n"
        "\n"
        "Input format ('#' starts a comment):\n"
        "  N M          vertices, edges (M <= 63)\n"
        "  S T          source, target (0-based)\n"
        "  u v p        M edge lines; p as '2/3', '0.75' or '1', in [0,1]\n"
        "\n"
        "Options:\n"
        "  --budget N   max internal decision-diagram nodes (0 = unlimited,\n"
        "               default 100000); on overflow prints sound [lo, hi] bounds\n"
        "  --dot FILE   write the decision diagram in Graphviz DOT format\n"
        "  --verify     cross-check by exhaustive enumeration of all 2^M edge\n"
        "               states (requires M <= 26); exits nonzero on mismatch\n"
        "  --decimal D  fractional digits for decimal printout (default 10)\n"
        "  --help       this text\n";
}

int main(int argc, char** argv) {
    uint64_t budget = 100000;
    std::string dotFile, inputFile;
    bool verify = false;
    int decimals = 10;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto need = [&](const char* name) -> std::string {
            if (i + 1 >= argc) {
                std::cerr << "missing value for " << name << "\n";
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--budget") budget = std::stoull(need("--budget"));
        else if (a == "--dot") dotFile = need("--dot");
        else if (a == "--verify") verify = true;
        else if (a == "--decimal") decimals = std::stoi(need("--decimal"));
        else if (a == "--help") { usage(argv[0]); return 0; }
        else if (a.rfind("--", 0) == 0) {
            std::cerr << "unknown option: " << a << "\n";
            return 2;
        } else if (inputFile.empty()) inputFile = a;
        else {
            std::cerr << "unexpected argument: " << a << "\n";
            return 2;
        }
    }

    std::string text;
    if (inputFile.empty()) {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        text = ss.str();
    } else {
        std::ifstream f(inputFile);
        if (!f) {
            std::cerr << "cannot open " << inputFile << "\n";
            return 2;
        }
        std::ostringstream ss;
        ss << f.rdbuf();
        text = ss.str();
    }

    Graph g;
    try {
        g = parseGraph(text);
    } catch (const std::exception& ex) {
        std::cerr << "input error: " << ex.what() << "\n";
        return 2;
    }

    Solver solver(g, budget == 0 ? std::numeric_limits<uint64_t>::max() : budget);
    int root = solver.solve();
    const Solver::Node& rn = solver.nodes()[root];
    bool exact = (rn.loVal == rn.hiVal);

    if (exact) {
        std::cout << "P(s~>t) = " << rn.loVal.str() << "\n";
        std::cout << "decimal: " << rn.loVal.decimal(decimals) << "\n";
    } else {
        std::cout << "ABORTED: node budget " << budget << " exceeded\n";
        std::cout << "bounds: " << rn.loVal.str() << " <= P(s~>t) <= "
                  << rn.hiVal.str() << "\n";
        std::cout << "decimal: " << rn.loVal.decimal(decimals) << " <= P <= "
                  << rn.hiVal.decimal(decimals) << "\n";
    }
    std::cout << "diagram: " << solver.internalCount() << " internal nodes, "
              << solver.nodes().size() << " total\n";

    if (!dotFile.empty()) {
        std::ofstream f(dotFile);
        if (!f) {
            std::cerr << "cannot write " << dotFile << "\n";
            return 2;
        }
        f << solver.toDot();
        std::cout << "dot: written to " << dotFile << "\n";
    }

    if (verify) {
        Rational ev;
        try {
            ev = enumerateExact(g);
        } catch (const std::exception& ex) {
            std::cerr << "verify error: " << ex.what() << "\n";
            return 2;
        }
        if (exact) {
            bool ok = (ev == rn.loVal);
            std::cout << "verify: enumeration = " << ev.str() << "  "
                      << (ok ? "MATCH" : "MISMATCH") << "\n";
            if (!ok) return 1;
        } else {
            bool ok = (rn.loVal <= ev || rn.loVal == ev) && (ev <= rn.hiVal || ev == rn.hiVal);
            std::cout << "verify: enumeration = " << ev.str()
                      << (ok ? " within bounds  BOUNDS-OK" : " OUTSIDE bounds  BOUNDS-VIOLATION")
                      << "\n";
            if (!ok) return 1;
        }
    }
    return 0;
}
