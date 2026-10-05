#include "tilelib/tilelib.hpp"

#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using tilelib::ManualLoader;
using tilelib::ResolvedTile;
using tilelib::Tile;
using tilelib::TileCache;
using tilelib::TileId;

namespace {

int g_failures = 0;

#define CHECK(cond)                                                  \
  do {                                                               \
    if (!(cond)) {                                                   \
      std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "    \
                << #cond << '\n';                                    \
      ++g_failures;                                                  \
    }                                                                \
  } while (0)

std::vector<std::byte> payload(std::size_t n) {
  return std::vector<std::byte>(n, std::byte{0xAB});
}

// Viewport requests issue loads exactly for missing required tiles at the
// viewport level; cached tiles are not re-requested.
int test_viewport_requests() {
  ManualLoader loader;
  TileCache cache(1 << 20, loader);

  const TileId a{3, 1, 1};
  const TileId b{3, 1, 2};
  cache.setViewport({a, b});
  CHECK(cache.version() == 1);
  CHECK(loader.pending().size() == 2);
  CHECK(cache.pendingCount() == 2);

  const auto h1 = loader.pending()[0].handle;
  const auto h2 = loader.pending()[1].handle;
  CHECK(loader.complete(h1, payload(100), "src://v1/a"));
  CHECK(loader.complete(h2, payload(200), "src://v1/b"));
  CHECK(cache.usedBytes() == 300);
  CHECK(cache.summedBytes() == cache.usedBytes());

  // New viewport overlapping on `a`: no reload for the cached tile.
  const TileId c{3, 2, 2};
  cache.setViewport({a, c});
  CHECK(loader.pending().size() == 1);
  CHECK(loader.pending()[0].id == c);
  CHECK(loader.beginCount() == 3);
  const Tile* ta = cache.find(a);
  CHECK(ta != nullptr && ta->pinned && ta->version == 2);
  return g_failures;
}

// Late results from a superseded viewport enter the cache tagged with their
// own version and may only use capacity left over by the current viewport's
// required tiles; otherwise they are dropped.
int test_late_result_old_version() {
  ManualLoader loader;
  TileCache cache(100, loader);

  const TileId a{3, 0, 0};
  const TileId b{3, 0, 1};
  const TileId c{3, 1, 0};
  const TileId d{3, 1, 1};

  cache.setViewport({a, b});  // v1
  const auto v1 = loader.pending();
  CHECK(v1.size() == 2);
  const std::uint64_t ha = v1[0].id == a ? v1[0].handle : v1[1].handle;
  const std::uint64_t hb = v1[0].id == b ? v1[0].handle : v1[1].handle;

  cache.setViewport({c, d});  // v2: a and b become stale
  const auto v2 = loader.pending();
  CHECK(v2.size() == 2);
  const std::uint64_t hc = v2[0].id == c ? v2[0].handle : v2[1].handle;
  const std::uint64_t hd = v2[0].id == d ? v2[0].handle : v2[1].handle;
  CHECK(loader.complete(hc, payload(40), "src://v2/c"));
  CHECK(loader.complete(hd, payload(40), "src://v2/d"));
  CHECK(cache.usedBytes() == 80);

  // Late arrival of `a` (v1, 40 bytes): only 20 bytes free and the required
  // tiles c/d are pinned, so it must be dropped, not displace them.
  CHECK(loader.complete(ha, payload(40), "src://v1/a"));
  CHECK(cache.find(a) == nullptr);
  CHECK(cache.droppedCount() == 1);
  CHECK(cache.usedBytes() == 80);
  CHECK(cache.find(c) != nullptr && cache.find(d) != nullptr);

  // Viewport v3 keeps only `c` required; `d` is demoted to evictable.
  cache.setViewport({c});
  // Late arrival of `b` (v1): fits by evicting the unpinned `d`, and is
  // stored under its original version.
  CHECK(loader.complete(hb, payload(40), "src://v1/b"));
  const Tile* tb = cache.find(b);
  CHECK(tb != nullptr);
  CHECK(tb->version == 1);
  CHECK(!tb->pinned);
  CHECK(cache.find(d) == nullptr);
  CHECK(cache.evictedCount() == 1);
  CHECK(cache.usedBytes() == 80);
  CHECK(cache.summedBytes() == cache.usedBytes());
  return g_failures;
}

// A cached parent tile substitutes for a missing descendant but is flagged
// as lacking precision; the exact tile takes over once loaded.
int test_parent_substitute() {
  ManualLoader loader;
  TileCache cache(1 << 20, loader);

  const TileId parent{2, 0, 0};
  cache.setViewport({parent});
  CHECK(loader.complete(loader.pending()[0].handle, payload(50),
                        "src://parent"));

  const TileId leaf{4, 1, 2};  // parent chain: (3,0,1) -> (2,0,0)
  ResolvedTile r = cache.resolve(leaf);
  CHECK(r.tile != nullptr);
  CHECK(!r.exact);
  CHECK(r.missing_levels == 2);
  CHECK(r.tile->id == parent);

  cache.setViewport({leaf});
  CHECK(loader.complete(loader.pending()[0].handle, payload(60),
                        "src://leaf"));
  r = cache.resolve(leaf);
  CHECK(r.tile != nullptr);
  CHECK(r.exact);
  CHECK(r.missing_levels == 0);
  CHECK(r.tile->id == leaf);

  // Nothing cached near this tile at all.
  r = cache.resolve(TileId{4, 7, 7});
  CHECK(r.tile == nullptr);
  return g_failures;
}

// LRU eviction only touches unpinned tiles, and the byte budget is
// conserved after every operation.
int test_eviction_budget_conservation() {
  ManualLoader loader;
  TileCache cache(120, loader);

  const TileId t1{3, 0, 0};
  const TileId t2{3, 0, 1};
  const TileId t3{3, 1, 0};
  const TileId t4{3, 1, 1};
  cache.setViewport({t1, t2, t3, t4});
  for (const auto& p : loader.pending()) {
    CHECK(loader.complete(p.handle, payload(30), "src://fill"));
  }
  CHECK(cache.usedBytes() == 120);
  CHECK(cache.summedBytes() == cache.usedBytes());

  // New viewport demotes t1..t4 and requires a fresh tile: the least
  // recently used unpinned tile (t1) is evicted to make room.
  const TileId t5{3, 2, 2};
  cache.setViewport({t5});
  CHECK(loader.complete(loader.pending()[0].handle, payload(30),
                        "src://t5"));
  CHECK(cache.find(t1) == nullptr);
  CHECK(cache.find(t2) != nullptr && cache.find(t5) != nullptr);
  CHECK(cache.evictedCount() == 1);
  CHECK(cache.usedBytes() == 120);
  CHECK(cache.summedBytes() == cache.usedBytes());
  CHECK(cache.usedBytes() <= cache.budget());

  // A tile larger than the whole budget can never be admitted.
  const TileId huge{3, 7, 7};
  cache.setViewport({huge});
  CHECK(loader.complete(loader.pending()[0].handle, payload(500),
                        "src://huge"));
  CHECK(cache.find(huge) == nullptr);
  CHECK(cache.droppedCount() >= 1);
  CHECK(cache.usedBytes() <= cache.budget());
  CHECK(cache.summedBytes() == cache.usedBytes());
  return g_failures;
}

// Changing the viewport cancels in-flight loads that are no longer required
// and never re-issues loads already in flight.
int test_cancellation() {
  ManualLoader loader;
  TileCache cache(1 << 20, loader);

  const TileId a{3, 0, 0};
  const TileId b{3, 0, 1};
  const TileId c{3, 1, 0};
  cache.setViewport({a, b, c});
  CHECK(loader.pending().size() == 3);
  CHECK(cache.pendingCount() == 3);

  cache.setViewport({a});
  CHECK(loader.cancelled().size() == 2);
  CHECK(loader.pending().size() == 1);
  CHECK(loader.pending()[0].id == a);
  CHECK(cache.pendingCount() == 1);
  CHECK(loader.beginCount() == 3);  // `a` was not re-issued

  // A cancelled load completing late is still classified by its old
  // version and admitted only as unpinned leftover capacity.
  const std::uint64_t zombie = loader.cancelled()[0];
  CHECK(loader.complete(zombie, payload(10), "src://late"));
  CHECK(cache.pendingCount() == 1);
  CHECK(cache.usedBytes() == 10);
  CHECK(cache.summedBytes() == cache.usedBytes());
  return g_failures;
}

// Source evidence travels with the tile and is updated on re-admission.
int test_provenance() {
  ManualLoader loader;
  TileCache cache(1 << 20, loader);

  const TileId a{3, 3, 3};
  cache.setViewport({a});
  CHECK(loader.complete(loader.pending()[0].handle, payload(16),
                        "unit-test://source/v1"));
  const Tile* t = cache.find(a);
  CHECK(t != nullptr);
  CHECK(t->provenance == "unit-test://source/v1");

  // Re-admission (e.g. refresh under a new viewport) replaces the evidence.
  cache.setViewport({a});
  cache.setViewport({});  // unpin
  cache.setViewport({a});
  CHECK(loader.beginCount() == 1);  // cached, no reload
  CHECK(cache.find(a)->provenance == "unit-test://source/v1");

  ResolvedTile r = cache.resolve(a);
  CHECK(r.exact && r.tile->provenance == "unit-test://source/v1");
  return g_failures;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: " << argv[0] << " <test-name>\n";
    return 2;
  }
  const std::string name = argv[1];
  int failures = 2;
  if (name == "viewport_requests") {
    failures = test_viewport_requests();
  } else if (name == "late_result_old_version") {
    failures = test_late_result_old_version();
  } else if (name == "parent_substitute") {
    failures = test_parent_substitute();
  } else if (name == "eviction_budget_conservation") {
    failures = test_eviction_budget_conservation();
  } else if (name == "cancellation") {
    failures = test_cancellation();
  } else if (name == "provenance") {
    failures = test_provenance();
  } else {
    std::cerr << "unknown test: " << name << '\n';
    return 2;
  }
  if (failures == 0) {
    std::cout << "PASS " << name << '\n';
  }
  return failures == 0 ? 0 : 1;
}
