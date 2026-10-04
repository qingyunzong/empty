// 演示：生成一个确定性的 12 跳转实例，求解最短合法布局，
// 输出迭代轨迹、偏移证书，并用 2^12 全枚举核对最优性。
#include <cstdlib>
#include <iostream>
#include <random>
#include <vector>

#include "branch.hpp"

int main(int argc, char** argv) {
    const int n = 120;       // 指令条数
    const int n_jumps = 12;  // 跳转条数（<= 20，可全枚举）
    const unsigned seed = argc > 1 ? std::atoi(argv[1]) : 5;

    std::mt19937 rng(seed);
    std::vector<branch::Instruction> prog(n);
    std::uniform_int_distribution<int> size_dist(1, 3);
    for (auto& ins : prog) ins.size = size_dist(rng);

    std::uniform_int_distribution<int> idx_dist(0, n - 1);
    int placed = 0;
    while (placed < n_jumps) {
        int i = idx_dist(rng);
        if (prog[i].is_jump) continue;
        prog[i].is_jump = true;
        prog[i].target = idx_dist(rng);
        ++placed;
    }

    std::cout << "实例: " << n << " 条指令, " << n_jumps
              << " 条跳转, 种子=" << seed << "\n\n";

    branch::SolveResult r = branch::solve(prog);

    std::cout << "=== 迭代轨迹 ===\n";
    for (const auto& line : r.trace) std::cout << line << "\n";
    std::cout << "\n" << branch::certificate(prog, r) << "\n";

    auto bf = branch::brute_force(prog);
    std::cout << "=== 枚举核对 ===\n";
    std::cout << "枚举 " << (1ULL << n_jumps) << " 种长短组合, 最短可行总长 = ";
    if (bf) std::cout << *bf << "\n";
    else std::cout << "无可行布局\n";

    bool ok = r.best.feasible && bf && *bf == r.best.total;
    std::cout << (ok ? "一致：松弛迭代达到最优\n"
                     : "不一致：求解器与枚举结果不符\n");
    return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
