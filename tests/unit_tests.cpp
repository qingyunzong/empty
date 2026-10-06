#include "analysis.h"
#include "interval_set.h"
#include "program.h"
#include "verify.h"

#include <iostream>

static int failures = 0;
#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            ++failures;                                                 \
            std::cerr << "FAIL line " << __LINE__ << ": " #cond "\n";   \
        }                                                               \
    } while (0)

static void testIntervalBasics() {
    CHECK(IntervalSet::range(0, 3).join(IntervalSet::range(2, 5)) ==
          IntervalSet::range(0, 5));
    CHECK(IntervalSet::range(0, 3).join(IntervalSet::range(4, 6)) ==
          IntervalSet::range(0, 6)); // adjacent segments merge
    IntervalSet c = IntervalSet::range(0, 3).join(IntervalSet::range(6, 9));
    CHECK(c.size() == 2);
    CHECK(c.contains(0) && c.contains(9) && !c.contains(4));
    CHECK(c.measure() == 8);
    CHECK(IntervalSet().empty());
    CHECK(IntervalSet::full().measure() == 256);
}

static void testSegmentCap() {
    IntervalSet s;
    for (int v : {0, 10, 20, 30, 40}) s = s.join(IntervalSet::single(v));
    CHECK(s.size() == IntervalSet::kMaxSegments); // 5 singletons capped to 4
    for (int v : {0, 10, 20, 30, 40}) CHECK(s.contains(v));
    CHECK(s.contains(5)); // gap filled by merge: over-approximation
    // 4 segments stay exact, no merging happens
    IntervalSet t;
    for (int v : {10, 80, 150, 220}) t = t.join(IntervalSet::single(v));
    CHECK(t.size() == 4);
    CHECK(t.measure() == 4);
}

static void testWrap() {
    CHECK(IntervalSet::single(255).addWrap(1) == IntervalSet::single(0));
    CHECK(IntervalSet::single(0).subWrap(1) == IntervalSet::single(255));
    CHECK(IntervalSet::range(250, 255).addWrap(3) ==
          IntervalSet::range(0, 2).join(IntervalSet::range(253, 255)));
    CHECK(IntervalSet::range(0, 5).subWrap(3) ==
          IntervalSet::range(0, 2).join(IntervalSet::range(253, 255)));
    CHECK(IntervalSet::full().addWrap(7) == IntervalSet::full());
    CHECK(IntervalSet::range(10, 20).addWrap(5) == IntervalSet::range(15, 25));
    CHECK(IntervalSet::range(10, 20).subWrap(5) == IntervalSet::range(5, 15));
}

static void testFilter() {
    IntervalSet f = IntervalSet::full();
    CHECK(filterSet(f, CmpOp::Lt, 10) == IntervalSet::range(0, 9));
    CHECK(filterSet(f, CmpOp::Ge, 10) == IntervalSet::range(10, 255));
    CHECK(filterSet(f, CmpOp::Ne, 5) ==
          IntervalSet::range(0, 4).join(IntervalSet::range(6, 255)));
    CHECK(filterSet(f, CmpOp::Eq, 5) == IntervalSet::single(5));
    CHECK(filterSet(f, CmpOp::Lt, 0).empty());
    CHECK(filterSet(f, CmpOp::Gt, 255).empty());
    CHECK(filterSet(f, CmpOp::Ne, 0) == IntervalSet::range(1, 255));
    CHECK(filterSet(f, CmpOp::Ne, 255) == IntervalSet::range(0, 254));
}

static void testFixpointAndVerify() {
    Program p = parseProgram(
        "x = 0\n"
        "loop: x = x + 1\n"
        "if x < 3 goto loop\n"
        "halt\n");
    AnalysisResult res = analyze(p);
    CHECK(res.states[1].vals[0] == IntervalSet::range(0, 2));
    CHECK(res.states[3].reachable);
    CHECK(res.states[3].vals[0] == IntervalSet::single(3));
    CHECK(verify(p, res.states).ok);
    // A tampered (unsound) abstract state must be caught by verification.
    auto bad = res.states;
    bad[2].vals[0] = IntervalSet::single(0);
    VerifyResult vr = verify(p, bad);
    CHECK(!vr.ok);
    CHECK(vr.violationCount > 0);
}

static void testBranchMerge() {
    Program p = parseProgram(
        "input x\n"
        "if x < 32 goto a\n"
        "if x < 64 goto b\n"
        "if x < 96 goto c\n"
        "if x < 128 goto d\n"
        "goto e\n"
        "a: x = 1\n"
        "goto j\n"
        "b: x = 70\n"
        "goto j\n"
        "c: x = 100\n"
        "goto j\n"
        "d: x = 200\n"
        "goto j\n"
        "e: x = 250\n"
        "j: halt\n");
    AnalysisResult res = analyze(p);
    const IntervalSet& xs = res.states.back().vals[0];
    CHECK(xs.size() == 4); // 5 singletons capped to 4 segments
    for (int v : {1, 70, 100, 200, 250}) CHECK(xs.contains(v));
    CHECK(verify(p, res.states).ok);
}

static void testMultiVar() {
    Program p = parseProgram(
        "input x\n"
        "y = x + 1\n"
        "halt\n");
    AnalysisResult res = analyze(p);
    CHECK(res.states[2].vals[p.varIndex("y")] == IntervalSet::full());
    CHECK(verify(p, res.states).ok);
}

static void testParseErrors() {
    bool threw = false;
    try { parseProgram("goto nowhere\n"); } catch (const ParseError&) { threw = true; }
    CHECK(threw);
    threw = false;
    try { parseProgram("x = 300\n"); } catch (const ParseError&) { threw = true; }
    CHECK(threw);
    threw = false;
    try { parseProgram("x = = 1\n"); } catch (const ParseError&) { threw = true; }
    CHECK(threw);
}

int main() {
    testIntervalBasics();
    testSegmentCap();
    testWrap();
    testFilter();
    testFixpointAndVerify();
    testBranchMerge();
    testMultiVar();
    testParseErrors();
    if (failures) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all unit tests passed\n";
    return 0;
}
