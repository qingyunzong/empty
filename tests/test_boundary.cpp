#include "check.hpp"
#include "intcol/column.hpp"

#include <cstdint>
#include <vector>

using intcol::Column;

static std::vector<int64_t> boundary_values() {
    std::vector<int64_t> v{0, 1, -1, INT64_MAX, INT64_MIN,
                           INT64_MAX - 1, INT64_MIN + 1};
    for (int k = 1; k < 63; ++k) {
        int64_t p = int64_t{1} << k;
        v.insert(v.end(), {p, p - 1, p + 1, -p, -p - 1, -p + 1});
    }
    return v;
}

int main() {
    const std::vector<int64_t> vals = boundary_values();

    // Each boundary value alone in its own page (capacity 1).
    Column solo(vals, 1);
    for (std::size_t i = 0; i < vals.size(); ++i) CHECK(solo.get(i) == vals[i]);

    // INT64_MIN/MAX force full 64-bit width.
    Column extreme(std::vector<int64_t>{INT64_MIN});
    CHECK(extreme.page_width(0) == 64);
    CHECK(extreme.get(0) == INT64_MIN);
    Column extreme2(std::vector<int64_t>{INT64_MAX});
    CHECK(extreme2.page_width(0) == 64);
    CHECK(extreme2.get(0) == INT64_MAX);

    // All boundaries packed across pages of 16: sign extension must survive
    // packing/unpacking at every bit offset.
    Column packed(vals, 16);
    CHECK(packed.size() == vals.size());
    std::vector<int64_t> scanned(packed.begin(), packed.end());
    CHECK(scanned == vals);
    for (std::size_t i = 0; i < vals.size(); ++i) CHECK(packed.get(i) == vals[i]);

    // Updates to boundary values, then back.
    Column col(std::vector<int64_t>(vals.size(), 0), 16);
    for (std::size_t i = 0; i < vals.size(); ++i) col.set(i, vals[i]);
    for (std::size_t i = 0; i < vals.size(); ++i) CHECK(col.get(i) == vals[i]);
    for (std::size_t i = 0; i < vals.size(); ++i) col.set(i, -vals[i] == vals[i] ? 1 : -vals[i]);
    for (std::size_t i = 0; i < vals.size(); ++i) {
        int64_t want = -vals[i] == vals[i] ? 1 : -vals[i];  // INT64_MIN stays itself
        CHECK(col.get(i) == want);
    }

    // Width boundaries: 2^(k-1)-1 fits k bits, 2^(k-1) needs k+1.
    for (unsigned k = 1; k < 64; ++k) {
        int64_t hi = k == 1 ? 0 : (int64_t{1} << (k - 1)) - 1;
        Column a(std::vector<int64_t>{hi});
        CHECK(a.page_width(0) == k);
        if (k < 63) {
            Column b(std::vector<int64_t>{int64_t{1} << (k - 1)});
            CHECK(b.page_width(0) == k + 1);
        }
        int64_t lo = k == 1 ? -1 : -(int64_t{1} << (k - 1));
        Column c(std::vector<int64_t>{lo});
        CHECK(c.page_width(0) == k);
        if (k < 63) {
            Column d(std::vector<int64_t>{-(int64_t{1} << (k - 1)) - 1});
            CHECK(d.page_width(0) == k + 1);
        }
    }

    std::puts("test_boundary OK");
    return 0;
}
