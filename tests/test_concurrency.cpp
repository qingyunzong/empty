#include "test_util.hpp"

#include <atomic>
#include <thread>

using namespace spatial;

// One writer publishes batches while readers concurrently grab snapshots and
// validate each snapshot against the brute-force scan. Any torn publish
// would show up as a mismatch.
int main() {
    std::mt19937_64 rng(1234);
    constexpr std::int64_t lo = -800, hi = 800;

    SpatialDb db(randomWorld(rng, 200, lo, hi, 50));

    std::atomic<bool> stop{false};
    std::atomic<int> errors{0};
    std::atomic<std::size_t> checks{0};

    auto reader = [&](std::uint64_t seed) {
        std::mt19937_64 local(seed);
        while (!stop.load(std::memory_order_relaxed)) {
            auto snap = db.snapshot();
            for (int q = 0; q < 10; ++q) {
                Ray ray = randomRay(local, snap->objects(), lo - 100, hi + 100);
                QueryResult res = snap->query(ray);
                if (res.hits != bruteForceHits(*snap, ray))
                    errors.fetch_add(1, std::memory_order_relaxed);
                for (ObjectId id : res.hits)
                    if (!contains(res.candidates, id))
                        errors.fetch_add(1, std::memory_order_relaxed);
                checks.fetch_add(1, std::memory_order_relaxed);
            }
        }
    };

    std::vector<std::thread> threads;
    for (int i = 0; i < 4; ++i) threads.emplace_back(reader, 9000 + i);

    std::mt19937_64 moveRng(555);
    std::uniform_int_distribution<ObjectId> pickObj(0, 199);
    for (int batch = 0; batch < 150; ++batch) {
        auto moves = randomWorld(moveRng, 8, lo, hi, 50);
        for (auto& [id, box] : moves) id = pickObj(moveRng);
        db.applyBatch(moves);
    }

    stop.store(true, std::memory_order_relaxed);
    for (auto& t : threads) t.join();

    CHECK(errors.load() == 0);
    std::printf("test_concurrency: OK (%zu snapshot validations, 0 errors)\n",
                checks.load());
    return 0;
}
