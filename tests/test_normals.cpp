#include "check.hpp"
#include "intmesh/mesh.hpp"

using namespace intmesh;

namespace {

// Face normals are exact, unnormalized integer cross products.
void faceNormalIsExactIntegerCross() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({2, 0, 0});
  const auto v2 = m.addVertex({0, 2, 0});
  const auto f = m.addTriangle(v0, v1, v2);
  // cross((2,0,0), (0,2,0)) = (0,0,4); NOT normalized to (0,0,1).
  CHECK_EQ(m.faceNormal(f), Vec3i(0, 0, 4));
}

// Reversed winding negates the normal.
void windingFlipsNormal() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({0, 1, 0});
  const auto f0 = m.addTriangle(v0, v1, v2);
  const auto f1 = m.addTriangle(v0, v2, v1);
  CHECK_EQ(m.faceNormal(f0), Vec3i(0, 0, 1));
  CHECK_EQ(m.faceNormal(f1), Vec3i(0, 0, -1));
}

// Group normal = plain sum of member face normals, per group.
void groupAggregationSumsFaceNormals() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({1, 1, 0});
  const auto v3 = m.addVertex({0, 1, 0});
  const auto v4 = m.addVertex({0, 0, 2});

  m.addTriangle(v0, v1, v2, /*group=*/0);  // (0,0,1)
  m.addTriangle(v0, v2, v3, /*group=*/0);  // (0,0,1)
  m.addTriangle(v0, v1, v4, /*group=*/1);  // cross((1,0,0),(0,0,2)) = (0,-2,0)

  CHECK_EQ(m.groupCount(), 2u);
  CHECK_EQ(m.groupNormal(0), Vec3i(0, 0, 2));
  CHECK_EQ(m.groupNormal(1), Vec3i(0, -2, 0));
}

// Groups are created on demand; empty groups aggregate to zero.
void sparseGroupsDefaultToZero() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({0, 1, 0});
  m.addTriangle(v0, v1, v2, /*group=*/3);

  CHECK_EQ(m.groupCount(), 4u);
  CHECK_EQ(m.groupNormal(0), Vec3i(0, 0, 0));
  CHECK_EQ(m.groupNormal(1), Vec3i(0, 0, 0));
  CHECK_EQ(m.groupNormal(2), Vec3i(0, 0, 0));
  CHECK_EQ(m.groupNormal(3), Vec3i(0, 0, 1));
}

// Large coordinates: cross products stay exact in 64 bits.
void largeCoordinatesStayExact() {
  const std::int64_t k = 1'000'000'000;  // 1e9, within the 2^30 bound
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({k, 0, 0});
  const auto v2 = m.addVertex({0, k, 0});
  const auto f = m.addTriangle(v0, v1, v2);
  CHECK_EQ(m.faceNormal(f), Vec3i(0, 0, k * k));
}

}  // namespace

int main() {
  faceNormalIsExactIntegerCross();
  windingFlipsNormal();
  groupAggregationSumsFaceNormals();
  sparseGroupsDefaultToZero();
  largeCoordinatesStayExact();
  return test::summarize("test_normals");
}
