// Barrier reclamation: retired snapshots survive until a reclamation
// barrier, and readers holding references keep snapshots alive past it.
#include <barrier>
#include <memory>
#include <thread>
#include <vector>

#include "spatial/index.hpp"
#include "test_util.hpp"

using spatial::Aabb2;
using spatial::Batch;
using spatial::SpatialIndex;

static Batch put(std::uint64_t id, double x) {
    Batch b;
    b.upserts = {{id, Aabb2{{x, 0.0}, {x + 1.0, 1.0}}}};
    return b;
}

int main() {
    SpatialIndex idx(1.0);
    idx.apply(put(1, 0.0));

    // Take a snapshot, then replace it; the old one is retired.
    std::weak_ptr<const spatial::Snapshot> retired_weak;
    std::shared_ptr<const spatial::Snapshot> held;
    {
        auto snap = idx.snapshot();
        held = snap;  // a reader still holding the old view
        idx.apply(put(1, 100.0));
        retired_weak = snap;
    }

    // Retired but not yet reclaimed: the reclaimer keeps retired snapshots
    // alive (the initial empty snapshot plus the one we replaced).
    CHECK(idx.reclaimer().retired_count() == 2);
    {
        auto still_alive = idx.snapshot();
        (void)still_alive;
    }
    CHECK(!retired_weak.expired());

    // Multi-threaded quiescent barrier: all threads rendezvous, then the
    // reclaimer drops its references.
    constexpr int kThreads = 4;
    std::barrier sync(kThreads + 1);
    std::vector<std::thread> pool;
    for (int i = 0; i < kThreads; ++i) {
        pool.emplace_back([&] {
            // Each worker queries the current snapshot, then reaches its
            // quiescent point.
            auto s = idx.snapshot();
            CHECK(s->size() == 1);
            sync.arrive_and_wait();
        });
    }
    sync.arrive_and_wait();  // all threads are quiescent now
    idx.reclaimer().reclaim_barrier();
    for (auto& t : pool) t.join();

    CHECK(idx.reclaimer().retired_count() == 0);
    // Our `held` reference keeps the snapshot itself alive...
    CHECK(!retired_weak.expired());
    CHECK(held->size() == 1);
    CHECK(held->query(Aabb2{{0.0, 0.0}, {0.5, 0.5}}).size() == 1);

    // ...and once the last reader drops it, it is really gone.
    held.reset();
    CHECK(retired_weak.expired());

    // A second retire + barrier cycle with no outstanding readers reclaims
    // immediately.
    std::weak_ptr<const spatial::Snapshot> second;
    {
        auto s = idx.snapshot();
        second = s;
        idx.apply(put(2, 200.0));
    }
    CHECK(idx.reclaimer().retired_count() == 1);
    idx.reclaimer().reclaim_barrier();
    CHECK(second.expired());

    return test::summary("test_reclaimer");
}
