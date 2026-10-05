#include "test_util.hpp"

using namespace spatial;

// Cross-checks tree queries against a full-object brute-force scan after
// every random batch of moves.
int main() {
    std::mt19937_64 rng(42);
    constexpr std::int64_t lo = -1000, hi = 1000;

    SpatialDb db(randomWorld(rng, 300, lo, hi, 40));

    std::uniform_int_distribution<std::size_t> moveCount(1, 20);
    std::uniform_int_distribution<ObjectId> pickObj(0, 299);

    std::size_t raysTested = 0, totalHits = 0;
    for (int batch = 0; batch < 40; ++batch) {
        std::vector<std::pair<ObjectId, Aabb>> moves;
        auto moved = randomWorld(rng, moveCount(rng), lo, hi, 40);
        for (auto& [id, box] : moved) {
            id = pickObj(rng);
            moves.push_back({id, box});
        }
        db.applyBatch(moves);

        auto snap = db.snapshot();
        for (int q = 0; q < 60; ++q) {
            Ray ray = randomRay(rng, snap->objects(), lo - 200, hi + 200);
            QueryResult res = snap->query(ray);
            std::vector<ObjectId> expected = bruteForceHits(*snap, ray);

            // Narrow-phase hits must exactly match the full scan.
            CHECK(res.hits == expected);
            // Broad-phase candidates must be a superset of the hits.
            for (ObjectId id : expected) CHECK(contains(res.candidates, id));

            ++raysTested;
            totalHits += res.hits.size();
        }
    }

    std::printf("test_tree_vs_scan: OK (%zu rays, %zu total hits)\n", raysTested,
                totalHits);
    CHECK(totalHits > 0); // sanity: the random world actually produces hits
    return 0;
}
