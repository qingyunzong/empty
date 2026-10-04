// 单元测试 + 随机模糊测试（求解器 vs 全枚举）。
#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "branch.hpp"

namespace {

int failures = 0;

void check(bool cond, const std::string& name) {
    std::cout << (cond ? "[通过] " : "[失败] ") << name << "\n";
    if (!cond) ++failures;
}

// 1. 无跳转：总长 = 各指令长度之和。
void test_no_jumps() {
    std::vector<branch::Instruction> prog(5);
    for (auto& ins : prog) ins.size = 3;
    auto r = branch::solve(prog);
    check(r.best.feasible && r.best.total == 15, "无跳转总长度");
}

// 2. 近跳转保持短编码。
void test_short_jump_kept() {
    std::vector<branch::Instruction> prog(10);
    prog[0].is_jump = true;
    prog[0].target = 5;
    auto r = branch::solve(prog);
    check(r.best.feasible && !r.best.is_long[0] && r.best.total == 11,
          "近跳转保持短编码");
}

// 3. 远跳转被迫拉长：位移 200 > 127。
void test_far_jump_forced_long() {
    std::vector<branch::Instruction> prog(210);
    prog[0].is_jump = true;
    prog[0].target = 202; // 位移 = 202 - 2 = 200 > 127
    auto r = branch::solve(prog);
    check(r.best.feasible && r.best.is_long[0] && r.best.total == 214,
          "远跳转被迫拉长");
}

// 4. 级联：A 拉长使 B 的目标偏移增大，B 也被迫拉长。
void test_cascade() {
    std::vector<branch::Instruction> prog(200);
    prog[0].is_jump = true;
    prog[0].target = 128;  // 初始位移 126，恰好合法
    prog[50].is_jump = true;
    prog[50].target = 199; // 位移 147，必须拉长，+3 字节
    auto r = branch::solve(prog);
    check(r.best.feasible && r.best.is_long[0] && r.best.is_long[50],
          "级联拉长");
    check(r.trace.size() >= 4, "级联至少两轮迭代");
}

// 5. 不可行：长编码范围被人为收窄仍放不下。
void test_infeasible() {
    std::vector<branch::Instruction> prog(200);
    prog[0].is_jump = true;
    prog[0].target = 150; // 位移 148 > 127，短编码越界
    prog[0].long_min = -10;
    prog[0].long_max = 10; // 长编码也只能表示 +-10
    auto r = branch::solve(prog);
    check(!r.best.feasible, "不可行检测");
}

// 6. 随机模糊：跳转数 <= 10，求解器结果必须等于全枚举最优。
void test_fuzz_small() {
    std::mt19937 rng(12345);
    for (int tc = 0; tc < 500; ++tc) {
        int n = 5 + rng() % 30;
        std::vector<branch::Instruction> prog(n);
        for (auto& ins : prog) ins.size = 1 + rng() % 3;
        int nj = rng() % 11;
        for (int k = 0; k < nj; ++k) {
            int i = rng() % n;
            prog[i].is_jump = true;
            prog[i].target = rng() % n;
        }
        auto r = branch::solve(prog);
        auto bf = branch::brute_force(prog);
        if (!(r.best.feasible && bf && *bf == r.best.total)) {
            check(false, "模糊用例 " + std::to_string(tc));
            return;
        }
    }
    check(true, "随机模糊 500 例（<=10 跳转）与枚举一致");
}

// 7. 上限规模：20 条跳转，2^20 = 1048576 种组合全枚举核对。
void test_twenty_jumps() {
    std::mt19937 rng(777);
    const int n = 25;
    std::vector<branch::Instruction> prog(n);
    for (int i = 0; i < 20; ++i) {
        prog[i].is_jump = true;
        prog[i].target = rng() % n;
    }
    auto r = branch::solve(prog);
    auto bf = branch::brute_force(prog);
    check(r.best.feasible && bf && *bf == r.best.total,
          "20 跳转与 2^20 全枚举一致");
}

} // namespace

int main() {
    test_no_jumps();
    test_short_jump_kept();
    test_far_jump_forced_long();
    test_cascade();
    test_infeasible();
    test_fuzz_small();
    test_twenty_jumps();
    std::cout << (failures == 0 ? "全部测试通过\n" : "存在失败用例\n");
    return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
