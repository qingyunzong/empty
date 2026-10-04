#pragma once

#include <cstdint>

namespace intmesh {

// Integer 3D vector. Components are 64-bit so that cross products of
// typical 32-bit-range coordinates stay exact. Cross products are
// evaluated with well-defined modular arithmetic and are exact as long
// as the true result fits in int64_t (guaranteed when all input
// coordinates satisfy |c| <= 2^30).
struct Vec3i {
  std::int64_t x = 0;
  std::int64_t y = 0;
  std::int64_t z = 0;

  constexpr bool operator==(const Vec3i&) const = default;

  constexpr Vec3i operator+(const Vec3i& o) const {
    return {x + o.x, y + o.y, z + o.z};
  }
  constexpr Vec3i operator-(const Vec3i& o) const {
    return {x - o.x, y - o.y, z - o.z};
  }
  constexpr Vec3i& operator+=(const Vec3i& o) {
    x += o.x; y += o.y; z += o.z;
    return *this;
  }
  constexpr Vec3i& operator-=(const Vec3i& o) {
    x -= o.x; y -= o.y; z -= o.z;
    return *this;
  }
  constexpr bool isZero() const { return x == 0 && y == 0 && z == 0; }
};

namespace detail {
// Well-defined wrapping multiply/subtract via unsigned arithmetic; the
// result is exact whenever the mathematical value fits in int64_t.
constexpr std::int64_t mulSub(std::int64_t a, std::int64_t b,
                              std::int64_t c, std::int64_t d) {
  const auto ua = static_cast<std::uint64_t>(a);
  const auto ub = static_cast<std::uint64_t>(b);
  const auto uc = static_cast<std::uint64_t>(c);
  const auto ud = static_cast<std::uint64_t>(d);
  return static_cast<std::int64_t>(ua * ub - uc * ud);
}
}  // namespace detail

// Exact integer cross product (not normalized).
constexpr Vec3i cross(const Vec3i& a, const Vec3i& b) {
  return {detail::mulSub(a.y, b.z, a.z, b.y),
          detail::mulSub(a.z, b.x, a.x, b.z),
          detail::mulSub(a.x, b.y, a.y, b.x)};
}

}  // namespace intmesh
