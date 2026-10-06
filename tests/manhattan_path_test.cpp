#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

#include "manhattan_path/manhattan_path.hpp"

namespace {

int g_failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            ++g_failures;                                                 \
            std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, \
                         __LINE__, #cond);                                \
        }                                                                 \
    } while (0)

using manhattan_path::Path;
using manhattan_path::Point;
using manhattan_path::dist128;

std::int64_t ref_range_length(const std::vector<Point>& pts, std::size_t first,
                              std::size_t last) {
    __int128 sum = 0;
    for (std::size_t i = first; i < last; ++i) sum += dist128(pts[i], pts[i + 1]);
    return static_cast<std::int64_t>(sum);
}

__int128 ref_total_length(const std::vector<Point>& pts) {
    __int128 sum = 0;
    for (std::size_t i = 0; i + 1 < pts.size(); ++i) sum += dist128(pts[i], pts[i + 1]);
    return sum;
}

void check_against_reference(const Path& path, const std::vector<Point>& ref,
                             std::mt19937_64& rng) {
    CHECK(path.size() == ref.size());
    if (path.size() != ref.size()) return;
    for (std::size_t i = 0; i < ref.size(); ++i) CHECK(path.at(i) == ref[i]);
    if (ref.empty()) return;

    CHECK(static_cast<__int128>(path.total_length()) == ref_total_length(ref));
    CHECK(path.front() == ref.front());
    CHECK(path.back() == ref.back());

    for (int q = 0; q < 8; ++q) {
        std::uniform_int_distribution<std::size_t> pick(0, ref.size() - 1);
        const std::size_t a = pick(rng);
        const std::size_t b = pick(rng);
        const std::size_t first = std::min(a, b);
        const std::size_t last = std::max(a, b);
        CHECK(path.length(first, last) == ref_range_length(ref, first, last));
    }
    CHECK(path.length(0, ref.size() - 1) == ref_range_length(ref, 0, ref.size() - 1));
}

Point random_point(std::mt19937_64& rng, bool extreme) {
    if (extreme) {
        std::uniform_int_distribution<int> side(0, 1);
        const std::int64_t lo = std::numeric_limits<std::int64_t>::min() / 2;
        const std::int64_t hi = std::numeric_limits<std::int64_t>::max() / 2;
        return {side(rng) ? hi : lo, side(rng) ? hi : lo};
    }
    std::uniform_int_distribution<std::int64_t> coord(-1000, 1000);
    return {coord(rng), coord(rng)};
}

void randomized_test() {
    std::mt19937_64 rng(20261007ULL);
    Path path;
    std::vector<Point> ref;

    for (int step = 0; step < 20000; ++step) {
        std::uniform_int_distribution<int> op(0, 9);
        const int choice = op(rng);
        const bool extreme = (step % 97 == 0);

        if (choice < 4 || ref.empty()) {
            std::uniform_int_distribution<std::size_t> pos(0, ref.size());
            const std::size_t index = pos(rng);
            const Point p = random_point(rng, extreme);

            std::vector<Point> trial = ref;
            trial.insert(trial.begin() + static_cast<std::ptrdiff_t>(index), p);
            const __int128 trial_total = ref_total_length(trial);
            const bool expect_ok =
                trial_total <= std::numeric_limits<std::int64_t>::max();

            const bool ok = path.insert(index, p);
            CHECK(ok == expect_ok);
            if (expect_ok) {
                ref = std::move(trial);
            } else {
                check_against_reference(path, ref, rng);
            }
        } else if (choice < 7) {
            std::uniform_int_distribution<std::size_t> pos(0, ref.size() - 1);
            const std::size_t index = pos(rng);
            CHECK(path.erase(index));
            ref.erase(ref.begin() + static_cast<std::ptrdiff_t>(index));
        } else {
            check_against_reference(path, ref, rng);
        }
    }
    check_against_reference(path, ref, rng);
}

void overflow_rejection_test() {
    const std::int64_t max = std::numeric_limits<std::int64_t>::max();
    Path path;
    CHECK(path.insert(0, {0, 0}));
    CHECK(path.insert(1, {max / 4, max / 4}));
    CHECK(path.insert(2, {0, 0}));

    const std::int64_t total_before = path.total_length();
    CHECK(!path.insert(1, {-max / 2, -max / 2}));
    CHECK(path.size() == 3);
    CHECK(path.total_length() == total_before);
    const Point origin{0, 0};
    const Point far{max / 4, max / 4};
    CHECK(path.at(0) == origin);
    CHECK(path.at(1) == far);
    CHECK(path.at(2) == origin);
    CHECK(path.length(0, 2) == total_before);

    CHECK(!path.insert(3, {max, max}));
    CHECK(!path.insert(0, {max, max}));
    CHECK(path.size() == 3);
    CHECK(path.total_length() == total_before);

    CHECK(path.erase(1));
    CHECK(path.size() == 2);
    CHECK(path.total_length() == 0);
    CHECK(!path.insert(1, {max, max}));
    CHECK(path.size() == 2);
    CHECK(path.total_length() == 0);
    CHECK(path.insert(1, {10, 0}));
    CHECK(path.total_length() == 20);
    CHECK(path.length(0, 2) == 20);
    CHECK(path.length(0, 1) == 10);
}

void duplicate_points_test() {
    Path path;
    for (int i = 0; i < 5; ++i) CHECK(path.insert(path.size(), {7, -3}));
    CHECK(path.size() == 5);
    CHECK(path.total_length() == 0);
    CHECK(path.length(0, 4) == 0);
    CHECK(path.length(2, 3) == 0);
    CHECK(path.erase(2));
    CHECK(path.size() == 4);
    const Point expected{7, -3};
    CHECK(path.at(0) == expected);
}

void range_semantics_test() {
    Path path;
    CHECK(path.insert(0, {0, 0}));
    CHECK(path.insert(1, {3, 4}));
    CHECK(path.insert(2, {6, 4}));
    CHECK(path.insert(3, {6, 10}));
    CHECK(path.total_length() == 7 + 3 + 6);
    CHECK(path.length(1, 2) == 3);
    CHECK(path.length(0, 0) == 0);
    CHECK(path.length(3, 3) == 0);
    CHECK(path.length(1, 3) == 3 + 6);
    CHECK(path.length(0, 3) == 16);
}

void invalid_operations_test() {
    Path path;
    CHECK(!path.erase(0));
    CHECK(!path.insert(1, {1, 1}));
    CHECK(path.insert(0, {1, 1}));
    CHECK(!path.erase(1));
    CHECK(!path.insert(2, {2, 2}));
    bool threw = false;
    try {
        (void)path.length(0, 5);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

}  // namespace

int main() {
    range_semantics_test();
    duplicate_points_test();
    invalid_operations_test();
    overflow_rejection_test();
    randomized_test();

    if (g_failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return EXIT_FAILURE;
    }
    std::puts("all tests passed");
    return EXIT_SUCCESS;
}
