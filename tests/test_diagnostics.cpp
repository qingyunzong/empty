#include "check.hpp"
#include "intmesh/mesh.hpp"

using namespace intmesh;

namespace {

bool hasEdge(const Diagnostics& d, VertexIndex u, VertexIndex v) {
  for (const auto& e : d.duplicateEdges)
    if (e.u == u && e.v == v) return true;
  return false;
}

const EdgeDiagnostic* findEdge(const Diagnostics& d, VertexIndex u,
                               VertexIndex v) {
  for (const auto& e : d.duplicateEdges)
    if (e.u == u && e.v == v) return &e;
  return nullptr;
}

// A well-formed square made of two triangles with consistent winding:
// no duplicate edges, no zero-area faces.
void cleanMeshHasNoDiagnostics() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({1, 1, 0});
  const auto v3 = m.addVertex({0, 1, 0});
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v0, v2, v3);

  const Diagnostics d = m.diagnostics();
  CHECK(d.duplicateEdges.empty());
  CHECK(d.zeroAreaFaces.empty());
}

// The exact same triangle added twice: every directed edge repeats.
void duplicatedFacesAreReported() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({0, 1, 0});
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v0, v1, v2);

  const Diagnostics d = m.diagnostics();
  CHECK_EQ(d.duplicateEdges.size(), 3u);
  CHECK(hasEdge(d, v0, v1));
  CHECK(hasEdge(d, v1, v2));
  CHECK(hasEdge(d, v0, v2));
  const EdgeDiagnostic* e = findEdge(d, v0, v1);
  CHECK(e != nullptr);
  if (e) {
    CHECK(e->repeatedDirection);
    CHECK(!e->nonManifold);  // only two faces, but same orientation
    CHECK_EQ(e->faces.size(), 2u);
  }
}

// Three distinct faces sharing one edge: non-manifold.
void nonManifoldEdgeIsReported() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({0, 1, 0});
  const auto v3 = m.addVertex({0, 0, 1});
  const auto v4 = m.addVertex({1, 1, 1});
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v1, v0, v3);  // opposite orientation on edge (0,1)
  m.addTriangle(v0, v1, v4);  // third face on the same edge

  const Diagnostics d = m.diagnostics();
  const EdgeDiagnostic* e = findEdge(d, v0, v1);
  CHECK(e != nullptr);
  if (e) {
    CHECK(e->nonManifold);
    CHECK_EQ(e->faces.size(), 3u);
  }
}

// Collinear vertices and repeated indices both yield zero-area faces.
void zeroAreaFacesAreReported() {
  Mesh m;
  const auto v0 = m.addVertex({0, 0, 0});
  const auto v1 = m.addVertex({1, 0, 0});
  const auto v2 = m.addVertex({2, 0, 0});  // collinear with v0, v1
  const auto v3 = m.addVertex({0, 1, 0});
  const auto v4 = m.addVertex({1, 1, 0});
  const auto v5 = m.addVertex({0, 2, 0});
  const auto f0 = m.addTriangle(v0, v1, v2);  // collinear -> zero area
  const auto f1 = m.addTriangle(v0, v0, v3);  // repeated index -> zero area
  const auto f2 = m.addTriangle(v3, v4, v5);  // healthy, shares no edge

  const Diagnostics d = m.diagnostics();
  CHECK_EQ(d.zeroAreaFaces.size(), 2u);
  CHECK_EQ(d.zeroAreaFaces[0], f0);
  CHECK_EQ(d.zeroAreaFaces[1], f1);
  CHECK(d.duplicateEdges.empty());
  (void)f2;
}

}  // namespace

int main() {
  cleanMeshHasNoDiagnostics();
  duplicatedFacesAreReported();
  nonManifoldEdgeIsReported();
  zeroAreaFacesAreReported();
  return test::summarize("test_diagnostics");
}
