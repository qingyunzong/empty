// 演示程序：从标准输入读取粒子，输出全部事件的精确时间与接触组。
// 输入格式：
//   第一行：粒子数 n
//   随后 n 行：位置(整数) 速度分子(整数) 速度分母(正整数)
// 输出：每个事件一行，形如
//   t = 5/2 : group [0,1]

#include <motion/simulation.hpp>

#include <cstdio>
#include <iostream>
#include <vector>

int main() {
    std::size_t n;
    if (!(std::cin >> n)) {
        std::fprintf(stderr, "usage: n, then n lines of: pos vnum vden\n");
        return 1;
    }
    std::vector<motion::Particle> particles;
    for (std::size_t i = 0; i < n; ++i) {
        long long pos, vnum, vden;
        if (!(std::cin >> pos >> vnum >> vden)) {
            std::fprintf(stderr, "invalid input at particle %zu\n", i);
            return 1;
        }
        particles.push_back({motion::Rational(pos),
                             motion::Rational(motion::BigInt(vnum), motion::BigInt(vden))});
    }

    try {
        motion::Simulation sim(std::move(particles));
        while (auto event = sim.step()) {
            std::printf("t = %s :", event->time.to_string().c_str());
            for (const auto& g : event->groups)
                std::printf(" group [%zu,%zu]", g.first, g.last);
            std::printf("\n");
        }
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
    return 0;
}
