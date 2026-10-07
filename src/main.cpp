#include <iomanip>
#include <iostream>
#include <string>

#include "bruteforce.hpp"
#include "scenario.hpp"
#include "solver.hpp"

namespace {

void usage(const char* prog) {
    std::cerr << "usage: " << prog
              << " <scenario-file> [--verify] [--max-leaves N]\n"
                 "  --verify       cross-check against full enumeration of all\n"
                 "                 allocation vectors (small instances only)\n"
                 "  --max-leaves N enumeration guard (default 50000000)\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::string path;
    bool verify = false;
    long long max_leaves = 50000000;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--verify") {
            verify = true;
        } else if (arg == "--max-leaves" && i + 1 < argc) {
            max_leaves = std::stoll(argv[++i]);
        } else if (arg == "-h" || arg == "--help") {
            usage(argv[0]);
            return 0;
        } else if (path.empty() && arg.rfind("--", 0) != 0) {
            path = arg;
        } else {
            usage(argv[0]);
            return 2;
        }
    }
    if (path.empty()) {
        usage(argv[0]);
        return 2;
    }

    try {
        const sim::Scenario sc = sim::load_scenario(path);
        const sim::Solution sol = sim::solve(sc);

        std::cout << "Scenario: " << sc.targets.size() << " targets, "
                  << sc.ammo_types << " ammo types, budget " << sc.budget
                  << "\n\n";

        // Evaluation table for the optimal plan.
        size_t name_w = 4;
        for (const auto& t : sc.targets) name_w = std::max(name_w, t.name.size());
        std::cout << "Evaluation table (optimal plan)\n";
        std::cout << std::left << std::setw(4) << "Id"
                  << std::setw(name_w + 2) << "Name" << std::right
                  << std::setw(7) << "Value" << std::setw(6) << "Thr";
        for (int a = 0; a < sc.ammo_types; ++a)
            std::cout << std::setw(4) << ("A" + std::to_string(a));
        std::cout << std::setw(8) << "Damage"
                  << "  Status\n";
        for (size_t t = 0; t < sc.targets.size(); ++t) {
            std::cout << std::left << std::setw(4) << t
                      << std::setw(name_w + 2) << sc.targets[t].name << std::right
                      << std::setw(7) << sc.targets[t].value << std::setw(6)
                      << sc.targets[t].threshold;
            for (int a = 0; a < sc.ammo_types; ++a)
                std::cout << std::setw(4) << sol.rounds[t][a];
            std::cout << std::setw(8) << sol.target_damage[t] << "  "
                      << (sol.destroyed[t] ? "DESTROYED" : "-") << "\n";
        }
        std::cout << "\nTotals: value=" << sol.total_value
                  << "  rounds=" << sol.total_rounds << "/" << sc.budget << "\n";

        if (verify) {
            const sim::ReferenceResult ref = sim::brute_force(sc, max_leaves);
            if (!ref.ran) {
                std::cout << "\nReference check SKIPPED: " << ref.leaf_count
                          << " allocation vectors exceed --max-leaves "
                          << max_leaves << "\n";
                return 0;
            }
            std::cout << "\nReference check: enumerated " << ref.leaf_count
                      << " allocation vectors\n"
                      << "  reference: value=" << ref.best_value
                      << " rounds=" << ref.best_rounds << "\n"
                      << "  solver:    value=" << sol.total_value
                      << " rounds=" << sol.total_rounds << "\n";
            if (ref.best_value == sol.total_value &&
                ref.best_rounds == sol.total_rounds) {
                std::cout << "VERIFY PASS\n";
            } else {
                std::cout << "VERIFY FAIL\n";
                return 1;
            }
        }
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }
    return 0;
}
