// Randomized differential test: the grid index must agree with a
// brute-force full-scan model after every batch of random mutations,
// including removals and id reuse.
#include <algorithm>
#include <map>
#include <random>
#include <vector>

#include "spatial/index.hpp"
#include "test_util.hpp"

using spatial::Aabb2;
using spatial::Batch;
using spatial::SpatialIndex;

int main() {
    std::mt19937_64 rng(0x5eedu);
    std::uniform_real_distribution<double> coord(-50.0, 50.0);
    std::uniform_real_distribution<double> extent(0.01, 8.0);
    std::uniform_int_distribution<std::uint64_t> id_pick(1, 40);
    std::uniform_int_distribution<int> op_pick(0, 2);

    SpatialIndex idx(/*cell_size=*/3.0);
    std::map<std::uint64_t, Aabb2> model;

    auto random_box = [&]() {
        const double x = coord(rng), y = coord(rng);
        return Aabb2{{x, y}, {x + extent(rng), y + extent(rng)}};
    };

    auto full_scan = [&](const Aabb2& q) {
        std::vector<std::uint64_t> out;
        if (!q.empty()) {
            for (const auto& [id, box] : model) {
                if (box.intersects(q)) out.push_back(id);
            }
        }
        return out;  // std::map iteration order is sorted by id
    };

    constexpr int kRounds = 400;
    for (int round = 0; round < kRounds; ++round) {
        Batch b;
        const int ops = 1 + static_cast<int>(rng() % 6);
        for (int i = 0; i < ops; ++i) {
            const std::uint64_t id = id_pick(rng);
            switch (op_pick(rng)) {
                case 0:
                    b.removes.push_back(id);
                    break;
                case 1:
                    b.upserts.push_back({id, random_box()});
                    break;
                default:  // zero-volume upsert: ignored by index and model
                    b.upserts.push_back(
                        {id, Aabb2{{coord(rng), coord(rng)}, {0.0, 0.0}}});
                    b.upserts.back().second.max = b.upserts.back().second.min;
                    break;
            }
        }
        idx.apply(b);

        // Replay the batch against the model with identical semantics.
        for (std::uint64_t id : b.removes) model.erase(id);
        for (const auto& [id, box] : b.upserts) {
            if (!box.empty()) model[id] = box;
        }

        auto snap = idx.snapshot();
        CHECK(snap->size() == model.size());

        for (int q = 0; q < 10; ++q) {
            const Aabb2 query_box = random_box();
            CHECK(snap->query(query_box) == full_scan(query_box));
        }
        // Also probe with boxes snapped to cell boundaries, where
        // half-open edge cases live.
        for (int q = 0; q < 10; ++q) {
            const double x = std::floor(coord(rng));
            const double y = std::floor(coord(rng));
            const Aabb2 query_box{{x, y}, {x + 3.0, y + 3.0}};
            CHECK(snap->query(query_box) == full_scan(query_box));
        }
    }

    return test::summary("test_model_check");
}
