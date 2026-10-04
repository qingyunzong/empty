#include "intmesh/mesh.hpp"

#include <algorithm>
#include <map>
#include <stdexcept>
#include <utility>

namespace intmesh {

VertexIndex Mesh::addVertex(const Vec3i& p) {
  ensureTopoWritable();
  const auto index = static_cast<VertexIndex>(positions_.size());
  positions_.pushBack(p);
  topo_->vertexFaces.emplace_back();
  return index;
}

FaceIndex Mesh::addTriangle(VertexIndex a, VertexIndex b, VertexIndex c,
                            GroupId group) {
  if (a >= positions_.size() || b >= positions_.size() ||
      c >= positions_.size())
    throw std::out_of_range("Mesh::addTriangle: vertex index out of range");
  ensureTopoWritable();
  const auto index = static_cast<FaceIndex>(topo_->triangles.size());
  topo_->triangles.push_back({a, b, c});
  topo_->faceGroups.push_back(group);
  topo_->vertexFaces[a].push_back(index);
  topo_->vertexFaces[b].push_back(index);
  topo_->vertexFaces[c].push_back(index);
  if (group >= topo_->groupCount) {
    groupNormals_.resize(group + 1);
    topo_->groupCount = group + 1;
  }
  const Vec3i normal = computeFaceNormal(*topo_, positions_, index);
  faceNormals_.pushBack(normal);
  groupNormals_.set(group, groupNormals_[group] + normal);
  return index;
}

std::size_t Mesh::vertexCount() const { return positions_.size(); }
std::size_t Mesh::faceCount() const { return faceNormals_.size(); }
std::size_t Mesh::groupCount() const { return groupNormals_.size(); }

const Vec3i& Mesh::vertex(VertexIndex v) const { return positions_.at(v); }

Triangle Mesh::triangle(FaceIndex f) const {
  return topo_->triangles.at(f);
}

GroupId Mesh::faceGroup(FaceIndex f) const { return topo_->faceGroups.at(f); }

Vec3i Mesh::faceNormal(FaceIndex f) const { return faceNormals_.at(f); }

Vec3i Mesh::groupNormal(GroupId g) const { return groupNormals_.at(g); }

void Mesh::moveVertex(VertexIndex v, const Vec3i& delta) {
  if (v >= positions_.size())
    throw std::out_of_range("Mesh::moveVertex: vertex index out of range");
  positions_.set(v, positions_[v] + delta);
  for (const FaceIndex f : topo_->vertexFaces[v]) {
    const Vec3i oldNormal = faceNormals_[f];
    const Vec3i newNormal = computeFaceNormal(*topo_, positions_, f);
    if (newNormal == oldNormal) continue;
    faceNormals_.set(f, newNormal);
    const GroupId g = topo_->faceGroups[f];
    groupNormals_.set(g, groupNormals_[g] - oldNormal + newNormal);
  }
}

Diagnostics Mesh::diagnostics() const {
  Diagnostics result;

  for (FaceIndex f = 0; f < topo_->triangles.size(); ++f)
    if (computeFaceNormal(*topo_, positions_, f).isZero())
      result.zeroAreaFaces.push_back(f);

  struct EdgeUse {
    std::vector<FaceIndex> faces;
    int forward = 0;   // wound as (lo, hi)
    int backward = 0;  // wound as (hi, lo)
  };
  std::map<std::pair<VertexIndex, VertexIndex>, EdgeUse> edges;
  auto record = [&](VertexIndex from, VertexIndex to, FaceIndex f) {
    if (from == to) return;  // self-loop: degenerate, caught by zero-area
    const auto key = std::minmax(from, to);
    auto& use = edges[key];
    use.faces.push_back(f);
    if (from == key.first)
      ++use.forward;
    else
      ++use.backward;
  };
  for (FaceIndex f = 0; f < topo_->triangles.size(); ++f) {
    const auto& t = topo_->triangles[f];
    record(t.a, t.b, f);
    record(t.b, t.c, f);
    record(t.c, t.a, f);
  }
  for (const auto& [key, use] : edges) {
    const bool repeatedDirection = use.forward > 1 || use.backward > 1;
    const bool nonManifold = use.faces.size() > 2;
    if (!repeatedDirection && !nonManifold) continue;
    EdgeDiagnostic diag;
    diag.u = key.first;
    diag.v = key.second;
    diag.faces = use.faces;
    diag.repeatedDirection = repeatedDirection;
    diag.nonManifold = nonManifold;
    result.duplicateEdges.push_back(std::move(diag));
  }
  return result;
}

Mesh::Snapshot Mesh::snapshot() const {
  return Snapshot(positions_, faceNormals_, groupNormals_, topo_);
}

std::vector<std::string> Mesh::verifyConsistency() const {
  std::vector<std::string> mismatches;

  // Independent full recomputation straight from positions + topology.
  std::vector<Vec3i> expectedFace(topo_->triangles.size());
  std::vector<Vec3i> expectedGroup(topo_->groupCount);
  for (FaceIndex f = 0; f < topo_->triangles.size(); ++f) {
    expectedFace[f] = computeFaceNormal(*topo_, positions_, f);
    expectedGroup[topo_->faceGroups[f]] += expectedFace[f];
  }

  auto vecToString = [](const Vec3i& v) {
    return "(" + std::to_string(v.x) + "," + std::to_string(v.y) + "," +
           std::to_string(v.z) + ")";
  };
  for (FaceIndex f = 0; f < expectedFace.size(); ++f)
    if (!(expectedFace[f] == faceNormals_[f]))
      mismatches.push_back("face " + std::to_string(f) + ": cached " +
                           vecToString(faceNormals_[f]) + " != recomputed " +
                           vecToString(expectedFace[f]));
  for (GroupId g = 0; g < expectedGroup.size(); ++g)
    if (!(expectedGroup[g] == groupNormals_[g]))
      mismatches.push_back("group " + std::to_string(g) + ": cached " +
                           vecToString(groupNormals_[g]) + " != recomputed " +
                           vecToString(expectedGroup[g]));
  return mismatches;
}

Vec3i Mesh::computeFaceNormal(const Topology& topo,
                              const PersistentVector<Vec3i>& positions,
                              FaceIndex f) {
  const Triangle& t = topo.triangles[f];
  const Vec3i& pa = positions[t.a];
  return cross(positions[t.b] - pa, positions[t.c] - pa);
}

void Mesh::ensureTopoWritable() {
  if (!topo_.unique()) topo_ = std::make_shared<Topology>(*topo_);
}

}  // namespace intmesh
