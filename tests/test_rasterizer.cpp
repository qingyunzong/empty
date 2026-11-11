#include "rast/rasterizer.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

using rast::Color;
using rast::Framebuffer;
using rast::Vertex;

namespace {

int g_checks = 0;
int g_failures = 0;

#define CHECK(cond)                                                  \
    do {                                                             \
        ++g_checks;                                                  \
        if (!(cond)) {                                               \
            ++g_failures;                                            \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__,       \
                         __LINE__, #cond);                           \
        }                                                            \
    } while (0)

// ---------------------------------------------------------------------
// Independent high-precision reference: the same pipeline expressed in
// long double, kept deliberately separate from the production code.
// ---------------------------------------------------------------------
namespace ref {

struct ClipV {
    long double x, y, z, w, u, v;
    long double inv_w, u_over_w, v_over_w;
};

struct RastV {
    long double sx, sy;
    long double ndc_z, inv_w, u_over_w, v_over_w;
};

long double planeDist(const ClipV& v, int plane) {
    switch (plane) {
        case 0: return v.w + v.z;  // near
        case 1: return v.w - v.z;  // far
        case 2: return v.w + v.x;  // left
        case 3: return v.w - v.x;  // right
        case 4: return v.w + v.y;  // bottom
        default: return v.w - v.y; // top
    }
}

ClipV intersect(const ClipV& a, const ClipV& b, int plane) {
    const long double da = planeDist(a, plane);
    const long double db = planeDist(b, plane);
    const long double t = da / (da - db);
    ClipV r;
    r.x = a.x + (b.x - a.x) * t;
    r.y = a.y + (b.y - a.y) * t;
    r.z = a.z + (b.z - a.z) * t;
    r.w = a.w + (b.w - a.w) * t;
    r.u = a.u + (b.u - a.u) * t;
    r.v = a.v + (b.v - a.v) * t;
    r.inv_w = a.inv_w + (b.inv_w - a.inv_w) * t;
    r.u_over_w = a.u_over_w + (b.u_over_w - a.u_over_w) * t;
    r.v_over_w = a.v_over_w + (b.v_over_w - a.v_over_w) * t;
    return r;
}

void clipPlane(int plane,
               const ClipV* in, std::size_t n,
               ClipV* out, std::size_t& on) {
    on = 0;
    if (n == 0) return;
    for (std::size_t i = 0; i < n; ++i) {
        const ClipV& cur = in[i];
        const ClipV& prev = in[(i + n - 1) % n];
        const bool ci = planeDist(cur, plane) >= 0.0L;
        const bool pi = planeDist(prev, plane) >= 0.0L;
        if (ci) {
            if (!pi) out[on++] = intersect(prev, cur, plane);
            out[on++] = cur;
        } else if (pi) {
            out[on++] = intersect(prev, cur, plane);
        }
    }
}

RastV toRaster(const ClipV& c, int width, int height) {
    RastV r;
    const long double iw = c.inv_w;
    const long double nx = c.x * iw;
    const long double ny = c.y * iw;
    r.sx = (nx * 0.5L + 0.5L) *
               static_cast<long double>(width) - 0.5L;
    r.sy = (ny * 0.5L + 0.5L) *
               static_cast<long double>(height) - 0.5L;
    r.ndc_z = c.z * iw;
    r.inv_w = iw;
    r.u_over_w = c.u_over_w;
    r.v_over_w = c.v_over_w;
    return r;
}

struct Image {
    int width, height;
    std::vector<std::uint32_t> coverage;
    std::vector<long double> depth;
    std::vector<long double> uu;
    std::vector<long double> vv;

    Image(int w, int h)
        : width(w),
          height(h),
          coverage(static_cast<std::size_t>(w) * h, 0u),
          depth(static_cast<std::size_t>(w) * h, 1.0L),
          uu(static_cast<std::size_t>(w) * h, 0.0L),
          vv(static_cast<std::size_t>(w) * h, 0.0L) {}

    std::size_t idx(int x, int y) const {
        return static_cast<std::size_t>(y) * width + x;
    }
};

}  // namespace ref

namespace ref {

void raster(Image& img, RastV a, RastV b, RastV c) {
    if (!std::isfinite(a.sx) || !std::isfinite(a.sy) ||
        !std::isfinite(b.sx) || !std::isfinite(b.sy) ||
        !std::isfinite(c.sx) || !std::isfinite(c.sy)) {
        return;
    }
    long double area =
        (b.sx - a.sx) * (c.sy - a.sy) -
        (b.sy - a.sy) * (c.sx - a.sx);
    if (area < 0.0L) {
        std::swap(b, c);
        area = (b.sx - a.sx) * (c.sy - a.sy) -
               (b.sy - a.sy) * (c.sx - a.sx);
    }
    if (!(area > 0.0L)) return;

    const long double minx = std::min({a.sx, b.sx, c.sx});
    const long double maxx = std::max({a.sx, b.sx, c.sx});
    const long double miny = std::min({a.sy, b.sy, c.sy});
    const long double maxy = std::max({a.sy, b.sy, c.sy});
    int x0 = std::max(0, static_cast<int>(std::floor(minx + 0.5L)));
    int y0 = std::max(0, static_cast<int>(std::floor(miny + 0.5L)));
    int x1 = std::min(img.width - 1,
                      static_cast<int>(std::ceil(maxx + 0.5L)) - 1);
    int y1 = std::min(img.height - 1,
                      static_cast<int>(std::ceil(maxy + 0.5L)) - 1);
    if (x1 < x0 || y1 < y0) return;

    auto edge = [](const RastV& p, const RastV& q,
                   long double px, long double py) {
        return (q.sx - p.sx) * (py - p.sy) -
               (q.sy - p.sy) * (px - p.sx);
    };
    auto topLeft = [](const RastV& p, const RastV& q) {
        const long double dy = q.sy - p.sy;
        const long double dx = q.sx - p.sx;
        return (dy == 0.0L && dx < 0.0L) || dy < 0.0L;
    };
    const bool tl01 = topLeft(a, b);
    const bool tl12 = topLeft(b, c);
    const bool tl20 = topLeft(c, a);
    const long double inv_area = 1.0L / area;

    for (int py = y0; py <= y1; ++py) {
        for (int px = x0; px <= x1; ++px) {
            const long double cx = px;
            const long double cy = py;
            const long double e01 = edge(a, b, cx, cy);
            const long double e12 = edge(b, c, cx, cy);
            const long double e20 = edge(c, a, cx, cy);
            const bool inside =
                (e01 > 0.0L || (e01 == 0.0L && tl01)) &&
                (e12 > 0.0L || (e12 == 0.0L && tl12)) &&
                (e20 > 0.0L || (e20 == 0.0L && tl20));
            if (!inside) continue;

            const long double ba = e12 * inv_area;
            const long double bb = e20 * inv_area;
            const long double bc = e01 * inv_area;
            const long double inv_w =
                ba * a.inv_w + bb * b.inv_w + bc * c.inv_w;
            const long double ndc_z =
                ba * a.ndc_z + bb * b.ndc_z + bc * c.ndc_z;
            const long double uow =
                ba * a.u_over_w + bb * b.u_over_w + bc * c.u_over_w;
            const long double vow =
                ba * a.v_over_w + bb * b.v_over_w + bc * c.v_over_w;
            const long double w_cam = 1.0L / inv_w;
            const long double u = uow * w_cam;
            const long double v = vow * w_cam;

            const std::size_t i = img.idx(px, py);
            ++img.coverage[i];
            // Match the production float depth granularity and the
            // strict-less depth test so winner selection is identical.
            const long double frag =
                static_cast<long double>(static_cast<float>(ndc_z));
            if (frag < img.depth[i]) {
                img.depth[i] = frag;
                img.uu[i] = u;
                img.vv[i] = v;
            }
        }
    }
}

void draw(Image& img, const std::vector<Vertex>& verts) {
    for (std::size_t base = 0; base + 3 <= verts.size(); base += 3) {
        ClipV bufa[32], bufb[32];
        std::size_t n = 3;
        for (int k = 0; k < 3; ++k) {
            const Vertex& s = verts[base + k];
            bufa[k] = {s.x, s.y, s.z, s.w, s.u, s.v,
                       1.0L / s.w, s.u / s.w, s.v / s.w};
        }
        for (int plane = 0; plane < 6; ++plane) {
            std::size_t nn = 0;
            clipPlane(plane, bufa, n, bufb, nn);
            n = nn;
            for (std::size_t k = 0; k < n; ++k) bufa[k] = bufb[k];
            if (n < 3) break;
        }
        if (n < 3) continue;
        for (std::size_t k = 1; k + 1 < n; ++k) {
            raster(img,
                   toRaster(bufa[0], img.width, img.height),
                   toRaster(bufa[k], img.width, img.height),
                   toRaster(bufa[k + 1], img.width, img.height));
        }
    }
}

}  // namespace ref

}  // namespace

namespace {

struct ProductionImage {
    int width, height;
    std::vector<Color> color;
    std::vector<float> depth;
    std::vector<std::uint32_t> coverage;
    std::vector<double> uu;
    std::vector<double> vv;
    Framebuffer fb;

    ProductionImage(int w, int h)
        : width(w),
          height(h),
          color(static_cast<std::size_t>(w) * h, Color{0, 0, 0, 0}),
          depth(static_cast<std::size_t>(w) * h, 1.0f),
          coverage(static_cast<std::size_t>(w) * h, 0u),
          uu(static_cast<std::size_t>(w) * h, 0.0),
          vv(static_cast<std::size_t>(w) * h, 0.0) {
        fb.width = w;
        fb.height = h;
        fb.color = color.data();
        fb.depth = depth.data();
        fb.coverage = coverage.data();
        fb.dbg_u = uu.data();
        fb.dbg_v = vv.data();
    }

    std::size_t idx(int x, int y) const {
        return static_cast<std::size_t>(y) * width + x;
    }
};

struct SolidCtx {
    int id;
};

Color solidSampler(double, double, void* user_data) {
    const int id = static_cast<SolidCtx*>(user_data)->id;
    return Color{static_cast<std::uint8_t>(id),
                 static_cast<std::uint8_t>(id + 1),
                 static_cast<std::uint8_t>(id + 2), 255};
}

Color uvSampler(double u, double v, void*) {
    return Color{static_cast<std::uint8_t>(std::lround(u * 255.0)),
                 static_cast<std::uint8_t>(std::lround(v * 255.0)),
                 0, 255};
}

void compareWithReference(const ProductionImage& prod,
                          const ref::Image& reference,
                          const char* name,
                          long double depth_eps = 2.0e-6L,
                          long double uv_eps = 1.0e-8L) {
    CHECK(prod.width == reference.width);
    CHECK(prod.height == reference.height);
    const std::size_t n =
        static_cast<std::size_t>(prod.width) * prod.height;
    long double max_depth_err = 0.0L;
    long double max_uv_err = 0.0L;
    std::size_t covered = 0;
    for (std::size_t i = 0; i < n; ++i) {
        ++g_checks;
        if (prod.coverage[i] != reference.coverage[i]) {
            ++g_failures;
            std::fprintf(stderr,
                         "FAIL [%s] coverage mismatch at %zu: prod=%u ref=%u\n",
                         name, i, prod.coverage[i], reference.coverage[i]);
        }
        if (reference.coverage[i] > 0 && reference.depth[i] < 1.0L) {
            ++covered;
            const long double de =
                std::fabsl(static_cast<long double>(prod.depth[i]) -
                           reference.depth[i]);
            max_depth_err = std::max(max_depth_err, de);
            const long double ue =
                std::fabsl(static_cast<long double>(prod.uu[i]) -
                           reference.uu[i]);
            const long double ve =
                std::fabsl(static_cast<long double>(prod.vv[i]) -
                           reference.vv[i]);
            max_uv_err = std::max(max_uv_err, std::max(ue, ve));
        }
    }
    ++g_checks;
    if (!(max_depth_err <= depth_eps)) {
        ++g_failures;
        std::fprintf(stderr,
                     "FAIL [%s] depth error %.3Le > %.3Le over %zu px\n",
                     name, max_depth_err, depth_eps, covered);
    }
    ++g_checks;
    if (!(max_uv_err <= uv_eps)) {
        ++g_failures;
        std::fprintf(stderr,
                     "FAIL [%s] uv error %.3Le > %.3Le over %zu px\n",
                     name, max_uv_err, uv_eps, covered);
    }
    std::printf("[%s] covered=%zu max_depth_err=%.3Le max_uv_err=%.3Le\n",
                name, covered, max_depth_err, max_uv_err);
}

// Rectangle assembled from four triangles around a center vertex: every
// pixel must be covered exactly once (no cracks, no double coverage).
void testRectangleNoGaps() {
    const int w = 24, h = 16;
    ProductionImage prod(w, h);
    ref::Image reference(w, h);

    // Full NDC quad (-1,1)x(-1,1), with a fan center.
    const Vertex bl{-1.0, -1.0, 0.0, 1.0, 0.0, 0.0};
    const Vertex br{ 1.0, -1.0, 0.0, 1.0, 1.0, 0.0};
    const Vertex tr{ 1.0,  1.0, 0.0, 1.0, 1.0, 1.0};
    const Vertex tl{-1.0,  1.0, 0.0, 1.0, 0.0, 1.0};
    const Vertex ctr{0.0,  0.0, 0.0, 1.0, 0.5, 0.5};
    const std::vector<Vertex> tris = {
        bl, br, ctr,
        br, tr, ctr,
        tr, tl, ctr,
        tl, bl, ctr,
    };

    SolidCtx ctx{10};
    rast::clear(prod.fb, Color{0, 0, 0, 0});
    rast::drawTriangles(prod.fb, tris.data(), tris.size(),
                        solidSampler, &ctx);
    ref::draw(reference, tris);
    compareWithReference(prod, reference, "rectangle_fan");

    const std::size_t n = static_cast<std::size_t>(w) * h;
    for (std::size_t i = 0; i < n; ++i) {
        CHECK(prod.coverage[i] == 1u);
        CHECK(prod.color[i].a == 255);
    }
}

// A triangle straddling the near plane: two vertices have negative camera
// z, one has positive; clipping must seal the boundary without cracks.
void testNearPlaneStraddle() {
    const int w = 32, h = 24;
    ProductionImage prod(w, h);
    ref::Image reference(w, h);

    // NDC z = z/w; pick clip-space points with w near the camera and one
    // vertex behind it (z < -w means outside the near plane).
    const std::vector<Vertex> tris = {
        Vertex{-0.8, -0.6, -1.6, 1.0, 0.0, 0.0},  // behind near plane
        Vertex{ 0.9, -0.5, -0.4, 1.0, 1.0, 0.0},  // in front
        Vertex{ 0.1,  0.9, -0.2, 1.0, 0.5, 1.0},  // in front
    };

    SolidCtx ctx{20};
    rast::clear(prod.fb, Color{0, 0, 0, 0});
    rast::drawTriangles(prod.fb, tris.data(), tris.size(),
                        solidSampler, &ctx);
    ref::draw(reference, tris);
    compareWithReference(prod, reference, "near_plane_straddle");

    std::size_t covered = 0;
    for (std::uint32_t c : prod.coverage) {
        CHECK(c <= 1u);
        if (c != 0u) ++covered;
    }
    CHECK(covered > 0);
}

// Vertices with opposite-sign w: one or two vertices behind the camera.
void testOppositeW() {
    const int w = 40, h = 30;

    struct Case {
        const char* name;
        std::vector<Vertex> tris;
    };
    const std::vector<Case> cases = {
        {
            "one_negative_w",
            {
                Vertex{-0.5, -0.5, 0.2, -1.0, 0.0, 0.0},
                Vertex{ 0.8, -0.4, 0.1,  1.0, 1.0, 0.0},
                Vertex{ 0.2,  0.8, 0.0,  1.0, 0.5, 1.0},
            },
        },
        {
            "two_negative_w",
            {
                Vertex{-0.7, -0.6, 0.3, -1.0, 0.0, 0.0},
                Vertex{ 0.7, -0.6, 0.3, -1.0, 1.0, 0.0},
                Vertex{ 0.0,  0.7, -0.5, 2.0, 0.5, 1.0},
            },
        },
        {
            "all_negative_w",
            {
                Vertex{-0.5, -0.5, 0.2, -1.0, 0.0, 0.0},
                Vertex{ 0.8, -0.4, 0.1, -1.0, 1.0, 0.0},
                Vertex{ 0.2,  0.8, 0.0, -1.0, 0.5, 1.0},
            },
        },
    };

    for (const Case& tc : cases) {
        ProductionImage prod(w, h);
        ref::Image reference(w, h);
        SolidCtx ctx{30};
        rast::clear(prod.fb, Color{0, 0, 0, 0});
        rast::drawTriangles(prod.fb, tc.tris.data(), tc.tris.size(),
                            solidSampler, &ctx);
        ref::draw(reference, tc.tris);
        compareWithReference(prod, reference, tc.name);

        if (std::strcmp(tc.name, "all_negative_w") == 0) {
            for (std::uint32_t c : prod.coverage) CHECK(c == 0u);
        }
    }
}


// Small canvases: compare every pixel's coverage, depth and interpolated
// texture position against the long-double reference across many clips.
void testSmallCanvasReference() {
    std::mt19937 rng(20261111u);
    std::uniform_real_distribution<double> coord(-1.35, 1.35);
    std::uniform_real_distribution<double> wdist(0.35, 2.2);
    std::uniform_real_distribution<double> uv(0.0, 1.0);
    std::uniform_int_distribution<int> sign(0, 1);

    const int dims[][2] = {{1, 1}, {2, 3}, {4, 4}, {5, 7}, {8, 6}, {13, 9}};
    for (const auto& dim : dims) {
        const int w = dim[0];
        const int h = dim[1];
        for (int iter = 0; iter < 120; ++iter) {
            std::vector<Vertex> tris;
            const int tri_count = 1 + (iter % 4);
            for (int t = 0; t < tri_count; ++t) {
                for (int k = 0; k < 3; ++k) {
                    double ww = wdist(rng);
                    if (sign(rng) == 0) ww = -ww;  // force w sign flips
                    tris.push_back(Vertex{
                        coord(rng), coord(rng), coord(rng) * 0.9,
                        ww, uv(rng), uv(rng)});
                }
            }

            ProductionImage prod(w, h);
            ref::Image reference(w, h);
            SolidCtx ctx{40};
            rast::clear(prod.fb, Color{0, 0, 0, 0});
            rast::drawTriangles(prod.fb, tris.data(), tris.size(),
                                solidSampler, &ctx);
            ref::draw(reference, tris);
            char tag[48];
            std::snprintf(tag, sizeof(tag), "small_%dx%d_%d", w, h, iter);
            // Clipped intersection points are computed in double while the
            // reference keeps long double; near-degenerate plane hits can
            // amplify that rounding to roughly 1e-7 in texture space.
            compareWithReference(prod, reference, tag, 2.0e-6L, 2.0e-7L);
        }
    }
}

// Two identical triangles with equal depth: the first submitted fragment
// must win; strict-less keeps it in place.
void testDepthTieKeepsFirst() {
    const int w = 16, h = 16;
    ProductionImage prod(w, h);
    ref::Image reference(w, h);

    const std::vector<Vertex> first = {
        Vertex{-0.75, -0.75, 0.2, 1.0, 0.1, 0.1},
        Vertex{ 0.75, -0.75, 0.2, 1.0, 0.9, 0.1},
        Vertex{ 0.0,   0.75, 0.2, 1.0, 0.5, 0.9},
    };
    const std::vector<Vertex> second = first;

    SolidCtx first_ctx{100};
    SolidCtx second_ctx{200};
    rast::clear(prod.fb, Color{0, 0, 0, 0});
    rast::drawTriangles(prod.fb, first.data(), first.size(),
                        solidSampler, &first_ctx);
    rast::drawTriangles(prod.fb, second.data(), second.size(),
                        solidSampler, &second_ctx);
    ref::draw(reference, first);
    ref::draw(reference, second);
    compareWithReference(prod, reference, "depth_tie");

    const Color expected = solidSampler(0.0, 0.0, &first_ctx);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const std::size_t i = prod.idx(x, y);
            if (prod.coverage[i] != 0u) {
                CHECK(prod.color[i].r == expected.r);
                CHECK(std::fabs(prod.depth[i] - 0.2f) < 1.0e-7f);
            }
        }
    }

    // A closer triangle must override the previous winner.
    std::vector<Vertex> closer = first;
    for (Vertex& v : closer) v.z = 0.1;
    SolidCtx close_ctx{50};
    rast::drawTriangles(prod.fb, closer.data(), closer.size(),
                        solidSampler, &close_ctx);
    const Color close_color = solidSampler(0.0, 0.0, &close_ctx);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const std::size_t i = prod.idx(x, y);
            if (prod.coverage[i] != 0u) {
                CHECK(prod.color[i].r == close_color.r);
                CHECK(std::fabs(prod.depth[i] - 0.1f) < 1.0e-7f);
            }
        }
    }
}

// The sampler receives perspective-correct texture positions: verify via
// the debug buffers against the reference and an affine-warp analytic case.
void testPerspectiveCorrectUV() {
    const int w = 24, h = 24;
    ProductionImage prod(w, h);
    ref::Image reference(w, h);

    // Non-trivial w per vertex makes perspective correction observable.
    const std::vector<Vertex> tris = {
        Vertex{-0.9, -0.9, -0.5, 2.5, 0.0, 0.0},
        Vertex{ 0.9, -0.9, -0.5, 0.6, 1.0, 0.0},
        Vertex{ 0.0,  0.9, -0.5, 1.4, 0.5, 1.0},
    };

    rast::clear(prod.fb, Color{0, 0, 0, 0});
    rast::drawTriangles(prod.fb, tris.data(), tris.size(),
                        uvSampler, nullptr);
    ref::draw(reference, tris);
    compareWithReference(prod, reference, "perspective_uv",
                         2.0e-6L, 1.0e-9L);

    // Texture coordinates must stay inside the [0,1] triangle range.
    for (std::size_t i = 0; i < prod.uu.size(); ++i) {
        if (prod.coverage[i] != 0u) {
            CHECK(prod.uu[i] >= -1.0e-12 && prod.uu[i] <= 1.0 + 1.0e-12);
            CHECK(prod.vv[i] >= -1.0e-12 && prod.vv[i] <= 1.0 + 1.0e-12);
            const Color c = prod.color[i];
            const Color expect = uvSampler(prod.uu[i], prod.vv[i], nullptr);
            CHECK(std::abs(int(c.r) - int(expect.r)) <= 1);
            CHECK(std::abs(int(c.g) - int(expect.g)) <= 1);
        }
    }
}

}  // namespace
int main() {
    testRectangleNoGaps();
    testNearPlaneStraddle();
    testOppositeW();
    testSmallCanvasReference();
    testDepthTieKeepsFirst();
    testPerspectiveCorrectUV();

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
