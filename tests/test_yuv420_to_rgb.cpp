#include "yuv420_to_rgb.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

using namespace yuvconv;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);     \
        }                                                                    \
    } while (0)

bool near(float a, float b, float eps = 1e-4f) {
    return std::fabs(a - b) <= eps;
}

void checkPixel(const float* px, float r, float g, float b,
                float eps = 1e-4f) {
    CHECK(near(px[0], r, eps));
    CHECK(near(px[1], g, eps));
    CHECK(near(px[2], b, eps));
}

// Builds a padded plane. Bytes outside the usable width/height window are
// filled with a sentinel so accidental reads of padding can be detected.
PlaneView makePaddedPlane(std::vector<uint8_t>& buf, int w, int h, int stride,
                          const std::vector<uint8_t>& values,
                          uint8_t sentinel = 0xA5) {
    const std::size_t capacity =
        static_cast<std::size_t>(std::abs(stride)) * h;
    buf.assign(capacity, sentinel);
    PlaneView p;
    p.width = w;
    p.height = h;
    p.stride = stride;
    if (stride >= 0) {
        p.data = buf.data();
        for (int row = 0; row < h; ++row) {
            for (int x = 0; x < w; ++x) {
                buf[static_cast<std::size_t>(row) * stride + x] =
                    values[static_cast<std::size_t>(row) * w + x];
            }
        }
    } else {
        // Row 0 occupies the last physical row; data points there.
        p.data = buf.data() + static_cast<std::size_t>(h - 1) * (-stride);
        for (int row = 0; row < h; ++row) {
            for (int x = 0; x < w; ++x) {
                const std::size_t idx =
                    static_cast<std::size_t>(h - 1 - row) * (-stride) + x;
                buf[idx] = values[static_cast<std::size_t>(row) * w + x];
            }
        }
    }
    return p;
}

bool paddingUntouched(const std::vector<uint8_t>& buf, int w, int h,
                      int stride, const std::vector<uint8_t>& values,
                      uint8_t sentinel = 0xA5) {
    for (int row = 0; row < h; ++row) {
        for (int x = 0; x < std::abs(stride); ++x) {
            std::size_t idx;
            if (stride >= 0) {
                idx = static_cast<std::size_t>(row) * stride + x;
            } else {
                idx = static_cast<std::size_t>(h - 1 - row) * (-stride) + x;
            }
            const uint8_t expected =
                x < w ? values[static_cast<std::size_t>(row) * w + x]
                      : sentinel;
            if (buf[idx] != expected) {
                return false;
            }
        }
    }
    return true;
}

// Two-page mapping: first page is a PROT_NONE guard, the usable window lives in
// the second page and ends exactly at the mapping boundary, so a one-past-end
// read raises SIGSEGV.
struct GuardBuf {
    uint8_t* base = nullptr;
    std::size_t mapSize = 0;
    std::size_t usable = 0;
    long page = 0;
};

GuardBuf makeGuardBuf(std::size_t size) {
    GuardBuf g;
    g.page = sysconf(_SC_PAGESIZE);
    // Three pages: guard | usable window | guard. The window is placed in the
    // middle page so both positive and negative strides get a PROT_NONE page
    // immediately beyond each end of their accessible range.
    g.mapSize = 3 * static_cast<std::size_t>(g.page);
    g.base = static_cast<uint8_t*>(
        mmap(nullptr, g.mapSize, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
    if (g.base == MAP_FAILED) {
        g.base = nullptr;
        return g;
    }
    g.usable = size;
    if (mprotect(g.base, static_cast<std::size_t>(g.page), PROT_NONE) != 0 ||
        mprotect(g.base + 2 * g.page, static_cast<std::size_t>(g.page),
                 PROT_NONE) != 0) {
        munmap(g.base, g.mapSize);
        g.base = nullptr;
    }
    return g;
}

void freeGuardBuf(GuardBuf& g) {
    if (g.base) {
        munmap(g.base, g.mapSize);
        g.base = nullptr;
    }
}

uint8_t* guardDataPtr(const GuardBuf& g, int height, ptrdiff_t stride) {
    if (stride >= 0) {
        return g.base + g.page; // top of the middle (writable) page
    }
    // Negative stride: data addresses the last row, so the usable window
    // [page, page+usable) ends exactly at data; rows extend backward from it.
    (void)height;
    return g.base + g.page + g.usable;
}

void fillGuardWindow(GuardBuf& g, int w, int h, ptrdiff_t stride,
                     const std::vector<uint8_t>& values) {
    uint8_t* data = guardDataPtr(g, h, stride);
    for (int row = 0; row < h; ++row) {
        for (int x = 0; x < w; ++x) {
            data[row * stride + x] =
                values[static_cast<std::size_t>(row) * w + x];
        }
    }
}

// ---------------------------------------------------------------------------
// Hand-computed colour cases (1x1)
// ---------------------------------------------------------------------------

// Full range, BT.601 (exact derived Kr=0.299/Kb=0.114 coefficients):
// Y=100, Cb=200, Cr=40. y=100/255; cb=(200-128)/255; cr=(40-128)/255.
// r clamps to 0; g=0.541436; b=0.892486.
void testHandFull601() {
    uint8_t yv = 100, uv = 200, vv = 40;
    PlaneView y{&yv, 1, 1, 1}, u{&uv, 1, 1, 1}, v{&vv, 1, 1, 1};
    float out[3]{};
    RgbImageView rgb{out, 1, 1, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Full,
                    ChromaLocation::Center};
    auto st =
        convertYuv420ToRgb(1, 1, y, u, v, rgb, p, &yv, 1, &uv, 1, &vv, 1);
    CHECK(st == ConvertStatus::Ok);
    checkPixel(out, 0.0f, 0.54144f, 0.89249f);
}

// Limited range, BT.709: Y=180, Cb=40, Cr=200.
// y=(180-16)/219; cb=(40-128)/224; cr=(200-128)/224.
// r clamps to 1; g=0.671982; b=0.019873.
void testHandLimited709() {
    uint8_t yv = 180, uv = 40, vv = 200;
    PlaneView y{&yv, 1, 1, 1}, u{&uv, 1, 1, 1}, v{&vv, 1, 1, 1};
    float out[3]{};
    RgbImageView rgb{out, 1, 1, 0};
    ConvertParams p{ColorMatrix::Bt709, SignalRange::Limited,
                    ChromaLocation::Center};
    auto st =
        convertYuv420ToRgb(1, 1, y, u, v, rgb, p, &yv, 1, &uv, 1, &vv, 1);
    CHECK(st == ConvertStatus::Ok);
    checkPixel(out, 1.0f, 0.67198f, 0.01987f, 1e-5f);
}

// Neutral chroma reproduces luma as grey under full range.
void testNeutral() {
    uint8_t yv = 82, uv = 128, vv = 128;
    PlaneView y{&yv, 1, 1, 1}, u{&uv, 1, 1, 1}, v{&vv, 1, 1, 1};
    float out[3]{};
    RgbImageView rgb{out, 1, 1, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Full,
                    ChromaLocation::Center};
    CHECK(convertYuv420ToRgb(1, 1, y, u, v, rgb, p, &yv, 1, &uv, 1, &vv, 1) ==
          ConvertStatus::Ok);
    const float g = 82.0f / 255.0f;
    checkPixel(out, g, g, g);
}

// Bilinear upsampling on an odd 3x3 luma frame (chroma is ceil = 2x2).
// Full range: Y=128 gives a constant luma pedestal yBase=128/255=0.50196;
// V=128 gives cr=0. U = [16,240; 80,200] drives Cb, hence G and B only.
void testBilinearBothLocations() {
    const int W = 3, H = 3, CW = 2, CH = 2;
    std::vector<uint8_t> yv(W * H, 128);
    std::vector<uint8_t> uv = {16, 240, 80, 200};
    std::vector<uint8_t> vv(CW * CH, 128);
    PlaneView y{yv.data(), W, H, W};
    PlaneView u{uv.data(), CW, CH, CW};
    PlaneView v{vv.data(), CW, CH, CW};
    float outCenter[W * H * 3];
    float outLeft[W * H * 3];
    RgbImageView rgbC{outCenter, W, H, 0};
    RgbImageView rgbL{outLeft, W, H, 0};
    ConvertParams center{ColorMatrix::Bt601, SignalRange::Full,
                         ChromaLocation::Center};
    ConvertParams left{ColorMatrix::Bt601, SignalRange::Full,
                       ChromaLocation::Left};
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgbC, center, yv.data(),
                             yv.size(), uv.data(), uv.size(), vv.data(),
                             vv.size()) == ConvertStatus::Ok);
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgbL, left, yv.data(),
                             yv.size(), uv.data(), uv.size(), vv.data(),
                             vv.size()) == ConvertStatus::Ok);

    const float yBase = 128.0f / 255.0f;
    // Exact BT.601 coefficients derived from Kr=0.299, Kb=0.114 (mirrors the
    // production derivation rather than a rounded handbook constant).
    const float kr = 0.299f, kb = 0.114f, kg = 1.0f - kr - kb;
    const float gCb = -2.0f * kb * (1.0f - kb) / kg;
    const float bCb = 2.0f * (1.0f - kb);
    auto cbOf = [](float u) { return (u - 128.0f) / 255.0f; };
    auto bOf = [&](float u) {
        return std::clamp(yBase + bCb * cbOf(u), 0.0f, 1.0f);
    };
    auto gOf = [&](float u) {
        return std::clamp(yBase + gCb * cbOf(u), 0.0f, 1.0f);
    };
    auto rOf = [&]() { return yBase; }; // cr = 0

    // Center, pixel (0,0): cx=0.25, cy=0.25. The coordinate is clamped to the
    // sample span but fy is kept, so interpolate 25% row 0 / 75% row 1:
    //   row0 = 16*.75+240*.25 = 72 ; row1 = 80*.75+200*.25 = 110
    //   fy=0.25 -> U = 72*.75 + 110*.25 = 81.5
    const float row0 = 16.0f * 0.75f + 240.0f * 0.25f;
    const float row1 = 80.0f * 0.75f + 200.0f * 0.25f;
    const float u00c = row0 * 0.75f + row1 * 0.25f;
    checkPixel(outCenter + 0, rOf(), gOf(u00c), bOf(u00c));

    // Center, pixel (1,1): cx=0.75, cy=0.75 -> all four samples, weights
    // (0.25/0.75) in each axis.
    const float top11 = 16.0f * 0.25f + 240.0f * 0.75f;    // 184
    const float bot11 = 80.0f * 0.25f + 200.0f * 0.75f;    // 170
    const float u11c = top11 * 0.25f + bot11 * 0.75f;      // 173.5
    checkPixel(outCenter + 3 * (1 * W + 1), rOf(), gOf(u11c), bOf(u11c));

    // Center, bottom-right pixel (2,2): cx=1.25, cy=1.25 -> index 1 clamps
    // back to 1, so only sample (1,1)=200 is reachable.
    checkPixel(outCenter + 3 * (2 * W + 2), rOf(), gOf(200.0f), bOf(200.0f));

    // Left, pixel (0,0): cx=0, cy=0 -> exact sample (0,0)=16.
    checkPixel(outLeft + 0, rOf(), gOf(16.0f), bOf(16.0f));

    // Left, pixel (1,0): cx=0.5 -> U=128, zero chroma -> pure luma grey.
    checkPixel(outLeft + 3, yBase, yBase, yBase);

    // Left, pixel (2,2): cx=1, cy=1 -> exact sample (1,1)=200.
    checkPixel(outLeft + 3 * (2 * W + 2), rOf(), gOf(200.0f), bOf(200.0f));
}

// Padding bytes keep their sentinel: the pipeline reads only usable samples.
void testPaddingNotRead() {
    const int W = 3, H = 3, CW = 2, CH = 2, STRIDE = 5, CSTRIDE = 4;
    std::vector<uint8_t> yVals(W * H), uVals(CW * CH), vVals(CW * CH);
    for (std::size_t i = 0; i < yVals.size(); ++i)
        yVals[i] = static_cast<uint8_t>(20 + 7 * i);
    for (std::size_t i = 0; i < uVals.size(); ++i) {
        uVals[i] = static_cast<uint8_t>(40 + 11 * i);
        vVals[i] = static_cast<uint8_t>(60 + 13 * i);
    }
    std::vector<uint8_t> yBuf, uBuf, vBuf;
    PlaneView y = makePaddedPlane(yBuf, W, H, STRIDE, yVals);
    PlaneView u = makePaddedPlane(uBuf, CW, CH, CSTRIDE, uVals);
    PlaneView v = makePaddedPlane(vBuf, CW, CH, CSTRIDE, vVals);
    float out[W * H * 3]{};
    RgbImageView rgb{out, W, H, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Full,
                    ChromaLocation::Center};
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgb, p, yBuf.data(), yBuf.size(),
                             uBuf.data(), uBuf.size(), vBuf.data(),
                             vBuf.size()) == ConvertStatus::Ok);
    CHECK(paddingUntouched(yBuf, W, H, STRIDE, yVals));
    CHECK(paddingUntouched(uBuf, CW, CH, CSTRIDE, uVals));
    CHECK(paddingUntouched(vBuf, CW, CH, CSTRIDE, vVals));
    CHECK(requiredPlaneBytes(y) ==
          static_cast<std::size_t>((H - 1) * STRIDE + W));
    CHECK(requiredPlaneBytes(u) ==
          static_cast<std::size_t>((CH - 1) * CSTRIDE + CW));
}

// Positive-stride plane ending exactly on a PROT_NONE guard page.
void testGuardPagePositive() {
    const int W = 4, H = 4, CW = 2, CH = 2;
    GuardBuf gy = makeGuardBuf(W * H);
    GuardBuf gu = makeGuardBuf(CW * CH);
    GuardBuf gv = makeGuardBuf(CW * CH);
    CHECK(gy.base && gu.base && gv.base);
    if (!gy.base) return;
    std::vector<uint8_t> yV(W * H, 110), uV(CW * CH, 140), vV(CW * CH, 120);
    PlaneView y{guardDataPtr(gy, H, W), W, H, W};
    PlaneView u{guardDataPtr(gu, CH, CW), CW, CH, CW};
    PlaneView v{guardDataPtr(gv, CH, CW), CW, CH, CW};
    fillGuardWindow(gy, W, H, W, yV);
    fillGuardWindow(gu, CW, CH, CW, uV);
    fillGuardWindow(gv, CW, CH, CW, vV);

    float out[W * H * 3]{};
    RgbImageView rgb{out, W, H, 0};
    ConvertParams p{ColorMatrix::Bt709, SignalRange::Limited,
                    ChromaLocation::Center};
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgb, p, guardDataPtr(gy, H, W),
                             gy.usable, guardDataPtr(gu, CH, CW), gu.usable,
                             guardDataPtr(gv, CH, CW),
                             gv.usable) == ConvertStatus::Ok);
    CHECK(planeFits(y, guardDataPtr(gy, H, W), gy.usable - 1) == false);
    CHECK(validatePlanes(W, H, y, u, v, rgb, guardDataPtr(gy, H, W),
                         gy.usable - 1, guardDataPtr(gu, CH, CW), gu.usable,
                         guardDataPtr(gv, CH, CW),
                         gv.usable) == ConvertStatus::OutOfRange);
    freeGuardBuf(gy);
    freeGuardBuf(gu);
    freeGuardBuf(gv);
}

// Boundary discipline with negative strides: window extends backward.
void testGuardPageNegativeStride() {
    const int W = 3, H = 3, CW = 2, CH = 2;
    const std::size_t ySize = static_cast<std::size_t>((H - 1) * W + W);
    const std::size_t cSize = static_cast<std::size_t>((CH - 1) * CW + CW);
    GuardBuf gy = makeGuardBuf(ySize);
    GuardBuf gu = makeGuardBuf(cSize);
    GuardBuf gv = makeGuardBuf(cSize);
    CHECK(gy.base && gu.base && gv.base);
    if (!gy.base) return;
    std::vector<uint8_t> yV(W * H, 130), uV(CW * CH, 100), vV(CW * CH, 150);
    PlaneView y{guardDataPtr(gy, H, -W), W, H, -W};
    PlaneView u{guardDataPtr(gu, CH, -CW), CW, CH, -CW};
    PlaneView v{guardDataPtr(gv, CH, -CW), CW, CH, -CW};
    fillGuardWindow(gy, W, H, -W, yV);
    fillGuardWindow(gu, CW, CH, -CW, uV);
    fillGuardWindow(gv, CW, CH, -CW, vV);

    float out[W * H * 3]{};
    RgbImageView rgb{out, W, H, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Full,
                    ChromaLocation::Left};
    const uint8_t* yBase = guardDataPtr(gy, H, -W) - (H - 1) * W;
    const uint8_t* uBase = guardDataPtr(gu, CH, -CW) - (CH - 1) * CW;
    const uint8_t* vBase = guardDataPtr(gv, CH, -CW) - (CH - 1) * CW;
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgb, p, yBase, gy.usable, uBase,
                             gu.usable, vBase, gv.usable) ==
          ConvertStatus::Ok);
    CHECK(planeFits(y, yBase, gy.usable - 1) == false);
    freeGuardBuf(gy);
    freeGuardBuf(gu);
    freeGuardBuf(gv);
}

// Argument and accessible-range validation.
void testValidation() {
    const int W = 2, H = 2;
    uint8_t mem[8]{};
    PlaneView y{mem, W, H, W}, u{mem, 1, 1, 1}, v{mem, 1, 1, 1};
    float out[W * H * 3]{};
    RgbImageView rgb{out, W, H, 0};
    ConvertParams p;

    CHECK(convertYuv420ToRgb(0, H, y, u, v, rgb, p, mem, sizeof mem, mem, 1,
                             mem, 1) == ConvertStatus::InvalidArgument);
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgb, p, nullptr, sizeof mem, mem,
                             1, mem, 1) == ConvertStatus::OutOfRange);

    PlaneView bad{mem, W, H, W - 1};
    // |stride| < width cannot satisfy the accessible window.
    CHECK(convertYuv420ToRgb(W, H, bad, u, v, rgb, p, mem, sizeof mem, mem, 1,
                             mem, 1) == ConvertStatus::OutOfRange);
    PlaneView zeroStride{mem, W, H, 0};
    CHECK(convertYuv420ToRgb(W, H, zeroStride, u, v, rgb, p, mem, sizeof mem,
                             mem, 1, mem, 1) == ConvertStatus::OutOfRange);

    PlaneView wide{mem, 2, 1, 2};
    CHECK(convertYuv420ToRgb(W, H, y, wide, v, rgb, p, mem, sizeof mem, mem,
                             sizeof mem, mem, 1) ==
          ConvertStatus::InvalidArgument);

    RgbImageView wrong{out, W, H + 1, 0};
    CHECK(convertYuv420ToRgb(W, H, y, u, v, wrong, p, mem, sizeof mem, mem, 1,
                             mem, 1) == ConvertStatus::InvalidArgument);

    PlaneView y3{mem, 3, 3, 3}, u3{mem, 2, 2, 2}, v3{mem, 2, 2, 2};
    float out3[27]{};
    RgbImageView rgb3{out3, 3, 3, 0};
    CHECK(convertYuv420ToRgb(3, 3, y3, u3, v3, rgb3, p, mem, 9, mem, 4, mem,
                             4) == ConvertStatus::Ok);
}

// A negative-stride view must be bit-identical to an explicitly row-flipped
// frame. (Equality with the upright mirror is not asserted in general because
// 4:2:0 vertical subsampling makes edge luma rows asymmetric; a separate
// constant-chroma case below covers the pure vertical-mirror property.)
void testFlipEquivalence() {
    const int W = 4, H = 4, CW = 2, CH = 2;
    std::vector<uint8_t> yUp(W * H), uUp(CW * CH), vUp(CW * CH);
    for (int r = 0; r < H; ++r)
        for (int c = 0; c < W; ++c)
            yUp[r * W + c] = static_cast<uint8_t>(30 + 9 * r + 3 * c);
    for (std::size_t i = 0; i < uUp.size(); ++i) {
        uUp[i] = static_cast<uint8_t>(50 + 17 * i);
        vUp[i] = static_cast<uint8_t>(90 + 7 * i);
    }

    std::vector<uint8_t> yFlip(W * H), uFlip(CW * CH), vFlip(CW * CH);
    for (int r = 0; r < H; ++r)
        std::memcpy(&yFlip[(H - 1 - r) * W], &yUp[r * W], W);
    for (int r = 0; r < CH; ++r) {
        std::memcpy(&uFlip[(CH - 1 - r) * CW], &uUp[r * CW], CW);
        std::memcpy(&vFlip[(CH - 1 - r) * CW], &vUp[r * CW], CW);
    }

    PlaneView yUpView{yUp.data(), W, H, W};
    PlaneView uUpView{uUp.data(), CW, CH, CW};
    PlaneView vUpView{vUp.data(), CW, CH, CW};
    PlaneView yNeg{yUp.data() + (H - 1) * W, W, H, -W};
    PlaneView uNeg{uUp.data() + (CH - 1) * CW, CW, CH, -CW};
    PlaneView vNeg{vUp.data() + (CH - 1) * CW, CW, CH, -CW};
    PlaneView yFlipView{yFlip.data(), W, H, W};
    PlaneView uFlipView{uFlip.data(), CW, CH, CW};
    PlaneView vFlipView{vFlip.data(), CW, CH, CW};

    float rgbUp[W * H * 3], rgbNeg[W * H * 3], rgbFlip[W * H * 3];
    RgbImageView outUp{rgbUp, W, H, 0}, outNeg{rgbNeg, W, H, 0},
        outFlip{rgbFlip, W, H, 0};
    for (auto location : {ChromaLocation::Center, ChromaLocation::Left}) {
        ConvertParams p{ColorMatrix::Bt709, SignalRange::Limited, location};
        CHECK(convertYuv420ToRgb(W, H, yUpView, uUpView, vUpView, outUp, p,
                                 yUp.data(), yUp.size(), uUp.data(),
                                 uUp.size(), vUp.data(),
                                 vUp.size()) == ConvertStatus::Ok);
        CHECK(convertYuv420ToRgb(W, H, yNeg, uNeg, vNeg, outNeg, p,
                                 yUp.data(), yUp.size(), uUp.data(),
                                 uUp.size(), vUp.data(),
                                 vUp.size()) == ConvertStatus::Ok);
        CHECK(convertYuv420ToRgb(W, H, yFlipView, uFlipView, vFlipView,
                                 outFlip, p, yFlip.data(), yFlip.size(),
                                 uFlip.data(), uFlip.size(), vFlip.data(),
                                 vFlip.size()) == ConvertStatus::Ok);

        for (int r = 0; r < H; ++r) {
            for (int c = 0; c < W; ++c) {
                const float* negPx = rgbNeg + 3 * (r * W + c);
                const float* flipPx = rgbFlip + 3 * (r * W + c);
                for (int k = 0; k < 3; ++k) {
                    // The two flip representations are exactly equal.
                    CHECK(negPx[k] == flipPx[k]);
                }
            }
        }
    }
}

// With constant (neutral) chroma, only luma matters, so a negative-stride view
// must equal the exact vertical mirror of the upright conversion.
void testFlipMirrorWithConstantChroma() {
    const int W = 4, H = 4, CW = 2, CH = 2;
    std::vector<uint8_t> yUp(W * H), uUp(CW * CH, 128), vUp(CW * CH, 128);
    for (int r = 0; r < H; ++r)
        for (int c = 0; c < W; ++c)
            yUp[r * W + c] = static_cast<uint8_t>(20 + 11 * r + 5 * c);
    PlaneView yUpView{yUp.data(), W, H, W};
    PlaneView uView{uUp.data(), CW, CH, CW};
    PlaneView vView{vUp.data(), CW, CH, CW};
    PlaneView yNeg{yUp.data() + (H - 1) * W, W, H, -W};
    float rgbUp[W * H * 3], rgbNeg[W * H * 3];
    RgbImageView outUp{rgbUp, W, H, 0}, outNeg{rgbNeg, W, H, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Full,
                    ChromaLocation::Center};
    CHECK(convertYuv420ToRgb(W, H, yUpView, uView, vView, outUp, p,
                             yUp.data(), yUp.size(), uUp.data(), uUp.size(),
                             vUp.data(), vUp.size()) == ConvertStatus::Ok);
    CHECK(convertYuv420ToRgb(W, H, yNeg, uView, vView, outNeg, p, yUp.data(),
                             yUp.size(), uUp.data(), uUp.size(), vUp.data(),
                             vUp.size()) == ConvertStatus::Ok);
    for (int r = 0; r < H; ++r)
        for (int c = 0; c < W; ++c)
            for (int k = 0; k < 3; ++k)
                CHECK(near(rgbNeg[3 * (r * W + c) + k],
                           rgbUp[3 * ((H - 1 - r) * W + c) + k], 1e-6f));
}

// Negative stride plus row padding: padding stays untouched and ranges hold.
void testNegativeStridePadding() {
    const int W = 3, H = 3, STRIDE = 5, CW = 2, CH = 2, CSTRIDE = 3;
    std::vector<uint8_t> yV(W * H), uV(CW * CH), vV(CW * CH);
    for (std::size_t i = 0; i < yV.size(); ++i)
        yV[i] = static_cast<uint8_t>(40 + 5 * i);
    for (std::size_t i = 0; i < uV.size(); ++i) {
        uV[i] = static_cast<uint8_t>(70 + 9 * i);
        vV[i] = static_cast<uint8_t>(110 + 11 * i);
    }
    std::vector<uint8_t> yBuf, uBuf, vBuf;
    PlaneView y = makePaddedPlane(yBuf, W, H, -STRIDE, yV);
    PlaneView u = makePaddedPlane(uBuf, CW, CH, -CSTRIDE, uV);
    PlaneView v = makePaddedPlane(vBuf, CW, CH, -CSTRIDE, vV);
    float out[W * H * 3]{};
    RgbImageView rgb{out, W, H, 0};
    ConvertParams p{ColorMatrix::Bt601, SignalRange::Limited,
                    ChromaLocation::Center};
    CHECK(convertYuv420ToRgb(W, H, y, u, v, rgb, p, yBuf.data(), yBuf.size(),
                             uBuf.data(), uBuf.size(), vBuf.data(),
                             vBuf.size()) == ConvertStatus::Ok);
    CHECK(paddingUntouched(yBuf, W, H, -STRIDE, yV));
    CHECK(paddingUntouched(uBuf, CW, CH, -CSTRIDE, uV));
    CHECK(requiredPlaneBytes(y) ==
          static_cast<std::size_t>((H - 1) * STRIDE + W));
}

} // namespace

int main() {
    testHandFull601();
    testHandLimited709();
    testNeutral();
    testBilinearBothLocations();
    testPaddingNotRead();
    testGuardPagePositive();
    testGuardPageNegativeStride();
    testValidation();
    testFlipEquivalence();
    testFlipMirrorWithConstantChroma();
    testNegativeStridePadding();
    if (g_failures == 0) {
        std::printf("All %d checks passed\n", g_checks);
        return 0;
    }
    std::printf("%d / %d checks FAILED\n", g_failures, g_checks);
    return 1;
}
