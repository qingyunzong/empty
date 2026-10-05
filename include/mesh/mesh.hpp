#pragma once

#include <compare>
#include <cstdint>
#include <utility>
#include <vector>

namespace mesh {

// Integer 3D vector. All arithmetic stays in int64_t; normals are never
// normalized, so cross products remain exact integer vectors.
struct Vec3i {
    std::int64_t x = 0;
    std::int64_t y = 0;
    std::int64_t z = 0;

    constexpr Vec3i operator+(const Vec3i& o) const { return {x + o.x, y + o.y, z + o.z}; }
    constexpr Vec3i operator-(const Vec3i& o) const { return {x - o.x, y - o.y, z - o.z}; }
    constexpr Vec3i& operator+=(const Vec3i& o) { x += o.x; y += o.y; z += o.z; return *this; }
    constexpr Vec3i& operator-=(const Vec3i& o) { x -= o.x; y -= o.y; z -= o.z; return *this; }
    constexpr bool operator==(const Vec3i&) const = default;
};

constexpr Vec3i cross(Vec3i a, Vec3i b) {
    return {a.y * b.z - a.z * b.y,
            a.z * b.x - a.x * b.z,
            a.x * b.y - a.y * b.x};
}

struct Triangle {
    std::uint32_t a = 0;
    std::uint32_t b = 0;
    std::uint32_t c = 0;
};

// Undirected edge, u < v.
struct Edge {
    std::uint32_t u = 0;
    std::uint32_t v = 0;
    constexpr auto operator<=>(const Edge&) const = default;
};

// Diagnostic for a suspicious edge.
//   occurrences   - total directed half-edges on {u,v} (1 = boundary, 2 = manifold)
//   sameDirection - half-edges oriented u->v (for a well-oriented 2-manifold
//                   interior edge this is exactly 1)
struct EdgeDiagnostic {
    Edge edge;
    std::size_t occurrences = 0;
    std::size_t sameDirection = 0;
};

// Immutable deep copy of a mesh. Lifetime is fully independent of the source
// Mesh: it stays valid after the source is mutated or destroyed.
class MeshSnapshot {
public:
    MeshSnapshot(std::vector<Vec3i> vertices,
                 std::vector<Triangle> triangles,
                 std::vector<Vec3i> faceNormals,
                 std::vector<Vec3i> vertexNormals)
        : vertices_(std::move(vertices)),
          triangles_(std::move(triangles)),
          faceNormals_(std::move(faceNormals)),
          vertexNormals_(std::move(vertexNormals)) {}

    const std::vector<Vec3i>& vertices() const { return vertices_; }
    const std::vector<Triangle>& triangles() const { return triangles_; }
    const std::vector<Vec3i>& faceNormals() const { return faceNormals_; }
    const std::vector<Vec3i>& vertexNormals() const { return vertexNormals_; }

    Vec3i vertex(std::size_t i) const { return vertices_.at(i); }
    Vec3i faceNormal(std::size_t i) const { return faceNormals_.at(i); }
    Vec3i vertexNormal(std::size_t i) const { return vertexNormals_.at(i); }

private:
    std::vector<Vec3i> vertices_;
    std::vector<Triangle> triangles_;
    std::vector<Vec3i> faceNormals_;
    std::vector<Vec3i> vertexNormals_;
};

class Mesh {
public:
    std::size_t addVertex(Vec3i p);
    // Throws std::out_of_range if any index is invalid.
    std::size_t addTriangle(std::uint32_t a, std::uint32_t b, std::uint32_t c);

    std::size_t vertexCount() const { return vertices_.size(); }
    std::size_t triangleCount() const { return triangles_.size(); }

    Vec3i vertex(std::size_t i) const { return vertices_.at(i); }
    const Triangle& triangle(std::size_t i) const { return triangles_.at(i); }

    // Incrementally maintained normals (integer, unnormalized).
    Vec3i faceNormal(std::size_t i) const { return faceNormals_.at(i); }
    Vec3i vertexNormal(std::size_t i) const { return vertexNormals_.at(i); }

    // Moves vertex `v` by `delta`, recomputing only the normals of adjacent
    // faces and of the vertices touched by those faces.
    void moveVertex(std::size_t v, Vec3i delta);

    // Diagnostics.
    // An edge is reported when it is non-manifold (occurrences > 2) or when
    // two half-edges share the same direction (inconsistent winding).
    std::vector<EdgeDiagnostic> duplicateEdges() const;
    // Faces whose integer cross product is exactly (0,0,0): degenerate
    // (repeated index) or collinear vertices.
    std::vector<std::size_t> zeroAreaFaces() const;

    // Deep, lifetime-independent copy of the current state.
    MeshSnapshot snapshot() const {
        return MeshSnapshot(vertices_, triangles_, faceNormals_, vertexNormals_);
    }

    // Independent full recomputation of every normal from scratch; returns
    // true when the incrementally maintained state matches it exactly.
    bool verifyNormals() const;

    // Reference recomputation, also usable standalone for cross-checking.
    static std::pair<std::vector<Vec3i>, std::vector<Vec3i>>
    computeNormals(const std::vector<Vec3i>& vertices,
                   const std::vector<Triangle>& triangles);

private:
    void updateFaceNormal(std::size_t f);

    std::vector<Vec3i> vertices_;
    std::vector<Triangle> triangles_;
    std::vector<Vec3i> faceNormals_;
    std::vector<Vec3i> vertexNormals_;            // sum of adjacent face normals
    std::vector<std::vector<std::uint32_t>> vertexFaces_;  // adjacency
};

} // namespace mesh
