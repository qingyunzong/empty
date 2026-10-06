#include "geom/rect_union.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <unordered_map>

namespace {

int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,     \
                         #cond);                                             \
            ++g_failures;                                                    \
        }                                                                    \
    } while (0)

#define CHECK_EQ(a, b)                                                       \
    do {                                                                     \
        auto va = (a);                                                       \
        auto vb = (b);                                                       \
        if (!(va == vb)) {                                                   \
            std::fprintf(stderr, "FAIL %s:%d: %s == %s (%lld vs %lld)\n",    \
                         __FILE__, __LINE__, #a, #b,                         \
                         static_cast<long long>(va),                         \
                         static_cast<long long>(vb));                        \
            ++g_failures;                                                    \
        }                                                                    \
    } while (0)

// Brute-force reference: tracks the union on a unit-cell grid over
// [LO, HI) x [LO, HI). All rectangles in randomized tests stay inside
// [LO + 1, HI - 1], so out-of-grid neighbors are always uncovered.
class GridModel {
public:
    static constexpr std::int64_t LO = -12;
    static constexpr std::int64_t HI = 12;
    static constexpr std::size_t N = HI - LO;

    bool add(std::int64_t id, std::int64_t x1, std::int64_t y1,
             std::int64_t x2, std::int64_t y2) {
        if (x1 > x2) std::swap(x1, x2);
        if (y1 > y2) std::swap(y1, y2);
        if (x1 == x2 || y1 == y2) return false;
        if (!rects_.emplace(id, Rect{x1, y1, x2, y2}).second) return false;
        rebuild();
        return true;
    }

    bool remove(std::int64_t id) {
        if (rects_.erase(id) == 0) return false;
        rebuild();
        return true;
    }

    std::int64_t area() const { return area_; }
    std::int64_t perimeter() const { return perimeter_; }

private:
    struct Rect {
        std::int64_t x1, y1, x2, y2;
    };

    void rebuild() {
        for (auto& row : cov_) row.fill(false);
        for (const auto& [id, r] : rects_) {
            for (std::int64_t x = r.x1; x < r.x2; ++x)
                for (std::int64_t y = r.y1; y < r.y2; ++y)
                    cov_[x - LO][y - LO] = true;
        }
        area_ = 0;
        perimeter_ = 0;
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = 0; j < N; ++j) {
                if (!cov_[i][j]) continue;
                ++area_;
                if (i == 0 || !cov_[i - 1][j]) ++perimeter_;
                if (i == N - 1 || !cov_[i + 1][j]) ++perimeter_;
                if (j == 0 || !cov_[i][j - 1]) ++perimeter_;
                if (j == N - 1 || !cov_[i][j + 1]) ++perimeter_;
            }
        }
    }

    std::unordered_map<std::int64_t, Rect> rects_;
    std::array<std::array<bool, N>, N> cov_{};
    std::int64_t area_ = 0;
    std::int64_t perimeter_ = 0;
};

void testSingleRectangle() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 3, 4));
    CHECK_EQ(ru.area(), 12);
    CHECK_EQ(ru.perimeter(), 14);
    CHECK_EQ(ru.size(), 1u);
    CHECK(ru.remove(1));
    CHECK_EQ(ru.area(), 0);
    CHECK_EQ(ru.perimeter(), 0);
    CHECK_EQ(ru.size(), 0u);
}

void testZeroAreaIgnored() {
    geom::RectUnion ru;
    CHECK(!ru.add(1, 2, 2, 2, 5));  // degenerate in x
    CHECK(!ru.add(2, 0, 3, 7, 3));  // degenerate in y
    CHECK(!ru.add(3, 4, 4, 4, 4));  // degenerate point
    CHECK_EQ(ru.size(), 0u);
    CHECK_EQ(ru.area(), 0);
    CHECK_EQ(ru.perimeter(), 0);
    CHECK(!ru.remove(1));
}

void testNormalization() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 5, 7, 2, 3));  // swapped corners
    CHECK_EQ(ru.area(), 12);
    CHECK_EQ(ru.perimeter(), 14);
}

void testDuplicateIdAndMissingRemove() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 2, 2));
    CHECK(!ru.add(1, 5, 5, 9, 9));  // id already present
    CHECK_EQ(ru.area(), 4);
    CHECK(!ru.remove(42));
    CHECK(ru.remove(1));
    CHECK_EQ(ru.area(), 0);
}

void testOverlap() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 4, 4));
    CHECK(ru.add(2, 2, 2, 6, 6));
    // Union: two 4x4 squares overlapping in a 2x2 corner.
    CHECK_EQ(ru.area(), 16 + 16 - 4);
    CHECK_EQ(ru.perimeter(), 24);
}

void testEdgeTouchingMerges() {
    geom::RectUnion ru;
    // Side by side: shared vertical edge must vanish.
    CHECK(ru.add(1, 0, 0, 2, 3));
    CHECK(ru.add(2, 2, 0, 5, 3));
    CHECK_EQ(ru.area(), 15);
    CHECK_EQ(ru.perimeter(), 16);  // single 5x3 rectangle
    // Stacked: shared horizontal edge must vanish.
    CHECK(ru.add(3, 0, 3, 5, 6));
    CHECK_EQ(ru.area(), 30);
    CHECK_EQ(ru.perimeter(), 22);  // single 5x6 rectangle
}

void testCornerTouchingDoesNotMerge() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 2, 2));
    CHECK(ru.add(2, 2, 2, 4, 4));
    CHECK_EQ(ru.area(), 8);
    CHECK_EQ(ru.perimeter(), 16);  // point contact keeps both perimeters
}

void testNestedAndHole() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 10, 10));
    CHECK(ru.add(2, 2, 2, 4, 4));  // fully inside: no change
    CHECK_EQ(ru.area(), 100);
    CHECK_EQ(ru.perimeter(), 40);
    // Frame made of 4 bars around a hole: interior hole edges count.
    geom::RectUnion frame;
    CHECK(frame.add(1, 0, 0, 6, 2));
    CHECK(frame.add(2, 0, 4, 6, 6));
    CHECK(frame.add(3, 0, 2, 2, 4));
    CHECK(frame.add(4, 4, 2, 6, 4));
    CHECK_EQ(frame.area(), 6 * 6 - 2 * 2);
    CHECK_EQ(frame.perimeter(), 24 + 8);  // outer 6x6 plus inner 2x2 hole
}

void testRemovalRestoresEdges() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 4, 4));
    CHECK(ru.add(2, 4, 0, 8, 4));
    CHECK_EQ(ru.perimeter(), 24);  // merged 8x4
    CHECK(ru.remove(2));
    CHECK_EQ(ru.area(), 16);
    CHECK_EQ(ru.perimeter(), 16);
}

void testNegativeAndLargeCoordinates() {
    geom::RectUnion ru;
    CHECK(ru.add(1, -1000000, -1000000, 1000000, 1000000));
    CHECK_EQ(ru.area(), 4000000000000LL);
    CHECK_EQ(ru.perimeter(), 8000000LL);
    CHECK(ru.add(2, -1000000, 1000000, 1000000, 1000001));
    CHECK_EQ(ru.area(), 4000000000000LL + 2000000LL);
    CHECK_EQ(ru.perimeter(), 8000000LL + 2);
}

void testRandomizedAgainstGridModel() {
    constexpr int kRounds = 300;
    constexpr int kOpsPerRound = 200;
    std::mt19937_64 rng(20261007);

    for (int round = 0; round < kRounds; ++round) {
        geom::RectUnion ru;
        GridModel model;
        // Small id pool forces frequent removes and duplicate-id adds.
        std::uniform_int_distribution<std::int64_t> id_dist(0, 11);
        std::uniform_int_distribution<std::int64_t> coord_dist(
            GridModel::LO + 1, GridModel::HI - 1);
        std::uniform_int_distribution<int> op_dist(0, 2);

        for (int op = 0; op < kOpsPerRound; ++op) {
            std::int64_t id = id_dist(rng);
            int choice = op_dist(rng);
            if (choice == 0) {
                CHECK_EQ(ru.remove(id), model.remove(id));
            } else {
                std::int64_t x1 = coord_dist(rng), y1 = coord_dist(rng);
                std::int64_t x2 = coord_dist(rng), y2 = coord_dist(rng);
                CHECK_EQ(ru.add(id, x1, y1, x2, y2),
                         model.add(id, x1, y1, x2, y2));
            }
            // Verify against the grid model after every single change.
            CHECK_EQ(ru.area(), model.area());
            CHECK_EQ(ru.perimeter(), model.perimeter());
        }
    }
}

} // namespace

int main() {
    testSingleRectangle();
    testZeroAreaIgnored();
    testNormalization();
    testDuplicateIdAndMissingRemove();
    testOverlap();
    testEdgeTouchingMerges();
    testCornerTouchingDoesNotMerge();
    testNestedAndHole();
    testRemovalRestoresEdges();
    testNegativeAndLargeCoordinates();
    testRandomizedAgainstGridModel();

    if (g_failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return EXIT_FAILURE;
    }
    std::puts("all tests passed");
    return EXIT_SUCCESS;
}
