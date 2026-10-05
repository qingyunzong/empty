// Randomized differential test: random batch moves are atomically published,
// then tree queries are checked against a brute-force scan of every object.
#include <algorithm>
#include <cstdint>
#include <random>
#include <vector>

#include "../tests/check.hpp"
#include "spatial/space.hpp"

using spatial::Aabb;
using spatial::Hit;
using spatial::ObjectId;
using spatial::QueryResult;
using spatial::Ray;
using spatial::Space;
using spatial::make_rational;

namespace {

std::mt19937_64 rng(0x5eedu);

std::int64_t rand_coord(std::int64_t lo, std::int64_t hi) {
  return std::uniform_int_distribution<std::int64_t>(lo, hi)(rng);
}

Aabb random_box() {
  Aabb b;
  for (int i = 0; i < 3; ++i) {
    const std::int64_t a = rand_coord(-1000, 1000);
    const std::int64_t c = rand_coord(-1000, 1000);
    b.lo[i] = std::min(a, c);
    b.hi[i] = std::max(a, c);
  }
  return b;
}

Ray random_ray() {
  Ray r;
  for (int i = 0; i < 3; ++i) {
    r.origin[i] = rand_coord(-1200, 1200);
    // Mix in zero components so parallel-ray paths are exercised.
    r.dir[i] = rand_coord(0, 4) == 0 ? 0 : rand_coord(-7, 7);
  }
  if (r.dir[0] == 0 && r.dir[1] == 0 && r.dir[2] == 0) r.dir[0] = 1;
  return r;
}

bool same_hits(const std::vector<Hit>& a, const std::vector<Hit>& b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i)
    if (a[i].id != b[i].id || a[i].t_enter != b[i].t_enter ||
        a[i].t_exit != b[i].t_exit)
      return false;
  return true;
}

}  // namespace

int main() {
  constexpr int kObjects = 200;
  constexpr int kRounds = 50;
  constexpr int kMovesPerRound = 20;
  constexpr int kRaysPerRound = 30;

  Space space;
  std::vector<ObjectId> ids;
  for (int i = 0; i < kObjects; ++i) ids.push_back(space.add(random_box()));

  std::int64_t total_hits = 0;
  std::int64_t total_candidates = 0;

  for (int round = 0; round < kRounds; ++round) {
    std::vector<std::pair<ObjectId, Aabb>> moves;
    for (int m = 0; m < kMovesPerRound; ++m) {
      const ObjectId id = ids[rand_coord(0, kObjects - 1)];
      moves.emplace_back(id, random_box());
    }
    space.move_batch(moves);

    auto snap = space.snapshot();
    CHECK((std::int64_t)snap->size() == kObjects);

    for (int q = 0; q < kRaysPerRound; ++q) {
      const Ray ray = random_ray();
      const spatial::Rational t_max =
          make_rational(rand_coord(1, 1 << 20), rand_coord(1, 64));

      const QueryResult qr = snap->query_ray(ray, t_max);
      const std::vector<Hit> ref = snap->scan_ray(ray, t_max);

      // Tree hits must equal the brute-force scan exactly (ids and t).
      CHECK(same_hits(qr.hits, ref));

      // Candidates must be a superset of hits, with no duplicates.
      CHECK(std::is_sorted(qr.candidates.begin(), qr.candidates.end()));
      CHECK(std::adjacent_find(qr.candidates.begin(), qr.candidates.end()) ==
            qr.candidates.end());
      for (const Hit& h : qr.hits)
        CHECK(std::binary_search(qr.candidates.begin(), qr.candidates.end(),
                                 h.id));

      // Hits must be sorted by (t_enter, id).
      CHECK(std::is_sorted(qr.hits.begin(), qr.hits.end(),
                           spatial::hit_less));

      total_hits += (std::int64_t)qr.hits.size();
      total_candidates += (std::int64_t)qr.candidates.size();
    }
  }

  std::cout << "random differential: rounds=" << kRounds
            << " rays=" << kRounds * kRaysPerRound
            << " total_candidates=" << total_candidates
            << " total_hits=" << total_hits << '\n';
  CHECK(total_hits > 0);  // the workload must actually exercise hits
  return testutil::finish("test_tree_scan");
}
