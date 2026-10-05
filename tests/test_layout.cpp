#include "layout.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace {

using asmlayout::Encoding;
using asmlayout::Instruction;

int failures = 0;

void check(bool cond, const std::string& name) {
    if (cond) {
        std::cout << "PASS  " << name << '\n';
    } else {
        std::cout << "FAIL  " << name << '\n';
        ++failures;
    }
}

void test_empty_program() {
    const Encoding enc;
    auto solved = asmlayout::solve_relaxation({}, enc);
    check(solved.layout.feasible && solved.layout.total_length == 0,
          "empty program has zero length");
    check(solved.trace.size() == 1 && solved.trace[0].flipped.empty(),
          "empty program converges in one iteration");
}

void test_fixed_only() {
    const Encoding enc;
    const std::vector<Instruction> prog = {
        Instruction::fixed(3), Instruction::fixed(4), Instruction::fixed(2)};
    auto solved = asmlayout::solve_relaxation(prog, enc);
    check(solved.layout.total_length == 9, "fixed-only total length");
    check(solved.layout.offsets[2] == 7, "fixed-only offsets");
}

void test_short_jump_in_range() {
    const Encoding enc;
    const std::vector<Instruction> prog = {
        Instruction::jump(2), Instruction::fixed(1), Instruction::fixed(1)};
    auto solved = asmlayout::solve_relaxation(prog, enc);
    check(!solved.layout.is_long[0] && solved.layout.displacement[0] == 1,
          "in-range jump stays short");
    check(solved.layout.total_length == 4, "in-range jump total length");
}

void test_forced_long_backward() {
    const Encoding enc;
    std::vector<Instruction> prog;
    for (int i = 0; i < 200; ++i)
        prog.push_back(Instruction::fixed(1));
    prog.push_back(Instruction::jump(0)); // disp = -202, out of rel8 range
    auto solved = asmlayout::solve_relaxation(prog, enc);
    check(solved.layout.is_long[200], "out-of-range jump grows to long");
    check(solved.layout.total_length == 205, "forced-long total length");
    check(solved.trace.size() == 2 && solved.trace[0].flipped.size() == 1,
          "forced-long converges in two iterations");
}

void test_cascading_growth() {
    const Encoding enc;
    // insn 2 is forced long (disp -129); growing it pushes insn 0's target
    // from disp 127 (legal) to 130 (illegal), so insn 0 must grow too.
    const std::vector<Instruction> prog = {
        Instruction::jump(3), Instruction::fixed(125), Instruction::jump(0),
        Instruction::fixed(1)};
    auto solved = asmlayout::solve_relaxation(prog, enc);
    check(solved.trace.size() == 3, "cascade takes three iterations");
    check(solved.trace[0].flipped == std::vector<int>{2},
          "cascade iteration 0 flips insn 2");
    check(solved.trace[1].flipped == std::vector<int>{0},
          "cascade iteration 1 flips insn 0");
    check(solved.layout.is_long[0] && solved.layout.is_long[2],
          "cascade final encoding");
    check(solved.layout.total_length == 136, "cascade total length");
    check(asmlayout::verify(prog, enc, solved.layout),
          "cascade certificate verifies");
}

void test_boundary_displacements() {
    const Encoding enc;
    // disp exactly 127 must stay short; disp 128 must grow.
    std::vector<Instruction> ok = {Instruction::jump(2), Instruction::fixed(127),
                                   Instruction::fixed(1)};
    auto solved_ok = asmlayout::solve_relaxation(ok, enc);
    check(!solved_ok.layout.is_long[0] && solved_ok.layout.displacement[0] == 127,
          "disp +127 stays short");
    std::vector<Instruction> far = {Instruction::jump(2), Instruction::fixed(128),
                                    Instruction::fixed(1)};
    auto solved_far = asmlayout::solve_relaxation(far, enc);
    check(solved_far.layout.is_long[0], "disp +128 grows to long");
    // disp exactly -128 stays short: backward jump from offset 126.
    std::vector<Instruction> back;
    back.push_back(Instruction::fixed(126));
    back.push_back(Instruction::jump(0));
    auto solved_back = asmlayout::solve_relaxation(back, enc);
    check(!solved_back.layout.is_long[1] &&
              solved_back.layout.displacement[1] == -128,
          "disp -128 stays short");
}

void test_enumeration_matches_relaxation() {
    const Encoding enc;
    std::mt19937 rng(20261005);
    for (int trial = 0; trial < 200; ++trial) {
        const int n = 4 + static_cast<int>(rng() % 20);
        std::vector<Instruction> prog;
        prog.reserve(n);
        int jumps = 0;
        for (int i = 0; i < n; ++i) {
            if (jumps < 12 && rng() % 3 == 0) {
                prog.push_back(Instruction::jump(static_cast<int>(rng() % n)));
                ++jumps;
            } else {
                prog.push_back(Instruction::fixed(1 + static_cast<int>(rng() % 8)));
            }
        }
        auto relaxed = asmlayout::solve_relaxation(prog, enc);
        auto optimum = asmlayout::solve_optimal(prog, enc);
        if (!optimum.has_value()) {
            check(false, "random enumeration available");
            return;
        }
        if (!asmlayout::verify(prog, enc, relaxed.layout) ||
            relaxed.layout.total_length != optimum->total_length) {
            check(false, "random trial: relaxation matches enumeration optimum");
            return;
        }
    }
    check(true, "200 random programs: relaxation total == enumeration optimum");
}

void test_enumeration_at_limit() {
    const Encoding enc;
    std::mt19937 rng(7);
    std::vector<Instruction> prog;
    for (int i = 0; i < 20; ++i) {
        prog.push_back(Instruction::jump(static_cast<int>(rng() % 40)));
        prog.push_back(Instruction::fixed(1 + static_cast<int>(rng() % 100)));
    }
    auto relaxed = asmlayout::solve_relaxation(prog, enc);
    auto optimum = asmlayout::solve_optimal(prog, enc);
    check(optimum.has_value(), "20-jump enumeration completes");
    check(optimum && relaxed.layout.total_length == optimum->total_length,
          "20-jump relaxation matches enumeration optimum");
}

void test_enumeration_limit_exceeded() {
    const Encoding enc;
    std::vector<Instruction> prog;
    for (int i = 0; i < 21; ++i)
        prog.push_back(Instruction::jump(0));
    check(!asmlayout::solve_optimal(prog, enc).has_value(),
          "21 jumps exceeds enumeration limit");
}

void test_verify_detects_tampering() {
    const Encoding enc;
    const std::vector<Instruction> prog = {
        Instruction::jump(3), Instruction::fixed(125), Instruction::jump(0),
        Instruction::fixed(1)};
    auto solved = asmlayout::solve_relaxation(prog, enc);
    auto tampered = solved.layout;
    tampered.offsets[1] += 1;
    check(!asmlayout::verify(prog, enc, tampered),
          "verify rejects tampered offsets");
    auto wrong_encoding = solved.layout;
    wrong_encoding.is_long[0] = false;
    check(!asmlayout::verify(prog, enc, wrong_encoding),
          "verify rejects illegal encoding choice");
}

void test_invalid_input() {
    const Encoding enc;
    bool threw = false;
    try {
        asmlayout::solve_relaxation({Instruction::jump(5)}, enc);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    check(threw, "out-of-range jump target rejected");
}

} // namespace

int main(int argc, char** argv) {
    const std::string filter = argc > 1 ? argv[1] : "";
    auto want = [&](const char* name) {
        return filter.empty() || filter == name;
    };
    if (want("basic")) {
        test_empty_program();
        test_fixed_only();
        test_short_jump_in_range();
        test_forced_long_backward();
        test_boundary_displacements();
        test_invalid_input();
    }
    if (want("cascade"))
        test_cascading_growth();
    if (want("random"))
        test_enumeration_matches_relaxation();
    if (want("limit")) {
        test_enumeration_at_limit();
        test_enumeration_limit_exceeded();
    }
    if (want("verify"))
        test_verify_detects_tampering();

    if (failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cout << failures << " test(s) failed\n";
    return 1;
}
