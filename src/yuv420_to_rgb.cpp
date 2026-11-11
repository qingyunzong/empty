#include "yuv420_to_rgb.hpp"

#include <algorithm>
#include <cmath>

namespace yuvconv {

const char* toString(ConvertStatus status) noexcept {
    switch (status) {
    case ConvertStatus::Ok:
        return "Ok";
    case ConvertStatus::InvalidArgument:
        return "InvalidArgument";
    case ConvertStatus::OutOfRange:
        return "OutOfRange";
    }
    return "Unknown";
}

namespace {

// Byte address of sample (x, row), honouring negative (flipped) strides.
const uint8_t* samplePtr(const PlaneView& plane, int x, int row) noexcept {
    return plane.data + static_cast<ptrdiff_t>(row) * plane.stride + x;
}

// [low, high] byte window (relative to the data pointer) that the caller must
// provide. With a negative stride the rows extend *backwards* from data, so
// the minimum address is data + (height-1)*stride.
bool byteWindow(const PlaneView& plane, ptrdiff_t& low, ptrdiff_t& high)
    noexcept {
    if (plane.width <= 0 || plane.height <= 0 || plane.stride == 0 ||
        plane.data == nullptr) {
        return false;
    }
    // A row occupies |stride| bytes; usable width must fit within it.
    // (Equal magnitude is fine: that simply means tight packing.)
    if (std::llabs(plane.stride) < plane.width) {
        return false;
    }
    const ptrdiff_t firstRowOffset = 0;
    const ptrdiff_t lastRowOffset =
        static_cast<ptrdiff_t>(plane.height - 1) * plane.stride;
    const ptrdiff_t rowStart = std::min(firstRowOffset, lastRowOffset);
    const ptrdiff_t rowEnd = std::max(firstRowOffset, lastRowOffset);
    low = rowStart;
    high = rowEnd + plane.width; // one-past last usable byte
    return true;
}

struct Coeffs {
    float yScale, yOffset; // yNorm = Y * yScale + yOffset
    float cScale, cOffset; // cNorm = C * cScale + cOffset
    float rCr, gCb, gCr, bCb;
};

Coeffs makeCoeffs(ColorMatrix matrix, SignalRange range) noexcept {
    Coeffs c{};

    float kr, kb;
    if (matrix == ColorMatrix::Bt709) {
        kr = 0.2126f;
        kb = 0.0722f;
    } else {
        kr = 0.299f;
        kb = 0.114f;
    }
    const float kg = 1.0f - kr - kb;

    if (range == SignalRange::Full) {
        c.yScale = 1.0f / 255.0f;
        c.yOffset = 0.0f;
        c.cScale = 1.0f / 255.0f;
        c.cOffset = -128.0f / 255.0f;
    } else {
        c.yScale = 1.0f / 219.0f;
        c.yOffset = -16.0f / 219.0f;
        c.cScale = 1.0f / 224.0f;
        c.cOffset = -128.0f / 224.0f;
    }

    // Derived from the canonical Y' = Kr R' + (1-Kr-Kb) G' + Kb B'.
    c.rCr = 2.0f * (1.0f - kr);
    c.gCb = -2.0f * kb * (1.0f - kb) / kg;
    c.gCr = -2.0f * kr * (1.0f - kr) / kg;
    c.bCb = 2.0f * (1.0f - kb);
    return c;
}

// Bilinear value at continuous chroma coordinate (cx, cy). The *coordinate* is
// clamped to the sample span [0, dim-1], so every addressed sample lies inside
// the plane: beyond the last sample the weight collapses onto that sample
// instead of reading one element past it. Negative-stride planes already map
// logical rows to the correct physical rows in samplePtr, so no extra flip is
// needed here.
float sampleChroma(const PlaneView& plane, float cx, float cy) noexcept {
    const int cw = plane.width;
    const int ch = plane.height;

    cx = std::clamp(cx, 0.0f, static_cast<float>(cw - 1));
    cy = std::clamp(cy, 0.0f, static_cast<float>(ch - 1));

    int x0 = static_cast<int>(std::floor(cx));
    int y0 = static_cast<int>(std::floor(cy));
    float fx = cx - static_cast<float>(x0);
    float fy = cy - static_cast<float>(y0);

    int x1 = x0 + 1;
    int y1 = y0 + 1;
    x0 = std::clamp(x0, 0, cw - 1);
    x1 = std::clamp(x1, 0, cw - 1);
    y0 = std::clamp(y0, 0, ch - 1);
    y1 = std::clamp(y1, 0, ch - 1);

    const float p00 = static_cast<float>(*samplePtr(plane, x0, y0));
    const float p01 = static_cast<float>(*samplePtr(plane, x0, y1));
    const float p10 = static_cast<float>(*samplePtr(plane, x1, y0));
    const float p11 = static_cast<float>(*samplePtr(plane, x1, y1));

    const float top = p00 * (1.0f - fx) + p10 * fx;
    const float bottom = p01 * (1.0f - fx) + p11 * fx;
    return top * (1.0f - fy) + bottom * fy;
}

float clamp01(float v) noexcept { return std::clamp(v, 0.0f, 1.0f); }

} // namespace

std::size_t requiredPlaneBytes(const PlaneView& plane) noexcept {
    ptrdiff_t low, high;
    if (!byteWindow(plane, low, high)) {
        return 0;
    }
    return static_cast<std::size_t>(high - low);
}

bool planeFits(const PlaneView& plane, const uint8_t* buffer,
               std::size_t bufferSize) noexcept {
    if (buffer == nullptr) {
        return false;
    }
    ptrdiff_t low, high;
    if (!byteWindow(plane, low, high)) {
        return false;
    }
    // The window is expressed relative to plane.data, which (with negative
    // strides) is not the buffer base; compare absolute byte addresses.
    const auto base = reinterpret_cast<std::uintptr_t>(buffer);
    const auto windowStart =
        reinterpret_cast<std::uintptr_t>(plane.data) + static_cast<std::uintptr_t>(low);
    const auto windowEnd =
        reinterpret_cast<std::uintptr_t>(plane.data) + static_cast<std::uintptr_t>(high);
    const auto bufferEnd = base + bufferSize;
    if (bufferEnd < base) {
        return false; // size overflow
    }
    if (windowEnd < windowStart) {
        return false; // window overflow
    }
    return windowStart >= base && windowEnd <= bufferEnd;
}

ConvertStatus validatePlanes(int width, int height,
                             const PlaneView& y, const PlaneView& u,
                             const PlaneView& v, const RgbImageView& out,
                             const uint8_t* yBuffer, std::size_t yBufferSize,
                             const uint8_t* uBuffer, std::size_t uBufferSize,
                             const uint8_t* vBuffer, std::size_t vBufferSize)
    noexcept {
    if (width <= 0 || height <= 0) {
        return ConvertStatus::InvalidArgument;
    }
    if (out.data == nullptr || out.width != width || out.height != height) {
        return ConvertStatus::InvalidArgument;
    }

    const int cw = (width + 1) / 2;  // ceil(width/2)
    const int ch = (height + 1) / 2; // ceil(height/2)

    if (y.width != width || y.height != height || u.width != cw ||
        u.height != ch || v.width != cw || v.height != ch) {
        return ConvertStatus::InvalidArgument;
    }

    if (!planeFits(y, yBuffer, yBufferSize) ||
        !planeFits(u, uBuffer, uBufferSize) ||
        !planeFits(v, vBuffer, vBufferSize)) {
        return ConvertStatus::OutOfRange;
    }

    // Output window: honour a (possibly negative) output stride as well.
    const ptrdiff_t outRowBytes =
        out.stride == 0 ? static_cast<ptrdiff_t>(3 * width) * sizeof(float)
                        : out.stride;
    if (outRowBytes <
        static_cast<ptrdiff_t>(static_cast<std::size_t>(3 * width) *
                               sizeof(float))) {
        return ConvertStatus::InvalidArgument;
    }
    return ConvertStatus::Ok;
}

ConvertStatus convertYuv420ToRgb(int width, int height,
                                 const PlaneView& y, const PlaneView& u,
                                 const PlaneView& v, const RgbImageView& out,
                                 const ConvertParams& params,
                                 const uint8_t* yBuffer, std::size_t yBufferSize,
                                 const uint8_t* uBuffer, std::size_t uBufferSize,
                                 const uint8_t* vBuffer, std::size_t vBufferSize)
    noexcept {
    const ConvertStatus status =
        validatePlanes(width, height, y, u, v, out, yBuffer, yBufferSize,
                       uBuffer, uBufferSize, vBuffer, vBufferSize);
    if (status != ConvertStatus::Ok) {
        return status;
    }

    const Coeffs coeff = makeCoeffs(params.matrix, params.range);

    // Continuous chroma coordinate of luma pixel (px, py).
    // Center: (px - 0.5)/2, Left: px/2.
    const float origin =
        params.chromaLocation == ChromaLocation::Center ? 0.25f : 0.0f;
    const float rowOrigin =
        params.chromaLocation == ChromaLocation::Center ? 0.25f : 0.0f;

    const ptrdiff_t outStrideBytes =
        out.stride == 0 ? static_cast<ptrdiff_t>(3 * width) * sizeof(float)
                        : out.stride;

    for (int py = 0; py < height; ++py) {
        const float cy = static_cast<float>(py) * 0.5f + rowOrigin;
        for (int px = 0; px < width; ++px) {
            const float cx = static_cast<float>(px) * 0.5f + origin;

            const float yRaw =
                static_cast<float>(*samplePtr(y, px, py));
            const float cbRaw = sampleChroma(u, cx, cy);
            const float crRaw = sampleChroma(v, cx, cy);

            const float yn = yRaw * coeff.yScale + coeff.yOffset;
            const float cbn = cbRaw * coeff.cScale + coeff.cOffset;
            const float crn = crRaw * coeff.cScale + coeff.cOffset;

            const float r = yn + coeff.rCr * crn;
            const float g = yn + coeff.gCb * cbn + coeff.gCr * crn;
            const float b = yn + coeff.bCb * cbn;

            auto* dst = reinterpret_cast<float*>(
                reinterpret_cast<uint8_t*>(out.data) +
                static_cast<ptrdiff_t>(py) * outStrideBytes) +
                        3 * px;
            dst[0] = clamp01(r);
            dst[1] = clamp01(g);
            dst[2] = clamp01(b);
        }
    }
    return ConvertStatus::Ok;
}

} // namespace yuvconv
