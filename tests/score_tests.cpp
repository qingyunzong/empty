#include "score/parser.hpp"
#include "score/rational.hpp"

#include <iostream>
#include <string>
#include <vector>

using score::Event;
using score::Rational;
using score::formatRational;
using score::parseScore;

static int g_failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            ++g_failures;                                                      \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "        \
                      << #cond << '\n';                                        \
        }                                                                      \
    } while (0)

#define CHECK_THROWS(expr)                                                     \
    do {                                                                       \
        bool threw = false;                                                    \
        try {                                                                  \
            (void)(expr);                                                      \
        } catch (const score::ParseError&) {                                   \
            threw = true;                                                      \
        }                                                                      \
        if (!threw) {                                                          \
            ++g_failures;                                                      \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "        \
                      << "expected ParseError: " #expr << '\n';                \
        }                                                                      \
    } while (0)

static void checkEvent(const Event& e, bool rest, const std::string& pitch,
                       const std::string& start, const std::string& end) {
    CHECK(e.isRest == rest);
    if (!rest) CHECK(e.pitch == pitch);
    CHECK(formatRational(e.start) == start);
    CHECK(formatRational(e.end) == end);
}

static void testRational() {
    CHECK(Rational(6, 8) == Rational(3, 4));
    CHECK(Rational(2, -4) == Rational(-1, 2));
    CHECK(Rational(-2, -4) == Rational(1, 2));
    CHECK(Rational(0, 7) == Rational(0, 1));
    CHECK(Rational(5, 10) + Rational(1, 3) == Rational(5, 6));
    CHECK(Rational(2, 3) * Rational(9, 4) == Rational(3, 2));
    CHECK(Rational(1, 2) / Rational(3, 4) == Rational(2, 3));
    CHECK(Rational(1, 3) < Rational(2, 5));
    CHECK(formatRational(Rational(4)) == "4");
    CHECK(formatRational(Rational(-3, 6)) == "-1/2");
}

static void testSimpleNotes() {
    auto ev = parseScore("C4/4 D4/8 E4/8.");
    CHECK(ev.size() == 3);
    if (ev.size() != 3) return;
    checkEvent(ev[0], false, "C4", "0", "1");
    checkEvent(ev[1], false, "D4", "1", "3/2");
    checkEvent(ev[2], false, "E4", "3/2", "9/4");
}

static void testDots() {
    auto ev = parseScore("C4/4. D4/4.. F#5/2.");
    CHECK(ev.size() == 3);
    if (ev.size() != 3) return;
    checkEvent(ev[0], false, "C4", "0", "3/2");
    checkEvent(ev[1], false, "D4", "3/2", "13/4");
    checkEvent(ev[2], false, "F#5", "13/4", "25/4");
}

static void testRestAndDefaultDuration() {
    auto ev = parseScore("R/4 C4 Bb3/8");
    CHECK(ev.size() == 3);
    if (ev.size() != 3) return;
    checkEvent(ev[0], true, "", "0", "1");
    checkEvent(ev[1], false, "C4", "1", "2");   // 省略时值默认四分音符
    checkEvent(ev[2], false, "Bb3", "2", "5/2");
}

static void testTupletUnequalMembers() {
    // 成员不等长：组内自然总时值 3/2 拍，缩放到 1 拍
    auto ev = parseScore("{1: C4/4 D4/8}");
    CHECK(ev.size() == 2);
    if (ev.size() != 2) return;
    checkEvent(ev[0], false, "C4", "0", "2/3");
    checkEvent(ev[1], false, "D4", "2/3", "1");
}

static void testTupletFractionBeats() {
    // 指定拍数为分数 3/2：自然总时值 2 拍，缩放因子 3/4
    auto ev = parseScore("{3/2: C4/4 D4/8 E4/8}");
    CHECK(ev.size() == 3);
    if (ev.size() != 3) return;
    checkEvent(ev[0], false, "C4", "0", "3/4");
    checkEvent(ev[1], false, "D4", "3/4", "9/8");
    checkEvent(ev[2], false, "E4", "9/8", "3/2");
}

static void testNestedTuplet() {
    // 外层自然总时值 3 拍缩到 2 拍；内层两个八分缩到 1 拍（再随外层缩放）
    auto ev = parseScore("{2: C4/4 {1: D4/8 E4/8} F4/4}");
    CHECK(ev.size() == 4);
    if (ev.size() != 4) return;
    checkEvent(ev[0], false, "C4", "0", "2/3");
    checkEvent(ev[1], false, "D4", "2/3", "1");
    checkEvent(ev[2], false, "E4", "1", "4/3");
    checkEvent(ev[3], false, "F4", "4/3", "2");
}

static void testReferenceScore() {
    // 参考短乐谱展开核验：
    //   C4/4 {1: D4/8 E4/8 F4/8} G4/2. R/8 Bb3/16
    // 三连音总时值 1 拍（每个 1/3 拍）；G4 附点二分 = 3 拍；
    // 休止 1/2 拍；Bb3 十六分 = 1/4 拍。
    auto ev = parseScore("C4/4 {1: D4/8 E4/8 F4/8} G4/2. R/8 Bb3/16");
    CHECK(ev.size() == 7);
    if (ev.size() != 7) return;
    checkEvent(ev[0], false, "C4",  "0",   "1");
    checkEvent(ev[1], false, "D4",  "1",   "4/3");
    checkEvent(ev[2], false, "E4",  "4/3", "5/3");
    checkEvent(ev[3], false, "F4",  "5/3", "2");
    checkEvent(ev[4], false, "G4",  "2",   "5");
    checkEvent(ev[5], true,  "",    "5",   "11/2");
    checkEvent(ev[6], false, "Bb3", "11/2", "23/4");
}

static void testDepthLimit() {
    std::string ok, bad;
    for (int i = 0; i < score::kMaxTupletDepth; ++i) ok += "{1: ";
    ok += "C4/4";
    for (int i = 0; i < score::kMaxTupletDepth; ++i) ok += "}";
    auto ev = parseScore(ok); // 16 层：允许
    CHECK(ev.size() == 1);
    if (ev.size() == 1) checkEvent(ev[0], false, "C4", "0", "1");

    for (int i = 0; i < score::kMaxTupletDepth + 1; ++i) bad += "{1: ";
    bad += "C4/4";
    for (int i = 0; i < score::kMaxTupletDepth + 1; ++i) bad += "}";
    CHECK_THROWS(parseScore(bad)); // 17 层：报错
}

static void testErrors() {
    CHECK_THROWS(parseScore("C4/4 }"));      // 多余的 }
    CHECK_THROWS(parseScore("{1: C4/4"));    // 未闭合
    CHECK_THROWS(parseScore("{1: }"));       // 空连音组
    CHECK_THROWS(parseScore("{0: C4/4}"));   // 拍数非正
    CHECK_THROWS(parseScore("H4/4"));        // 非法音名
    CHECK_THROWS(parseScore("C4/0"));        // 非法分母
    CHECK_THROWS(parseScore("{1 C4/4}"));    // 缺少 ':'
}

int main() {
    testRational();
    testSimpleNotes();
    testDots();
    testRestAndDefaultDuration();
    testTupletUnequalMembers();
    testTupletFractionBeats();
    testNestedTuplet();
    testReferenceScore();
    testDepthLimit();
    testErrors();

    if (g_failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cerr << g_failures << " check(s) failed\n";
    return 1;
}
