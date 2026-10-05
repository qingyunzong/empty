#include "spatial/index.hpp"

#include <cstdint>
#include <map>
#include <vector>

#include "test_framework.hpp"

using Index = spatial::SpatialIndex<2>;
using Box2 = spatial::Box<2>;

static Box2 box_at(double x, double y) { return Box2{{x, y}, {x + 1, y + 1}}; }

TF_TEST(batch_move_is_atomic_and_old_view_is_stable) {
    Index idx;
    std::vector<Index::Op> setup;
    for (std::uint64_t i = 0; i < 100; ++i)
        setup.push_back(Index::Upsert{i, box_at(static_cast<double>(i), 0)});
    idx.commit(setup);

    auto old_view = idx.open_view();

    // One atomic batch: move ids 0..49 far away, remove 50..74, add 200..209.
    std::vector<Index::Op> batch;
    for (std::uint64_t i = 0; i < 50; ++i)
        batch.push_back(Index::Upsert{i, box_at(static_cast<double>(i), 1000)});
    for (std::uint64_t i = 50; i < 75; ++i) batch.push_back(Index::Remove{i});
    for (std::uint64_t i = 200; i < 210; ++i)
        batch.push_back(Index::Upsert{i, box_at(0, static_cast<double>(i))});
    idx.commit(batch);

    // Old view: untouched by the batch.
    CHECK_EQ(old_view.size(), std::size_t{100});
    CHECK_EQ(old_view.query(Box2{{-1, 999}, {200, 1002}}).size(), std::size_t{0});
    CHECK_EQ(old_view.query(Box2{{-1, -1}, {200, 2}}).size(), std::size_t{100});

    // New view: the whole batch is visible at once (all-or-nothing).
    auto new_view = idx.open_view();
    CHECK_EQ(new_view.size(), std::size_t{85});  // 100 - 25 removed + 10 added
    CHECK_EQ(new_view.query(Box2{{-1, 999}, {200, 1002}}).size(), std::size_t{50});
    CHECK_EQ(new_view.query(Box2{{-1, -1}, {200, 2}}).size(), std::size_t{25});
    CHECK_EQ(new_view.query(Box2{{-1, 199}, {2, 211}}).size(), std::size_t{10});
}

TF_TEST(deletion_and_id_reuse_do_not_affect_old_views) {
    Index idx;
    idx.commit({Index::Upsert{7, box_at(10, 10)}, Index::Upsert{8, box_at(20, 20)}});
    auto v0 = idx.open_view();

    idx.commit({Index::Remove{7}});
    auto v1 = idx.open_view();

    idx.commit({Index::Upsert{7, box_at(500, 500)}});  // id reuse
    auto v2 = idx.open_view();

    // v0 still sees the original box for id 7.
    std::map<std::uint64_t, Box2> seen0;
    v0.query(Box2{{-1000, -1000}, {1000, 1000}},
             [&](std::uint64_t id, const Box2& b) { seen0.emplace(id, b); });
    CHECK_EQ(seen0.size(), std::size_t{2});
    CHECK(seen0.count(7) == 1);
    CHECK_EQ(seen0[7].min[0], 10.0);
    CHECK_EQ(v0.query(Box2{{9, 9}, {12, 12}}).size(), std::size_t{1});

    // v1: id 7 is deleted.
    CHECK_EQ(v1.query(Box2{{-1000, -1000}, {1000, 1000}}).size(), std::size_t{1});

    // v2: id 7 exists again, but only at the new location.
    std::map<std::uint64_t, Box2> seen2;
    v2.query(Box2{{-1000, -1000}, {1000, 1000}},
             [&](std::uint64_t id, const Box2& b) { seen2.emplace(id, b); });
    CHECK_EQ(seen2.size(), std::size_t{2});
    CHECK_EQ(seen2[7].min[0], 500.0);
    CHECK(v2.query(Box2{{9, 9}, {12, 12}}).empty());

    // And v0 is still unchanged after the reuse commit.
    CHECK_EQ(v0.query(Box2{{9, 9}, {12, 12}}).size(), std::size_t{1});
    CHECK_EQ(v0.size(), std::size_t{2});
}

TF_MAIN()
