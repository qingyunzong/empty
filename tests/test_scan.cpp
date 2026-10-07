#include "check.hpp"
#include "intcol/column.hpp"

#include <numeric>
#include <vector>

using intcol::Column;

int main() {
    // Cross-page scan with tiny pages (capacity 3) over 1000 values.
    std::vector<int64_t> vals(1000);
    std::iota(vals.begin(), vals.end(), -500);
    Column col(vals, 3);
    CHECK(col.page_count() == 334);
    std::size_t i = 0;
    for (int64_t v : col) CHECK(v == vals[i++]);
    CHECK(i == vals.size());

    // Iterator across zero-length pages interleaved with data pages.
    Column mixed({{7}, {}, {}, {8, 9}, {}, {-10}});
    std::vector<int64_t> got(mixed.begin(), mixed.end());
    CHECK((got == std::vector<int64_t>{7, 8, 9, -10}));

    // std algorithms work with the forward iterator.
    CHECK(std::distance(col.begin(), col.end()) == 1000);

    std::puts("test_scan OK");
    return 0;
}
