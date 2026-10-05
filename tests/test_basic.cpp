// Unit tests: query semantics, composition order of assign/add, segment
// coalescing, gaps, and single-threaded snapshot isolation.
#include <interval_index/interval_index.hpp>

#include <optional>
#include <vector>

#include "test_util.hpp"

using interval_index::batch;
using interval_index::index;
using interval_index::segment;

using seg = segment<int>;

static void test_empty_and_single_assign() {
    index<int> idx;
    CHECK(!idx.query(0).has_value());
    idx.assign(10, 20, 100);
    CHECK(!idx.query(9).has_value());
    CHECK_EQ(idx.query(10), std::optional<int>(100));
    CHECK_EQ(idx.query(19), std::optional<int>(100));
    CHECK(!idx.query(20).has_value());  // half-open
}

static void test_composition_order() {
    // assign then add: add accumulates onto the assigned value.
    index<int> a;
    a.assign(0, 100, 10);
    a.add(0, 100, 5);
    CHECK_EQ(a.query(50), std::optional<int>(15));

    // add then assign: assign wins, the earlier add is discarded.
    index<int> b;
    b.assign(0, 100, 1);  // establish values so add has something to touch
    b.add(0, 100, 999);
    b.assign(0, 100, 7);
    CHECK_EQ(b.query(50), std::optional<int>(7));

    // add never creates values on unassigned points.
    index<int> c;
    c.add(0, 100, 5);
    CHECK(!c.query(50).has_value());
    CHECK(c.snap().segments().empty());

    // One batch, ops applied strictly in insertion order.
    index<int> d;
    d.apply(batch<int>()
                .assign(0, 100, 10)   // [0,100) = 10
                .add(20, 40, 5)       // [20,40) = 15
                .assign(30, 50, 7)    // [30,50) = 7
                .add(0, 100, 1));     // everything +1
    std::vector<seg> want = {{0, 20, 11}, {20, 30, 16}, {30, 50, 8}, {50, 100, 11}};
    CHECK_EQ(d.snap().segments(), want);
}

static void test_split_and_coalesce() {
    // Overwriting the middle of a segment splits it into three.
    index<int> idx;
    idx.assign(0, 100, 1);
    idx.assign(30, 70, 2);
    std::vector<seg> want = {{0, 30, 1}, {30, 70, 2}, {70, 100, 1}};
    CHECK_EQ(idx.snap().segments(), want);

    // Adjacent equal values coalesce into one segment.
    index<int> e;
    e.assign(0, 50, 3);
    e.assign(50, 100, 3);
    CHECK_EQ(e.snap().segments(), std::vector<seg>{{0, 100, 3}});

    // add can make neighbours equal; they must fuse.
    index<int> f;
    f.assign(0, 50, 3);
    f.assign(50, 100, 5);
    f.add(50, 100, -2);
    CHECK_EQ(f.snap().segments(), std::vector<seg>{{0, 100, 3}});

    // Coalescing must never fill an unassigned gap.
    index<int> g;
    g.assign(0, 10, 1);
    g.assign(20, 30, 1);
    CHECK_EQ(g.snap().segments(), (std::vector<seg>{{0, 10, 1}, {20, 30, 1}}));
    CHECK(!g.query(15).has_value());
    g.add(5, 25, 9);  // touches both islands, gap stays unassigned
    CHECK_EQ(g.snap().segments(),
             (std::vector<seg>{{0, 5, 1}, {5, 10, 10}, {20, 25, 10}, {25, 30, 1}}));
    CHECK(!g.query(15).has_value());
}

static void test_snapshot_isolation_single_thread() {
    index<int> idx;
    idx.assign(0, 100, 1);
    auto s1 = idx.snap();
    idx.assign(0, 100, 2);
    idx.add(0, 100, 40);
    auto s2 = idx.snap();
    idx.assign(0, 100, 9);
    CHECK_EQ(s1.query(42), std::optional<int>(1));
    CHECK_EQ(s2.query(42), std::optional<int>(42));
    CHECK_EQ(idx.query(42), std::optional<int>(9));
}

static void test_randomized_structure_invariants() {
    // After random updates, segments must be sorted, non-empty, non-
    // overlapping, and never have equal values on adjacent segments.
    index<int> idx;
    rng r(12345);
    for (int i = 0; i < 500; ++i) {
        int lo = static_cast<int>(r.below(200));
        int hi = lo + 1 + static_cast<int>(r.below(40));
        int v = static_cast<int>(r.below(7)) - 3;
        if (r.below(2))
            idx.assign(lo, hi, v);
        else
            idx.add(lo, hi, v);
    }
    auto segs = idx.snap().segments();
    for (std::size_t i = 0; i < segs.size(); ++i) {
        CHECK(segs[i].lo < segs[i].hi);
        if (i) {
            CHECK(segs[i - 1].hi <= segs[i].lo);
            CHECK(!(segs[i - 1].hi == segs[i].lo &&
                    segs[i - 1].value == segs[i].value));
        }
    }
}

int main() {
    test_empty_and_single_assign();
    test_composition_order();
    test_split_and_coalesce();
    test_snapshot_isolation_single_thread();
    test_randomized_structure_invariants();
    std::puts("test_basic: all checks passed");
    return 0;
}
