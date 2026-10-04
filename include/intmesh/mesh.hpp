#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "intmesh/persistent_vector.hpp"
#include "intmesh/vec3i.hpp"

namespace intmesh {

using VertexIndex = std::uint32_t;
using FaceIndex = std::uint32_t;
using GroupId = std::uint32_t;

struct Triangle {
  VertexIndex a = 0;
  VertexIndex b = 0;
  VertexIndex c = 0;
};

// One undirected edge flagged by the diagnostics pass.
struct EdgeDiagnostic {
  VertexIndex u = 0;  // u < v
  VertexIndex v = 0;
  std::vector<FaceIndex> faces;   // faces referencing this edge
  bool repeatedDirection = false; // same directed edge used more than once
  bool nonManifold = false;       // edge shared by more than two faces
};

struct Diagnostics {
  // Edges used more often than a well-formed oriented manifold allows:
  // either the same directed edge appears twice (duplicated faces or
  // inconsistent winding), or an edge is shared by 3+ faces.
  std::vector<EdgeDiagnostic> duplicateEdges;
  // Faces whose exact integer normal is the zero vector (degenerate
  // geometry: collinear or repeated vertices).
  std::vector<FaceIndex> zeroAreaFaces;
};

// Triangle mesh over integer vertices. Face normals are exact integer
// cross products (never normalized); group normals are the plain sums
// of the face normals in each group. moveVertex() updates only the
// faces adjacent to the moved vertex and their groups. snapshot()
// returns a cheap, lifetime-safe read-only view that is unaffected by
// later mutations. verifyConsistency() recomputes every normal from
// scratch and reports any divergence from the incrementally
// maintained caches.
class Mesh {
public:
  class Snapshot;

  VertexIndex addVertex(const Vec3i& p);
  FaceIndex addTriangle(VertexIndex a, VertexIndex b, VertexIndex c,
                        GroupId group = 0);

  std::size_t vertexCount() const;
  std::size_t faceCount() const;
  std::size_t groupCount() const;

  const Vec3i& vertex(VertexIndex v) const;
  Triangle triangle(FaceIndex f) const;
  GroupId faceGroup(FaceIndex f) const;

  // Cached, incrementally maintained values.
  Vec3i faceNormal(FaceIndex f) const;
  Vec3i groupNormal(GroupId g) const;

  // Moves a vertex by delta, recomputing only adjacent face normals
  // and the affected group aggregates. O(adjacent faces).
  void moveVertex(VertexIndex v, const Vec3i& delta);

  // Diagnostics are computed from positions and topology directly.
  Diagnostics diagnostics() const;

  Snapshot snapshot() const;

  // Independent full-mesh recomputation of every face and group
  // normal, compared against the incremental caches. Returns a list of
  // human-readable mismatches; empty means consistent.
  std::vector<std::string> verifyConsistency() const;

private:
  struct Topology {
    std::vector<Triangle> triangles;
    std::vector<GroupId> faceGroups;
    std::vector<std::vector<FaceIndex>> vertexFaces;  // adjacency
    std::size_t groupCount = 0;
  };

  static Vec3i computeFaceNormal(const Topology& topo,
                                 const PersistentVector<Vec3i>& positions,
                                 FaceIndex f);
  void ensureTopoWritable();

  PersistentVector<Vec3i> positions_;
  PersistentVector<Vec3i> faceNormals_;
  PersistentVector<Vec3i> groupNormals_;
  std::shared_ptr<Topology> topo_ = std::make_shared<Topology>();
};

// Read-only view of a Mesh at the time snapshot() was called. Shares
// copy-on-write storage with the originating mesh, so it stays valid
// and unchanged no matter how the mesh is mutated afterwards; it even
// outlives the mesh itself safely.
class Mesh::Snapshot {
public:
  std::size_t vertexCount() const { return positions_.size(); }
  std::size_t faceCount() const { return faceNormals_.size(); }
  std::size_t groupCount() const { return groupNormals_.size(); }

  const Vec3i& vertex(VertexIndex v) const { return positions_.at(v); }
  Vec3i faceNormal(FaceIndex f) const { return faceNormals_.at(f); }
  Vec3i groupNormal(GroupId g) const { return groupNormals_.at(g); }
  Triangle triangle(FaceIndex f) const { return topo_->triangles.at(f); }
  GroupId faceGroup(FaceIndex f) const { return topo_->faceGroups.at(f); }

private:
  friend class Mesh;
  Snapshot(PersistentVector<Vec3i> positions,
           PersistentVector<Vec3i> faceNormals,
           PersistentVector<Vec3i> groupNormals,
           std::shared_ptr<const Topology> topo)
      : positions_(std::move(positions)),
        faceNormals_(std::move(faceNormals)),
        groupNormals_(std::move(groupNormals)),
        topo_(std::move(topo)) {}

  PersistentVector<Vec3i> positions_;
  PersistentVector<Vec3i> faceNormals_;
  PersistentVector<Vec3i> groupNormals_;
  std::shared_ptr<const Topology> topo_;
};

}  // namespace intmesh
