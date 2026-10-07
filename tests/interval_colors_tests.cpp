#include "interval_colors.h"

#include <cstdlib>
#include <iostream>
#include <vector>

using interval_colors::IntervalColors;
using interval_colors::Segment;

namespace {

int g_failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            ++g_failures;                                                      \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " #cond  \
                      << '\n';                                                 \
        }                                                                      \
    } while (false)

void checkSegments(const IntervalColors& ic, int version,
                   std::vector<Segment> expected) {
    CHECK(ic.segments(version) == expected);
}

// 不变式：有序、不重迭、相邻不同色。
void checkInvariant(const IntervalColors& ic, int version) {
    const auto& segs = ic.segments(version);
    for (std::size_t i = 0; i < segs.size(); ++i) {
        CHECK(segs[i].lo < segs[i].hi);
        if (i > 0) {
            CHECK(segs[i - 1].hi <= segs[i].lo);
            CHECK(!(segs[i - 1].hi == segs[i].lo &&
                    segs[i - 1].color == segs[i].color));
        }
    }
}

// 空范围不产生变更：返回原版本 id，版本数不增加。
void testEmptyRangeNoOp() {
    IntervalColors ic;
    int v1 = ic.paint(0, 0, 10, 7);
    CHECK(ic.paint(v1, 5, 5, 9) == v1);
    CHECK(ic.paint(v1, 8, 3, 9) == v1);
    CHECK(ic.paint(0, 0, 0, 1) == 0);
    CHECK(ic.versionCount() == 2);
    checkSegments(ic, v1, {{0, 10, 7}});
}

// 段内染色导致旧段分裂为三段。
void testSplit() {
    IntervalColors ic;
    int v1 = ic.paint(0, 0, 10, 1);
    int v2 = ic.paint(v1, 3, 5, 2);
    checkSegments(ic, v2, {{0, 3, 1}, {3, 5, 2}, {5, 10, 1}});
    // 旧版本保持完整。
    checkSegments(ic, v1, {{0, 10, 1}});
    CHECK(ic.colorAt(v2, 2) == 1);
    CHECK(ic.colorAt(v2, 4) == 2);
    CHECK(ic.colorAt(v2, 9) == 1);
    CHECK(ic.colorAt(v2, 10) == std::nullopt);
}

// 一次染色横跨多个旧段：截断两端、吞掉中间。
void testCrossSegmentOverwrite() {
    IntervalColors ic;
    int v = 0;
    v = ic.paint(v, 0, 5, 1);
    v = ic.paint(v, 5, 10, 2);
    v = ic.paint(v, 10, 15, 3);
    checkSegments(ic, v, {{0, 5, 1}, {5, 10, 2}, {10, 15, 3}});

    int v2 = ic.paint(v, 3, 12, 9);
    checkSegments(ic, v2, {{0, 3, 1}, {3, 12, 9}, {12, 15, 3}});
    checkInvariant(ic, v2);

    // 完全覆盖整个表。
    int v3 = ic.paint(v2, -100, 100, 0);
    checkSegments(ic, v3, {{-100, 100, 0}});
}

// 相邻同色必须合并：向右接、向左接、同时桥接两侧。
void testAdjacentMerge() {
    IntervalColors ic;
    int v1 = ic.paint(0, 0, 5, 1);
    int v2 = ic.paint(v1, 5, 10, 1); // 右邻同色
    checkSegments(ic, v2, {{0, 10, 1}});

    int v3 = ic.paint(v2, -5, 0, 1); // 左邻同色
    checkSegments(ic, v3, {{-5, 10, 1}});

    // 桥接：中间填入与两侧相同的颜色，三段合为一段。
    IntervalColors ic2;
    int a = ic2.paint(0, 0, 5, 4);
    a = ic2.paint(a, 10, 15, 4);
    a = ic2.paint(a, 5, 10, 4);
    checkSegments(ic2, a, {{0, 15, 4}});
}

// 从同一旧版本分支出多个新版本，彼此与祖先均不受污染。
void testBranchIsolation() {
    IntervalColors ic;
    int v1 = ic.paint(0, 0, 100, 1);

    int v2 = ic.paint(v1, 10, 20, 2);  // 分支 A
    int v3 = ic.paint(v1, 50, 60, 3);  // 分支 B（同样源自 v1）
    int v4 = ic.paint(v2, 15, 25, 4);  // 分支 A 的延伸

    checkSegments(ic, v1, {{0, 100, 1}});
    checkSegments(ic, v2, {{0, 10, 1}, {10, 20, 2}, {20, 100, 1}});
    checkSegments(ic, v3, {{0, 50, 1}, {50, 60, 3}, {60, 100, 1}});
    checkSegments(ic, v4, {{0, 10, 1}, {10, 15, 2}, {15, 25, 4}, {25, 100, 1}});

    for (int v = 0; v < ic.versionCount(); ++v) checkInvariant(ic, v);
}

// 覆盖长度：间隙不计、边界裁剪、空查询为零。
void testCoveredLength() {
    IntervalColors ic;
    int v = 0;
    v = ic.paint(v, 0, 10, 1);
    v = ic.paint(v, 20, 30, 2);

    CHECK(ic.coveredLength(v, 0, 100) == 20);
    CHECK(ic.coveredLength(v, -5, 5) == 5);
    CHECK(ic.coveredLength(v, 8, 22) == 4);   // [8,10) + [20,22)
    CHECK(ic.coveredLength(v, 10, 20) == 0);  // 间隙
    CHECK(ic.coveredLength(v, 5, 5) == 0);
    CHECK(ic.coveredLength(v, 7, 3) == 0);
    CHECK(ic.coveredLength(0, 0, 100) == 0);
}

// 负数坐标与重染同一颜色（幂等且仍合并）。
void testEdgeCases() {
    IntervalColors ic;
    int v1 = ic.paint(0, -10, -3, 5);
    checkSegments(ic, v1, {{-10, -3, 5}});
    CHECK(ic.coveredLength(v1, -10, -3) == 7);

    int v2 = ic.paint(v1, -6, 0, 5); // 同色延伸，合并
    checkSegments(ic, v2, {{-10, 0, 5}});

    int v3 = ic.paint(v2, -10, 0, 5); // 完全同色重染，结果不变
    checkSegments(ic, v3, {{-10, 0, 5}});

    // 非法版本抛异常。
    bool threw = false;
    try {
        (void)ic.segments(999);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

} // namespace

int main() {
    testEmptyRangeNoOp();
    testSplit();
    testCrossSegmentOverwrite();
    testAdjacentMerge();
    testBranchIsolation();
    testCoveredLength();
    testEdgeCases();

    if (g_failures != 0) {
        std::cerr << g_failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all interval_colors tests passed\n";
    return EXIT_SUCCESS;
}
