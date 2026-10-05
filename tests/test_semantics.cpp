// Semantics: assign/add/erase, explicit combination order, canonical form.
#include "interval_index.hpp"
#include "check.hpp"

#include <cstdint>
#include <vector>

using index_t = iix::interval_index<int, std::int64_t>;
using op = index_t::op;
using segment = index_t::snapshot::segment;

static std::vector<segment> segs(const index_t& idx) {
    return idx.get_snapshot().segments();
}

static void run() {
    {  // empty index: nothing found
        index_t idx;
        CHECK(!idx.get_snapshot().query(0).has_value());
        CHECK(!idx.get_snapshot().query(-100).has_value());
    }
    {  // basic assign and point queries
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 5)});
        auto s = idx.get_snapshot();
        CHECK(!s.query(-1));
        CHECK(s.query(0) == 5);
        CHECK(s.query(9) == 5);
        CHECK(!s.query(10));
    }
    {  // overlapping assign splits the old segment
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 1)});
        idx.apply_batch({op::assign(3, 7, 2)});
        std::vector<segment> want = {{0, 3, 1}, {3, 7, 2}, {7, 10, 1}};
        CHECK(segs(idx) == want);
    }
    {  // canonical form: re-assigning equal values coalesces back
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 1)});
        idx.apply_batch({op::assign(3, 7, 2)});
        idx.apply_batch({op::assign(3, 7, 1)});
        std::vector<segment> want = {{0, 10, 1}};
        CHECK(segs(idx) == want);
    }
    {  // add accumulates onto existing values
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 10)});
        idx.apply_batch({op::add(3, 7, 5)});
        std::vector<segment> want = {{0, 3, 10}, {3, 7, 15}, {7, 10, 10}};
        CHECK(segs(idx) == want);
    }
    {  // add over absent region: absent counts as zero
        index_t idx;
        idx.apply_batch({op::add(2, 5, 3)});
        std::vector<segment> want = {{2, 5, 3}};
        CHECK(segs(idx) == want);
    }
    {  // add fills gaps inside the range
        index_t idx;
        idx.apply_batch({op::assign(2, 4, 10), op::assign(6, 8, 20)});
        idx.apply_batch({op::add(0, 10, 1)});
        std::vector<segment> want = {{0, 2, 1}, {2, 4, 11}, {4, 6, 1}, {6, 8, 21}, {8, 10, 1}};
        CHECK(segs(idx) == want);
    }
    {  // add can make neighbors equal -> coalesced
        index_t idx;
        idx.apply_batch({op::assign(0, 5, 1), op::assign(5, 10, 2)});
        idx.apply_batch({op::add(0, 5, 1)});
        std::vector<segment> want = {{0, 10, 2}};
        CHECK(segs(idx) == want);
    }
    {  // erase removes coverage
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 1)});
        idx.apply_batch({op::erase(3, 7)});
        std::vector<segment> want = {{0, 3, 1}, {7, 10, 1}};
        CHECK(segs(idx) == want);
        CHECK(!idx.get_snapshot().query(5));
    }
    {  // explicit combination order, case 1: add THEN assign -> assign wins
        index_t idx;
        idx.apply_batch({op::add(0, 10, 5), op::assign(3, 7, 100)});
        std::vector<segment> want = {{0, 3, 5}, {3, 7, 100}, {7, 10, 5}};
        CHECK(segs(idx) == want);
    }
    {  // explicit combination order, case 2: assign THEN add -> add accumulates
        index_t idx;
        idx.apply_batch({op::assign(3, 7, 100), op::add(0, 10, 5)});
        std::vector<segment> want = {{0, 3, 5}, {3, 7, 105}, {7, 10, 5}};
        CHECK(segs(idx) == want);
    }
    {  // same ops in different order give different results (order matters)
        index_t a, b;
        a.apply_batch({op::add(0, 10, 5), op::assign(0, 10, 7)});
        b.apply_batch({op::assign(0, 10, 7), op::add(0, 10, 5)});
        CHECK(a.get_snapshot().query(4) == 7);
        CHECK(b.get_snapshot().query(4) == 12);
    }
    {  // empty-range ops are no-ops
        index_t idx;
        idx.apply_batch({op::assign(0, 10, 1), op::add(4, 4, 99), op::erase(6, 6)});
        std::vector<segment> want = {{0, 10, 1}};
        CHECK(segs(idx) == want);
    }
    {  // negative keys work
        index_t idx;
        idx.apply_batch({op::assign(-10, -3, 4), op::add(-6, 0, 2)});
        std::vector<segment> want = {{-10, -6, 4}, {-6, -3, 6}, {-3, 0, 2}};
        CHECK(segs(idx) == want);
    }
    {  // many sequential batches stay canonical: adjacent segments differ
        index_t idx;
        for (int i = 0; i < 50; ++i) {
            idx.apply_batch({op::assign(i * 2, i * 2 + 3, i % 7), op::add(i, i + 20, 1)});
        }
        auto ss = segs(idx);
        for (std::size_t i = 1; i < ss.size(); ++i) {
            CHECK(ss[i - 1].hi == ss[i].lo);      // contiguous coverage
            CHECK(ss[i - 1].val != ss[i].val);    // canonical: neighbors differ
        }
    }
}
TEST_MAIN()
