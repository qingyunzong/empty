#include "layout.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

using asmlayout::Encoding;
using asmlayout::Instruction;

// Input format, one instruction per line ('#' starts a comment):
//   fixed <size>          fixed-size instruction
//   jump <target_index>   relative jump to instruction <target_index>
//   encoding <ssz> <lsz> <min> <max>   optional, must come first
std::vector<Instruction> parse_program(std::istream& in, Encoding& enc) {
    std::vector<Instruction> prog;
    std::string line;
    int lineno = 0;
    while (std::getline(in, line)) {
        ++lineno;
        const auto hash = line.find('#');
        if (hash != std::string::npos)
            line.erase(hash);
        std::istringstream tokens(line);
        std::string word;
        if (!(tokens >> word))
            continue;
        if (word == "fixed") {
            int size = 0;
            tokens >> size;
            prog.push_back(Instruction::fixed(size));
        } else if (word == "jump") {
            int target = 0;
            tokens >> target;
            prog.push_back(Instruction::jump(target));
        } else if (word == "encoding") {
            tokens >> enc.short_size >> enc.long_size >> enc.short_min >>
                enc.short_max;
        } else {
            std::cerr << "line " << lineno << ": unknown directive '" << word
                      << "'\n";
            std::exit(2);
        }
    }
    return prog;
}

std::vector<Instruction> demo_program() {
    // Cascading growth: insn 2 must go long, which pushes insn 0's target
    // out of short range, forcing insn 0 to grow as well.
    return {
        Instruction::jump(3),   // 0: forward jump, disp 127 -> 130
        Instruction::fixed(125),// 1: filler
        Instruction::jump(0),   // 2: backward jump, disp -129, forced long
        Instruction::fixed(1),  // 3: target of insn 0
    };
}

int run(const std::vector<Instruction>& prog, const Encoding& enc) {
    asmlayout::SolveResult solved = asmlayout::solve_relaxation(prog, enc);
    std::cout << asmlayout::render_trace(solved) << '\n';
    std::cout << asmlayout::render_certificate(prog, solved.layout) << '\n';
    std::cout << "certificate self-check: "
              << (asmlayout::verify(prog, enc, solved.layout) ? "OK" : "FAILED")
              << '\n';

    int jump_count = 0;
    for (const auto& insn : prog)
        if (insn.kind == Instruction::Kind::Jump)
            ++jump_count;

    if (auto optimum = asmlayout::solve_optimal(prog, enc)) {
        std::cout << "exhaustive check over 2^" << jump_count
                  << " short/long combinations:\n";
        std::cout << "  optimal total length = " << optimum->total_length
                  << '\n';
        std::cout << "  relaxation total     = "
                  << solved.layout.total_length << '\n';
        std::cout << "  relaxation is optimal: "
                  << (optimum->total_length == solved.layout.total_length
                          ? "YES"
                          : "NO")
                  << '\n';
    } else {
        std::cout << "more than 20 jumps; exhaustive check skipped\n";
    }
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    Encoding enc;
    if (argc == 1 || std::string(argv[1]) == "--demo") {
        std::cout << "running built-in demo program\n\n";
        return run(demo_program(), enc);
    }
    std::ifstream in(argv[1]);
    if (!in) {
        std::cerr << "cannot open " << argv[1] << '\n';
        return 2;
    }
    try {
        return run(parse_program(in, enc), enc);
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << '\n';
        return 1;
    }
}
