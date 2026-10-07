// Byte-budget conservation and source-evidence audit across a long,
// deterministic mixed workload: viewport switches, pumps, cancellations,
// late deliveries, evictions and rejections.
#include "tilelib/loader.hpp"
#include "test_util.hpp"

#include <cstdint>

using namespace tilelib;

static std::uint64_t admitted_from_evidence(const TileCache& c) {
    std::uint64_t n = 0;
    for (const auto& e : c.evidence())
        if (e.kind == EvidenceKind::Admit || e.kind == EvidenceKind::LateAdmit) n += e.bytes;
    return n;
}

static std::uint64_t evicted_from_evidence(const TileCache& c) {
    std::uint64_t n = 0;
    for (const auto& e : c.evidence())
        if (e.kind == EvidenceKind::Evict) n += e.bytes;
    return n;
}

static void run() {
    TileCache cache(/*current_budget=*/256, /*stale_budget=*/128);
    std::uint64_t fetch_calls = 0;
    TileLoader loader(cache, [&](TileId id) {
        ++fetch_calls;
        // Deterministic pseudo-varied sizes, occasionally oversized.
        std::size_t n = 8 + ((id.x * 31 + id.y * 17 + id.z * 13) % 48);
        if ((id.x + id.y) % 11 == 0) n = 400; // exceeds both budgets -> reject
        return std::vector<std::byte>(n, std::byte{0x5A});
    });

    std::uint64_t gen = 0;
    for (int step = 0; step < 60; ++step) {
        switch (step % 4) {
            case 0: { // jump the viewport somewhere deterministic
                ++gen;
                std::uint32_t base = static_cast<std::uint32_t>(step * 3);
                loader.set_viewport(Viewport{gen, 2, 4, base, base, base + 2, base + 1});
                break;
            }
            case 1: // partial pump, then cancel one pending request
                loader.pump(3);
                if (loader.pending_count() > 0) {
                    // Cancel a tile that the previous viewport switch queued.
                    const std::uint32_t prev = static_cast<std::uint32_t>((step - 1) * 3);
                    loader.cancel(TileId{4, prev + 1, prev});
                }
                break;
            case 2: // a late reply from two generations ago
                loader.deliver_late(TileId{3, static_cast<std::uint32_t>(step), 1},
                                    gen >= 2 ? gen - 2 : gen,
                                    std::vector<std::byte>(24, std::byte{0x11}),
                                    Source::Disk);
                break;
            case 3: // drain everything outstanding
                loader.pump();
                break;
        }
        CHECK(cache.stats().conserved());
    }

    const CacheStats& s = cache.stats();
    CHECK(s.conserved());
    CHECK(s.evicted_count > 0);        // workload really caused evictions
    CHECK(s.rejected_count > 0);       // ... and rejections
    CHECK(loader.cancelled_count() > 0); // ... and cancellations
    CHECK(fetch_calls > 0);

    // Source evidence must reconcile exactly with the byte budget:
    // admitted == live + evicted, and every byte is traceable in the log.
    CHECK(admitted_from_evidence(cache) == s.admitted_bytes);
    CHECK(evicted_from_evidence(cache) == s.evicted_bytes);
    CHECK(s.current_bytes + s.stale_bytes + s.evicted_bytes == s.admitted_bytes);

    // Every live tile carries source evidence.
    for (const auto& slot : cache.render_set(required_tiles(Viewport{gen, 2, 4, 0, 0, 3, 3}))) {
        if (!slot.approximate) CHECK(cache.peek(slot.used) != nullptr);
    }
}

TEST_MAIN()
