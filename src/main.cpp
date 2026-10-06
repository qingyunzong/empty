#include "compress.hpp"

#include <iostream>
#include <string>
#include <vector>

// Input format (stdin):
//   line 1: the symbol string s (length <= 30)
//   line 2: m, the number of candidate fragments (<= 18)
//   next m lines: the candidate fragments
//   last line: dict_cost ref_cost len_cost
// Output (stdout):
//   "IMPOSSIBLE" if s cannot be tiled; otherwise the minimum cost on the
//   first line and the space-separated optimal piece sequence on the second.
int main() {
    std::string s;
    if (!std::getline(std::cin, s)) return 0;

    int m = 0;
    if (!(std::cin >> m)) return 0;
    std::vector<std::string> candidates(m);
    for (auto& c : candidates) std::cin >> c;

    CostParams params;
    std::cin >> params.dict_cost >> params.ref_cost >> params.len_cost;

    const CompressResult result = compress_min_cost(s, candidates, params);
    if (!result.feasible) {
        std::cout << "IMPOSSIBLE\n";
        return 0;
    }
    std::cout << result.cost << '\n';
    for (size_t i = 0; i < result.pieces.size(); ++i) {
        if (i) std::cout << ' ';
        std::cout << result.pieces[i];
    }
    std::cout << '\n';
    return 0;
}
