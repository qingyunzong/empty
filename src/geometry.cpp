#include "curve2d/geometry.hpp"

#include <algorithm>

namespace curve2d {

i128 orient(IPoint a, IPoint b, IPoint c) {
  i128 bax = static_cast<i128>(b.x) - a.x;
  i128 bay = static_cast<i128>(b.y) - a.y;
  i128 cax = static_cast<i128>(c.x) - a.x;
  i128 cay = static_cast<i128>(c.y) - a.y;
  return bax * cay - bay * cax;
}

namespace {

PairResult pointResult(IPoint p) {
  PairResult r;
  r.kind = PairKind::Point;
  r.point = Point{Rational(p.x), Rational(p.y)};
  return r;
}

bool onSegmentInt(const Segment& s, IPoint p) {
  if (orient(s.a, s.b, p) != 0) return false;
  return std::min(s.a.x, s.b.x) <= p.x && p.x <= std::max(s.a.x, s.b.x) &&
         std::min(s.a.y, s.b.y) <= p.y && p.y <= std::max(s.a.y, s.b.y);
}

// Collinear (both non-degenerate) segments: project on the dominant axis of s
// and intersect the 1D intervals. Overlap endpoints are original endpoints.
PairResult collinearPair(const Segment& s, const Segment& t) {
  i128 dx = static_cast<i128>(s.b.x) - s.a.x;
  i128 dy = static_cast<i128>(s.b.y) - s.a.y;
  bool useX = abs128(dx) >= abs128(dy);
  auto proj = [&](IPoint p) { return useX ? p.x : p.y; };

  int64_t lo1 = std::min(proj(s.a), proj(s.b));
  int64_t hi1 = std::max(proj(s.a), proj(s.b));
  int64_t lo2 = std::min(proj(t.a), proj(t.b));
  int64_t hi2 = std::max(proj(t.a), proj(t.b));
  int64_t lo = std::max(lo1, lo2);
  int64_t hi = std::min(hi1, hi2);
  if (lo > hi) return {};

  auto endpointFor = [&](int64_t v) -> IPoint {
    for (IPoint p : {s.a, s.b, t.a, t.b})
      if (proj(p) == v) return p;
    return IPoint{}; // unreachable: lo/hi are endpoint projections
  };

  IPoint pa = endpointFor(lo);
  if (lo == hi) return pointResult(pa);
  IPoint pb = endpointFor(hi);
  PairResult r;
  r.kind = PairKind::Overlap;
  r.ovA = std::min(pa, pb);
  r.ovB = std::max(pa, pb);
  return r;
}

} // namespace

PairResult intersectPair(const Segment& s, const Segment& t) {
  bool sDeg = s.a == s.b;
  bool tDeg = t.a == t.b;
  if (sDeg && tDeg) return s.a == t.a ? pointResult(s.a) : PairResult{};
  if (sDeg) return onSegmentInt(t, s.a) ? pointResult(s.a) : PairResult{};
  if (tDeg) return onSegmentInt(s, t.a) ? pointResult(t.a) : PairResult{};

  i128 o1 = orient(s.a, s.b, t.a);
  i128 o2 = orient(s.a, s.b, t.b);
  i128 o3 = orient(t.a, t.b, s.a);
  i128 o4 = orient(t.a, t.b, s.b);

  if (o1 == 0 && o2 == 0) return collinearPair(s, t);

  bool straddleS = o1 == 0 || o2 == 0 || (o1 < 0) != (o2 < 0);
  bool straddleT = o3 == 0 || o4 == 0 || (o3 < 0) != (o4 < 0);
  if (!straddleS || !straddleT) return {};

  // Unique crossing point: s.a + r * (tnum / den), r = s.b - s.a.
  i128 rx = static_cast<i128>(s.b.x) - s.a.x;
  i128 ry = static_cast<i128>(s.b.y) - s.a.y;
  i128 sx = static_cast<i128>(t.b.x) - t.a.x;
  i128 sy = static_cast<i128>(t.b.y) - t.a.y;
  i128 qpx = static_cast<i128>(t.a.x) - s.a.x;
  i128 qpy = static_cast<i128>(t.a.y) - s.a.y;
  i128 den = rx * sy - ry * sx; // nonzero: lines are not parallel
  i128 tnum = qpx * sy - qpy * sx;
  Rational param(tnum, den);
  PairResult r;
  r.kind = PairKind::Point;
  r.point = Point{Rational(s.a.x) + Rational(rx) * param,
                  Rational(s.a.y) + Rational(ry) * param};
  return r;
}

bool onSegment(const Segment& s, const Point& p) {
  Rational cross = Rational(static_cast<i128>(s.b.x) - s.a.x) * (p.y - Rational(s.a.y)) -
                   Rational(static_cast<i128>(s.b.y) - s.a.y) * (p.x - Rational(s.a.x));
  if (!cross.isZero()) return false;
  int64_t loX = std::min(s.a.x, s.b.x), hiX = std::max(s.a.x, s.b.x);
  int64_t loY = std::min(s.a.y, s.b.y), hiY = std::max(s.a.y, s.b.y);
  return Rational(loX) <= p.x && p.x <= Rational(hiX) && Rational(loY) <= p.y &&
         p.y <= Rational(hiY);
}

} // namespace curve2d
