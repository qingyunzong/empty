#include "compress.hpp"

#include <iostream>
#include <string>

namespace {

void usage(const char* prog) {
    std::cerr << "usage: " << prog
              << " <string> [max_distinct=18] [dict_per_char=1] [ref_per_char=1]"
                 " [dict_flat=0] [ref_flat=0]\n";
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2 || argc > 7) {
        usage(argv[0]);
        return 2;
    }
    std::string s = argv[1];
    if (s.size() > 30) {
        std::cerr << "error: input length must be <= 30\n";
        return 2;
    }
    std::size_t max_distinct = argc > 2 ? std::stoull(argv[2]) : 18;
    comp::CostModel model;
    if (argc > 3) model.dict_per_char = std::stoll(argv[3]);
    if (argc > 4) model.ref_per_char = std::stoll(argv[4]);
    if (argc > 5) model.dict_flat = std::stoll(argv[5]);
    if (argc > 6) model.ref_flat = std::stoll(argv[6]);

    comp::Solution sol = comp::solve(s, model, max_distinct);
    if (!sol.ok) {
        std::cout << "no feasible segmentation\n";
        return 1;
    }
    std::cout << "cost: " << sol.cost << "\npieces:";
    for (const auto& p : sol.pieces) std::cout << ' ' << p;
    std::cout << '\n';
    return 0;
}
