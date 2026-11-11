#pragma once

#include <cstddef>
#include <cstdint>
#include <sys/types.h>

namespace yuvconv {

// YUV->RGB colour matrix selection.
enum class ColorMatrix {
    Bt601, // ITU-R BT.601 (SMPTE 170M) Kr=0.299,  Kb=0.114
    Bt709  // ITU-R BT.709                Kr=0.2126, Kb=0.0722
};

// Sample encoding range.
enum class SignalRange {
    Limited, // Y in [16,235], Cb/Cr in [16,240]
    Full     // Y/Cb/Cr in [0,255]
};

// Horizontal/vertical chroma sample location for 4:2:0 upsampling.
enum class ChromaLocation {
    Center, // MPEG-2: chroma samples sit at (x*2+0.5, y*2+0.5)
    Left    // MPEG-1/JPEG: chroma samples sit at (x*2,     y*2)
};

enum class ConvertStatus {
    Ok,
    InvalidArgument,
    OutOfRange // a plane's data window does not fit in the supplied buffer
};

const char* toString(ConvertStatus status) noexcept;

// A caller-owned 8-bit planar image.
//
// stride is the byte distance between two successive rows and may be negative
// (in which case row 0 is the last row in memory and the image is vertically
// flipped). The padding bytes between width and |stride| are never read.
struct PlaneView {
    const uint8_t* data = nullptr;
    int width = 0;          // usable samples per row (padding excluded)
    int height = 0;         // number of usable rows
    ptrdiff_t stride = 0;   // signed row-to-row byte offset
};

// Result is a tightly packed RGB image, 3 floats per pixel, row major.
struct RgbImageView {
    float* data = nullptr;
    int width = 0;
    int height = 0;
    ptrdiff_t stride = 0; // byte stride; 0 means 3*width*sizeof(float)
};

struct ConvertParams {
    ColorMatrix matrix = ColorMatrix::Bt601;
    SignalRange range = SignalRange::Limited;
    ChromaLocation chromaLocation = ChromaLocation::Center;
};

// Number of bytes of [data, data+size) that the plane is allowed to touch.
// Every usable sample of every row must lie inside that window; padding bytes
// are explicitly excluded. Returns 0 for an invalid plane.
std::size_t requiredPlaneBytes(const PlaneView& plane) noexcept;

bool planeFits(const PlaneView& plane, const uint8_t* buffer,
               std::size_t bufferSize) noexcept;

// Validates dimensions, strides, pointers and the accessible window of every
// plane before any sample is read. Chroma plane dimensions are derived as
// ceil(width/2) x ceil(height/2).
ConvertStatus validatePlanes(int width, int height,
                             const PlaneView& y, const PlaneView& u,
                             const PlaneView& v, const RgbImageView& out,
                             const uint8_t* yBuffer, std::size_t yBufferSize,
                             const uint8_t* uBuffer, std::size_t uBufferSize,
                             const uint8_t* vBuffer, std::size_t vBufferSize)
    noexcept;

// Runs the conversion. Buffers are the accessible ranges backing y/u/v (see
// validatePlanes). On non-Ok status the output is left untouched.
ConvertStatus convertYuv420ToRgb(int width, int height,
                                 const PlaneView& y, const PlaneView& u,
                                 const PlaneView& v, const RgbImageView& out,
                                 const ConvertParams& params,
                                 const uint8_t* yBuffer, std::size_t yBufferSize,
                                 const uint8_t* uBuffer, std::size_t uBufferSize,
                                 const uint8_t* vBuffer, std::size_t vBufferSize)
    noexcept;

} // namespace yuvconv
