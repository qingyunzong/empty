#include <random>
#include <set>
#include <vector>

#include "check.hpp"
#include "intmesh/mesh.hpp"

using namespace intmesh;

namespace {

// Builds an n x n vertex grid triangulated into 2*(n-1)^2 faces;
// each quad (two triangles) forms its own group.
Mesh makeGrid(int n, std::vector<std::vector<VertexIndex>>& grid) {
  Mesh m;
  grid.assign(n, std::vector<VertexIndex>(n));
  for (int y = 0; y < n; ++y)
    for (int x = 0; x < n; ++x) grid[y][x] = m.addVertex({x, y, 0});
  GroupId group = 0;
  for (int y = 0; y + 1 < n; ++y)
    for (int x = 0; x + 1 < n; ++x) {
      m.addTriangle(grid[y][x], grid[y][x + 1], grid[y + 1][x + 1], group);
      m.addTriangle(grid[y][x], grid[y + 1][x + 1], grid[y + 1][x], group);
      ++group;
    }
  return m;
}

// Moving a vertex touches only its adjacent faces and their groups.
void moveUpdatesOnlyAdjacentFaces() {
  std::vector<std::vector<VertexIndex>> grid;
  Mesh m = makeGrid(4, grid);

  std::vector<Vec3i> before;
  for (FaceIndex f = 0; f < m.faceCount(); ++f)
    before.push_back(m.faceNormal(f));

  const VertexIndex center = grid[1][1];
  // Faces adjacent to grid[1][1]: both triangles of quads (0,0) and
  // (1,1), plus one triangle of quads (1,0) and (0,1).
  const std::set<FaceIndex> expectedTouched = {0, 1, 3, 6, 8, 9};

  m.moveVertex(center, {0, 0, 3});

  for (FaceIndex f = 0; f < m.faceCount(); ++f) {
    const bool changed = !(m.faceNormal(f) == before[f]);
    CHECK_EQ(changed, expectedTouched.count(f) > 0);
  }
  CHECK(m.verifyConsistency().empty());
}

// Group aggregates track the delta of each touched face exactly.
void groupNormalsTrackDeltas() {
  std::vector<std::vector<VertexIndex>> grid;
  Mesh m = makeGrid(3, grid);

  const GroupId g = 2;  // quad (0,1): faces 4 and 5
  const Vec3i groupBefore = m.groupNormal(g);
  const Vec3i f4Before = m.faceNormal(4);
  const Vec3i f5Before = m.faceNormal(5);

  // grid[1][1] belongs to face 4 of group 2 (face 5 stays unchanged).
  m.moveVertex(grid[1][1], {1, 0, 2});

  const Vec3i expected =
      groupBefore - f4Before - f5Before + m.faceNormal(4) + m.faceNormal(5);
  CHECK_EQ(m.groupNormal(g), expected);
  CHECK(m.verifyConsistency().empty());
}

// A zero delta leaves every cached value untouched.
void zeroDeltaIsANoOp() {
  std::vector<std::vector<VertexIndex>> grid;
  Mesh m = makeGrid(3, grid);
  std::vector<Vec3i> facesBefore;
  for (FaceIndex f = 0; f < m.faceCount(); ++f)
    facesBefore.push_back(m.faceNormal(f));
  std::vector<Vec3i> groupsBefore;
  for (GroupId g = 0; g < m.groupCount(); ++g)
    groupsBefore.push_back(m.groupNormal(g));

  m.moveVertex(grid[1][1], {0, 0, 0});

  for (FaceIndex f = 0; f < m.faceCount(); ++f)
    CHECK_EQ(m.faceNormal(f), facesBefore[f]);
  for (GroupId g = 0; g < m.groupCount(); ++g)
    CHECK_EQ(m.groupNormal(g), groupsBefore[g]);
}

// Randomized soak: after every burst of random moves, the incremental
// caches must match an independent full recomputation, and the final
// state must match a mesh rebuilt from scratch at the same positions.
void randomizedMovesMatchFullRecompute() {
  std::mt19937_64 rng(20261005);
  std::uniform_int_distribution<int> coord(-50, 50);
  std::uniform_int_distribution<int> step(-7, 7);

  Mesh m;
  const int vertexCount = 60;
  for (int i = 0; i < vertexCount; ++i)
    m.addVertex({coord(rng), coord(rng), coord(rng)});
  std::uniform_int_distribution<VertexIndex> pickVertex(0, vertexCount - 1);
  std::uniform_int_distribution<GroupId> pickGroup(0, 4);
  const int faceCount = 100;
  for (int i = 0; i < faceCount; ++i)
    m.addTriangle(pickVertex(rng), pickVertex(rng), pickVertex(rng),
                  pickGroup(rng));

  for (int burst = 0; burst < 20; ++burst) {
    for (int i = 0; i < 25; ++i)
      m.moveVertex(pickVertex(rng), {step(rng), step(rng), step(rng)});
    const auto mismatches = m.verifyConsistency();
    CHECK(mismatches.empty());
  }

  // Independent cross-check: rebuild from scratch at final positions.
  Mesh rebuilt;
  for (VertexIndex v = 0; v < m.vertexCount(); ++v)
    rebuilt.addVertex(m.vertex(v));
  for (FaceIndex f = 0; f < m.faceCount(); ++f) {
    const Triangle t = m.triangle(f);
    rebuilt.addTriangle(t.a, t.b, t.c, m.faceGroup(f));
  }
  for (FaceIndex f = 0; f < m.faceCount(); ++f)
    CHECK_EQ(m.faceNormal(f), rebuilt.faceNormal(f));
  for (GroupId g = 0; g < m.groupCount(); ++g)
    CHECK_EQ(m.groupNormal(g), rebuilt.groupNormal(g));
}

}  // namespace

int main() {
  moveUpdatesOnlyAdjacentFaces();
  groupNormalsTrackDeltas();
  zeroDeltaIsANoOp();
  randomizedMovesMatchFullRecompute();
  return test::summarize("test_incremental");
}
