#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "analysis.hpp"
#include "program.hpp"
#include "verify.hpp"

namespace {

void usage(const char* argv0) {
    std::cerr << "usage: " << argv0 << " [--verify|-v] <program.an>\n"
              << "  Computes the fixpoint over-approximation of reachable 8-bit values\n"
              << "  (union of <= 4 intervals, hull-merged beyond that) for every\n"
              << "  program point. --verify additionally enumerates all concrete\n"
              << "  reachable states and checks inclusion.\n";
}

bool isExitPoint(const Program& prog, int pc) {
    const Instruction& ins = prog.code[pc];
    if (ins.kind == Instruction::Kind::Halt) return true;
    bool fallsThrough = ins.kind != Instruction::Kind::Goto &&
                        ins.kind != Instruction::Kind::CondGoto;
    return fallsThrough && pc + 1 == static_cast<int>(prog.code.size());
}

} // namespace

int main(int argc, char** argv) {
    bool verify = false;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--verify" || arg == "-v") {
            verify = true;
        } else if (arg == "--help" || arg == "-h") {
            usage(argv[0]);
            return 0;
        } else if (!arg.empty() && arg[0] == '-') {
            std::cerr << "unknown option: " << arg << "\n";
            usage(argv[0]);
            return 2;
        } else {
            path = arg;
        }
    }
    if (path.empty()) {
        usage(argv[0]);
        return 2;
    }

    std::ifstream in(path);
    if (!in) {
        std::cerr << "cannot open " << path << "\n";
        return 2;
    }
    std::ostringstream buf;
    buf << in.rdbuf();

    std::string error;
    bool ok = false;
    Program prog = parseProgram(buf.str(), error, ok);
    if (!ok) {
        std::cerr << "parse error: " << error << "\n";
        return 1;
    }

    AnalysisResult res = analyze(prog);

    std::cout << "== Abstract fixpoint (over-approximated sets) ==\n";
    for (int pc = 0; pc < static_cast<int>(prog.code.size()); ++pc) {
        std::cout << "pc " << pc << ": " << instrToString(prog.code[pc]);
        if (isExitPoint(prog, pc)) std::cout << "    ; exit point";
        std::cout << "\n";
        bool any = false;
        for (const std::string& v : prog.varNames) {
            const IntervalSet& set = res.at[pc].at(v);
            if (!set.isBottom()) {
                std::cout << "    " << v << ": " << set.toString() << "\n";
                any = true;
            }
        }
        if (!any) std::cout << "    (unreachable)\n";
    }
    std::cout << "fixpoint reached after " << res.iterations << " worklist iterations\n";

    if (!verify) return 0;

    VerifyResult vr = verifyConcrete(prog, res);
    std::cout << "== Concrete verification ==\n";
    std::cout << "enumerated " << vr.statesVisited << " concrete reachable states\n";
    if (vr.ok) {
        std::cout << "VERIFIED: abstract result covers all concrete states\n";
        return 0;
    }
    std::cout << "VIOLATED: abstract result misses concrete states:\n";
    for (const std::string& v : vr.violations) std::cout << "  " << v << "\n";
    return 1;
}
