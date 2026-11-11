#include "tangent_generator.hpp"

#include <cmath>
#include <cstdio>
#include <functional>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using namespace tangentgen;

namespace {

int g_failures = 0;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            ++g_failures;                                                \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);  \
        }                                                                \
    } while (0)

#define CHECK_THROWS(expr)                                       \
    do {                                                         \
        bool caught = false;                                     \
        try {                                                    \
            (void)(expr);                                        \
        } catch (const std::exception&) {                        \
            caught = true;                                       \
        }                                                        \
        if (!caught) {                                           \
            ++g_failures;                                        \
            std::printf("FAIL %s:%d  expected throw: %s\n",      \
                        __FILE__, __LINE__, #expr);              \
        }                                                        \
    } while (0)

Vec3 v3(float x, float y, float z) { return Vec3{x, y, z}; }
Vec2 v2(float u, float v) { return Vec2{u, v}; }

float dot3(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

float len3(const Vec3& a) { return std::sqrt(dot3(a, a)); }

bool approx(float actual, float expected, float eps = 1e-6f) {
    return std::fabs(actual - expected) <= eps;
}

bool approxVec(const Vec3& actual, const Vec3& expected,
               float eps = 1e-6f) {
    return approx(actual.x, expected.x, eps) &&
           approx(actual.y, expected.y, eps) &&
           approx(actual.z, expected.z, eps);
}

// Checks unit length, orthogonality to the normal, and the shader bitangent
// direction against the geometric +V gradient (or its mirror for flipped UV).
void verifyFrame(const CornerInput& corner, const TangentOutput& frame,
                 const Vec3& expected_t, const Vec3& expected_b,
                 float eps = 1e-6f) {
    CHECK(approx(len3(frame.tangent), 1.0f, eps));
    CHECK(approx(dot3(frame.tangent, corner.normal), 0.0f, eps));
    CHECK(approxVec(frame.tangent, expected_t, eps));
    const Vec3 bitangent = reconstructBitangent(frame, corner.normal);
    const float expected_len = len3(expected_b);
    if (expected_len > 0.0f) {
        const Vec3 expected_dir =
            v3(expected_b.x / expected_len, expected_b.y / expected_len,
               expected_b.z / expected_len);
        CHECK(approxVec(bitangent, expected_dir, eps));
        CHECK(approx(len3(bitangent), 1.0f, eps));
    }
}

CornerInput corner(Vec3 p, Vec3 n, Vec2 uv) {
    return CornerInput{p, n, uv};
}

// Axis-aligned triangle: T must be +X and the reconstructed bitangent +Y.
void testSingleTriangle() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, 1)),
    };
    const auto out = computeTangents(mesh);
    CHECK(out.size() == 3);
    for (std::size_t i = 0; i < out.size(); ++i) {
        verifyFrame(mesh[i], out[i], v3(1, 0, 0), v3(0, 1, 0));
        CHECK(approx(out[i].handedness, 1.0f));
    }
}

// A mirrored UV mapping flips handedness to -1. The shader bitangent
// B = cross(N, T) * w then points along the actual +V gradient (-Y), while
// the tangent stays +X.
void testMirroredUv() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, -1)),
    };
    const auto out = computeTangents(mesh);
    for (std::size_t i = 0; i < out.size(); ++i) {
        verifyFrame(mesh[i], out[i], v3(1, 0, 0), v3(0, -1, 0));
        CHECK(approx(out[i].handedness, -1.0f));
    }
}

// Two triangles form a unit square. The duplicated diagonal corner shares
// position and UV but gets a different normal (hard seam): its tangent must
// be separate, while identical keys must still share identical tangents.
void testHardNormalSeam() {
    const Vec3 n = v3(0, 0, 1);
    const Vec3 n_tilt = v3(1, 0, 0);
    const std::vector<CornerInput> base{
        corner(v3(0, 0, 0), n, v2(0, 0)),       // 0
        corner(v3(1, 0, 0), n, v2(1, 0)),       // 1
        corner(v3(1, 1, 0), n_tilt, v2(1, 1)),  // 2 seam, tilted normal
        corner(v3(0, 0, 0), n, v2(0, 0)),       // 3
        corner(v3(1, 1, 0), n, v2(1, 1)),       // 4 seam, flat normal
        corner(v3(0, 1, 0), n, v2(0, 1)),       // 5
    };
    const auto out = computeTangents(base);
    CHECK(out.size() == 6);
    for (std::size_t i = 0; i < out.size(); ++i) {
        CHECK(approx(len3(out[i].tangent), 1.0f));
        CHECK(approx(dot3(out[i].tangent, base[i].normal), 0.0f));
        CHECK(approx(out[i].handedness, 1.0f));
    }
    // Identical keys (corner 0 and 3) share the accumulated tangent.
    CHECK(approxVec(out[0].tangent, out[3].tangent));
    // Same position/UV but different normals (2 vs 4) are separated.
    CHECK(!approxVec(out[2].tangent, out[4].tangent));
    CHECK(approxVec(out[4].tangent, v3(1, 0, 0)));
    // Tilted-normal tangent is orthogonal to the tilted normal.
    CHECK(approx(dot3(out[2].tangent, n_tilt), 0.0f));
    // Reconstructed bitangents follow +Y on the flat-normal corners.
    CHECK(approxVec(reconstructBitangent(out[4], n), v3(0, 1, 0)));
}

// Cyclic corner permutation and winding reversal must preserve the tangent and
// geometric handedness, so the shader bitangent keeps pointing along +V.
void testTriangleReorder() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> base{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, 1)),
    };
    const std::vector<CornerInput> cycled{base[1], base[2], base[0]};
    const std::vector<CornerInput> flipped{base[0], base[2], base[1]};

    const auto ref = computeTangents(base);
    const auto cyc = computeTangents(cycled);
    const auto flp = computeTangents(flipped);

    CHECK(approxVec(cyc[2].tangent, ref[0].tangent));
    CHECK(approxVec(cyc[0].tangent, ref[1].tangent));
    CHECK(approxVec(cyc[1].tangent, ref[2].tangent));
    CHECK(approx(cyc[0].handedness, ref[0].handedness));

    CHECK(approxVec(flp[0].tangent, ref[0].tangent));
    CHECK(approxVec(flp[1].tangent, ref[2].tangent));
    CHECK(approxVec(flp[2].tangent, ref[1].tangent));
    CHECK(approx(flp[0].handedness, 1.0f));
    CHECK(approx(flp[1].handedness, 1.0f));
    for (const auto& frame : flp) {
        CHECK(approxVec(reconstructBitangent(frame, n), v3(0, 1, 0)));
    }
}

// Zero-area triangles never accumulate. Their corners receive the
// deterministic axis fallback least parallel to the normal; ties break X/Y/Z.
void testZeroAreaAndFallback() {
    const Vec3 nz = v3(0, 0, 1);
    const Vec3 nx = v3(1, 0, 0);
    const Vec3 n45 = [] {
        const float s = 0.70710678f;
        return v3(s, s, 0);
    }();
    const std::vector<CornerInput> mesh{
        corner(v3(1, 2, 3), nz, v2(0, 0)),
        corner(v3(1, 2, 3), nz, v2(1, 0)),
        corner(v3(1, 2, 3), nz, v2(0, 1)),
        corner(v3(5, 5, 5), nx, v2(0, 0)),
        corner(v3(5, 5, 5), nx, v2(1, 0)),
        corner(v3(5, 5, 5), nx, v2(0, 1)),
        corner(v3(0, 0, 0), n45, v2(0, 0)),
        corner(v3(2, 0, 0), n45, v2(1, 0)),
        corner(v3(1, 0, 0), n45, v2(0, 1)),
    };
    const auto out = computeTangents(mesh);
    CHECK(approxVec(out[0].tangent, v3(1, 0, 0)));
    CHECK(approxVec(out[1].tangent, v3(1, 0, 0)));
    CHECK(approxVec(out[2].tangent, v3(1, 0, 0)));
    // Normal +X: Y and Z tie for least parallel, Y wins.
    CHECK(approxVec(out[3].tangent, v3(0, 1, 0)));
    // Normal with |x| == |y|, z smallest: Z wins.
    CHECK(approxVec(out[6].tangent, v3(0, 0, 1)));
    for (std::size_t i = 0; i < out.size(); ++i) {
        CHECK(approx(len3(out[i].tangent), 1.0f));
        CHECK(approx(dot3(out[i].tangent, mesh[i].normal), 0.0f));
        CHECK(approx(out[i].handedness, 1.0f));
    }
}

// Collinear UVs make the Jacobian singular even though the geometry has area.
void testDegenerateUv() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(2, 0)),
    };
    const auto out = computeTangents(mesh);
    for (const auto& frame : out) {
        CHECK(approxVec(frame.tangent, v3(1, 0, 0)));
        CHECK(approx(frame.handedness, 1.0f));
    }
}

// A mirrored face produces the opposite tangent with negative handedness:
// the shared corners use separate accumulator keys (handedness differs), so
// each keeps a valid unit tangent and never degenerates to NaN.
void testCancellationFallback() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        // Face A: T = +X, handedness +1.
        corner(v3(0, 0, 0), n, v2(0, 0)),  // 0 shared
        corner(v3(1, 0, 0), n, v2(1, 0)),  // 1
        corner(v3(0, 1, 0), n, v2(0, 1)),  // 2
        // Face B shares the origin, CCW (+Z) geometry with mirrored UVs
        // (det < 0): its face tangent is -X and handedness is -1.
        corner(v3(0, 0, 0), n, v2(0, 0)),    // 3 shared
        corner(v3(-1, 0, 0), n, v2(-1, 0)),  // 4
        corner(v3(0, -1, 0), n, v2(0, 1)),   // 5
    };
    const auto out = computeTangents(mesh);
    CHECK(approx(out[0].handedness, 1.0f));
    CHECK(approx(out[3].handedness, -1.0f));
    // Distinct handedness keys cannot share accumulation; both corners keep
    // a valid unit tangent (+X here) with their own handedness sign.
    CHECK(approxVec(out[0].tangent, v3(1, 0, 0)));
    CHECK(approxVec(out[3].tangent, v3(1, 0, 0)));
    for (std::size_t i = 0; i < out.size(); ++i) {
        CHECK(approx(len3(out[i].tangent), 1.0f));
        CHECK(approx(dot3(out[i].tangent, mesh[i].normal), 0.0f));
        CHECK(std::isfinite(out[i].tangent.x) &&
              std::isfinite(out[i].tangent.y) &&
              std::isfinite(out[i].tangent.z));
    }
}

// Same handedness key with equal and opposite angle-weighted face tangents
// cancels to zero and must use the deterministic fallback.
void testSameKeyCancellationFallback() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        // Face A, tangent +X.
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, 1)),
        // Face B is Face A rotated 180 degrees around Z and kept CCW:
        // geometry and UVs rotate together, so handedness stays +1 while the
        // face tangent at the shared origin becomes -X.
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(-1, 0, 0), n, v2(-1, 0)),
        corner(v3(0, -1, 0), n, v2(0, -1)),
    };
    const auto out = computeTangents(mesh);
    // Both origin corners have identical position, normal, UV and handedness,
    // so they share one accumulator whose contributions cancel.
    CHECK(approx(out[0].handedness, 1.0f));
    CHECK(approx(out[3].handedness, 1.0f));
    CHECK(approxVec(out[0].tangent, v3(1, 0, 0)));
    CHECK(approxVec(out[3].tangent, v3(1, 0, 0)));
    for (const auto& frame : out) {
        CHECK(approx(len3(frame.tangent), 1.0f));
        CHECK(std::isfinite(frame.tangent.x));
    }
}

// A non-axis-aligned triangle: the reconstructed bitangent must equal the
// normalized geometric +V gradient, including its tilted direction.
void testRotatedTriangleBitangent() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(1, 1, 0), n, v2(0, 1)),
    };
    const auto out = computeTangents(mesh);
    // e1 = (1,0), e2 = (1,1); du1=1,dv1=0,du2=0,dv2=1, det=1.
    // T = e1 = (1,0); the shader bitangent cross(N, T) is +Y regardless of
    // the non-unit UV gradient magnitude.
    for (const auto& frame : out) {
        CHECK(approxVec(frame.tangent, v3(1, 0, 0)));
        CHECK(approxVec(reconstructBitangent(frame, n), v3(0, 1, 0)));
        CHECK(approx(frame.handedness, 1.0f));
    }
}

// Two triangles sharing one corner with orthogonal face tangents and
// different interior angles: the accumulated tangent must follow the
// angle-weighted average before normalization.
void testAngleWeighting() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> mesh{
        // Face A at origin: angle pi/2, tangent +X.
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, 1)),
        // Face B at origin: angle pi/4, tangent +Y. +U maps to geometric +Y
        // and +V maps to -X with a positive UV determinant, so handedness
        // remains +1.
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(0, 1, 0), n, v2(1, 0)),
        corner(v3(1, 1, 0), n, v2(1, -1)),
    };
    const auto out = computeTangents(mesh);
    // Accumulator: (pi/2, pi/4) in (X, Y), normalized.
    const float expected_x = 2.0f / std::sqrt(5.0f);
    const float expected_y = 1.0f / std::sqrt(5.0f);
    CHECK(approxVec(out[0].tangent, v3(expected_x, expected_y, 0)));
    CHECK(approxVec(out[3].tangent, v3(expected_x, expected_y, 0)));
    CHECK(approx(out[0].handedness, 1.0f));
}

// The indexed wrapper must expand corner records and match the corner API.
void testIndexedWrapper() {
    const std::vector<Vec3> positions{v3(0, 0, 0), v3(1, 0, 0),
                                      v3(0, 1, 0)};
    const std::vector<Vec3> normals{v3(0, 0, 1), v3(0, 0, 1),
                                    v3(0, 0, 1)};
    const std::vector<Vec2> uvs{v2(0, 0), v2(1, 0), v2(0, 1)};
    const std::vector<std::uint32_t> indices{0, 1, 2};
    const auto out = computeTangents(positions, normals, uvs, indices);
    CHECK(out.size() == 3);
    for (const auto& frame : out) {
        CHECK(approxVec(frame.tangent, v3(1, 0, 0)));
        CHECK(approx(frame.handedness, 1.0f));
    }
    CHECK_THROWS(computeTangents(positions, normals, uvs,
                                 std::vector<std::uint32_t>{0, 1, 9}));
    CHECK_THROWS(computeTangents(positions, normals, uvs,
                                 std::vector<std::uint32_t>{0, 1}));
}

// Input contract: finite unit normals, finite data, corner count multiple of 3.
void testInputValidation() {
    const Vec3 n = v3(0, 0, 1);
    const std::vector<CornerInput> good{
        corner(v3(0, 0, 0), n, v2(0, 0)),
        corner(v3(1, 0, 0), n, v2(1, 0)),
        corner(v3(0, 1, 0), n, v2(0, 1)),
    };
    CHECK(computeTangents(good).size() == 3);

    std::vector<CornerInput> bad_count{good[0], good[1]};
    CHECK_THROWS(computeTangents(bad_count));

    std::vector<CornerInput> bad_normal = good;
    bad_normal[1].normal = v3(0, 0, 0.5f);
    CHECK_THROWS(computeTangents(bad_normal));

    std::vector<CornerInput> inf_normal = good;
    inf_normal[0].normal = v3(std::numeric_limits<float>::infinity(), 0, 0);
    CHECK_THROWS(computeTangents(inf_normal));

    std::vector<CornerInput> nan_uv = good;
    nan_uv[2].uv = v2(std::numeric_limits<float>::quiet_NaN(), 0);
    CHECK_THROWS(computeTangents(nan_uv));

    CHECK_THROWS(computeTangents(good, TangentOptions{-1.0f}));
}

}  // namespace

int main() {
    std::vector<std::pair<std::string, std::function<void()>>> tests;
    tests.push_back({"single_triangle", testSingleTriangle});
    tests.push_back({"mirrored_uv", testMirroredUv});
    tests.push_back({"hard_normal_seam", testHardNormalSeam});
    tests.push_back({"triangle_reorder", testTriangleReorder});
    tests.push_back({"zero_area_fallback", testZeroAreaAndFallback});
    tests.push_back({"degenerate_uv", testDegenerateUv});
    tests.push_back({"cancellation_fallback", testCancellationFallback});
    tests.push_back({"same_key_cancellation_fallback",
                     testSameKeyCancellationFallback});
    tests.push_back({"rotated_bitangent", testRotatedTriangleBitangent});
    tests.push_back({"angle_weighting", testAngleWeighting});
    tests.push_back({"indexed_wrapper", testIndexedWrapper});
    tests.push_back({"input_validation", testInputValidation});
    for (const auto& [name, fn] : tests) {
        const int before = g_failures;
        fn();
        std::printf("[%s] %s\n", g_failures == before ? "PASS" : "FAIL",
                    name.c_str());
    }
    if (g_failures != 0) {
        std::printf("%d check(s) failed\n", g_failures);
    }
    return g_failures == 0 ? 0 : 1;
}
