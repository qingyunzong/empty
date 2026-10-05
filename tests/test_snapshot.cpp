// Snapshot retention and atomic batch publication.
#include <vector>

#include "../tests/check.hpp"
#include "spatial/space.hpp"

using spatial::Aabb;
using spatial::ObjectId;
using spatial::QueryResult;
using spatial::Ray;
using spatial::Space;
using spatial::make_rational;

static const spatial::Rational kInf = make_rational(INT64_C(1) << 60, 1);

int main() {
  Space space;
  const ObjectId a = space.add(Aabb{{0, 0, 0}, {10, 10, 10}});
  const ObjectId b = space.add(Aabb{{100, 0, 0}, {110, 10, 10}});

  const Ray ray{{-50, 5, 5}, {1, 0, 0}};

  auto s1 = space.snapshot();
  const QueryResult before = s1->query_ray(ray, kInf);
  CHECK(before.hits.size() == 2);
  CHECK(before.hits[0].id == a);
  CHECK(before.hits[0].t_enter == make_rational(50, 1));
  CHECK(before.hits[1].id == b);
  CHECK(before.hits[1].t_enter == make_rational(150, 1));

  // Batch move: both objects jump far away in one atomic publish.
  space.move_batch({
      {a, Aabb{{1000, 0, 0}, {1010, 10, 10}}},
      {b, Aabb{{2000, 0, 0}, {2010, 10, 10}}},
  });

  auto s2 = space.snapshot();
  CHECK(s2 != s1);

  // New snapshot sees the fully applied batch (no partial state).
  const QueryResult after = s2->query_ray(ray, kInf);
  CHECK(after.hits.size() == 2);
  CHECK(after.hits[0].t_enter == make_rational(1050, 1));
  CHECK(after.hits[1].t_enter == make_rational(2050, 1));

  // The retained old snapshot still answers with the old geometry.
  const QueryResult retained = s1->query_ray(ray, kInf);
  CHECK(retained.hits.size() == 2);
  CHECK(retained.hits[0].t_enter == make_rational(50, 1));
  CHECK(retained.hits[1].t_enter == make_rational(150, 1));

  // With t_max = 1500 the old snapshot still reaches both old boxes, while
  // the new snapshot only reaches 'a' (b moved out to t = 2050).
  const spatial::Rational far = make_rational(1500, 1);
  CHECK(s1->query_ray(ray, far).hits.size() == 2);
  const QueryResult ranged = s2->query_ray(ray, far);
  CHECK(ranged.hits.size() == 1);
  CHECK(ranged.hits[0].id == a);

  // Remove publishes a fresh snapshot; s2 stays intact.
  space.remove(b);
  auto s3 = space.snapshot();
  CHECK(s3->size() == 1);
  CHECK(s3->query_ray(ray, kInf).hits.size() == 1);
  CHECK(s2->query_ray(ray, kInf).hits.size() == 2);

  return testutil::finish("test_snapshot");
}
