#include "check.hpp"
#include "intcol/column.hpp"

#include <vector>

using intcol::Column;

static void expect_eq(const Column& c, const std::vector<int64_t>& ref) {
    CHECK(c.size() == ref.size());
    for (std::size_t i = 0; i < ref.size(); ++i) CHECK(c.get(i) == ref[i]);
    std::vector<int64_t> scanned(c.begin(), c.end());
    CHECK(scanned == ref);
}

int main() {
    std::vector<int64_t> vals;
    for (int i = 0; i < 500; ++i) vals.push_back((i % 7) - 3);  // narrow: 3 bits
    Column col(vals, 32);
    CHECK(col.page_width(0) == 3);

    Column snap = col.snapshot();
    const unsigned snap_width0 = snap.page_width(0);

    // Widen every page of the original.
    for (std::size_t i = 0; i < col.size(); i += 3) col.set(i, 1'000'000 + i);
    // Narrow some pages back down.
    for (std::size_t i = 0; i < col.size(); ++i)
        if (i % 32 != 0) col.set(i, 0);

    // Snapshot must be bit-for-bit the old state.
    expect_eq(snap, vals);
    CHECK(snap.page_width(0) == snap_width0);

    // Original reflects updates.
    std::vector<int64_t> expected = vals;
    for (std::size_t i = 0; i < expected.size(); i += 3) expected[i] = 1'000'000 + i;
    for (std::size_t i = 0; i < expected.size(); ++i)
        if (i % 32 != 0) expected[i] = 0;
    expect_eq(col, expected);

    // Mutating the snapshot afterwards must not disturb the original.
    snap.set(0, -12345);
    CHECK(col.get(0) == expected[0]);
    CHECK(snap.get(0) == -12345);

    std::puts("test_snapshot OK");
    return 0;
}
