#include "check.hpp"
#include "intcol/column.hpp"

#include <cstdint>
#include <random>
#include <vector>

using intcol::Column;

static int64_t random_value(std::mt19937_64& rng) {
    switch (rng() % 4) {
        case 0: return static_cast<int64_t>(rng() % 13) - 6;          // tiny
        case 1: return static_cast<int64_t>(rng() % 2001) - 1000;     // small
        case 2: {                                                     // boundary-ish
            unsigned k = rng() % 64;
            int64_t base = k == 0 ? 0 : (int64_t{1} << (k - 1));
            int64_t delta = static_cast<int64_t>(rng() % 3) - 1;
            int64_t v = base + delta;
            return (rng() & 1) ? v : -v;
        }
        default: return static_cast<int64_t>(rng());                  // full range
    }
}

static void verify(const Column& col, const std::vector<int64_t>& ref,
                   std::mt19937_64& rng) {
    CHECK(col.size() == ref.size());
    std::vector<int64_t> scanned(col.begin(), col.end());
    CHECK(scanned == ref);
    for (int t = 0; t < 64 && !ref.empty(); ++t) {
        std::size_t i = rng() % ref.size();
        CHECK(col.get(i) == ref[i]);
    }
}

int main() {
    std::mt19937_64 rng(20261007);
    for (int trial = 0; trial < 20; ++trial) {
        const std::size_t cap = std::vector<std::size_t>{1, 2, 7, 32, 128}[rng() % 5];
        const std::size_t n = 1 + rng() % 800;
        std::vector<int64_t> ref(n);
        for (auto& v : ref) v = random_value(rng);
        Column col(ref, cap);

        std::vector<std::pair<Column, std::vector<int64_t>>> snaps;
        for (int step = 0; step < 4000; ++step) {
            std::size_t i = rng() % n;
            int64_t v = random_value(rng);
            col.set(i, v);
            ref[i] = v;
            if (step % 251 == 0) snaps.emplace_back(col.snapshot(), ref);
            if (step % 499 == 0) verify(col, ref, rng);
        }
        verify(col, ref, rng);
        for (const auto& [snap, expected] : snaps) {
            Column s = snap;  // verify via non-const scan too
            std::vector<int64_t> scanned(s.begin(), s.end());
            CHECK(scanned == expected);
        }
    }
    std::puts("test_fuzz OK");
    return 0;
}
