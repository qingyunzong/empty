// Unit tests for geom::RectUnion.
//
// The randomized test cross-verifies every mutation against a naive
// short-coordinate unit-grid model: each unit cell in a small integer
// lattice is tracked explicitly, and area/perimeter are derived by
// direct cell counting. This model is obviously correct, so agreement
// after every add/remove validates the compressed-grid implementation.

#include "geom/rect_union.hpp"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <random>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            ++failures;                                                        \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "        \
                      << #cond << '\n';                                        \
        }                                                                      \
    } while (false)

#define CHECK_EQ(a, b)                                                         \
    do {                                                                       \
        const auto va = (a);                                                   \
        const auto vb = (b);                                                   \
        if (!(va == vb)) {                                                     \
            ++failures;                                                        \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " << #a  \
                      << " == " << #b << " (" << va << " vs " << vb << ")\n";  \
        }                                                                      \
    } while (false)

struct NaiveModel {
    std::map<std::pair<int, int>, int> cells; // unit cell -> cover count

    void add(int x1, int y1, int x2, int y2) {
        for (int x = x1; x < x2; ++x)
            for (int y = y1; y < y2; ++y)
                ++cells[{x, y}];
    }
    void remove(int x1, int y1, int x2, int y2) {
        for (int x = x1; x < x2; ++x)
            for (int y = y1; y < y2; ++y) {
                if (--cells[{x, y}] == 0) {
                    cells.erase({x, y});
                }
            }
    }
    std::int64_t area() const { return static_cast<std::int64_t>(cells.size()); }
    std::int64_t perimeter() const {
        std::int64_t p = 0;
        for (const auto& [pos, count] : cells) {
            const auto& [x, y] = pos;
            if (!cells.count({x - 1, y})) ++p;
            if (!cells.count({x + 1, y})) ++p;
            if (!cells.count({x, y - 1})) ++p;
            if (!cells.count({x, y + 1})) ++p;
        }
        return p;
    }
};

void test_single_rectangle() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 0, 0, 4, 3));
    CHECK_EQ(ru.area(), 12);
    CHECK_EQ(ru.perimeter(), 14);
    CHECK_EQ(ru.size(), 1u);
}

void test_zero_area_ignored() {
    geom::RectUnion ru;
    CHECK(!ru.add(1, 2, 2, 2, 9));   // point
    CHECK(!ru.add(2, 0, 5, 8, 5));   // horizontal line
    CHECK(!ru.add(3, 4, 0, 4, 7));   // vertical line
    CHECK_EQ(ru.area(), 0);
    CHECK_EQ(ru.perimeter(), 0);
    CHECK_EQ(ru.size(), 0u);
    CHECK(!ru.contains(1));
    // Zero-area add must not replace an existing rectangle.
    CHECK(ru.add(4, 0, 0, 2, 2));
    CHECK(!ru.add(4, 0, 0, 0, 5));
    CHECK_EQ(ru.area(), 4);
}

void test_unnormalized_coordinates() {
    geom::RectUnion ru;
    CHECK(ru.add(1, 10, 8, 2, 3)); // swapped corners
    CHECK_EQ(ru.area(), 8 * 5);
    CHECK_EQ(ru.perimeter(), 2 * (8 + 5));
}

void test_overlap() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 4, 4);
    ru.add(2, 2, 2, 6, 6);
    // Union is an L-shape: 16 + 16 - 4 = 28.
    CHECK_EQ(ru.area(), 28);
    // Perimeter of the L: each 4x4 square has 16, shared region removes
    // 2 boundary segments of length 2 from each square: 32 - 8 = 24.
    CHECK_EQ(ru.perimeter(), 24);
}

void test_edge_touching_merges() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 2, 2);
    ru.add(2, 2, 0, 4, 2); // shares full edge x=2
    // Union is a single 4x2 rectangle; the shared edge is internal.
    CHECK_EQ(ru.area(), 8);
    CHECK_EQ(ru.perimeter(), 12);

    ru.add(3, 0, 2, 4, 4); // shares full edge y=2 with both
    CHECK_EQ(ru.area(), 16);
    CHECK_EQ(ru.perimeter(), 16);
}

void test_partial_edge_touching() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 3, 2);
    ru.add(2, 1, 2, 2, 5); // touches along segment x in [1,2] at y=2
    // Area: 6 + 3 = 9. Perimeter: only the length-1 shared segment is
    // removed from both: 10 + 8 - 2 = 16.
    CHECK_EQ(ru.area(), 9);
    CHECK_EQ(ru.perimeter(), 16);
}

void test_corner_touching_does_not_merge() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 2, 2);
    ru.add(2, 2, 2, 4, 4); // touches only at point (2,2)
    CHECK_EQ(ru.area(), 8);
    CHECK_EQ(ru.perimeter(), 16); // no shared edge removed
}

void test_containment() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 10, 10);
    ru.add(2, 2, 2, 5, 5); // fully inside
    CHECK_EQ(ru.area(), 100);
    CHECK_EQ(ru.perimeter(), 40);
}

void test_remove_restores() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 4, 4);
    ru.add(2, 2, 2, 6, 6);
    CHECK(ru.remove(2));
    CHECK_EQ(ru.area(), 16);
    CHECK_EQ(ru.perimeter(), 16);
    CHECK(ru.remove(1));
    CHECK_EQ(ru.area(), 0);
    CHECK_EQ(ru.perimeter(), 0);
    CHECK(!ru.remove(1)); // already gone
    CHECK(!ru.remove(99)); // never existed
}

void test_replace_same_id() {
    geom::RectUnion ru;
    ru.add(1, 0, 0, 2, 2);
    CHECK(ru.add(1, 0, 0, 3, 3)); // replace
    CHECK_EQ(ru.size(), 1u);
    CHECK_EQ(ru.area(), 9);
    CHECK_EQ(ru.perimeter(), 12);
    CHECK(!ru.add(1, 0, 0, 3, 3)); // identical: no change
}

void test_large_coordinates() {
    geom::RectUnion ru;
    ru.add(1, -1000000, -1000000, 1000000, 1000000);
    CHECK_EQ(ru.area(), 4000000000000LL); // 2e6 * 2e6
    CHECK_EQ(ru.perimeter(), 8000000LL);
    ru.add(2, 999999, -1000000, 1000000, 1000000); // sliver overlap
    CHECK_EQ(ru.area(), 4000000000000LL);
    CHECK_EQ(ru.perimeter(), 8000000LL);
}

void test_negative_coordinates() {
    geom::RectUnion ru;
    ru.add(1, -5, -5, -1, -1);
    ru.add(2, -3, -3, 1, 1);
    // 16 + 16 - 4 = 28, same L-shape as the overlap test, shifted.
    CHECK_EQ(ru.area(), 28);
    CHECK_EQ(ru.perimeter(), 24);
}

void test_randomized_vs_unit_grid_model() {
    std::mt19937_64 rng(20261008);
    geom::RectUnion ru;
    NaiveModel model;
    std::vector<std::pair<geom::RectUnion::Id, std::array<int, 4>>> active;

    constexpr int kRange = 8; // coordinates in [-8, 8)
    auto rand_coord = [&]() {
        return static_cast<int>(rng() % (2 * kRange)) - kRange;
    };

    for (int step = 0; step < 4000; ++step) {
        if (active.empty() || rng() % 3 != 0) {
            // add (or replace) a rectangle under a random id
            const geom::RectUnion::Id id =
                static_cast<geom::RectUnion::Id>(rng() % 12);
            int x1 = rand_coord(), x2 = rand_coord();
            int y1 = rand_coord(), y2 = rand_coord();
            if (x1 > x2) std::swap(x1, x2);
            if (y1 > y2) std::swap(y1, y2);
            if (x1 == x2 || y1 == y2) {
                // zero-area must be ignored, existing entry untouched
                CHECK(!ru.add(id, x1, y1, x2, y2));
            } else {
                // replace in the model: erase old rect with this id first
                for (auto it = active.begin(); it != active.end(); ++it) {
                    if (it->first == id) {
                        model.remove(it->second[0], it->second[1],
                                     it->second[2], it->second[3]);
                        active.erase(it);
                        break;
                    }
                }
                ru.add(id, x1, y1, x2, y2);
                model.add(x1, y1, x2, y2);
                active.push_back({id, {x1, y1, x2, y2}});
            }
        } else {
            // remove a random active id
            const std::size_t idx = rng() % active.size();
            const auto [id, r] = active[idx];
            CHECK(ru.remove(id));
            model.remove(r[0], r[1], r[2], r[3]);
            active.erase(active.begin() + static_cast<std::ptrdiff_t>(idx));
        }
        // Verify after every single mutation.
        CHECK_EQ(ru.area(), model.area());
        CHECK_EQ(ru.perimeter(), model.perimeter());
        CHECK_EQ(ru.size(), active.size());
        if (failures > 20) {
            std::cerr << "too many failures, aborting randomized test\n";
            return;
        }
    }
}

const std::pair<std::string, std::function<void()>> kTests[] = {
    {"single_rectangle", test_single_rectangle},
    {"zero_area_ignored", test_zero_area_ignored},
    {"unnormalized_coordinates", test_unnormalized_coordinates},
    {"overlap", test_overlap},
    {"edge_touching_merges", test_edge_touching_merges},
    {"partial_edge_touching", test_partial_edge_touching},
    {"corner_touching_does_not_merge", test_corner_touching_does_not_merge},
    {"containment", test_containment},
    {"remove_restores", test_remove_restores},
    {"replace_same_id", test_replace_same_id},
    {"large_coordinates", test_large_coordinates},
    {"negative_coordinates", test_negative_coordinates},
    {"randomized_vs_unit_grid_model", test_randomized_vs_unit_grid_model},
};

} // namespace

int main(int argc, char** argv) {
    const std::string filter = argc > 1 ? argv[1] : "";
    bool ran = false;
    for (const auto& [name, fn] : kTests) {
        if (!filter.empty() && name != filter) {
            continue;
        }
        ran = true;
        failures = 0;
        fn();
        if (failures == 0) {
            std::cout << "PASS " << name << '\n';
        } else {
            std::cerr << "FAILED " << name << " (" << failures
                      << " checks failed)\n";
            return 1;
        }
    }
    if (!ran) {
        std::cerr << "no test matched filter '" << filter << "'\n";
        return 2;
    }
    return 0;
}
