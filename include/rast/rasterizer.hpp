#pragma once

#include <cstddef>
#include <cstdint>

namespace rast {

// Homogeneous clip-space position plus texture coordinate.
struct Vertex {
    double x, y, z, w;
    double u, v;
};

struct Color {
    std::uint8_t r, g, b, a;
};

// Caller supplied texture lookup. Invoked once for every fragment that passes
// the depth test, with the perspective-correct interpolated texture position.
using TextureSampleFn = Color (*)(double u, double v, void* user_data);

// Row-major, top-left origin framebuffer.
// color and depth are required and must hold width*height entries.
// coverage (if non-null) is incremented for every geometrically covered
// fragment, before the depth test; it is instrumentation for verifying that
// adjacent triangles share edges without cracks or double coverage.
// dbg_u / dbg_v (if non-null) receive the texture position of the fragment
// that currently owns each pixel (the one that passed the depth test).
struct Framebuffer {
    int width = 0;
    int height = 0;
    Color* color = nullptr;
    float* depth = nullptr;
    std::uint32_t* coverage = nullptr;
    double* dbg_u = nullptr;
    double* dbg_v = nullptr;

    std::size_t index(int x, int y) const {
        return static_cast<std::size_t>(y) * static_cast<std::size_t>(width) +
               static_cast<std::size_t>(x);
    }
};
// Fills the color buffer, resets depth to the far value (1.0 in NDC) and
// zeroes the optional coverage / debug buffers.
void clear(Framebuffer& fb, Color clear_color, double clear_depth = 1.0);

// Draws vertex_count/3 triangles. For every triangle the pipeline is:
//   1. clip against the six standard frustum planes
//      (-w <= x,y,z <= w) using Sutherland-Hodgman,
//   2. perspective divide (w > 0 guaranteed for surviving vertices),
//   3. viewport mapping to pixel coordinates, pixel-center sampling,
//   4. top-left fill rule for shared-edge ownership,
//   5. perspective-correct interpolation of depth and texture coordinates,
//   6. strict-less depth test: a fragment replaces the stored one only when
//      its depth is strictly smaller; equal depth keeps the earlier fragment.
void drawTriangles(Framebuffer& fb,
                   const Vertex* vertices,
                   std::size_t vertex_count,
                   TextureSampleFn sample,
                   void* user_data);

}  // namespace rast
