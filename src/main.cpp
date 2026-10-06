#include "analysis.h"
#include "program.h"
#include "verify.h"

#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <vector>

static const char* kUsage =
    "usage: analyzer [--no-verify] FILE\n"
    "  Computes an 8-bit wrap-aware range fixpoint (interval unions, at most\n"
    "  4 segments; extra segments merged) and verifies the over-approximation\n"
    "  by exhaustive enumeration of all concrete states.\n";

int main(int argc, char** argv) {
    bool doVerify = true;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--no-verify") {
            doVerify = false;
        } else if (a == "-h" || a == "--help") {
            std::cout << kUsage;
            return 0;
        } else if (!a.empty() && a[0] == '-') {
            std::cerr << "unknown option: " << a << "\n" << kUsage;
            return 2;
        } else if (path.empty()) {
            path = a;
        } else {
            std::cerr << "unexpected argument: " << a << "\n";
            return 2;
        }
    }
    if (path.empty()) {
        std::cerr << kUsage;
        return 2;
    }

    std::ifstream in(path);
    if (!in) {
        std::cerr << "error: cannot open " << path << "\n";
        return 2;
    }
    std::ostringstream ss;
    ss << in.rdbuf();

    Program prog;
    try {
        prog = parseProgram(ss.str());
    } catch (const ParseError& e) {
        std::cerr << "parse error: " << e.what() << "\n";
        return 2;
    }

    std::map<int, std::vector<std::string>> labelAt;
    for (auto& [name, idx] : prog.labels) labelAt[idx].push_back(name);

    std::cout << "== Program ==\n";
    for (size_t i = 0; i < prog.instrs.size(); ++i) {
        for (auto& l : labelAt[(int)i]) std::cout << "      " << l << ":\n";
        std::cout << "  L" << i << "\t" << prog.instrs[i].text << "\n";
    }

    AnalysisResult res = analyze(prog);
    std::cout << "\n== Abstract fixpoint (interval unions, at most "
              << IntervalSet::kMaxSegments
              << " segments; extra segments merged) ==\n";
    std::cout << "  converged after " << res.iterations
              << " transfer applications (no iteration cap)\n";
    for (size_t i = 0; i < prog.instrs.size(); ++i) {
        const AbstractState& st = res.states[i];
        if (!st.reachable) {
            std::cout << "  L" << i << "\t(unreachable)\n";
            continue;
        }
        std::cout << "  L" << i;
        for (size_t v = 0; v < prog.vars.size(); ++v)
            std::cout << "\t" << prog.vars[v] << ": " << st.vals[v].toString();
        std::cout << "\n";
    }

    if (!doVerify) return 0;

    VerifyResult vr = verify(prog, res.states);
    std::cout << "\n== Concrete verification (exhaustive enumeration) ==\n";
    std::cout << "  enumerated " << vr.statesEnumerated
              << " concrete configurations\n";
    if (!vr.complete) {
        std::cout << "  WARNING: enumeration hit safety cap; result incomplete\n";
        return 1;
    }
    if (vr.ok) {
        std::cout << "  VERDICT: PASS (abstract sets over-approximate all "
                     "concrete states)\n";
        return 0;
    }
    std::cout << "  VERDICT: FAIL (" << vr.violationCount << " violations)\n";
    for (auto& v : vr.violations) std::cout << "    " << v << "\n";
    return 1;
}
