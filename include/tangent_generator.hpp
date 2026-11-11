#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace tangentgen {

constexpr float kDefaultNormalTolerance = 1e-6f;
constexpr double kTangentEps = 1e-12;

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;

    bool operator==(const Vec3&) const = default;
};

struct Vec2 {
    float u = 0.0f;
    float v = 0.0f;

    bool operator==(const Vec2&) const = default;
};

struct CornerInput {
    Vec3 position;
    Vec3 normal;
    Vec2 uv;
};

struct TangentOutput {
    Vec3 tangent;
    float handedness = 1.0f;
};

struct TangentOptions {
    float normal_tolerance = kDefaultNormalTolerance;
};

namespace detail {

struct DVec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;

    DVec3& operator+=(const DVec3& rhs) {
        x += rhs.x;
        y += rhs.y;
        z += rhs.z;
        return *this;
    }
};

inline DVec3 operator-(const DVec3& a, const DVec3& b) {
    return {a.x - b.x, a.y - b.y, a.z - b.z};
}

inline DVec3 operator+(const DVec3& a, const DVec3& b) {
    return {a.x + b.x, a.y + b.y, a.z + b.z};
}

inline DVec3 operator*(const DVec3& a, double s) {
    return {a.x * s, a.y * s, a.z * s};
}

inline double dot(const DVec3& a, const DVec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

inline DVec3 cross(const DVec3& a, const DVec3& b) {
    return {a.y * b.z - a.z * b.y,
            a.z * b.x - a.x * b.z,
            a.x * b.y - a.y * b.x};
}

inline double lengthSquared(const DVec3& a) { return dot(a, a); }

inline double length(const DVec3& a) { return std::sqrt(lengthSquared(a)); }

inline DVec3 toD(const Vec3& v) {
    return {static_cast<double>(v.x), static_cast<double>(v.y),
            static_cast<double>(v.z)};
}

inline bool finiteVec(const Vec3& v) {
    return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z);
}

inline bool finiteVec(const Vec2& v) {
    return std::isfinite(v.u) && std::isfinite(v.v);
}

inline void hashCombine(std::size_t& seed, const void* data,
                        std::size_t bytes) {
    const auto* p = static_cast<const unsigned char*>(data);
    for (std::size_t i = 0; i < bytes; ++i) {
        seed ^= static_cast<std::size_t>(p[i]) + 0x9e3779b97f4a7c15ULL +
                (seed << 6) + (seed >> 2);
    }
}

// World axis least parallel (smallest |dot|) to the unit normal.
// Ties resolve in X, then Y, then Z order.
inline DVec3 fallbackAxis(const DVec3& n) {
    double best_score = std::fabs(n.x);
    int best_axis = 0;
    const double sy = std::fabs(n.y);
    const double sz = std::fabs(n.z);
    if (sy < best_score) {
        best_score = sy;
        best_axis = 1;
    }
    if (sz < best_score) {
        best_axis = 2;
    }
    if (best_axis == 0) return {1.0, 0.0, 0.0};
    if (best_axis == 1) return {0.0, 1.0, 0.0};
    return {0.0, 0.0, 1.0};
}

// Deterministic unit tangent perpendicular to n, built from a world axis.
inline DVec3 fallbackTangent(const DVec3& n) {
    const DVec3 axis = fallbackAxis(n);
    DVec3 residual = axis - n * dot(n, axis);
    return residual * (1.0 / length(residual));
}

// Gram-Schmidt orthogonalization against the unit normal, then normalization.
// A vanishing residual means the accumulated tangent is parallel to n and the
// deterministic axis fallback is used instead.
inline DVec3 orthonormalize(const DVec3& t, const DVec3& n) {
    DVec3 residual = t - n * dot(n, t);
    const double scale = std::max(1.0, lengthSquared(t));
    if (lengthSquared(residual) <= kTangentEps * kTangentEps * scale) {
        return fallbackTangent(n);
    }
    return residual * (1.0 / length(residual));
}

struct AccumKey {
    Vec3 position;
    Vec3 normal;
    Vec2 uv;
    std::int8_t handedness = 1;

    bool operator==(const AccumKey&) const = default;
};

struct AccumKeyHash {
    std::size_t operator()(const AccumKey& key) const noexcept {
        std::size_t seed = 1469598103934665603ULL;
        hashCombine(seed, &key.position, sizeof(key.position));
        hashCombine(seed, &key.normal, sizeof(key.normal));
        hashCombine(seed, &key.uv, sizeof(key.uv));
        hashCombine(seed, &key.handedness, sizeof(key.handedness));
        return seed;
    }
};

inline void validateCorners(const std::vector<CornerInput>& corners,
                            float normal_tolerance) {
    if (!(normal_tolerance >= 0.0f) || !std::isfinite(normal_tolerance)) {
        throw std::invalid_argument(
            "tangent: normal_tolerance must be a finite non-negative value");
    }
    if (corners.size() % 3 != 0) {
        throw std::invalid_argument(
            "tangent: corner count must be a multiple of three");
    }
    const double tol = static_cast<double>(normal_tolerance);
    for (std::size_t i = 0; i < corners.size(); ++i) {
        const CornerInput& c = corners[i];
        if (!finiteVec(c.position) || !finiteVec(c.normal) ||
            !finiteVec(c.uv)) {
            throw std::invalid_argument(
                "tangent: non-finite input at corner " + std::to_string(i));
        }
        const double norm_error = std::fabs(length(toD(c.normal)) - 1.0);
        if (norm_error > tol) {
            throw std::invalid_argument(
                "tangent: normal at corner " + std::to_string(i) +
                " is not a unit vector");
        }
    }
}

}  // namespace detail

// Generates per-corner tangent frames for a triangle mesh.
//
// For every usable triangle the UV Jacobian yields a face tangent (gradient of
// position along +U) and bitangent (gradient along +V). Each corner adds the
// face tangent weighted by its interior angle; only corners with identical
// position, normal, UV and handedness share one accumulator. Accumulated
// tangents are Gram-Schmidt orthogonalized against the corner normal.
// Degenerate UVs, zero-area faces and canceling accumulations fall back to the
// axis least parallel to the normal, tie-broken X, then Y, then Z.
inline std::vector<TangentOutput> computeTangents(
    const std::vector<CornerInput>& corners,
    const TangentOptions& options = {}) {
    detail::validateCorners(corners, options.normal_tolerance);

    const std::size_t corner_count = corners.size();
    const std::size_t face_count = corner_count / 3;

    std::unordered_map<detail::AccumKey, detail::DVec3,
                       detail::AccumKeyHash>
        accum;
    accum.reserve(corner_count);

    // Accumulator key per corner. Defaults to the fallback key (handedness
    // +1) for corners of zero-area faces or degenerate UVs.
    std::vector<detail::AccumKey> corner_keys(corner_count);
    for (std::size_t i = 0; i < corner_count; ++i) {
        corner_keys[i] = detail::AccumKey{
            corners[i].position, corners[i].normal, corners[i].uv,
            static_cast<std::int8_t>(1)};
    }

    for (std::size_t face = 0; face < face_count; ++face) {
        const CornerInput& c0 = corners[face * 3 + 0];
        const CornerInput& c1 = corners[face * 3 + 1];
        const CornerInput& c2 = corners[face * 3 + 2];

        const detail::DVec3 p0 = detail::toD(c0.position);
        const detail::DVec3 p1 = detail::toD(c1.position);
        const detail::DVec3 p2 = detail::toD(c2.position);

        const detail::DVec3 e1 = p1 - p0;
        const detail::DVec3 e2 = p2 - p0;
        const detail::DVec3 geometric_normal = detail::cross(e1, e2);
        const double area2 = detail::lengthSquared(geometric_normal);

        // Zero-area face: no accumulation for any of its corners.
        if (area2 <= kTangentEps * kTangentEps *
                         std::max({1.0, detail::lengthSquared(e1),
                                   detail::lengthSquared(e2)})) {
            continue;
        }

        const double du1 =
            static_cast<double>(c1.uv.u) - static_cast<double>(c0.uv.u);
        const double dv1 =
            static_cast<double>(c1.uv.v) - static_cast<double>(c0.uv.v);
        const double du2 =
            static_cast<double>(c2.uv.u) - static_cast<double>(c0.uv.u);
        const double dv2 =
            static_cast<double>(c2.uv.v) - static_cast<double>(c0.uv.v);
        const double det = du1 * dv2 - du2 * dv1;

        // Degenerate UV mapping: the Jacobian is not invertible.
        const double uv_scale =
            std::max({1.0, du1 * du1 + dv1 * dv1,
                      du2 * du2 + dv2 * dv2});
        if (std::fabs(det) <= kTangentEps * std::sqrt(uv_scale)) {
            continue;
        }

        const double inv_det = 1.0 / det;
        const detail::DVec3 tangent = (e1 * dv2 - e2 * dv1) * inv_det;

        // Handedness records whether the UV parameterization (T, B_uv)
        // agrees in orientation with the surface frame (T, cross(N, T)) used
        // by the shader bitangent B = cross(N, T) * w. Since
        // cross(T, B_uv) = cross(e1, e2) / det, its orientation relative to
        // the corner normal is sign(det * dot(geoNormal, N)). Mirrored UVs
        // make det negative and yield -1; the product stays invariant under
        // triangle reordering, including winding flips.
        const detail::DVec3 normal = detail::toD(c0.normal);
        const double frame_dot = det * detail::dot(geometric_normal, normal);
        const std::int8_t handedness =
            frame_dot >= 0.0 ? static_cast<std::int8_t>(1)
                             : static_cast<std::int8_t>(-1);

        const CornerInput* face_corners[3] = {&c0, &c1, &c2};
        for (int k = 0; k < 3; ++k) {
            const CornerInput* prev = face_corners[(k + 2) % 3];
            const CornerInput* cur = face_corners[k];
            const CornerInput* next = face_corners[(k + 1) % 3];

            const detail::DVec3 to_prev =
                detail::toD(prev->position) - detail::toD(cur->position);
            const detail::DVec3 to_next =
                detail::toD(next->position) - detail::toD(cur->position);
            const double cos_angle =
                detail::dot(to_prev, to_next) /
                (detail::length(to_prev) * detail::length(to_next));
            const double angle =
                std::acos(std::clamp(cos_angle, -1.0, 1.0));

            const detail::AccumKey key{
                cur->position, cur->normal, cur->uv, handedness};
            accum[key] += tangent * angle;
            corner_keys[face * 3 + k] = key;
        }
    }

    std::vector<TangentOutput> output(corner_count);
    for (std::size_t i = 0; i < corner_count; ++i) {
        const CornerInput& c = corners[i];
        const detail::DVec3 n = detail::toD(c.normal);
        const detail::AccumKey& key = corner_keys[i];

        detail::DVec3 tangent;
        const auto found = accum.find(key);
        if (found == accum.end() ||
            detail::lengthSquared(found->second) <=
                kTangentEps * kTangentEps) {
            // Degenerate UV, zero-area face, or contributions canceled out.
            tangent = detail::fallbackTangent(n);
        } else {
            tangent = detail::orthonormalize(found->second, n);
        }

        output[i].tangent =
            Vec3{static_cast<float>(tangent.x), static_cast<float>(tangent.y),
                 static_cast<float>(tangent.z)};
        output[i].handedness = static_cast<float>(key.handedness);
    }
    return output;
}

// Indexed-mesh convenience wrapper. The three index arrays are expanded into
// per-corner position, normal and UV records.
inline std::vector<TangentOutput> computeTangents(
    const std::vector<Vec3>& positions,
    const std::vector<Vec3>& normals,
    const std::vector<Vec2>& uvs,
    const std::vector<std::uint32_t>& indices,
    const TangentOptions& options = {}) {
    if (indices.size() % 3 != 0) {
        throw std::invalid_argument(
            "tangent: index count must be a multiple of three");
    }
    const std::size_t vertex_count =
        std::max({positions.size(), normals.size(), uvs.size()});
    std::vector<CornerInput> corners;
    corners.reserve(indices.size());
    for (std::uint32_t idx : indices) {
        if (static_cast<std::size_t>(idx) >= vertex_count) {
            throw std::out_of_range(
                "tangent: index " + std::to_string(idx) +
                " exceeds vertex count " + std::to_string(vertex_count));
        }
        CornerInput corner;
        if (idx < positions.size()) corner.position = positions[idx];
        if (idx < normals.size()) corner.normal = normals[idx];
        if (idx < uvs.size()) corner.uv = uvs[idx];
        corners.push_back(corner);
    }
    return computeTangents(corners, options);
}

// Reconstructs the shader-side bitangent B = cross(N, T) * handedness.
// For positive handedness cross(T, B) points along the mesh normal; for
// negative handedness it points opposite, matching a mirrored UV mapping.
inline Vec3 reconstructBitangent(const TangentOutput& frame,
                                 const Vec3& normal) {
    const float tx = normal.y * frame.tangent.z - normal.z * frame.tangent.y;
    const float ty = normal.z * frame.tangent.x - normal.x * frame.tangent.z;
    const float tz = normal.x * frame.tangent.y - normal.y * frame.tangent.x;
    return Vec3{tx * frame.handedness, ty * frame.handedness,
                tz * frame.handedness};
}

}  // namespace tangentgen
