#include "spatial/index.hpp"

#include <cstdint>

#include "test_framework.hpp"

using Index = spatial::SpatialIndex<2>;
using Box2 = spatial::Box<2>;

TF_TEST(zero_volume_upserts_are_ignored) {
    Index idx;
    idx.commit({Index::Upsert{1, Box2{{0, 0}, {0, 5}}},   // zero width
                Index::Upsert{2, Box2{{1, 1}, {1, 1}}},   // point
                Index::Upsert{3, Box2{{9, 9}, {4, 4}}},   // inverted
                Index::Upsert{4, Box2{{0, 0}, {4, 4}}}}); // valid
    auto view = idx.open_view();
    CHECK_EQ(view.size(), std::size_t{1});
    auto hits = view.query(Box2{{-10, -10}, {10, 10}});
    CHECK_EQ(hits.size(), std::size_t{1});
    CHECK_EQ(hits[0], std::uint64_t{4});
}

TF_TEST(zero_volume_update_is_a_noop) {
    Index idx;
    idx.commit({Index::Upsert{1, Box2{{0, 0}, {2, 2}}}});
    idx.commit({Index::Upsert{1, Box2{{5, 5}, {5, 9}}}});  // zero volume: ignored
    auto view = idx.open_view();
    CHECK_EQ(view.size(), std::size_t{1});
    CHECK_EQ(view.query(Box2{{0, 0}, {2, 2}}).size(), std::size_t{1});
    CHECK(view.query(Box2{{4, 4}, {9, 9}}).empty());
}

TF_TEST(zero_volume_query_range_matches_nothing) {
    Index idx;
    idx.commit({Index::Upsert{1, Box2{{0, 0}, {2, 2}}}});
    auto view = idx.open_view();
    CHECK(view.query(Box2{{1, 1}, {1, 1}}).empty());   // point query
    CHECK(view.query(Box2{{0, 0}, {2, 0}}).empty());   // zero-height strip
    CHECK_EQ(view.query(Box2{{1, 1}, {2, 2}}).size(), std::size_t{1});
}

TF_MAIN()
