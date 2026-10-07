#include "tilelib/cache.hpp"
#include "test_util.hpp"

#include <cstring>

using namespace tilelib;

static std::vector<std::byte> payload(std::size_t n) {
    return std::vector<std::byte>(n, std::byte{0xAB});
}

static void run() {
    // --- LRU eviction within the current-generation budget ---
    {
        TileCache cache(/*current_budget=*/100, /*stale_budget=*/40);
        cache.set_generation(1);
        CHECK(cache.insert(Tile{TileId{1, 0, 0}, 1, Source::Network, payload(60)}));
        CHECK(cache.insert(Tile{TileId{1, 1, 0}, 1, Source::Network, payload(60)}));
        // Second insert overflows the budget: oldest tile is evicted.
        CHECK(cache.peek(TileId{1, 0, 0}) == nullptr);
        CHECK(cache.peek(TileId{1, 1, 0}) != nullptr);
        CHECK(cache.stats().current_bytes == 60);
        CHECK(cache.stats().evicted_bytes == 60);
        CHECK(cache.stats().conserved());
    }

    // --- Oversized tile is rejected, budget untouched ---
    {
        TileCache cache(50, 20);
        cache.set_generation(1);
        CHECK(!cache.insert(Tile{TileId{2, 0, 0}, 1, Source::Network, payload(51)}));
        CHECK(cache.stats().rejected_count == 1);
        CHECK(cache.stats().admitted_bytes == 0);
        CHECK(cache.stats().conserved());
        CHECK(cache.evidence().back().kind == EvidenceKind::Reject);
    }

    // --- Late results enter the same-version cache only ---
    {
        TileCache cache(100, 50);
        cache.set_generation(1);
        CHECK(cache.insert(Tile{TileId{3, 0, 0}, 1, Source::Network, payload(20)}));
        CHECK(cache.insert(Tile{TileId{3, 1, 0}, 1, Source::Network, payload(20)}));
        cache.set_generation(2); // viewport moved on; gen-1 bytes demoted
        CHECK(cache.stats().current_bytes == 0);
        CHECK(cache.stats().stale_bytes == 40);

        // Late gen-1 arrival: confined to the stale pool, must not occupy the
        // new viewport's required capacity. LRU trim evicts one 20-byte tile.
        CHECK(cache.insert(Tile{TileId{3, 2, 0}, 1, Source::Network, payload(30)}));
        CHECK(cache.stats().current_bytes == 0);
        CHECK(cache.stats().stale_bytes == 50);
        CHECK(cache.stats().evicted_bytes == 20);
        CHECK(cache.evidence().back().kind == EvidenceKind::LateAdmit);

        // New-generation tiles get the full required capacity regardless.
        CHECK(cache.insert(Tile{TileId{3, 3, 0}, 2, Source::Network, payload(100)}));
        CHECK(cache.stats().current_bytes == 100);
        CHECK(cache.stats().conserved());
    }

    // --- Parent substitution is flagged precision-deficient ---
    {
        TileCache cache(1000, 1000);
        cache.set_generation(1);
        cache.insert(Tile{TileId{2, 1, 1}, 1, Source::Network, payload(10)});
        cache.insert(Tile{TileId{3, 2, 2}, 1, Source::Disk, payload(10)});

        auto slots = cache.render_set({TileId{3, 2, 2}, TileId{4, 6, 6}, TileId{4, 15, 15}});
        CHECK(slots.size() == 3);
        // Exact hit: full precision.
        CHECK(!slots[0].approximate);
        CHECK(slots[0].used == TileId(3, 2, 2));
        CHECK(slots[0].source == Source::Disk);
        // Parent substitute: allowed, but marked as lacking precision.
        CHECK(slots[1].approximate);
        CHECK(slots[1].used == TileId(2, 1, 1));
        CHECK(slots[1].source == Source::ParentSubstitute);
        // No ancestor cached: still flagged, no usable substitute.
        CHECK(slots[2].approximate);
        CHECK(slots[2].used == TileId(4, 15, 15));
        CHECK(cache.stats().conserved());
    }

    // --- Eviction callback fires for the loader to acknowledge ---
    {
        TileCache cache(10, 10);
        cache.set_generation(1);
        int calls = 0;
        TileId last{};
        cache.set_evict_callback([&](const Tile& t) { ++calls; last = t.id; });
        cache.insert(Tile{TileId{1, 0, 0}, 1, Source::Network, payload(8)});
        cache.insert(Tile{TileId{1, 1, 0}, 1, Source::Network, payload(8)});
        CHECK(calls == 1);
        CHECK(last == TileId(1, 0, 0));
        CHECK(cache.stats().conserved());
    }
}

TEST_MAIN()
