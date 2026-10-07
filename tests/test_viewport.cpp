#include "tilelib/viewport.hpp"
#include "test_util.hpp"

using namespace tilelib;

static void run() {
    // TileId ancestry math.
    TileId leaf{4, 9, 5};
    auto p = leaf.parent();
    CHECK(p && *p == TileId(3, 4, 2));
    CHECK(TileId(3, 4, 2).is_ancestor_of(leaf));
    CHECK(TileId(0, 0, 0).is_ancestor_of(leaf));
    CHECK(!TileId(3, 5, 2).is_ancestor_of(leaf));
    CHECK(!leaf.is_ancestor_of(TileId(3, 4, 2)));
    CHECK(!TileId(0, 0, 0).parent().has_value());

    // Viewport requests tiles coarse-to-fine across the level hierarchy.
    Viewport v{/*generation=*/1, /*min_level=*/1, /*level=*/3,
               /*x0=*/4, /*y0=*/4, /*x1=*/5, /*y1=*/5};
    auto req = required_tiles(v);
    CHECK(req.size() == 1 + 1 + 4); // z1: (0,0); z2: (1,1); z3: 2x2
    CHECK(req.front() == TileId(1, 1, 1));
    CHECK(req[1] == TileId(2, 2, 2));
    CHECK(req.back() == TileId(3, 5, 5));

    // Single-level viewport requests exactly the rect at that level.
    Viewport flat{2, 5, 5, 0, 0, 3, 1};
    auto flat_req = required_tiles(flat);
    CHECK(flat_req.size() == 8);
    CHECK(flat_req.front() == TileId(5, 0, 0));
    CHECK(flat_req.back() == TileId(5, 3, 1));
}

TEST_MAIN()
