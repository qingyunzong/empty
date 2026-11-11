#include "rast/rasterizer.hpp"

#include <algorithm>
#include <cmath>

namespace rast {

namespace {

// A clipped vertex carrying the quantities needed later. Ndc z, 1/w and
// u/w, v/w are all affine in screen space, which is what makes the
// perspective-correct interpolation below work.
struct ClipVertex {
    double x, y, z, w;
    double u, v;
    double inv_w;
    double u_over_w;
    double v_over_w;
};

struct RastVertex {
    double sx, sy;      // pixel coordinates
    double ndc_z;
    double inv_w;
    double u_over_w;
    double v_over_w;
};

enum PlaneId {
    PLANE_NEAR = 0,  // w + z >= 0  (z >= -w)
    PLANE_FAR,       // w - z >= 0  (z <=  w)
    PLANE_LEFT,      // w + x >= 0  (x >= -w)
    PLANE_RIGHT,     // w - x >= 0  (x <=  w)
    PLANE_BOTTOM,    // w + y >= 0  (y >= -w)
    PLANE_TOP        // w - y >= 0  (y <=  w)
};

constexpr std::size_t MAX_CLIP_VERTS = 32;

double planeDistance(const ClipVertex& v, int plane) {
    switch (plane) {
        case PLANE_NEAR:   return v.w + v.z;
        case PLANE_FAR:    return v.w - v.z;
        case PLANE_LEFT:   return v.w + v.x;
        case PLANE_RIGHT:  return v.w - v.x;
        case PLANE_BOTTOM: return v.w + v.y;
        case PLANE_TOP:    return v.w - v.y;
    }
    return 0.0;
}

ClipVertex makeClipVertex(const Vertex& v) {
    ClipVertex c;
    c.x = v.x;
    c.y = v.y;
    c.z = v.z;
    c.w = v.w;
    c.u = v.u;
    c.v = v.v;
    c.inv_w = 1.0 / v.w;
    c.u_over_w = v.u / v.w;
    c.v_over_w = v.v / v.w;
    return c;
}

// Linear interpolation of every interpolant at the plane intersection.
ClipVertex intersectVertex(const ClipVertex& a,
                           const ClipVertex& b,
                           int plane) {
    const double da = planeDistance(a, plane);
    const double db = planeDistance(b, plane);
    const double t = da / (da - db);

    ClipVertex r;
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

// Sutherland-Hodgman against one plane.
void clipAgainstPlane(int plane,
                      const ClipVertex* in,
                      std::size_t in_count,
                      ClipVertex* out,
                      std::size_t& out_count) {
    out_count = 0;
    if (in_count == 0) {
        return;
    }
    for (std::size_t i = 0; i < in_count; ++i) {
        const ClipVertex& cur = in[i];
        const ClipVertex& prev = in[(i + in_count - 1) % in_count];
        const bool cur_inside = planeDistance(cur, plane) >= 0.0;
        const bool prev_inside = planeDistance(prev, plane) >= 0.0;

        if (cur_inside) {
            if (!prev_inside) {
                if (out_count >= MAX_CLIP_VERTS) {
                    out_count = 0;
                    return;
                }
                out[out_count++] = intersectVertex(prev, cur, plane);
            }
            if (out_count >= MAX_CLIP_VERTS) {
                out_count = 0;
                return;
            }
            out[out_count++] = cur;
        } else if (prev_inside) {
            if (out_count >= MAX_CLIP_VERTS) {
                out_count = 0;
                return;
            }
            out[out_count++] = intersectVertex(prev, cur, plane);
        }
    }
}

RastVertex toRasterVertex(const ClipVertex& c,
                          int width,
                          int height) {
    RastVertex r;
    const double inv_w = c.inv_w;  // 1/w is affine, do not redivide.
    const double ndc_x = c.x * inv_w;
    const double ndc_y = c.y * inv_w;
    r.sx = (ndc_x * 0.5 + 0.5) * static_cast<double>(width) - 0.5;
    r.sy = (ndc_y * 0.5 + 0.5) * static_cast<double>(height) - 0.5;
    r.ndc_z = c.z * inv_w;
    r.inv_w = inv_w;
    r.u_over_w = c.u_over_w;
    r.v_over_w = c.v_over_w;
    return r;
}

void rasterizeTriangle(Framebuffer& fb,
                       const RastVertex& v0,
                       const RastVertex& v1,
                       const RastVertex& v2,
                       TextureSampleFn sample,
                       void* user_data) {
    // A clip intersection can land on the camera plane (w == 0), making the
    // perspective divide undefined; drop that degenerate fan triangle.
    if (!std::isfinite(v0.sx) || !std::isfinite(v0.sy) ||
        !std::isfinite(v1.sx) || !std::isfinite(v1.sy) ||
        !std::isfinite(v2.sx) || !std::isfinite(v2.sy)) {
        return;
    }
    const double area =
        (v1.sx - v0.sx) * (v2.sy - v0.sy) -
        (v1.sy - v0.sy) * (v2.sx - v0.sx);
    if (!(area > 0.0)) {
        // Reject degenerate / clockwise winding after normalization.
        return;
    }

    const double min_x = std::min({v0.sx, v1.sx, v2.sx});
    const double max_x = std::max({v0.sx, v1.sx, v2.sx});
    const double min_y = std::min({v0.sy, v1.sy, v2.sy});
    const double max_y = std::max({v0.sy, v1.sy, v2.sy});

    int x0 = static_cast<int>(std::floor(min_x + 0.5));
    int y0 = static_cast<int>(std::floor(min_y + 0.5));
    int x1 = static_cast<int>(std::ceil(max_x + 0.5)) - 1;
    int y1 = static_cast<int>(std::ceil(max_y + 0.5)) - 1;
    x0 = std::max(x0, 0);
    y0 = std::max(y0, 0);
    x1 = std::min(x1, fb.width - 1);
    y1 = std::min(y1, fb.height - 1);
    if (x1 < x0 || y1 < y0) {
        return;
    }

    // Edge functions for the counter-clockwise (screen space, y down)
    // triangle; interior values are non-negative.
    auto edge = [](const RastVertex& a, const RastVertex& b,
                   double px, double py) {
        return (b.sx - a.sx) * (py - a.sy) -
               (b.sy - a.sy) * (px - a.sx);
    };

    // Top edge: horizontal with the third vertex below it.
    // Left edge: directed upwards in screen space (y strictly decreasing).
    auto is_top_left = [](const RastVertex& a, const RastVertex& b) {
        const double dy = b.sy - a.sy;
        const double dx = b.sx - a.sx;
        return (dy == 0.0 && dx < 0.0) || dy < 0.0;
    };
    const bool tl01 = is_top_left(v0, v1);
    const bool tl12 = is_top_left(v1, v2);
    const bool tl20 = is_top_left(v2, v0);

    const double inv_area = 1.0 / area;

    for (int py = y0; py <= y1; ++py) {
        for (int px = x0; px <= x1; ++px) {
            const double cx = static_cast<double>(px);
            const double cy = static_cast<double>(py);

            const double w01 = edge(v0, v1, cx, cy);
            const double w12 = edge(v1, v2, cx, cy);
            const double w20 = edge(v2, v0, cx, cy);

            // Top-left rule: a zero edge counts only when it is top/left.
            const bool inside =
                (w01 > 0.0 || (w01 == 0.0 && tl01)) &&
                (w12 > 0.0 || (w12 == 0.0 && tl12)) &&
                (w20 > 0.0 || (w20 == 0.0 && tl20));
            if (!inside) {
                continue;
            }

            const std::size_t idx = fb.index(px, py);
            if (fb.coverage != nullptr) {
                ++fb.coverage[idx];
            }

            // Barycentric weights (w opposite each vertex); all interp-
            // olated quantities are affine in screen space.
            const double b0 = w12 * inv_area;
            const double b1 = w20 * inv_area;
            const double b2 = w01 * inv_area;

            const double inv_w =
                b0 * v0.inv_w + b1 * v1.inv_w + b2 * v2.inv_w;
            const double ndc_z =
                b0 * v0.ndc_z + b1 * v1.ndc_z + b2 * v2.ndc_z;
            const double u_over_w =
                b0 * v0.u_over_w + b1 * v1.u_over_w +
                b2 * v2.u_over_w;
            const double v_over_w =
                b0 * v0.v_over_w + b1 * v1.v_over_w +
                b2 * v2.v_over_w;

            const double w_cam = 1.0 / inv_w;
            const double u = u_over_w * w_cam;
            const double v = v_over_w * w_cam;

            const float frag_depth = static_cast<float>(ndc_z);
            // Strict less: equal depth keeps the fragment submitted first.
            if (!(frag_depth < fb.depth[idx])) {
                continue;
            }
            fb.depth[idx] = frag_depth;
            if (fb.dbg_u != nullptr) {
                fb.dbg_u[idx] = u;
            }
            if (fb.dbg_v != nullptr) {
                fb.dbg_v[idx] = v;
            }
            fb.color[idx] = sample(u, v, user_data);
        }
    }
}

}  // namespace

void clear(Framebuffer& fb, Color clear_color, double clear_depth) {
    const std::size_t count =
        static_cast<std::size_t>(fb.width) * static_cast<std::size_t>(fb.height);
    for (std::size_t i = 0; i < count; ++i) {
        fb.color[i] = clear_color;
        fb.depth[i] = static_cast<float>(clear_depth);
        if (fb.coverage != nullptr) {
            fb.coverage[i] = 0;
        }
        if (fb.dbg_u != nullptr) {
            fb.dbg_u[i] = 0.0;
        }
        if (fb.dbg_v != nullptr) {
            fb.dbg_v[i] = 0.0;
        }
    }
}

void drawTriangles(Framebuffer& fb,
                   const Vertex* vertices,
                   std::size_t vertex_count,
                   TextureSampleFn sample,
                   void* user_data) {
    if (fb.width <= 0 || fb.height <= 0 || fb.color == nullptr ||
        fb.depth == nullptr || vertices == nullptr || sample == nullptr) {
        return;
    }

    for (std::size_t base = 0; base + 3 <= vertex_count; base += 3) {
        ClipVertex buf_a[MAX_CLIP_VERTS];
        ClipVertex buf_b[MAX_CLIP_VERTS];
        std::size_t count = 3;
        buf_a[0] = makeClipVertex(vertices[base]);
        buf_a[1] = makeClipVertex(vertices[base + 1]);
        buf_a[2] = makeClipVertex(vertices[base + 2]);

        // Six standard frustum planes: -w <= x,y,z <= w.
        for (int plane = 0; plane < 6; ++plane) {
            std::size_t next_count = 0;
            clipAgainstPlane(plane, buf_a, count, buf_b, next_count);
            count = next_count;
            for (std::size_t i = 0; i < count; ++i) {
                buf_a[i] = buf_b[i];
            }
            if (count < 3) {
                break;
            }
        }
        if (count < 3) {
            continue;
        }

        // Triangulate the convex clip polygon as a fan.
        for (std::size_t k = 1; k + 1 < count; ++k) {
            RastVertex r0 = toRasterVertex(buf_a[0], fb.width, fb.height);
            RastVertex r1 = toRasterVertex(buf_a[k], fb.width, fb.height);
            RastVertex r2 =
                toRasterVertex(buf_a[k + 1], fb.width, fb.height);

            // Normalize winding to counter-clockwise in screen space.
            const double area =
                (r1.sx - r0.sx) * (r2.sy - r0.sy) -
                (r1.sy - r0.sy) * (r2.sx - r0.sx);
            if (area < 0.0) {
                RastVertex tmp = r1;
                r1 = r2;
                r2 = tmp;
            }
            rasterizeTriangle(fb, r0, r1, r2, sample, user_data);
        }
    }
}

}  // namespace rast
