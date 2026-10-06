// Boundary-value tests: minimal width selection and two's-complement
// sign extension at every width boundary.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

#include "packed_column.hpp"

using packed::IntColumn;
using packed::PackedPage;
using packed::requiredWidth;

static int64_t minForWidth(int w) {
    return w == 64 ? std::numeric_limits<int64_t>::min()
                   : -(int64_t{1} << (w - 1));
}
static int64_t maxForWidth(int w) {
    return w == 64 ? std::numeric_limits<int64_t>::max()
                   : (int64_t{1} << (w - 1)) - 1;
}

int main() {
    // requiredWidth sanity at exact boundaries.
    assert(requiredWidth(0) == 1);
    assert(requiredWidth(-1) == 1);
    assert(requiredWidth(1) == 2);
    assert(requiredWidth(-2) == 2);
    assert(requiredWidth(127) == 8);
    assert(requiredWidth(-128) == 8);
    assert(requiredWidth(128) == 9);
    assert(requiredWidth(-129) == 9);
    assert(requiredWidth(std::numeric_limits<int64_t>::max()) == 64);
    assert(requiredWidth(std::numeric_limits<int64_t>::min()) == 64);

    // For every width w: a page holding exactly {min, max, 0, -1} of that
    // width must have width w and round-trip every value with correct
    // sign extension.
    for (int w = 1; w <= 64; ++w) {
        std::vector<int64_t> vals = {minForWidth(w), maxForWidth(w), 0, -1};
        PackedPage page(vals);
        assert(page.width() == w);
        for (size_t i = 0; i < vals.size(); ++i) assert(page.get(i) == vals[i]);
    }

    // Dense sweep around every power-of-two boundary: 2^k, 2^k-1, -(2^k),
    // -(2^k)-1 must all survive packing next to each other.
    std::vector<int64_t> vals;
    for (int k = 0; k < 63; ++k) {
        int64_t p = int64_t{1} << k;
        vals.insert(vals.end(), {p, p - 1, -p, -p - 1, p + 1});
    }
    vals.insert(vals.end(), {std::numeric_limits<int64_t>::min(),
                             std::numeric_limits<int64_t>::max(),
                             std::numeric_limits<int64_t>::min() + 1,
                             std::numeric_limits<int64_t>::max() - 1});
    auto col = IntColumn::fromValues(vals, /*pageSize=*/7);  // odd size to split words
    assert(col.size() == vals.size());
    for (size_t i = 0; i < vals.size(); ++i) assert(col.get(i) == vals[i]);

    // Width-64 page (contains INT64_MIN) must not be truncated.
    std::vector<int64_t> extremes = {std::numeric_limits<int64_t>::min(), -1, 0,
                                     std::numeric_limits<int64_t>::max()};
    PackedPage p64(extremes);
    assert(p64.width() == 64);
    for (size_t i = 0; i < extremes.size(); ++i) assert(p64.get(i) == extremes[i]);

    std::puts("test_sign_extension: OK");
    return 0;
}
