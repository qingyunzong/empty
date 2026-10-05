#include "test_util.hpp"

using namespace spatial;

// Old snapshots must keep serving pre-publish results after batch moves are
// atomically published.
int main() {
    std::mt19937_64 rng(7);
    constexpr std::int64_t lo = -500, hi = 500;

    SpatialDb db(randomWorld(rng, 80, lo, hi, 30));
    auto snap1 = db.snapshot();

    // Record pre-publish query results on the old snapshot.
    std::vector<Ray> rays;
    std::vector<QueryResult> before;
    for (int i = 0; i < 40; ++i) {
        rays.push_back(randomRay(rng, snap1->objects(), lo - 100, hi + 100));
        before.push_back(snap1->query(rays.back()));
    }

    // Publish a batch that teleports every object far away, atomically.
    std::vector<std::pair<ObjectId, Aabb>> moves;
    for (const auto& [id, box] : snap1->objects()) {
        Aabb shifted = box;
        for (int a = 0; a < 3; ++a) {
            shifted.min[a] += 100000;
            shifted.max[a] += 100000;
        }
        moves.emplace_back(id, shifted);
    }
    db.applyBatch(moves);

    auto snap2 = db.snapshot();
    CHECK(snap2 != snap1);

    // The new snapshot reflects the whole batch at once.
    for (const auto& [id, box] : snap2->objects()) {
        for (int a = 0; a < 3; ++a) CHECK(box.min[a] >= 100000 + lo);
    }

    // The old snapshot is untouched: identical candidates, hits, and objects.
    CHECK(snap1->objects().size() == 80);
    for (std::size_t i = 0; i < rays.size(); ++i) {
        QueryResult after = snap1->query(rays[i]);
        CHECK(after.candidates == before[i].candidates);
        CHECK(after.hits == before[i].hits);
        CHECK(after.hits == bruteForceHits(*snap1, rays[i]));
    }

    // Rays into the old region hit nothing on the new snapshot.
    for (const Ray& ray : rays) {
        QueryResult res = snap2->query(ray);
        CHECK(res.hits.empty());
        CHECK(res.hits == bruteForceHits(*snap2, ray));
    }

    std::puts("test_snapshot: OK");
    return 0;
}
