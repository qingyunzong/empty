#include "tilelib/loader.hpp"
#include "test_util.hpp"

using namespace tilelib;

static std::vector<std::byte> payload(std::size_t n) {
    return std::vector<std::byte>(n, std::byte{0xCD});
}

static void run() {
    // --- Viewport-driven requests, pumped on demand ---
    {
        TileCache cache(1000, 500);
        TileLoader loader(cache, [](TileId id) { return payload(10 + id.z); });
        Viewport v{1, 2, 3, 0, 0, 1, 1}; // z2: 1 tile, z3: 4 tiles
        loader.set_viewport(v);
        CHECK(loader.pending_count() == 5);
        CHECK(loader.pump(2) == 2);
        CHECK(loader.pending_count() == 3);
        CHECK(cache.stats().current_count == 2);
        loader.pump();
        CHECK(loader.pending_count() == 0);
        CHECK(cache.stats().current_count == 5);
        CHECK(cache.stats().conserved());
    }

    // --- Cancellation: byte-neutral, recorded as evidence ---
    {
        TileCache cache(1000, 500);
        TileLoader loader(cache, [](TileId) { return payload(10); });
        loader.set_viewport(Viewport{1, 3, 3, 0, 0, 3, 0}); // 4 tiles
        CHECK(loader.cancel(TileId{3, 1, 0}));
        CHECK(loader.cancelled_count() == 1);
        CHECK(!loader.cancel(TileId{3, 1, 0})); // already gone
        loader.pump();
        CHECK(cache.stats().current_count == 3);
        CHECK(cache.peek(TileId{3, 1, 0}) == nullptr);
        CHECK(cache.stats().admitted_bytes == 30);
        CHECK(cache.stats().conserved());
        // A late reply for the cancelled tile is dropped, not admitted.
        loader.deliver_late(TileId{3, 1, 0}, 1, payload(10));
        CHECK(cache.peek(TileId{3, 1, 0}) == nullptr);
        CHECK(cache.stats().admitted_bytes == 30);
        CHECK(cache.stats().conserved());
    }

    // --- Viewport switch: in-flight old requests land in same-version cache ---
    {
        TileCache cache(1000, 500);
        TileLoader loader(cache, [](TileId) { return payload(40); });
        loader.set_viewport(Viewport{1, 3, 3, 0, 0, 1, 0}); // gen 1, 2 tiles
        loader.set_viewport(Viewport{2, 3, 3, 4, 0, 5, 0}); // gen 2, 2 tiles
        CHECK(loader.pending_count() == 4);
        loader.pump();
        // Gen-1 completions are late: stale pool only, required capacity free.
        CHECK(cache.stats().current_count == 2);
        CHECK(cache.stats().stale_count == 2);
        CHECK(cache.stats().current_bytes == 80);
        CHECK(cache.stats().stale_bytes == 80);
        CHECK(cache.stats().conserved());
    }

    // --- Loader acknowledges evictions from the cache ---
    {
        TileCache cache(50, 500);
        TileLoader loader(cache, [](TileId) { return payload(30); });
        loader.set_viewport(Viewport{1, 3, 3, 0, 0, 2, 0}); // 3 tiles x 30B > 50B
        loader.pump();
        CHECK(loader.evicted().size() == 2);
        CHECK(loader.evicted().front() == TileId(3, 0, 0)); // oldest first
        CHECK(cache.stats().current_bytes == 30);
        CHECK(cache.stats().evicted_bytes == 60);
        CHECK(cache.stats().conserved());
        // Loader-side evidence mirrors the cache-side eviction evidence.
        std::size_t loader_evicts = 0, cache_evicts = 0;
        for (const auto& e : loader.evidence())
            if (e.kind == EvidenceKind::Evict) ++loader_evicts;
        for (const auto& e : cache.evidence())
            if (e.kind == EvidenceKind::Evict) ++cache_evicts;
        CHECK(loader_evicts == cache_evicts);
    }

    // --- Parent substitution through the loader-populated cache ---
    {
        TileCache cache(1000, 500);
        TileLoader loader(cache, [](TileId) { return payload(10); });
        loader.set_viewport(Viewport{1, 2, 2, 1, 1, 1, 1}); // only the parent
        loader.pump();
        auto slots = cache.render_set({TileId{3, 2, 2}, TileId{3, 3, 3}});
        CHECK(slots[0].approximate);
        CHECK(slots[0].used == TileId(2, 1, 1));
        CHECK(slots[0].source == Source::ParentSubstitute);
        CHECK(slots[1].approximate);
        CHECK(cache.stats().conserved());
    }
}

TEST_MAIN()
