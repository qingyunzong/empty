#include "spatial/index.hpp"

#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>

#include "test_framework.hpp"

using Index = spatial::SpatialIndex<2>;
using Box2 = spatial::Box<2>;

// A writer publishes 300 generations of 64-box batches while readers
// continuously open views. Every view must observe exactly one complete
// generation (batch atomicity) and reclamation runs concurrently.
TF_TEST(concurrent_readers_observe_atomic_batches) {
    constexpr std::uint64_t kIds = 64;
    constexpr int kGenerations = 300;

    Index idx;
    std::vector<Index::Op> gen0;
    for (std::uint64_t i = 0; i < kIds; ++i)
        gen0.push_back(Index::Upsert{i, Box2{{0.0, static_cast<double>(i)},
                                             {1.0, static_cast<double>(i) + 1.0}}});
    idx.commit(gen0);

    std::atomic<bool> stop{false};
    std::atomic<int> violations{0};
    const Box2 everything{{-1e9, -1e9}, {1e9, 1e9}};

    auto reader_fn = [&] {
        while (!stop.load(std::memory_order_relaxed)) {
            auto view = idx.open_view();
            // Generation g places every box at x in [g, g+1): adjacent
            // generations only touch, so a mixed view would be detectable.
            double generation = -1.0;
            std::size_t count = 0;
            view.query(everything, [&](std::uint64_t, const Box2& b) {
                ++count;
                if (generation < 0.0) {
                    generation = b.min[0];
                } else if (b.min[0] != generation) {
                    ++violations;  // torn batch: mixed generations
                }
            });
            if (count != kIds) ++violations;
        }
    };

    std::vector<std::thread> readers;
    for (int i = 0; i < 4; ++i) readers.emplace_back(reader_fn);

    for (int g = 1; g <= kGenerations; ++g) {
        std::vector<Index::Op> batch;
        batch.reserve(kIds);
        for (std::uint64_t i = 0; i < kIds; ++i)
            batch.push_back(Index::Upsert{i, Box2{{static_cast<double>(g),
                                                   static_cast<double>(i)},
                                                  {static_cast<double>(g) + 1.0,
                                                   static_cast<double>(i) + 1.0}}});
        idx.commit(batch);  // also drives epoch advance + reclamation
    }
    stop.store(true);
    for (auto& t : readers) t.join();

    CHECK_EQ(violations.load(), 0);
    idx.collect();
    CHECK(Index::live_snapshot_count() <= 2);
}

TF_MAIN()
