#pragma once

// Shared helpers for the png8 test suite: a tiny CHECK harness, a PNG
// builder, and an *independent* reference implementation of the scanline
// filter inversion used to cross-check the library.

#include "png8/png8.hpp"
#include "png8/zlib_stored.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <span>
#include <string>
#include <vector>

namespace tutil {

inline int g_failures = 0;
inline int g_checks = 0;

}  // namespace tutil

#define CHECK(cond)                                                              \
    do {                                                                         \
        ++tutil::g_checks;                                                       \
        if (!(cond)) {                                                           \
            ++tutil::g_failures;                                                 \
            std::fprintf(stderr, "FAIL %s:%d: CHECK(%s)\n", __FILE__, __LINE__,  \
                         #cond);                                                 \
        }                                                                        \
    } while (0)

#define CHECK_EQ(a, b)                                                           \
    do {                                                                         \
        ++tutil::g_checks;                                                       \
        const auto va = (a);                                                     \
        const auto vb = (b);                                                     \
        if (!(va == vb)) {                                                       \
            ++tutil::g_failures;                                                 \
            std::fprintf(stderr, "FAIL %s:%d: CHECK_EQ(%s, %s)\n", __FILE__,     \
                         __LINE__, #a, #b);                                      \
        }                                                                        \
    } while (0)

#define TEST_MAIN()                                                              \
    int main() {                                                                 \
        run_tests();                                                             \
        if (tutil::g_failures == 0) {                                            \
            std::printf("OK: %d checks passed\n", tutil::g_checks);              \
            return 0;                                                            \
        }                                                                        \
        std::printf("FAILED: %d of %d checks failed\n", tutil::g_failures,       \
                    tutil::g_checks);                                            \
        return 1;                                                                \
    }

namespace tutil {

inline void append_be32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    out.push_back(static_cast<std::uint8_t>(value >> 24));
    out.push_back(static_cast<std::uint8_t>(value >> 16));
    out.push_back(static_cast<std::uint8_t>(value >> 8));
    out.push_back(static_cast<std::uint8_t>(value));
}

// Builds a PNG byte stream chunk by chunk. CRCs are computed with an
// independent bitwise implementation (not the library's table-driven one).
class PngBuilder {
  public:
    PngBuilder() : bytes_{137, 80, 78, 71, 13, 10, 26, 10} {}

    static std::uint32_t crc_bitwise(std::span<const std::uint8_t> data) {
        std::uint32_t crc = 0xFFFFFFFFu;
        for (std::uint8_t byte : data) {
            crc ^= byte;
            for (int k = 0; k < 8; ++k)
                crc = (crc & 1) ? 0xEDB88320u ^ (crc >> 1) : crc >> 1;
        }
        return crc ^ 0xFFFFFFFFu;
    }

    PngBuilder& chunk(const char type[4], std::span<const std::uint8_t> data) {
        append_be32(bytes_, static_cast<std::uint32_t>(data.size()));
        const std::size_t type_pos = bytes_.size();
        bytes_.insert(bytes_.end(), type, type + 4);
        bytes_.insert(bytes_.end(), data.begin(), data.end());
        const std::uint32_t crc =
            crc_bitwise(std::span<const std::uint8_t>(bytes_).subspan(type_pos, 4 + data.size()));
        append_be32(bytes_, crc);
        return *this;
    }

    // Appends a chunk with a raw, possibly wrong, CRC (for negative tests).
    PngBuilder& chunk_raw_crc(const char type[4], std::span<const std::uint8_t> data,
                              std::uint32_t crc) {
        append_be32(bytes_, static_cast<std::uint32_t>(data.size()));
        bytes_.insert(bytes_.end(), type, type + 4);
        bytes_.insert(bytes_.end(), data.begin(), data.end());
        append_be32(bytes_, crc);
        return *this;
    }

    PngBuilder& ihdr(std::uint32_t width, std::uint32_t height, std::uint8_t bit_depth = 8,
                     std::uint8_t color_type = 0, std::uint8_t compression = 0,
                     std::uint8_t filter = 0, std::uint8_t interlace = 0) {
        std::vector<std::uint8_t> data;
        append_be32(data, width);
        append_be32(data, height);
        data.insert(data.end(), {bit_depth, color_type, compression, filter, interlace});
        return chunk("IHDR", data);
    }

    PngBuilder& idat(std::span<const std::uint8_t> data) { return chunk("IDAT", data); }

    PngBuilder& iend() { return chunk("IEND", {}); }

    const std::vector<std::uint8_t>& bytes() const { return bytes_; }
    std::vector<std::uint8_t>& bytes() { return bytes_; }

  private:
    std::vector<std::uint8_t> bytes_;
};

// Independent forward filter: produces filtered scanlines for `pixels`
// using the given per-row filter types (values must be 0..4).
inline std::vector<std::uint8_t> reference_filter(const std::vector<std::uint8_t>& pixels,
                                                  std::uint32_t width, std::uint32_t height,
                                                  const std::vector<std::uint8_t>& filters) {
    auto paeth = [](int a, int b, int c) {
        const int p = a + b - c;
        const int pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
        return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
    };
    std::vector<std::uint8_t> out;
    out.reserve(pixels.size() + height);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t f = filters[y];
        out.push_back(f);
        for (std::uint32_t x = 0; x < width; ++x) {
            const int raw = pixels[static_cast<std::size_t>(y) * width + x];
            const int left = x >= 1 ? pixels[static_cast<std::size_t>(y) * width + x - 1] : 0;
            const int up = y >= 1 ? pixels[static_cast<std::size_t>(y - 1) * width + x] : 0;
            const int up_left =
                (x >= 1 && y >= 1) ? pixels[static_cast<std::size_t>(y - 1) * width + x - 1] : 0;
            int predictor = 0;
            switch (f) {
                case 0: predictor = 0; break;
                case 1: predictor = left; break;
                case 2: predictor = up; break;
                case 3: predictor = (left + up) / 2; break;
                case 4: predictor = paeth(left, up, up_left); break;
            }
            out.push_back(static_cast<std::uint8_t>((raw - predictor) & 0xFF));
        }
    }
    return out;
}

// Independent inverse filter (cross-check target for png8::decode).
inline std::vector<std::uint8_t> reference_unfilter(const std::vector<std::uint8_t>& filtered,
                                                    std::uint32_t width, std::uint32_t height) {
    auto paeth = [](int a, int b, int c) {
        const int p = a + b - c;
        const int pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
        return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
    };
    const std::size_t row_bytes = static_cast<std::size_t>(width) + 1;
    std::vector<std::uint8_t> out(static_cast<std::size_t>(width) * height, 0);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t f = filtered[static_cast<std::size_t>(y) * row_bytes];
        for (std::uint32_t x = 0; x < width; ++x) {
            const int diff = filtered[static_cast<std::size_t>(y) * row_bytes + 1 + x];
            const int left = x >= 1 ? out[static_cast<std::size_t>(y) * width + x - 1] : 0;
            const int up = y >= 1 ? out[static_cast<std::size_t>(y - 1) * width + x] : 0;
            const int up_left =
                (x >= 1 && y >= 1) ? out[static_cast<std::size_t>(y - 1) * width + x - 1] : 0;
            int predictor = 0;
            switch (f) {
                case 0: predictor = 0; break;
                case 1: predictor = left; break;
                case 2: predictor = up; break;
                case 3: predictor = (left + up) / 2; break;
                case 4: predictor = paeth(left, up, up_left); break;
            }
            out[static_cast<std::size_t>(y) * width + x] =
                static_cast<std::uint8_t>((diff + predictor) & 0xFF);
        }
    }
    return out;
}

// Deterministic PRNG for reproducible fixtures.
inline std::mt19937_64& rng() {
    static std::mt19937_64 gen{0x504E4738};  // "PNG8"
    return gen;
}

inline std::vector<std::uint8_t> random_bytes(std::size_t n) {
    std::vector<std::uint8_t> v(n);
    for (auto& b : v) b = static_cast<std::uint8_t>(rng()() & 0xFF);
    return v;
}

// Builds a complete single-IDAT PNG around already-filtered scanlines.
inline std::vector<std::uint8_t> make_png(std::uint32_t width, std::uint32_t height,
                                          const std::vector<std::uint8_t>& filtered) {
    const std::vector<std::uint8_t> zlib = png8::zlib::compress_stored(filtered);
    return PngBuilder().ihdr(width, height).idat(zlib).iend().bytes();
}

}  // namespace tutil
