#include "mesh/mesh.hpp"

#include <algorithm>
#include <map>
#include <stdexcept>

namespace mesh {

std::size_t Mesh::addVertex(Vec3i p) {
    vertices_.push_back(p);
    vertexNormals_.push_back({});
    vertexFaces_.emplace_back();
    return vertices_.size() - 1;
}

std::size_t Mesh::addTriangle(std::uint32_t a, std::uint32_t b, std::uint32_t c) {
    const auto n = static_cast<std::uint32_t>(vertices_.size());
    if (a >= n || b >= n || c >= n) {
        throw std::out_of_range("Mesh::addTriangle: vertex index out of range");
    }
    triangles_.push_back({a, b, c});
    const auto f = static_cast<std::uint32_t>(triangles_.size() - 1);
    vertexFaces_[a].push_back(f);
    vertexFaces_[b].push_back(f);
    vertexFaces_[c].push_back(f);
    faceNormals_.push_back({});
    updateFaceNormal(f);
    return f;
}

void Mesh::updateFaceNormal(std::size_t f) {
    const Triangle& t = triangles_[f];
    const Vec3i n = cross(vertices_[t.b] - vertices_[t.a],
                          vertices_[t.c] - vertices_[t.a]);
    faceNormals_[f] = n;
    vertexNormals_[t.a] += n;
    vertexNormals_[t.b] += n;
    vertexNormals_[t.c] += n;
}

void Mesh::moveVertex(std::size_t v, Vec3i delta) {
    if (v >= vertices_.size()) {
        throw std::out_of_range("Mesh::moveVertex: vertex index out of range");
    }
    if (delta == Vec3i{}) {
        return;
    }
    // Remove the contribution of every adjacent face, move, then re-add with
    // the recomputed normals. Only faces touching `v` can change.
    for (std::uint32_t f : vertexFaces_[v]) {
        const Triangle& t = triangles_[f];
        const Vec3i n = faceNormals_[f];
        vertexNormals_[t.a] -= n;
        vertexNormals_[t.b] -= n;
        vertexNormals_[t.c] -= n;
    }
    vertices_[v] += delta;
    for (std::uint32_t f : vertexFaces_[v]) {
        updateFaceNormal(f);
    }
}

std::vector<EdgeDiagnostic> Mesh::duplicateEdges() const {
    struct Counts {
        std::size_t total = 0;
        std::size_t forward = 0; // oriented low->high
    };
    std::map<Edge, Counts> counts;
    auto note = [&](std::uint32_t p, std::uint32_t q) {
        Edge e{std::min(p, q), std::max(p, q)};
        auto& c = counts[e];
        ++c.total;
        if (p < q) {
            ++c.forward;
        }
    };
    for (const Triangle& t : triangles_) {
        note(t.a, t.b);
        note(t.b, t.c);
        note(t.c, t.a);
    }
    std::vector<EdgeDiagnostic> out;
    for (const auto& [edge, c] : counts) {
        const std::size_t sameDir = std::max(c.forward, c.total - c.forward);
        if (c.total > 2 || sameDir > 1) {
            out.push_back({edge, c.total, sameDir});
        }
    }
    return out;
}

std::vector<std::size_t> Mesh::zeroAreaFaces() const {
    std::vector<std::size_t> out;
    for (std::size_t f = 0; f < triangles_.size(); ++f) {
        if (faceNormals_[f] == Vec3i{}) {
            out.push_back(f);
        }
    }
    return out;
}

std::pair<std::vector<Vec3i>, std::vector<Vec3i>>
Mesh::computeNormals(const std::vector<Vec3i>& vertices,
                     const std::vector<Triangle>& triangles) {
    std::vector<Vec3i> faceNormals(triangles.size());
    std::vector<Vec3i> vertexNormals(vertices.size());
    for (std::size_t f = 0; f < triangles.size(); ++f) {
        const Triangle& t = triangles[f];
        const Vec3i n = cross(vertices.at(t.b) - vertices.at(t.a),
                              vertices.at(t.c) - vertices.at(t.a));
        faceNormals[f] = n;
        vertexNormals.at(t.a) += n;
        vertexNormals.at(t.b) += n;
        vertexNormals.at(t.c) += n;
    }
    return {std::move(faceNormals), std::move(vertexNormals)};
}

bool Mesh::verifyNormals() const {
    const auto [faceNormals, vertexNormals] = computeNormals(vertices_, triangles_);
    return faceNormals == faceNormals_ && vertexNormals == vertexNormals_;
}

} // namespace mesh
