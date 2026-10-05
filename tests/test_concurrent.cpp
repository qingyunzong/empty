// Concurrency smoke test: readers query acquired snapshots while the writer
// keeps publishing batch moves. Every acquired snapshot must be
// self-consistent (tree query == brute-force scan of that same snapshot).
#include <atomic>
#include <cstdint>
#include <random>
#include <thread>
#include <vector>

#include "../tests/check.hpp"
#include "spatial/space.hpp"

using spatial::Aabb;
using spatial::ObjectId;
using spatial::QueryResult;
using spatial::Ray;
using spatial::Space;
using spatial::make_rational;

namespace {
std::atomic<bool> stop{false};
std::atomic<std::int64_t> queries{0};
std::atomic<std::int64_t> mismatches{0};

Aabb box_at(std::int64_t x, std::int64_t y, std::int64_t z,
            std::int64_t size) {
  return {{x, y, z}, {x + size, y + size, z + size}};
}
}  // namespace

int main() {
  constexpr int kObjects = 128;
  Space space;
  std::vector<ObjectId> ids;
  for (int i = 0; i < kObjects; ++i)
    ids.push_back(space.add(box_at(i * 20 - 1000, (i % 7) * 30 - 90,
                                   (i % 5) * 40 - 80, 8)));

  auto reader = [&](std::uint64_t seed) {
    std::mt19937_64 rng(seed);
    while (!stop.load(std::memory_order_relaxed)) {
      auto snap = space.snapshot();
      Ray ray;
      for (int i = 0; i < 3; ++i) {
        ray.origin[i] = (std::int64_t)(rng() % 4001) - 2000;
        ray.dir[i] = (std::int64_t)(rng() % 15) - 7;
      }
      if (ray.dir[0] == 0 && ray.dir[1] == 0 && ray.dir[2] == 0)
        ray.dir[0] = 1;
      const spatial::Rational t_max = make_rational(1 << 16, 1);
      const QueryResult qr = snap->query_ray(ray, t_max);
      const auto ref = snap->scan_ray(ray, t_max);
      bool ok = qr.hits.size() == ref.size();
      for (std::size_t i = 0; ok && i < ref.size(); ++i)
        ok = qr.hits[i].id == ref[i].id && qr.hits[i].t_enter == ref[i].t_enter;
      if (!ok)
        ++mismatches;
      else
        ++queries;
    }
  };

  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t) threads.emplace_back(reader, 0xabc0 + t);

  for (int round = 0; round < 300; ++round) {
    std::vector<std::pair<ObjectId, Aabb>> moves;
    for (int m = 0; m < 16; ++m) {
      const ObjectId id = ids[(round * 16 + m) % kObjects];
      moves.emplace_back(
          id, box_at((round * 37 + m * 11) % 2000 - 1000,
                     (round * 13 + m * 29) % 400 - 200,
                     (round * 7 + m * 17) % 600 - 300, 4 + m % 12));
    }
    space.move_batch(moves);
  }

  stop.store(true);
  for (auto& t : threads) t.join();

  std::cout << "concurrent: consistent_queries=" << queries.load()
            << " mismatches=" << mismatches.load() << '\n';
  CHECK(queries.load() > 0);
  CHECK(mismatches.load() == 0);
  return testutil::finish("test_concurrent");
}
