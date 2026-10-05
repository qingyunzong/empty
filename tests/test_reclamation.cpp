#include "spatial/index.hpp"

#include <cstdint>

#include "test_framework.hpp"

using Index = spatial::SpatialIndex<2>;
using Box2 = spatial::Box<2>;

static Index::Op move_op(std::uint64_t id, double x) {
    return Index::Upsert{id, Box2{{x, 0}, {x + 1, 1}}};
}

TF_TEST(retired_snapshots_survive_until_readers_pass_barrier) {
    const std::size_t base = Index::live_snapshot_count();
    Index idx;
    idx.commit({move_op(1, 0)});
    CHECK_EQ(Index::live_snapshot_count(), base + 1);  // no readers: old reclaimed

    {
        auto reader = idx.open_view();   // pins the current epoch
        idx.commit({move_op(1, 100)});   // retires the snapshot `reader` holds
        CHECK_EQ(Index::live_snapshot_count(), base + 2);  // pinned reader blocks
        CHECK_EQ(idx.retired_count(), std::size_t{1});
        CHECK_EQ(idx.collect(), std::size_t{0});           // barrier: still blocked
        CHECK_EQ(Index::live_snapshot_count(), base + 2);
        // The pinned old view is still fully usable.
        CHECK_EQ(reader.query(Box2{{-1, -1}, {2, 2}}).size(), std::size_t{1});
    }  // reader unpins: passes the quiescent-state barrier

    CHECK_EQ(idx.collect(), std::size_t{1});  // now reclaimed
    CHECK_EQ(Index::live_snapshot_count(), base + 1);
    CHECK_EQ(idx.retired_count(), std::size_t{0});
}

TF_TEST(newer_readers_do_not_block_older_reclamation) {
    const std::size_t base = Index::live_snapshot_count();
    Index idx;
    idx.commit({move_op(1, 0)});
    {
        auto old_reader = idx.open_view();  // announces epoch E
        idx.commit({move_op(1, 100)});      // retires at E, advances to E+1
        CHECK_EQ(idx.collect(), std::size_t{0});  // blocked by old_reader
    }
    auto new_reader = idx.open_view();  // active, but announced at epoch E+1
    CHECK_EQ(idx.collect(), std::size_t{1});  // retired-at-E reclaimed anyway
    CHECK_EQ(Index::live_snapshot_count(), base + 1);
    CHECK_EQ(new_reader.size(), std::size_t{1});
}

TF_TEST(multiple_generations_reclaimed_together) {
    const std::size_t base = Index::live_snapshot_count();
    Index idx;
    idx.commit({move_op(1, 0)});
    {
        auto v = idx.open_view();
        for (int i = 1; i <= 5; ++i) idx.commit({move_op(1, i * 10.0)});
        CHECK_EQ(Index::live_snapshot_count(), base + 6);
        CHECK_EQ(idx.retired_count(), std::size_t{5});
        // The held view still sees the very first generation.
        CHECK_EQ(v.query(Box2{{-1, -1}, {2, 2}}).size(), std::size_t{1});
        CHECK_EQ(v.size(), std::size_t{1});
    }
    CHECK_EQ(idx.collect(), std::size_t{5});
    CHECK_EQ(Index::live_snapshot_count(), base + 1);
    CHECK_EQ(idx.retired_count(), std::size_t{0});
}

TF_MAIN()
