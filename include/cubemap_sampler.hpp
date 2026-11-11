// Embeddable cube-map texture sampler (header-only, C++17).
//
// Conventions
// -----------
// * Six faces, in order: +X, -X, +Y, -Y, +Z, -Z (enum Face).
// * A direction d selects a face by the component with the largest absolute
//   value; ties resolve in axis priority X, then Y, then Z.
// * Each face carries an orthonormal basis (N, R, U): N is the outward face
//   normal, R points right and U points up, with R x U == N.
// * A direction is projected onto a face by scaling it so the normal
//   component is one: d / (d . N); the face coordinates (qu, qv) are the dot
//   products of that projected point with R and U, each in [-1, 1].
// * Face coordinate q maps to pixel coordinate x = (q + 1) * size / 2 - 0.5;
//   the nearest pixel index is floor(x + 0.5), clamped into [0, size-1].
// * Bilinear taps that fall outside a face are reprojected through the
//   neighbouring face using the tap's own direction and read there; taps are
//   never pinned to the edge of the original face.
//
// The component owns no storage: a CubeMapView wraps six face pixel arrays of
// identical square size, either one contiguous block or one pointer per face.
#ifndef CUBEMAP_SAMPLER_HPP
#define CUBEMAP_SAMPLER_HPP

#include <array>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <type_traits>

namespace cubemap {

// Face ordering: +/- X, +/- Y, +/- Z.
enum Face : int {
    FACE_POS_X = 0,
    FACE_NEG_X = 1,
    FACE_POS_Y = 2,
    FACE_NEG_Y = 3,
    FACE_POS_Z = 4,
    FACE_NEG_Z = 5,
    FACE_COUNT = 6
};

// How a bilinear tap landing outside the sampled face is resolved.
enum class EdgePolicy {
    Reproject, // Re-project the tap direction onto the neighbouring face.
    Clamp      // Pin the tap to the current edge (used by tests only).
};

// Minimal 3-component vector; embedding apps may adapt it to their own math.
template <typename T>
struct Vec3 {
    T x{};
    T y{};
    T z{};

    constexpr Vec3() = default;
    constexpr Vec3(T x_, T y_, T z_) : x(x_), y(y_), z(z_) {}

    constexpr Vec3& operator+=(const Vec3& o) {
        x += o.x; y += o.y; z += o.z;
        return *this;
    }
    constexpr Vec3& operator-=(const Vec3& o) {
        x -= o.x; y -= o.y; z -= o.z;
        return *this;
    }
    constexpr Vec3& operator*=(T s) {
        x *= s; y *= s; z *= s;
        return *this;
    }
};

template <typename T>
constexpr Vec3<T> operator+(Vec3<T> a, const Vec3<T>& b) { a += b; return a; }
template <typename T>
constexpr Vec3<T> operator-(Vec3<T> a, const Vec3<T>& b) { a -= b; return a; }
template <typename T>
constexpr Vec3<T> operator*(Vec3<T> v, T s) { v *= s; return v; }

template <typename T>
constexpr T dot(const Vec3<T>& a, const Vec3<T>& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
template <typename T>
constexpr Vec3<T> cross(const Vec3<T>& a, const Vec3<T>& b) {
    return Vec3<T>(a.y * b.z - a.z * b.y,
                   a.z * b.x - a.x * b.z,
                   a.x * b.y - a.y * b.x);
}

namespace detail {

// (N, R, U) basis for every face. R x U == N and all are signed unit axes.
template <typename T>
struct FaceBasis {
    Vec3<T> normal;
    Vec3<T> right;
    Vec3<T> up;
};

template <typename T>
constexpr std::array<FaceBasis<T>, FACE_COUNT> makeBases() {
    using V = Vec3<T>;
    return {{
        {V(1, 0, 0),  V(0, 0, -1), V(0, 1, 0)},  // +X
        {V(-1, 0, 0), V(0, 0, 1),  V(0, 1, 0)},  // -X
        {V(0, 1, 0),  V(1, 0, 0),  V(0, 0, -1)}, // +Y
        {V(0, -1, 0), V(1, 0, 0),  V(0, 0, 1)},  // -Y
        {V(0, 0, 1),  V(1, 0, 0),  V(0, 1, 0)},  // +Z
        {V(0, 0, -1), V(-1, 0, 0), V(0, 1, 0)}   // -Z
    }};
}

template <typename T>
constexpr T absScalar(T v) { return v < T(0) ? -v : v; }

// Pixel mixing customization point: pixel types provide
// static P mix(const P& a, const P& b, float t); arithmetic types work too.
template <typename P>
struct PixelOps {
    static P mix(const P& a, const P& b, float t) {
        if constexpr (std::is_arithmetic_v<P>) {
            return static_cast<P>(static_cast<float>(a) +
                                  t * (static_cast<float>(b) -
                                       static_cast<float>(a)));
        } else {
            return P::mix(a, b, t);
        }
    }
};

} // namespace detail

// Non-owning view of six equal-sized square face images.
//
// Pixels within a face are row-major: pixel (u, v) is at index v * size + u,
// u grows along R and v grows along U.
template <typename Pixel>
class CubeMapView {
public:
    using pixel_type = Pixel;
    using vec3_type = Vec3<float>;

    // One contiguous block holding all six faces back to back.
    CubeMapView(const Pixel* faces, int size)
        : size_(requirePositive(size)) {
        if (faces == nullptr) {
            throw std::invalid_argument("CubeMapView: null face storage");
        }
        for (int i = 0; i < FACE_COUNT; ++i) {
            faces_[i] = faces + static_cast<std::size_t>(i) * facePixels();
        }
    }

    // One pointer per face; each must point at size*size pixels.
    CubeMapView(const std::array<const Pixel*, FACE_COUNT>& faces, int size)
        : size_(requirePositive(size)) {
        for (int i = 0; i < FACE_COUNT; ++i) {
            if (faces[i] == nullptr) {
                throw std::invalid_argument("CubeMapView: null face storage");
            }
            faces_[i] = faces[i];
        }
    }

    int size() const noexcept { return size_; }
    const Pixel* faceData(int face) const { return faces_[faceIndex(face)]; }

    // Face coordinate q in [-1, 1] to pixel coordinate in [-0.5, size-0.5].
    static float pixelCoord(float q, int size) {
        return (q + 1.0f) * 0.5f * static_cast<float>(size) - 0.5f;
    }

    // Nearest pixel index for a pixel coordinate, clamped into the face.
    static int nearestIndex(float x, int size) {
        long i = static_cast<long>(std::floor(x + 0.5f));
        if (i < 0) i = 0;
        if (i > size - 1) i = size - 1;
        return static_cast<int>(i);
    }

    // Choose the face for direction d. Ties resolve X, then Y, then Z.
    // Throws std::invalid_argument for the zero direction.
    static int selectFace(const vec3_type& d) {
        const float ax = detail::absScalar(d.x);
        const float ay = detail::absScalar(d.y);
        const float az = detail::absScalar(d.z);
        if (ax == 0.0f && ay == 0.0f && az == 0.0f) {
            throw std::invalid_argument(
                "CubeMapView: zero direction has no cube face");
        }
        if (ax >= ay && ax >= az) {
            return d.x >= 0.0f ? FACE_POS_X : FACE_NEG_X;
        }
        if (ay >= az) {
            return d.y >= 0.0f ? FACE_POS_Y : FACE_NEG_Y;
        }
        return d.z >= 0.0f ? FACE_POS_Z : FACE_NEG_Z;
    }

    // Project direction d onto face, returning (qu, qv) in [-1, 1].
    static vec3_type project(const vec3_type& d, int face) {
        const auto& b = bases()[faceIndex(face)];
        const float w = dot(d, b.normal);
        if (w == 0.0f) {
            throw std::invalid_argument(
                "CubeMapView: direction is tangent to the target face");
        }
        const vec3_type p = d * (1.0f / w);
        return vec3_type(dot(p, b.right), dot(p, b.up), 0.0f);
    }

    // Rebuild the world-space direction of a face-local tap (qu, qv).
    // The tap may lie outside [-1, 1]; the result is unit length.
    static vec3_type tapDirection(int face, float qu, float qv) {
        const auto& b = bases()[faceIndex(face)];
        const vec3_type d = b.normal + b.right * qu + b.up * qv;
        const float len = std::sqrt(dot(d, d));
        if (len == 0.0f) {
            throw std::invalid_argument(
                "CubeMapView: degenerate tap direction");
        }
        return d * (1.0f / len);
    }

    // Nearest-neighbour sample along direction d.
    Pixel sampleNearest(vec3_type d) const {
        normalizeOrThrow(d);
        const int face = selectFace(d);
        const vec3_type q = project(d, face);
        return readNearest(face, q.x, q.y);
    }

    // Bilinear sample along direction d. Outside taps are re-projected onto
    // the neighbouring face by default.
    Pixel sampleBilinear(vec3_type d,
                         EdgePolicy edgePolicy = EdgePolicy::Reproject) const {
        normalizeOrThrow(d);
        const int face = selectFace(d);
        const vec3_type q = project(d, face);
        return sampleBilinearFace(face, q.x, q.y, edgePolicy);
    }

    // Bilinear sample from explicit face coordinates, handy for fixtures.
    Pixel sampleBilinearFace(int face, float qu, float qv,
                             EdgePolicy edgePolicy =
                                 EdgePolicy::Reproject) const {
        faceIndex(face);
        const float px = pixelCoord(qu, size_);
        const float py = pixelCoord(qv, size_);
        const int x0 = static_cast<int>(std::floor(px));
        const int y0 = static_cast<int>(std::floor(py));
        const float tx = px - static_cast<float>(x0);
        const float ty = py - static_cast<float>(y0);

        const Pixel p00 = fetchTap(face, x0,     y0,     edgePolicy);
        const Pixel p10 = fetchTap(face, x0 + 1, y0,     edgePolicy);
        const Pixel p01 = fetchTap(face, x0,     y0 + 1, edgePolicy);
        const Pixel p11 = fetchTap(face, x0 + 1, y0 + 1, edgePolicy);

        using Ops = detail::PixelOps<Pixel>;
        const Pixel top = Ops::mix(p00, p10, tx);
        const Pixel bottom = Ops::mix(p01, p11, tx);
        return Ops::mix(top, bottom, ty);
    }

    // Nearest pixel at face coordinates (qu, qv).
    Pixel readNearest(int face, float qu, float qv) const {
        const int u = nearestIndex(pixelCoord(qu, size_), size_);
        const int v = nearestIndex(pixelCoord(qv, size_), size_);
        return texel(face, u, v);
    }

    // Read texel (u, v) of a face; coordinates must already be in range.
    Pixel texel(int face, int u, int v) const {
        faceIndex(face);
        if (u < 0 || v < 0 || u >= size_ || v >= size_) {
            throw std::out_of_range(
                "CubeMapView: texel coordinate outside the face");
        }
        return faces_[face][static_cast<std::size_t>(v) * size_ + u];
    }

private:
    static const std::array<detail::FaceBasis<float>, FACE_COUNT>& bases() {
        static const auto b = detail::makeBases<float>();
        return b;
    }

    static int requirePositive(int size) {
        if (size <= 0) {
            throw std::invalid_argument(
                "CubeMapView: face size must be positive");
        }
        return size;
    }

    static int faceIndex(int face) {
        if (face < 0 || face >= FACE_COUNT) {
            throw std::out_of_range("CubeMapView: invalid face index");
        }
        return face;
    }

    std::size_t facePixels() const {
        return static_cast<std::size_t>(size_) *
               static_cast<std::size_t>(size_);
    }

    static void normalizeOrThrow(vec3_type& d) {
        const float len = std::sqrt(dot(d, d));
        if (len == 0.0f) {
            throw std::invalid_argument(
                "CubeMapView: zero direction cannot be sampled");
        }
        d *= 1.0f / len;
    }

    // Resolve one bilinear tap. (tx, ty) are integer pixel coordinates that
    // may be -1 or size; out-of-range taps follow the requested policy.
    Pixel fetchTap(int face, int tx, int ty, EdgePolicy policy) const {
        if (tx >= 0 && ty >= 0 && tx < size_ && ty < size_) {
            return texel(face, tx, ty);
        }

        if (policy == EdgePolicy::Clamp) {
            const int u = tx < 0 ? 0 : (tx >= size_ ? size_ - 1 : tx);
            const int v = ty < 0 ? 0 : (ty >= size_ ? size_ - 1 : ty);
            return texel(face, u, v);
        }

        // Reproject: pixel coordinate -> face coordinate -> world direction
        // -> the face that actually contains it -> nearest pixel there.
        const float tapQu =
            (static_cast<float>(tx) + 0.5f) * 2.0f /
                static_cast<float>(size_) - 1.0f;
        const float tapQv =
            (static_cast<float>(ty) + 0.5f) * 2.0f /
                static_cast<float>(size_) - 1.0f;
        const vec3_type d = tapDirection(face, tapQu, tapQv);
        const int neighbour = selectFace(d);
        const vec3_type q = project(d, neighbour);
        return readNearest(neighbour, q.x, q.y);
    }

    std::array<const Pixel*, FACE_COUNT> faces_{};
    int size_;
};

} // namespace cubemap

#endif // CUBEMAP_SAMPLER_HPP
