// Index behaviour: queries, zero-volume handling, snapshot isolation under
// removal and id reuse, and atomic visibility of batch moves.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

#include "spatial/index.hpp"
#include "test_util.hpp"

using spatial::Aabb2;
using spatial::Batch;
using spatial::SpatialIndex;

static bool has(const std::vector<std::uint64_t>& v, std::uint64_t id) {
    return std::binary_search(v.begin(), v.end(), id);
}

static void test_basic_and_zero_volume() {
    SpatialIndex idx(/*cell_size=*/1.0);
    Batch b;
    b.upserts = {{1, Aabb2{{0.0, 0.0}, {1.0, 1.0}}},
                 {2, Aabb2{{5.0, 5.0}, {6.0, 6.0}}},
                 {3, Aabb2{{0.0, 0.0}, {0.0, 4.0}}},   // zero width: ignored
                 {4, Aabb2{{2.0, 2.0}, {2.0, 2.0}}}};  // zero area: ignored
    idx.apply(b);

    auto snap = idx.snapshot();
    CHECK(snap->size() == 2);

    auto hits = snap->query(Aabb2{{0.5, 0.5}, {0.75, 0.75}});
    CHECK(hits.size() == 1 && has(hits, 1));

    // Query touching box 1 only at its exclusive max edge: no hit.
    CHECK(snap->query(Aabb2{{1.0, 0.0}, {2.0, 1.0}}).empty());

    // Zero-volume query box matches nothing.
    CHECK(snap->query(Aabb2{{0.5, 0.5}, {0.5, 0.5}}).empty());

    // Whole-space query finds both live objects, never the ignored ones.
    auto all = snap->query(Aabb2{{-100.0, -100.0}, {100.0, 100.0}});
    CHECK(all.size() == 2 && has(all, 1) && has(all, 2));

    // Moving an object to a zero-volume box is ignored: it keeps its box.
    Batch mv;
    mv.upserts = {{1, Aabb2{{9.0, 9.0}, {9.0, 10.0}}}};
    idx.apply(mv);
    auto after = idx.snapshot();
    CHECK(after->size() == 2);
    CHECK(has(after->query(Aabb2{{0.0, 0.0}, {0.5, 0.5}}), 1));
}

static void test_snapshot_isolation_and_id_reuse() {
    SpatialIndex idx(1.0);
    Batch b;
    b.upserts = {{1, Aabb2{{0.0, 0.0}, {1.0, 1.0}}},
                 {2, Aabb2{{10.0, 10.0}, {11.0, 11.0}}}};
    idx.apply(b);
    auto old = idx.snapshot();

    // Remove id 2, reuse id 1 at a new location, add id 3.
    Batch b2;
    b2.removes = {2};
    b2.upserts = {{1, Aabb2{{50.0, 50.0}, {51.0, 51.0}}},
                  {3, Aabb2{{20.0, 20.0}, {21.0, 21.0}}}};
    idx.apply(b2);

    // Old view is untouched: id 1 at the origin, id 2 still present, no id 3.
    CHECK(old->size() == 2);
    CHECK(has(old->query(Aabb2{{0.0, 0.0}, {0.5, 0.5}}), 1));
    CHECK(old->query(Aabb2{{50.0, 50.0}, {50.5, 50.5}}).empty());
    CHECK(has(old->query(Aabb2{{10.0, 10.0}, {10.5, 10.5}}), 2));
    CHECK(old->query(Aabb2{{20.0, 20.0}, {20.5, 20.5}}).empty());

    // New view reflects removal, reuse and insertion.
    auto cur = idx.snapshot();
    CHECK(cur->size() == 2);
    CHECK(cur->query(Aabb2{{0.0, 0.0}, {0.5, 0.5}}).empty());
    CHECK(has(cur->query(Aabb2{{50.0, 50.0}, {50.5, 50.5}}), 1));
    CHECK(cur->query(Aabb2{{10.0, 10.0}, {10.5, 10.5}}).empty());
    CHECK(has(cur->query(Aabb2{{20.0, 20.0}, {20.5, 20.5}}), 3));
}

static void test_atomic_batch_move() {
    constexpr std::uint64_t kObjects = 8;
    SpatialIndex idx(1.0);

    auto positions = [](double base) {
        Batch b;
        for (std::uint64_t i = 0; i < kObjects; ++i) {
            const double x = base + static_cast<double>(i) * 2.0;
            b.upserts.push_back({i + 1, Aabb2{{x, 0.0}, {x + 1.0, 1.0}}});
        }
        return b;
    };
    idx.apply(positions(0.0));

    std::atomic<bool> stop{false};
    std::atomic<std::uint64_t> violations{0};
    const Aabb2 world{{-1000.0, -1000.0}, {2000.0, 2000.0}};

    // Readers: every snapshot must show ALL objects in region A or ALL in
    // region B; a mix means a partially applied batch was observed.
    std::vector<std::thread> readers;
    for (int t = 0; t < 4; ++t) {
        readers.emplace_back([&] {
            while (!stop.load(std::memory_order_relaxed)) {
                auto snap = idx.snapshot();
                int in_a = 0, in_b = 0;
                for (const auto& e : snap->entries()) {
                    if (e.box.min[0] < 500.0) ++in_a; else ++in_b;
                }
                if (in_a != 0 && in_b != 0)
                    violations.fetch_add(1, std::memory_order_relaxed);
                if (snap->query(world).size() != kObjects)
                    violations.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    std::thread writer([&] {
        for (int i = 0; i < 2000; ++i) {
            idx.apply(positions(i % 2 == 0 ? 0.0 : 1000.0));
        }
        stop.store(true, std::memory_order_relaxed);
    });

    writer.join();
    for (auto& r : readers) r.join();
    CHECK(violations.load() == 0);
}

int main() {
    test_basic_and_zero_volume();
    test_snapshot_isolation_and_id_reuse();
    test_atomic_batch_move();
    return test::summary("test_index");
}
