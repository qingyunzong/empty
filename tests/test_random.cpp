// Randomized differential test: mpath::ManhattanPath vs. a naive reference
// that stores points in a std::vector and recomputes lengths from scratch.

#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <random>
#include <vector>

#include "manhattan_path.hpp"

using mpath::ManhattanPath;
using mpath::Point;

namespace {

__int128 dist128(Point a, Point b) {
    __int128 dx = static_cast<__int128>(a.x) - b.x;
    __int128 dy = static_cast<__int128>(a.y) - b.y;
    if (dx < 0) dx = -dx;
    if (dy < 0) dy = -dy;
    return dx + dy;
}

// Naive reference implementation with the same contract as ManhattanPath.
struct Reference {
    std::vector<Point> points;

    std::size_t size() const { return points.size(); }

    __int128 total128() const {
        __int128 total = 0;
        for (std::size_t i = 0; i + 1 < points.size(); ++i)
            total += dist128(points[i], points[i + 1]);
        return total;
    }

    std::int64_t total_length() const {
        return static_cast<std::int64_t>(total128());
    }

    // Apply, recompute, roll back on overflow ("keep the old version").
    bool insert(std::size_t index, Point p) {
        if (index > points.size()) return false;
        points.insert(points.begin() + static_cast<std::ptrdiff_t>(index), p);
        if (total128() > std::numeric_limits<std::int64_t>::max()) {
            points.erase(points.begin() + static_cast<std::ptrdiff_t>(index));
            return false;
        }
        return true;
    }

    bool erase(std::size_t index) {
        if (index >= points.size()) return false;
        Point saved = points[index];
        points.erase(points.begin() + static_cast<std::ptrdiff_t>(index));
        if (total128() > std::numeric_limits<std::int64_t>::max()) {
            points.insert(points.begin() + static_cast<std::ptrdiff_t>(index), saved);
            return false;
        }
        return true;
    }

    std::int64_t length(std::size_t l, std::size_t r) const {
        __int128 total = 0;
        for (std::size_t i = l; i < r; ++i) total += dist128(points[i], points[i + 1]);
        return static_cast<std::int64_t>(total);
    }
};

Point random_point(std::mt19937_64& rng) {
    // Mostly small coordinates; occasionally extreme ones to hit overflow.
    switch (rng() % 10) {
        case 0: {
            std::uniform_int_distribution<std::int64_t> any;
            return Point{any(rng), any(rng)};
        }
        case 1: {
            const std::int64_t extremes[] = {
                std::numeric_limits<std::int64_t>::max(),
                std::numeric_limits<std::int64_t>::min(),
                std::numeric_limits<std::int64_t>::max() / 2,
                std::numeric_limits<std::int64_t>::min() / 2,
                0,
            };
            return Point{extremes[rng() % 5], extremes[rng() % 5]};
        }
        default: {
            std::uniform_int_distribution<std::int64_t> small(-1000, 1000);
            return Point{small(rng), small(rng)};
        }
    }
}

int run(std::uint64_t seed, int ops) {
    std::mt19937_64 rng(seed);
    ManhattanPath path;
    Reference ref;
    int failures = 0;

    auto check = [&](bool ok, const char* what, int op) {
        if (!ok) {
            std::fprintf(stderr, "seed=%" PRIu64 " op=%d: %s\n", seed, op, what);
            ++failures;
        }
    };

    for (int op = 0; op < ops; ++op) {
        const std::size_t n = ref.size();
        const int kind = static_cast<int>(rng() % 100);

        if (kind < 45 || n == 0) {
            // insert
            std::uniform_int_distribution<std::size_t> at(0, n);
            const std::size_t index = at(rng);
            const Point p = random_point(rng);
            const bool got = path.insert(index, p);
            const bool want = ref.insert(index, p);
            check(got == want, "insert accept/reject mismatch", op);
        } else if (kind < 80) {
            // erase
            std::uniform_int_distribution<std::size_t> at(0, n - 1);
            const std::size_t index = at(rng);
            const bool got = path.erase(index);
            const bool want = ref.erase(index);
            check(got == want, "erase accept/reject mismatch", op);
        } else {
            // range length query
            std::uniform_int_distribution<std::size_t> at(0, n - 1);
            const std::size_t a = at(rng);
            const std::size_t b = at(rng);
            const std::size_t l = a < b ? a : b;
            const std::size_t r = a < b ? b : a;
            check(path.length(l, r) == ref.length(l, r), "range length mismatch", op);
        }

        check(path.size() == ref.size(), "size mismatch", op);
        check(path.total_length() == ref.total_length(), "total length mismatch", op);

        // Periodically compare the full point sequence.
        if (op % 97 == 0) {
            for (std::size_t i = 0; i < ref.size(); ++i)
                check(path.point_at(i) == ref.points[i], "point sequence mismatch", op);
        }

        if (failures > 20) break;  // stop early on systematic failure
    }

    return failures;
}

}  // namespace

int main(int argc, char** argv) {
    const std::uint64_t seed = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 1;
    const int ops = argc > 2 ? std::atoi(argv[2]) : 30000;
    const int failures = run(seed, ops);
    if (failures != 0) {
        std::fprintf(stderr, "seed=%" PRIu64 ": %d failure(s)\n", seed, failures);
        return 1;
    }
    std::printf("seed=%" PRIu64 ": %d random ops matched the reference\n", seed, ops);
    return 0;
}
