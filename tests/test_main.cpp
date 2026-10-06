#include <iostream>
#include <string>

#include "analysis.hpp"
#include "interval_set.hpp"
#include "program.hpp"
#include "verify.hpp"

static int failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            ++failures;                                                    \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  "    \
                      << #cond << "\n";                                    \
        }                                                                  \
    } while (0)

static Program mustParse(const std::string& src) {
    std::string error;
    bool ok = false;
    Program prog = parseProgram(src, error, ok);
    if (!ok) {
        std::cerr << "unexpected parse error: " << error << "\n";
        ++failures;
    }
    return prog;
}

static void testIntervalBasics() {
    IntervalSet a = IntervalSet::range(10, 20);
    CHECK(a.toString() == "[10,20]");
    CHECK(a.addWrap(5) == IntervalSet::range(15, 25));

    // Whole interval wraps around the 8-bit ring.
    CHECK(IntervalSet::range(250, 255).addWrap(10) == IntervalSet::range(4, 9));

    // Interval straddling the wrap point splits into two segments.
    IntervalSet split = IntervalSet::range(200, 250).addWrap(10);
    CHECK(split == IntervalSet::range(210, 255).join(IntervalSet::range(0, 4)));
    CHECK(split.intervals().size() == 2);

    // Subtraction wraps too: [0,5] - 10 = [-10,-5] mod 256.
    CHECK(IntervalSet::range(0, 5).addWrap(-10) == IntervalSet::range(246, 251));
}

static void testSegmentCap() {
    IntervalSet four = IntervalSet::constant(0)
                           .join(IntervalSet::constant(10))
                           .join(IntervalSet::constant(20))
                           .join(IntervalSet::constant(30));
    CHECK(four.intervals().size() == 4);

    IntervalSet five = four.join(IntervalSet::constant(40));
    CHECK(five.intervals().size() == 1); // hull merge
    CHECK(five == IntervalSet::range(0, 40));

    // Adjacent segments merge before the cap applies.
    IntervalSet adj = IntervalSet::range(0, 3).join(IntervalSet::range(4, 9));
    CHECK(adj == IntervalSet::range(0, 9));
}

static void testCmpSets() {
    CHECK(cmpSatisfyingSet(CmpOp::Lt, 100) == IntervalSet::range(0, 99));
    CHECK(cmpSatisfyingSet(CmpOp::Ge, 100) == IntervalSet::range(100, 255));
    CHECK(cmpSatisfyingSet(CmpOp::Eq, 7) == IntervalSet::constant(7));
    IntervalSet ne = cmpSatisfyingSet(CmpOp::Ne, 5);
    CHECK(ne == IntervalSet::range(0, 4).join(IntervalSet::range(6, 255)));
    CHECK(cmpSatisfyingSet(CmpOp::Lt, 0).isBottom());
    CHECK(cmpSatisfyingSet(CmpOp::Lt, 300) == IntervalSet::top());
    CHECK(cmpSatisfyingSet(CmpOp::Eq, 300).isBottom());
    CHECK(cmpSatisfyingSet(CmpOp::Ne, 300) == IntervalSet::top());
}

static void testCountUpFixpoint() {
    Program prog = mustParse(
        "x = 0\n"
        "loop:\n"
        "x = x + 3\n"
        "if x < 100 goto loop\n"
        "halt\n");
    AnalysisResult res = analyze(prog);
    // Loop head accumulates [0,99]; exit over-approximates to [100,102].
    CHECK(res.at[1].at("x") == IntervalSet::range(0, 99));
    CHECK(res.at[3].at("x") == IntervalSet::range(100, 102));
    CHECK(res.iterations > 0);

    VerifyResult vr = verifyConcrete(prog, res);
    CHECK(vr.ok);
    CHECK(vr.statesVisited > 60); // 34 loop-head values + others
}

static void testWrapOrbitFixpoint() {
    Program prog = mustParse(
        "x = 0\n"
        "loop:\n"
        "x = x + 100\n"
        "if x != 0 goto loop\n"
        "halt\n");
    AnalysisResult res = analyze(prog);
    // The 64-value orbit needs > 4 segments, so the head merges to top.
    CHECK(res.at[1].at("x") == IntervalSet::top());
    // The exit filter x == 0 stays precise.
    CHECK(res.at[3].at("x") == IntervalSet::constant(0));

    VerifyResult vr = verifyConcrete(prog, res);
    CHECK(vr.ok);
}

static void testBranchMerge() {
    Program prog = mustParse(
        "x = 0\n"
        "loop:\n"
        "x = x + 3\n"
        "if x < 100 goto loop\n"
        "if x >= 101 goto big\n"
        "y = 5\n"
        "goto done\n"
        "big:\n"
        "y = 200\n"
        "done:\n"
        "halt\n");
    AnalysisResult res = analyze(prog);
    int haltPc = static_cast<int>(prog.code.size()) - 1;
    IntervalSet expected = IntervalSet::constant(5).join(IntervalSet::constant(200));
    CHECK(res.at[haltPc].at("y") == expected);
    CHECK(res.at[haltPc].at("y").intervals().size() == 2);

    VerifyResult vr = verifyConcrete(prog, res);
    CHECK(vr.ok);
}

static void testCountDownWrap() {
    Program prog = mustParse(
        "x = 10\n"
        "loop:\n"
        "x = x - 3\n"
        "if x < 200 goto loop\n"
        "halt\n");
    AnalysisResult res = analyze(prog);
    // Loop head holds exactly the 4 concrete values (4 segments, no merge).
    CHECK(res.at[1].at("x").intervals().size() == 4);
    CHECK(res.at[3].at("x") == IntervalSet::constant(254));
    VerifyResult vr = verifyConcrete(prog, res);
    CHECK(vr.ok);
}

static void testVerifyCatchesUnsound() {
    Program prog = mustParse(
        "x = 0\n"
        "loop:\n"
        "x = x + 3\n"
        "if x < 100 goto loop\n"
        "halt\n");
    AnalysisResult res = analyze(prog);
    res.at[3]["x"] = IntervalSet::constant(5); // deliberately wrong
    VerifyResult vr = verifyConcrete(prog, res);
    CHECK(!vr.ok);
    CHECK(!vr.violations.empty());
}

static void testParserErrors() {
    std::string error;
    bool ok = true;
    parseProgram("x = 0\ngoto nowhere\n", error, ok);
    CHECK(!ok);
    parseProgram("x = = 3\n", error, ok);
    CHECK(!ok);
    parseProgram("", error, ok);
    CHECK(!ok);
    parseProgram("loop:\nloop:\nhalt\n", error, ok);
    CHECK(!ok);
}

int main() {
    testIntervalBasics();
    testSegmentCap();
    testCmpSets();
    testCountUpFixpoint();
    testWrapOrbitFixpoint();
    testBranchMerge();
    testCountDownWrap();
    testVerifyCatchesUnsound();
    testParserErrors();
    if (failures == 0) {
        std::cout << "all unit tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
