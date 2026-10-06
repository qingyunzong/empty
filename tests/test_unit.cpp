// Unit tests for mpath::ManhattanPath.

#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>

#include "manhattan_path.hpp"

using mpath::ManhattanPath;
using mpath::Point;

static int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, \
                         #cond);                                          \
            ++failures;                                                   \
        }                                                                 \
    } while (0)

static void test_empty() {
    ManhattanPath path;
    CHECK(path.empty());
    CHECK(path.size() == 0);
    CHECK(path.total_length() == 0);
}

static void test_basic_total_and_ranges() {
    ManhattanPath path;
    // (0,0) -> (3,4) -> (10,10): edges 7 and 13, total 20.
    CHECK(path.insert(0, Point{0, 0}));
    CHECK(path.insert(1, Point{3, 4}));
    CHECK(path.insert(2, Point{10, 10}));
    CHECK(path.size() == 3);
    CHECK(path.total_length() == 20);

    // Range queries exclude connections outside [l, r].
    CHECK(path.length(0, 0) == 0);
    CHECK(path.length(1, 1) == 0);
    CHECK(path.length(2, 2) == 0);
    CHECK(path.length(0, 1) == 7);
    CHECK(path.length(1, 2) == 13);
    CHECK(path.length(0, 2) == 20);
}

static void test_duplicates_are_legal() {
    ManhattanPath path;
    CHECK(path.insert(0, Point{5, 5}));
    CHECK(path.insert(1, Point{5, 5}));
    CHECK(path.insert(2, Point{5, 5}));
    CHECK(path.size() == 3);
    CHECK(path.total_length() == 0);
    CHECK(path.length(0, 2) == 0);
    CHECK(path.insert(1, Point{5, 5}));  // duplicate in the middle
    CHECK(path.size() == 4);
    CHECK(path.total_length() == 0);
}

static void test_insert_positions_and_order() {
    ManhattanPath path;
    CHECK(path.insert(0, Point{2, 0}));   // [2]
    CHECK(path.insert(0, Point{1, 0}));   // [1, 2] front
    CHECK(path.insert(2, Point{4, 0}));   // [1, 2, 4] back
    CHECK(path.insert(2, Point{3, 0}));   // [1, 2, 3, 4] middle
    CHECK(path.size() == 4);
    for (std::size_t i = 0; i < 4; ++i) {
        CHECK(path.point_at(i) == (Point{static_cast<std::int64_t>(i + 1), 0}));
    }
    CHECK(path.total_length() == 3);
    CHECK(path.length(1, 2) == 1);
}

static void test_erase_positions() {
    ManhattanPath path;
    for (std::int64_t i = 0; i < 5; ++i) CHECK(path.insert(path.size(), Point{i, 0}));
    // [0,1,2,3,4], total 4.
    CHECK(path.erase(2));  // middle -> [0,1,3,4]
    CHECK(path.size() == 4);
    CHECK(path.total_length() == 4);  // edges 1 + 2 + 1
    CHECK(path.point_at(2) == (Point{3, 0}));
    CHECK(path.erase(0));  // front -> [1,3,4]
    CHECK(path.point_at(0) == (Point{1, 0}));
    CHECK(path.total_length() == 3);
    CHECK(path.erase(path.size() - 1));  // back -> [1,3]
    CHECK(path.size() == 2);
    CHECK(path.total_length() == 2);
    CHECK(path.length(0, 1) == 2);
    CHECK(path.erase(0));
    CHECK(path.erase(0));
    CHECK(path.empty());
    CHECK(path.total_length() == 0);
}

static void test_invalid_operations() {
    ManhattanPath path;
    CHECK(path.insert(0, Point{0, 0}));
    CHECK(!path.insert(2, Point{1, 1}));  // index > size
    CHECK(path.size() == 1);
    CHECK(!path.erase(1));  // out of range
    CHECK(path.size() == 1);

    bool threw = false;
    try {
        (void)path.length(0, 1);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        (void)path.length(1, 0);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        (void)path.point_at(7);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

static void test_overflow_rejected_and_old_version_kept() {
    constexpr std::int64_t kMax = std::numeric_limits<std::int64_t>::max();
    constexpr std::int64_t kMin = std::numeric_limits<std::int64_t>::min();

    ManhattanPath path;
    CHECK(path.insert(0, Point{0, 0}));
    // Edge of exactly INT64_MAX still fits.
    CHECK(path.insert(1, Point{kMax, 0}));
    CHECK(path.total_length() == kMax);

    // Any further positive edge would overflow -> rejected, path unchanged.
    CHECK(!path.insert(2, Point{kMax, 1}));
    CHECK(!path.insert(0, Point{-1, 0}));
    CHECK(!path.insert(1, Point{7, 7}));
    CHECK(path.size() == 2);
    CHECK(path.total_length() == kMax);
    CHECK(path.point_at(0) == (Point{0, 0}));
    CHECK(path.point_at(1) == (Point{kMax, 0}));

    // Zero-length insertions are still accepted (no overflow).
    CHECK(path.insert(1, Point{0, 0}));
    CHECK(path.size() == 3);
    CHECK(path.total_length() == kMax);

    // A single edge longer than INT64_MAX cannot be created.
    ManhattanPath wide;
    CHECK(wide.insert(0, Point{kMin, kMin}));
    CHECK(!wide.insert(1, Point{kMax, kMax}));
    CHECK(wide.size() == 1);
    CHECK(wide.total_length() == 0);
    CHECK(wide.point_at(0) == (Point{kMin, kMin}));

    // Erasing is always safe and shrinks the total.
    CHECK(path.erase(1));
    CHECK(path.size() == 2);
    CHECK(path.total_length() == kMax);
    CHECK(path.erase(0));
    CHECK(path.total_length() == 0);
}

static void test_negative_coordinates() {
    ManhattanPath path;
    CHECK(path.insert(0, Point{-3, -4}));
    CHECK(path.insert(1, Point{3, 4}));
    CHECK(path.total_length() == 14);  // 6 + 8
    CHECK(path.insert(1, Point{0, 0}));
    CHECK(path.total_length() == 14);  // 7 + 7
    CHECK(path.length(0, 1) == 7);
    CHECK(path.length(1, 2) == 7);
    CHECK(path.length(0, 2) == 14);
}

int main() {
    test_empty();
    test_basic_total_and_ranges();
    test_duplicates_are_legal();
    test_insert_positions_and_order();
    test_erase_positions();
    test_invalid_operations();
    test_overflow_rejected_and_old_version_kept();
    test_negative_coordinates();

    if (failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    std::puts("all unit tests passed");
    return 0;
}
