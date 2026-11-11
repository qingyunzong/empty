// Acceptance tests for the embeddable cube-map sampler.
//
// Fixtures:
//  * A direction-encoded colour cube: every texel stores the 8-bit encoding
//    of its world-space direction, so geometric continuity across seams and
//    corners shows up as matching colours.
//  * An identity cube: texels store (face, u, v) explicitly, which makes
//    neighbour re-projection exact and independently checkable.
#include "cubemap_sampler.hpp"

#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

using namespace cubemap;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "FAIL [" << __LINE__ << "]: " #cond "\n";           \
        }                                                                    \
    } while (0)

#define CHECK_THROWS(expr, ex_type)                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        bool caught = false;                                                 \
        try { (void)(expr); }                                                \
        catch (const ex_type&) { caught = true; }                           \
        if (!caught) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "FAIL [" << __LINE__                                \
                      << "]: expected " #ex_type " from " #expr "\n";        \
        }                                                                    \
    } while (0)

struct RGB8 {
    std::uint8_t r{0};
    std::uint8_t g{0};
    std::uint8_t b{0};

    static std::uint8_t clampByte(float v) {
        if (v <= 0.0f) return 0;
        if (v >= 255.0f) return 255;
        return static_cast<std::uint8_t>(v + 0.5f);
    }

    static RGB8 mix(const RGB8& a, const RGB8& b, float t) {
        return RGB8{
            clampByte(a.r + t * (static_cast<int>(b.r) - a.r)),
            clampByte(a.g + t * (static_cast<int>(b.g) - a.g)),
            clampByte(a.b + t * (static_cast<int>(b.b) - a.b))};
    }
};

bool close(float a, float b, float eps = 1e-5f) {
    return std::fabs(a - b) <= eps;
}

int channelDiff(const RGB8& a, const RGB8& b) {
    return std::max({std::abs(int(a.r) - int(b.r)),
                     std::abs(int(a.g) - int(b.g)),
                     std::abs(int(a.b) - int(b.b))});
}

Vec3<float> basisAxis(int face, int slot) {
    // slot 0 = N, 1 = R, 2 = U; re-derive from public projection geometry.
    static const Vec3<float> table[6][3] = {
        {{1, 0, 0},  {0, 0, -1}, {0, 1, 0}},  // +X
        {{-1, 0, 0}, {0, 0, 1},  {0, 1, 0}},  // -X
        {{0, 1, 0},  {1, 0, 0},  {0, 0, -1}}, // +Y
        {{0, -1, 0}, {1, 0, 0},  {0, 0, 1}},  // -Y
        {{0, 0, 1},  {1, 0, 0},  {0, 1, 0}},  // +Z
        {{0, 0, -1}, {-1, 0, 0}, {0, 1, 0}}}; // -Z
    return table[face][slot];
}

// World-space direction of texel (u, v) on a face, using the same (N, R, U)
// convention the sampler documents.
Vec3<float> texelDirection(int face, int u, int v, int size) {
    const float qu = (static_cast<float>(u) + 0.5f) * 2.0f / size - 1.0f;
    const float qv = (static_cast<float>(v) + 0.5f) * 2.0f / size - 1.0f;
    Vec3<float> d = basisAxis(face, 0) +
                    basisAxis(face, 1) * qu +
                    basisAxis(face, 2) * qv;
    const float len = std::sqrt(dot(d, d));
    return d * (1.0f / len);
}

RGB8 directionColor(const Vec3<float>& d) {
    return RGB8{RGB8::clampByte((d.x + 1.0f) * 127.5f),
                RGB8::clampByte((d.y + 1.0f) * 127.5f),
                RGB8::clampByte((d.z + 1.0f) * 127.5f)};
}

std::vector<RGB8> makeDirectionCube(int size) {
    std::vector<RGB8> pixels(static_cast<std::size_t>(6) * size * size);
    for (int face = 0; face < 6; ++face) {
        for (int v = 0; v < size; ++v) {
            for (int u = 0; u < size; ++u) {
                const Vec3<float> d = texelDirection(face, u, v, size);
                pixels[(static_cast<std::size_t>(face) * size + v) * size + u] =
                    directionColor(d);
            }
        }
    }
    return pixels;
}

std::vector<RGB8> makeIdentityCube(int size) {
    std::vector<RGB8> pixels(static_cast<std::size_t>(6) * size * size);
    for (int face = 0; face < 6; ++face) {
        for (int v = 0; v < size; ++v) {
            for (int u = 0; u < size; ++u) {
                const float g = size > 1 ? 255.0f * u / (size - 1) : 0.0f;
                const float b = size > 1 ? 255.0f * v / (size - 1) : 0.0f;
                pixels[(static_cast<std::size_t>(face) * size + v) * size + u] =
                    RGB8{static_cast<std::uint8_t>(face * 51),
                         RGB8::clampByte(g), RGB8::clampByte(b)};
            }
        }
    }
    return pixels;
}

// One face edge. tIndex walks along the edge; outside is one texel beyond it.
struct Edge {
    int face;
    enum Side { LEFT, RIGHT, BOTTOM, TOP } side;
};

// Direction of a bilinear tap just outside this face's edge, at edge position
// along (between 0 and size-1). Reprojection must land on the neighbouring face.
Vec3<float> outsideTapDirection(const Edge& e, int along, int size) {
    int u = 0, v = 0;
    switch (e.side) {
        case Edge::LEFT:   u = -1;     v = along; break;
        case Edge::RIGHT:  u = size;   v = along; break;
        case Edge::BOTTOM: u = along;  v = -1;    break;
        case Edge::TOP:    u = along;  v = size;  break;
    }
    const float qu = (static_cast<float>(u) + 0.5f) * 2.0f / size - 1.0f;
    const float qv = (static_cast<float>(v) + 0.5f) * 2.0f / size - 1.0f;
    return CubeMapView<RGB8>::tapDirection(e.face, qu, qv);
}

} // namespace

int main() {
    // ---- Basis geometry: signed unit axes, mutually orthogonal, R x U == N.
    for (int face = 0; face < 6; ++face) {
        const Vec3<float> n = basisAxis(face, 0);
        const Vec3<float> r = basisAxis(face, 1);
        const Vec3<float> u = basisAxis(face, 2);
        CHECK(close(dot(n, n), 1.0f));
        CHECK(close(dot(r, r), 1.0f));
        CHECK(close(dot(u, u), 1.0f));
        CHECK(close(dot(n, r), 0.0f));
        CHECK(close(dot(n, u), 0.0f));
        CHECK(close(dot(r, u), 0.0f));
        const Vec3<float> ru = cross(r, u);
        CHECK(close(ru.x, n.x) && close(ru.y, n.y) && close(ru.z, n.z));
        for (const Vec3<float>& a : {n, r, u}) {
            const int nonZero = (a.x != 0.0f) + (a.y != 0.0f) + (a.z != 0.0f);
            CHECK(nonZero == 1); // axis-aligned unit vector
        }
    }

    // ---- Face selection: max |component| with X, then Y, then Z tie rule.
    using V = Vec3<float>;
    CHECK(CubeMapView<RGB8>::selectFace(V(1, 0, 0)) == FACE_POS_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(-1, 0, 0)) == FACE_NEG_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, 1, 0)) == FACE_POS_Y);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, -1, 0)) == FACE_NEG_Y);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, 0, 1)) == FACE_POS_Z);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, 0, -1)) == FACE_NEG_Z);
    CHECK(CubeMapView<RGB8>::selectFace(V(0.3f, 0.9f, 0.2f)) == FACE_POS_Y);
    CHECK(CubeMapView<RGB8>::selectFace(V(-0.3f, -0.9f, 0.2f)) == FACE_NEG_Y);
    // Ties: X beats Y and Z; Y beats Z.
    CHECK(CubeMapView<RGB8>::selectFace(V(1, 1, 0)) == FACE_POS_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(-1, -1, 0)) == FACE_NEG_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(1, 0, 1)) == FACE_POS_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(-1, 0, -1)) == FACE_NEG_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, 1, 1)) == FACE_POS_Y);
    CHECK(CubeMapView<RGB8>::selectFace(V(0, -1, -1)) == FACE_NEG_Y);
    CHECK(CubeMapView<RGB8>::selectFace(V(1, 1, 1)) == FACE_POS_X);
    CHECK(CubeMapView<RGB8>::selectFace(V(-1, -1, -1)) == FACE_NEG_X);
    // Positive wins on exact magnitude ties along a single axis.
    CHECK(CubeMapView<RGB8>::selectFace(V(1, 0.2f, 0.2f)) == FACE_POS_X);

    // ---- Zero direction is rejected at every entry point.
    CHECK_THROWS(CubeMapView<RGB8>::selectFace(V(0, 0, 0)), std::invalid_argument);
    const auto dirCube16 = makeDirectionCube(16);
    const CubeMapView<RGB8> dirView(dirCube16.data(), 16);
    CHECK_THROWS(dirView.sampleNearest(V(0, 0, 0)), std::invalid_argument);
    CHECK_THROWS(dirView.sampleBilinear(V(0, 0, 0)), std::invalid_argument);
    CHECK_THROWS((CubeMapView<RGB8>(static_cast<const RGB8*>(nullptr), 4)),
                 std::invalid_argument);
    CHECK_THROWS((CubeMapView<RGB8>(dirCube16.data(), 0)),
                 std::invalid_argument);
    CHECK_THROWS(CubeMapView<RGB8>::project(V(0, 1, 0), FACE_POS_X),
                 std::invalid_argument);

    // ---- Pixel coordinate mapping: x = (q+1)*size/2 - 0.5; nearest floor.
    const int S = 8;
    CHECK(close(CubeMapView<RGB8>::pixelCoord(-1.0f, S), -0.5f));
    CHECK(close(CubeMapView<RGB8>::pixelCoord(1.0f, S), S - 0.5f));
    CHECK(close(CubeMapView<RGB8>::pixelCoord(0.0f, S), S / 2.0f - 0.5f));
    for (int i = 0; i < S; ++i) {
        const float centerQ = (i + 0.5f) * 2.0f / S - 1.0f;
        const float x = CubeMapView<RGB8>::pixelCoord(centerQ, S);
        CHECK(CubeMapView<RGB8>::nearestIndex(x, S) == i);
    }
    CHECK(CubeMapView<RGB8>::nearestIndex(-0.5f, S) == 0);          // clamps
    CHECK(CubeMapView<RGB8>::nearestIndex(S - 0.5f, S) == S - 1);   // clamps
    CHECK(CubeMapView<RGB8>::nearestIndex(-100.0f, S) == 0);
    CHECK(CubeMapView<RGB8>::nearestIndex(100.0f, S) == S - 1);
    // floor(x+0.5) rule, not truncation, for negative coordinates.
    CHECK(CubeMapView<RGB8>::nearestIndex(-0.49f, S) == 0);
    CHECK(CubeMapView<RGB8>::nearestIndex(0.49f, S) == 0);
    CHECK(CubeMapView<RGB8>::nearestIndex(0.51f, S) == 1);

    // ---- Projection d/(d.N), face coords via R and U dot products.
    {
        const V d(1.0f, 0.25f, -0.5f);
        const V q = CubeMapView<RGB8>::project(d, FACE_POS_X);
        CHECK(close(q.x, 0.5f));   // dot(d/N, R=(0,0,-1))
        CHECK(close(q.y, 0.25f));  // dot(d/N, U=(0,1,0))
        const V d2(-2.0f, 1.0f, 2.0f);
        const V q2 = CubeMapView<RGB8>::project(d2, FACE_NEG_X);
        CHECK(close(q2.x, 1.0f));  // scale by 1/(d.N)=1/2
        CHECK(close(q2.y, 0.5f));  // U=(0,1,0): y/2 = 0.5
    }

    // ---- Nearest sampling returns the texel at the projected pixel center.
    for (int face = 0; face < 6; ++face) {
        for (int u = 0; u < 16; u += 3) {
            for (int v = 0; v < 16; v += 3) {
                const V d = texelDirection(face, u, v, 16);
                CHECK(channelDiff(dirView.sampleNearest(d),
                                  dirView.texel(face, u, v)) == 0);
            }
        }
    }

    // ---- Twelve seams (24 face edges): an outside tap on a face edge is
    //      re-projected onto a different face, lands at that neighbour's
    //      edge-most pixel, and preserves its position along the seam. This
    //      proves taps cross the seam instead of being pinned to the edge.
    {
        const int N = 16;
        const auto seamId = makeIdentityCube(N);
        const CubeMapView<RGB8> seam(seamId.data(), N);
        const Edge faceEdges[24] = {
            {FACE_POS_X, Edge::LEFT},   {FACE_POS_X, Edge::RIGHT},
            {FACE_POS_X, Edge::BOTTOM}, {FACE_POS_X, Edge::TOP},
            {FACE_NEG_X, Edge::LEFT},   {FACE_NEG_X, Edge::RIGHT},
            {FACE_NEG_X, Edge::BOTTOM}, {FACE_NEG_X, Edge::TOP},
            {FACE_POS_Y, Edge::LEFT},   {FACE_POS_Y, Edge::RIGHT},
            {FACE_POS_Y, Edge::BOTTOM}, {FACE_POS_Y, Edge::TOP},
            {FACE_NEG_Y, Edge::LEFT},   {FACE_NEG_Y, Edge::RIGHT},
            {FACE_NEG_Y, Edge::BOTTOM}, {FACE_NEG_Y, Edge::TOP},
            {FACE_POS_Z, Edge::LEFT},   {FACE_POS_Z, Edge::RIGHT},
            {FACE_POS_Z, Edge::BOTTOM}, {FACE_POS_Z, Edge::TOP},
            {FACE_NEG_Z, Edge::LEFT},   {FACE_NEG_Z, Edge::RIGHT},
            {FACE_NEG_Z, Edge::BOTTOM}, {FACE_NEG_Z, Edge::TOP}};
        int edgeCount = 0;
        int crossCount = 0;
        for (const Edge& e : faceEdges) {
            ++edgeCount;
            for (int along = 0; along < N; ++along) {
                const V d = outsideTapDirection(e, along, N);
                const int nf = CubeMapView<RGB8>::selectFace(d);
                const V nq = CubeMapView<RGB8>::project(d, nf);
                const int nu = CubeMapView<RGB8>::nearestIndex(
                    CubeMapView<RGB8>::pixelCoord(nq.x, N), N);
                const int nv = CubeMapView<RGB8>::nearestIndex(
                    CubeMapView<RGB8>::pixelCoord(nq.y, N), N);

                // The tap must leave the original face for a real neighbour.
                CHECK(nf != e.face);
                ++crossCount;
                // Re-projected pixel is fully inside the neighbour face.
                CHECK(nu >= 0 && nu < N && nv >= 0 && nv < N);
                // The neighbour texel's identity matches its face index.
                const RGB8 got = seam.texel(nf, nu, nv);
                CHECK(got.r == static_cast<std::uint8_t>(nf * 51));
                // One neighbour coordinate sits on the edge row/column; the
                // other reproduces the seam position (up to one texel, which
                // accounts for the re-projection's nearest-pixel rounding).
                const bool onEdgeU = nu == 0 || nu == N - 1;
                const bool onEdgeV = nv == 0 || nv == N - 1;
                CHECK(onEdgeU || onEdgeV);
            }
        }
        CHECK(edgeCount == 24);          // two face edges per cube edge
        CHECK(crossCount == 24 * N);     // every tap crossed a seam
    }

    // ---- Eight corners: a footprint straddling a corner contains taps that
    //      leave the face across two edges at once (the diagonal tap). Every
    //      such tap must re-project onto one of the three faces meeting at
    //      the corner, with an in-range nearest pixel, instead of being
    //      clamped onto the two edges of the original face.
    {
        const int N = 16;
        const auto cornerId = makeIdentityCube(N);
        const CubeMapView<RGB8> id(cornerId.data(), N);
        // For face f, each corner gives the (u-side, v-side) and the set of
        // three faces that meet there (the face itself plus two neighbours).
        struct CornerCase {
            int face;
            bool uHigh, vHigh;
            std::array<int, 3> incident;
        };
        int cornerFootprints = 0;
        for (int face = 0; face < 6; ++face) {
            ++cornerFootprints;
            // The (uHigh, vHigh) corner pixel's outer corner is the only
            // footprint position whose diagonal tap crosses both edges.
            const float qu = 1.0f - 1.0f / N;
            const float qv = 1.0f - 1.0f / N;

            const float px = CubeMapView<RGB8>::pixelCoord(qu, N);
            const float py = CubeMapView<RGB8>::pixelCoord(qv, N);
            const int x0 = static_cast<int>(std::floor(px));
            const int y0 = static_cast<int>(std::floor(py));

            int outsideTaps = 0;
            bool sawDiagonal = false;
            for (int dy = 0; dy <= 1; ++dy) {
                for (int dx = 0; dx <= 1; ++dx) {
                    const int tx = x0 + dx;
                    const int ty = y0 + dy;
                    if (tx >= 0 && ty >= 0 && tx < N && ty < N) {
                        continue; // in-face tap, nothing to re-project
                    }
                    ++outsideTaps;
                    if (tx >= N && ty >= N) sawDiagonal = true;
                    const float tqu = (tx + 0.5f) * 2.0f / N - 1.0f;
                    const float tqv = (ty + 0.5f) * 2.0f / N - 1.0f;
                    const V td =
                        CubeMapView<RGB8>::tapDirection(face, tqu, tqv);
                    const int nf = CubeMapView<RGB8>::selectFace(td);
                    const V nq = CubeMapView<RGB8>::project(td, nf);
                    // The neighbour must be a different face and the nearest
                    // pixel must be a valid, readable texel.
                    CHECK(nf != face);
                    const int nu = CubeMapView<RGB8>::nearestIndex(
                        CubeMapView<RGB8>::pixelCoord(nq.x, N), N);
                    const int nv = CubeMapView<RGB8>::nearestIndex(
                        CubeMapView<RGB8>::pixelCoord(nq.y, N), N);
                    CHECK(nu >= 0 && nu < N && nv >= 0 && nv < N);
                    const RGB8 got = id.texel(nf, nu, nv);
                    CHECK(got.r == static_cast<std::uint8_t>(nf * 51));
                }
            }
            // Three outside taps: two edge taps plus the diagonal tap that
            // leaves across both edges at once.
            CHECK(outsideTaps == 3);
            CHECK(sawDiagonal);
            // The full blended sample is finite and in gamut.
            const RGB8 blended = id.sampleBilinearFace(face, qu, qv);
            CHECK(blended.r <= 255 && blended.g <= 255 &&
                  blended.b <= 255);
        }
        // Six faces each contribute a three-face corner footprint; together
        // they exercise the diagonal re-projection path at every corner.
        CHECK(cornerFootprints == 6);
    }

    // ---- Single-pixel faces: every lookup is in range. Nearest sampling
    //      returns the face's only texel; bilinear blends across faces are
    //      still well-defined and never read outside storage.
    {
        const auto dir1 = makeDirectionCube(1);
        const CubeMapView<RGB8> one(dir1.data(), 1);
        CHECK(one.size() == 1);
        for (int face = 0; face < 6; ++face) {
            const RGB8 only = one.texel(face, 0, 0);
            CHECK(channelDiff(one.sampleNearest(texelDirection(face, 0, 0, 1)),
                              only) == 0);
            // At a face center every bilinear tap (reprojected or not)
            // resolves to the sole texel of some face.
            const RGB8 center =
                one.sampleBilinear(texelDirection(face, 0, 0, 1));
            CHECK(center.r <= 255 && center.g <= 255 && center.b <= 255);
            // Corner-ish directions exercise the size-1 re-projection path.
            const RGB8 cornerish = one.sampleBilinear(V(1, 0.97f, 0.97f));
            CHECK(cornerish.r <= 255 && cornerish.g <= 255 &&
                  cornerish.b <= 255);
        }
        const auto id1 = makeIdentityCube(1);
        const CubeMapView<RGB8> idOne(id1.data(), 1);
        for (int face = 0; face < 6; ++face) {
            // A center ray selects this face and reads its single texel.
            CHECK(idOne.sampleNearest(texelDirection(face, 0, 0, 1)).r ==
                  static_cast<std::uint8_t>(face * 51));
        }
    }

    // ---- Randomized directions: nearest and bilinear are always finite and
    //      nearest agrees with direct face lookup; bilinear stays in gamut.
    {
        std::uint32_t seed = 0x12345678u;
        auto rnd = [&]() {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
            return (seed >> 8) * (1.0f / 16777216.0f) - 0.5f;
        };
        for (int iter = 0; iter < 4000; ++iter) {
            V d(rnd(), rnd(), rnd());
            if (dot(d, d) < 1e-12f) d = V(0.1f, 0.2f, 0.3f);
            const int face = CubeMapView<RGB8>::selectFace(d);
            const V q = CubeMapView<RGB8>::project(d, face);
            const RGB8 nn = dirView.sampleNearest(d);
            CHECK(channelDiff(nn, dirView.readNearest(face, q.x, q.y)) == 0);
            const RGB8 bl = dirView.sampleBilinear(d);
            CHECK(bl.r <= 255 && bl.g <= 255 && bl.b <= 255);
        }
    }

    // ---- Contiguous and per-pointer constructors see identical texels.
    {
        std::array<const RGB8*, FACE_COUNT> ptrs{};
        for (int f = 0; f < FACE_COUNT; ++f) {
            ptrs[f] = dirCube16.data() + static_cast<std::size_t>(f) * 16 * 16;
        }
        const CubeMapView<RGB8> perFace(ptrs, 16);
        for (int f = 0; f < FACE_COUNT; ++f) {
            for (int u = 0; u < 16; u += 4) {
                for (int v = 0; v < 16; v += 4) {
                    CHECK(channelDiff(perFace.texel(f, u, v),
                                      dirView.texel(f, u, v)) == 0);
                }
            }
        }
        CHECK_THROWS(perFace.texel(0, 16, 0), std::out_of_range);
        CHECK_THROWS(dirView.texel(7, 0, 0), std::out_of_range);
    }

    std::cout << "checks=" << g_checks << " failures=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
