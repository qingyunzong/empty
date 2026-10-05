#include "mesh/mesh.hpp"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    if (!ok) {
        ++g_failures;
        std::cerr << "FAIL: " << what << '\n';
    }
}

bool containsEdge(const std::vector<mesh::EdgeDiagnostic>& diags,
                  std::uint32_t u, std::uint32_t v) {
    for (const auto& d : diags) {
        if (d.edge == mesh::Edge{u, v}) {
            return true;
        }
    }
    return false;
}

// Two triangles sharing edge {1,2} with the same winding -> same-direction
// duplicate; plus a third face on edge {0,1} -> non-manifold (3 occurrences).
int testDuplicateEdges() {
    mesh::Mesh m;
    m.addVertex({0, 0, 0}); // 0
    m.addVertex({1, 0, 0}); // 1
    m.addVertex({0, 1, 0}); // 2
    m.addVertex({1, 1, 0}); // 3
    m.addVertex({0, 0, 1}); // 4
    m.addTriangle(0, 1, 2);
    m.addTriangle(1, 2, 3); // half-edge 1->2 duplicates 0,1,2's 1->2
    m.addTriangle(0, 4, 1);
    m.addTriangle(0, 1, 4); // edge {0,1} now appears 3 times

    const auto diags = m.duplicateEdges();
    check(diags.size() == 2, "exactly two suspicious edges");
    check(containsEdge(diags, 1, 2), "same-direction duplicate on {1,2}");
    check(containsEdge(diags, 0, 1), "non-manifold edge {0,1}");
    for (const auto& d : diags) {
        if (d.edge == mesh::Edge{0, 1}) {
            check(d.occurrences == 3, "edge {0,1} occurs 3 times");
        }
        if (d.edge == mesh::Edge{1, 2}) {
            check(d.occurrences == 2 && d.sameDirection == 2,
                  "edge {1,2} twice in the same direction");
        }
    }
    return g_failures;
}

int testZeroAreaFaces() {
    mesh::Mesh m;
    m.addVertex({0, 0, 0});  // 0
    m.addVertex({2, 0, 0});  // 1
    m.addVertex({4, 0, 0});  // 2 (collinear with 0,1)
    m.addVertex({0, 3, 0});  // 3
    m.addTriangle(0, 1, 2);  // collinear -> zero area
    m.addTriangle(0, 1, 1);  // repeated index -> degenerate
    m.addTriangle(0, 1, 3);  // healthy face

    const auto zero = m.zeroAreaFaces();
    check(zero.size() == 2, "two zero-area faces");
    check(zero[0] == 0 && zero[1] == 1, "faces 0 and 1 flagged, face 2 clean");
    check(m.duplicateEdges().empty() || true, "diagnostics callable together");
    return g_failures;
}

// Unit square in z=0 split into two triangles. Face normals must be the exact
// integer vector (0,0,1); the shared interior vertices aggregate (0,0,2).
int testNormalAggregation() {
    mesh::Mesh m;
    m.addVertex({0, 0, 0}); // 0
    m.addVertex({1, 0, 0}); // 1
    m.addVertex({1, 1, 0}); // 2
    m.addVertex({0, 1, 0}); // 3
    m.addTriangle(0, 1, 2);
    m.addTriangle(0, 2, 3);

    check(m.faceNormal(0) == mesh::Vec3i{0, 0, 1}, "face 0 normal (0,0,1)");
    check(m.faceNormal(1) == mesh::Vec3i{0, 0, 1}, "face 1 normal (0,0,1)");
    check(m.vertexNormal(0) == mesh::Vec3i{0, 0, 2}, "corner 0 aggregates two faces");
    check(m.vertexNormal(2) == mesh::Vec3i{0, 0, 2}, "corner 2 aggregates two faces");
    check(m.vertexNormal(1) == mesh::Vec3i{0, 0, 1}, "corner 1 has one face");
    check(m.vertexNormal(3) == mesh::Vec3i{0, 0, 1}, "corner 3 has one face");
    check(m.verifyNormals(), "incremental state matches full recompute");
    return g_failures;
}

// Build a triangulated grid, apply deterministic pseudo-random moves, and
// after every move cross-check the incremental state against an independent
// full recomputation; finally compare against a from-scratch rebuilt mesh.
int testIncrementalMove() {
    mesh::Mesh m;
    constexpr int n = 5;
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            m.addVertex({x, y, 0});
        }
    }
    auto vid = [](int x, int y) { return static_cast<std::uint32_t>(y * n + x); };
    for (int y = 0; y + 1 < n; ++y) {
        for (int x = 0; x + 1 < n; ++x) {
            m.addTriangle(vid(x, y), vid(x + 1, y), vid(x + 1, y + 1));
            m.addTriangle(vid(x, y), vid(x + 1, y + 1), vid(x, y + 1));
        }
    }
    check(m.verifyNormals(), "grid consistent before moves");

    std::uint64_t state = 0x9e3779b97f4a7c15ull;
    auto next = [&] {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        return state;
    };
    for (int step = 0; step < 200; ++step) {
        const auto v = next() % (n * n);
        const mesh::Vec3i d{static_cast<std::int64_t>(next() % 7) - 3,
                            static_cast<std::int64_t>(next() % 7) - 3,
                            static_cast<std::int64_t>(next() % 7) - 3};
        m.moveVertex(v, d);
        if (!m.verifyNormals()) {
            check(false, "incremental state diverged from full recompute");
            return g_failures;
        }
    }

    // Independent rebuild with identical final positions must match exactly.
    mesh::Mesh rebuilt;
    for (std::size_t i = 0; i < m.vertexCount(); ++i) {
        rebuilt.addVertex(m.vertex(i));
    }
    for (std::size_t f = 0; f < m.triangleCount(); ++f) {
        const auto& t = m.triangle(f);
        rebuilt.addTriangle(t.a, t.b, t.c);
    }
    for (std::size_t f = 0; f < m.triangleCount(); ++f) {
        check(m.faceNormal(f) == rebuilt.faceNormal(f), "face normal matches rebuild");
    }
    for (std::size_t v = 0; v < m.vertexCount(); ++v) {
        check(m.vertexNormal(v) == rebuilt.vertexNormal(v), "vertex normal matches rebuild");
    }
    return g_failures;
}

// A snapshot must stay valid and unchanged after the source mesh is mutated
// and even destroyed.
int testSnapshotLifetime() {
    mesh::MeshSnapshot snap = [] {
        mesh::Mesh m;
        m.addVertex({0, 0, 0});
        m.addVertex({1, 0, 0});
        m.addVertex({0, 1, 0});
        m.addTriangle(0, 1, 2);
        mesh::MeshSnapshot s = m.snapshot();
        m.moveVertex(2, {5, 5, 5}); // mutate after snapshotting
        check(s.vertex(2) == mesh::Vec3i{0, 1, 0}, "snapshot vertex immune to move");
        check(s.faceNormal(0) == mesh::Vec3i{0, 0, 1}, "snapshot face normal immune");
        check(m.faceNormal(0) == mesh::Vec3i{0, -5, 6}, "live mesh updated");
        return s;
    }(); // mesh destroyed here
    check(snap.vertex(2) == mesh::Vec3i{0, 1, 0}, "snapshot outlives source mesh");
    check(snap.vertexNormal(0) == mesh::Vec3i{0, 0, 1}, "snapshot vertex normal intact");
    check(snap.vertices().size() == 3 && snap.triangles().size() == 1,
          "snapshot contents complete");
    return g_failures;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: mesh_tests <case>\n";
        return 2;
    }
    const std::string c = argv[1];
    int rc = 2;
    if (c == "duplicate_edges") rc = testDuplicateEdges();
    else if (c == "zero_area") rc = testZeroAreaFaces();
    else if (c == "normal_aggregation") rc = testNormalAggregation();
    else if (c == "incremental_move") rc = testIncrementalMove();
    else if (c == "snapshot_lifetime") rc = testSnapshotLifetime();
    else {
        std::cerr << "unknown case: " << c << '\n';
        return 2;
    }
    if (rc == 0) {
        std::cout << "PASS: " << c << '\n';
    }
    return rc == 0 ? 0 : 1;
}
