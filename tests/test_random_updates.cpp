// Randomized differential test: IntColumn vs a plain std::vector<int64_t>,
// including width widening/narrowing checks and snapshot immutability.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <random>
#include <vector>

#include "packed_column.hpp"

using packed::IntColumn;

static int64_t pickValue(std::mt19937_64& rng) {
    switch (rng() % 4) {
        case 0:  // small values keep pages narrow
            return static_cast<int64_t>(rng() % 21) - 10;
        case 1:  // medium signed values
            return static_cast<int64_t>(rng() % 2000001) - 1000000;
        case 2:  // full-range values force width 64
            return static_cast<int64_t>(rng());
        default: {  // width boundaries: +-2^k and neighbors
            int k = static_cast<int>(rng() % 63);
            int64_t p = int64_t{1} << k;
            int64_t cand[] = {p, p - 1, -p, -p - 1, p + 1};
            return cand[rng() % 5];
        }
    }
}

static void checkWidths(const IntColumn& col, const std::vector<int64_t>& ref) {
    size_t pos = 0;
    for (size_t p = 0; p < col.pageCount(); ++p) {
        int expected = 0;
        for (size_t k = 0; k < col.pageLength(p); ++k) {
            int w = packed::requiredWidth(ref[pos++]);
            if (w > expected) expected = w;
        }
        assert(col.pageWidth(p) == expected);  // minimal width, widen + narrow
    }
}

int main() {
    constexpr size_t kPageSize = 128;
    constexpr size_t kN = 10000;
    constexpr int kOps = 200000;
    std::mt19937_64 rng(0xC0FFEE);

    std::vector<int64_t> ref(kN);
    for (auto& v : ref) v = pickValue(rng);
    auto col = IntColumn::fromValues(ref, kPageSize);

    struct Snap {
        IntColumn col;
        std::vector<int64_t> ref;
    };
    std::vector<Snap> snaps;
    snaps.push_back({col.snapshot(), ref});

    for (int op = 0; op < kOps; ++op) {
        size_t i = rng() % kN;
        int64_t v = pickValue(rng);
        col.set(i, v);
        ref[i] = v;
        assert(col.get(i) == v);
        if (op % 4096 == 0) {
            for (size_t j = 0; j < 64; ++j) {
                size_t k = rng() % kN;
                assert(col.get(k) == ref[k]);
            }
        }
        if (op % 50000 == 49999) snaps.push_back({col.snapshot(), ref});
    }

    // Full final comparison plus per-page minimal-width verification.
    for (size_t i = 0; i < kN; ++i) assert(col.get(i) == ref[i]);
    checkWidths(col, ref);

    // Old snapshots must be bit-for-bit unaffected by later updates.
    for (const auto& s : snaps) {
        assert(s.col.size() == s.ref.size());
        for (size_t i = 0; i < s.ref.size(); ++i) assert(s.col.get(i) == s.ref[i]);
        checkWidths(s.col, s.ref);
    }

    std::puts("test_random_updates: OK");
    return 0;
}
