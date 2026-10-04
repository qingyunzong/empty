#include <optional>
#include <vector>

#include "check.hpp"
#include "intmesh/mesh.hpp"

using namespace intmesh;

namespace {

Mesh makeSampleMesh() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({2, 0, 0});
  const auto v2 = m.addVertex({2, 2, 0});
  const auto v3 = m.addVertex({0, 2, 0});
  m.addTriangle(v0, v1, v2, 0);
  m.addTriangle(v0, v2, v3, 1);
  return m;
}

// Mutations after snapshot() must not leak into the old snapshot.
void snapshotIsImmuneToLaterMoves() {
  Mesh m = makeSampleMesh();
  const auto snap = m.snapshot();

  const Vec3i snapVertex0 = snap.vertex(0);
  const Vec3i snapFace0 = snap.faceNormal(0);
  const Vec3i snapGroup0 = snap.groupNormal(0);

  m.moveVertex(0, {5, 5, 5});
  m.moveVertex(1, {0, 0, 9});

  CHECK_EQ(snap.vertex(0), snapVertex0);
  CHECK_EQ(snap.faceNormal(0), snapFace0);
  CHECK_EQ(snap.groupNormal(0), snapGroup0);
  // The mesh itself did move on.
  CHECK(!(m.vertex(0) == snapVertex0));
  CHECK(m.verifyConsistency().empty());
}

// Topology growth after snapshot() must not affect the old snapshot.
void snapshotIsImmuneToLaterAdds() {
  Mesh m = makeSampleMesh();
  const auto snap = m.snapshot();
  CHECK_EQ(snap.vertexCount(), 4u);
  CHECK_EQ(snap.faceCount(), 2u);

  const auto v4 = m.addVertex({0, 0, 7});
  m.addTriangle(0, 1, v4, 2);

  CHECK_EQ(snap.vertexCount(), 4u);
  CHECK_EQ(snap.faceCount(), 2u);
  CHECK_EQ(snap.groupCount(), 2u);
  CHECK_EQ(m.vertexCount(), 5u);
  CHECK_EQ(m.faceCount(), 3u);
  CHECK_EQ(m.groupCount(), 3u);
}

// A chain of snapshots preserves the full history of a moving vertex.
void snapshotChainPreservesHistory() {
  Mesh m = makeSampleMesh();
  std::vector<Mesh::Snapshot> history;
  history.push_back(m.snapshot());
  for (int i = 1; i <= 5; ++i) {
    m.moveVertex(0, {1, 0, 0});
    history.push_back(m.snapshot());
  }
  for (int i = 0; i <= 5; ++i)
    CHECK_EQ(history[i].vertex(0), Vec3i(i, 0, 0));
  CHECK(m.verifyConsistency().empty());
}

// Snapshots are self-contained: they stay valid after the originating
// mesh is destroyed.
void snapshotOutlivesMesh() {
  std::optional<Mesh::Snapshot> snap;
  Vec3i expectedFace0;
  {
    Mesh m = makeSampleMesh();
    expectedFace0 = m.faceNormal(0);
    snap = m.snapshot();
  }  // m destroyed here
  CHECK_EQ(snap->vertexCount(), 4u);
  CHECK_EQ(snap->faceNormal(0), expectedFace0);
  CHECK_EQ(snap->triangle(1).c, 3u);
  CHECK_EQ(snap->groupNormal(1), Vec3i(0, 0, 4));
}

}  // namespace

int main() {
  snapshotIsImmuneToLaterMoves();
  snapshotIsImmuneToLaterAdds();
  snapshotChainPreservesHistory();
  snapshotOutlivesMesh();
  return test::summarize("test_snapshot");
}
