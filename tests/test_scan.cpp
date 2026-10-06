// Cross-page scanning, zero-length pages, and scan-after-update behavior.
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <vector>

#include "packed_column.hpp"

using packed::IntColumn;

static std::vector<int64_t> scanAll(const IntColumn& col) {
    return {col.begin(), col.end()};
}

int main() {
    // Zero-length pages are legal, have width 0, and are skipped by scans.
    auto col = IntColumn::fromPages({{}, {1, 2}, {}, {-3}, {}, {0, -1, 5}, {}});
    assert(col.size() == 6);
    assert(col.pageCount() == 7);
    assert(col.pageWidth(0) == 0);
    assert(col.pageLength(2) == 0);
    std::vector<int64_t> expected = {1, 2, -3, 0, -1, 5};
    assert(scanAll(col) == expected);
    assert(std::distance(col.begin(), col.end()) == 6);
    for (size_t i = 0; i < expected.size(); ++i) assert(col.get(i) == expected[i]);

    // Updates through zero-length-page boundaries hit the right element.
    col.set(2, -1000000);  // first element of page 3
    col.set(0, 70000);     // widens page 1
    expected[2] = -1000000;
    expected[0] = 70000;
    assert(scanAll(col) == expected);

    // Entirely empty column: begin() == end(), size 0.
    auto empty = IntColumn::fromPages({{}, {}, {}});
    assert(empty.size() == 0);
    assert(empty.begin() == empty.end());
    assert(scanAll(empty).empty());

    // Scan across many pages of varying widths matches a plain vector.
    std::vector<int64_t> big;
    for (int i = 0; i < 5000; ++i) {
        if (i % 3 == 0) big.push_back(i);
        else if (i % 3 == 1) big.push_back(-i * 1000000LL);
        else big.push_back(static_cast<int64_t>(i) << 40);
    }
    auto wide = IntColumn::fromValues(big, /*pageSize=*/97);
    assert(scanAll(wide) == big);

    // Snapshot taken before updates still scans the old values.
    auto snap = wide.snapshot();
    for (size_t i = 0; i < big.size(); i += 97) wide.set(i, -1);
    assert(scanAll(snap) == big);

    std::puts("test_scan: OK");
    return 0;
}
