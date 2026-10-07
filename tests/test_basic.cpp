#include "check.hpp"
#include "intcol/column.hpp"

#include <vector>

using intcol::Column;

int main() {
    // Empty column: zero pages, empty scan.
    Column empty;
    CHECK(empty.size() == 0);
    CHECK(empty.page_count() == 0);
    CHECK(empty.begin() == empty.end());

    // Zero-length pages are legal and skipped by scans.
    Column with_empty({{}, {1, -2}, {}, {3}, {}});
    CHECK(with_empty.size() == 3);
    CHECK(with_empty.page_count() == 5);
    CHECK(with_empty.page_size(0) == 0);
    CHECK(with_empty.page_width(0) == 0);
    std::vector<int64_t> scanned(with_empty.begin(), with_empty.end());
    CHECK((scanned == std::vector<int64_t>{1, -2, 3}));
    CHECK(with_empty.get(0) == 1 && with_empty.get(1) == -2 && with_empty.get(2) == 3);

    // Round-trip with default capacity.
    std::vector<int64_t> vals{5, -7, 0, 100, -100};
    Column col(vals);
    CHECK(col.size() == vals.size());
    for (std::size_t i = 0; i < vals.size(); ++i) CHECK(col.get(i) == vals[i]);

    // Minimal width: page width equals the smallest sufficient signed width.
    struct Case { int64_t v; unsigned w; };
    for (auto [v, w] : {Case{0, 1}, Case{-1, 1}, Case{1, 2}, Case{-2, 2},
                        Case{2, 3}, Case{-3, 3}, Case{127, 8}, Case{-128, 8},
                        Case{128, 9}, Case{-129, 9}}) {
        Column c(std::vector<int64_t>{v});
        CHECK(c.page_width(0) == w);
        CHECK(c.get(0) == v);
    }

    // Update widens the page.
    Column wide(std::vector<int64_t>{1, 2, 3});
    CHECK(wide.page_width(0) == 3);
    wide.set(0, 100);
    CHECK(wide.page_width(0) == 8);
    CHECK(wide.get(0) == 100 && wide.get(1) == 2 && wide.get(2) == 3);

    // Update narrows the page.
    Column narrow(std::vector<int64_t>{100, 1});
    CHECK(narrow.page_width(0) == 8);
    narrow.set(0, 3);
    CHECK(narrow.page_width(0) == 3);
    CHECK(narrow.get(0) == 3 && narrow.get(1) == 1);

    // Out-of-range access throws.
    bool threw = false;
    try { col.get(5); } catch (const std::out_of_range&) { threw = true; }
    CHECK(threw);

    std::puts("test_basic OK");
    return 0;
}
