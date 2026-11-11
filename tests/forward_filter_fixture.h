#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <vector>

namespace imgrecon::test {

// Independent forward (encoding) counterpart of the reconstruction filters.
// This deliberately re-derives predictions from raw bytes instead of inverting
// the decoder, so round-trip tests exercise genuinely separate logic.

struct PassSpec {
    int startX;
    int startY;
    int stepX;
    int stepY;
};

constexpr PassSpec kPasses[7] = {
    {0, 0, 8, 8}, {4, 0, 8, 8}, {0, 4, 4, 8}, {2, 0, 4, 4},
    {0, 2, 2, 4}, {1, 0, 2, 2}, {0, 1, 1, 2},
};

inline int subCount(int start, int step, int extent) {
    if (start >= extent) {
        return 0;
    }
    return (extent - start - 1) / step + 1;
}

inline std::uint8_t paethForward(int a, int b, int c) {
    const int p = a + b - c;
    const int pa = std::abs(p - a);
    const int pb = std::abs(p - b);
    const int pc = std::abs(p - c);
    if (pa <= pb && pa <= pc) {
        return static_cast<std::uint8_t>(a);
    }
    if (pb <= pc) {
        return static_cast<std::uint8_t>(b);
    }
    return static_cast<std::uint8_t>(c);
}

// Encodes one raw sub-image row. previousRaw is the prior row of the same
// stream (empty/zero for the first row); bpp is bytes per pixel.
inline std::vector<std::uint8_t> encodeRow(const std::vector<std::uint8_t>& raw,
                                           const std::vector<std::uint8_t>& previousRaw,
                                           int bpp, std::uint8_t filterType) {
    std::vector<std::uint8_t> out;
    out.reserve(raw.size() + 1);
    out.push_back(filterType);
    for (std::size_t i = 0; i < raw.size(); ++i) {
        const int a = (i >= static_cast<std::size_t>(bpp)) ? raw[i - bpp] : 0;
        const int b = previousRaw.empty() ? 0 : previousRaw[i];
        const int c = (i >= static_cast<std::size_t>(bpp) && !previousRaw.empty())
                          ? previousRaw[i - bpp]
                          : 0;
        int prediction = 0;
        switch (filterType) {
            case 0:
                prediction = 0;
                break;
            case 1:
                prediction = a;
                break;
            case 2:
                prediction = b;
                break;
            case 3:
                prediction = (a + b) / 2;
                break;
            case 4:
                prediction = paethForward(a, b, c);
                break;
        }
        out.push_back(static_cast<std::uint8_t>((raw[i] - prediction) & 0xFF));
    }
    return out;
}

// Builds the seven encoded streams for an entire image.
// filterForRow chooses the filter number for each (stream, sub-row) pair.
inline std::array<std::vector<std::uint8_t>, 7> encodeImage(
    const std::vector<std::uint8_t>& image, int width, int height, int bpp,
    const std::function<std::uint8_t(int pass, int subRow)>& filterForRow) {
    std::array<std::vector<std::uint8_t>, 7> streams;
    const std::size_t rowSize = static_cast<std::size_t>(width) * bpp;

    for (int pass = 0; pass < 7; ++pass) {
        const PassSpec& spec = kPasses[pass];
        const int subWidth = subCount(spec.startX, spec.stepX, width);
        const int subHeight = subCount(spec.startY, spec.stepY, height);
        if (subWidth == 0 || subHeight == 0) {
            continue;
        }
        std::vector<std::uint8_t> previousRaw;
        for (int subRow = 0; subRow < subHeight; ++subRow) {
            const int targetY = spec.startY + subRow * spec.stepY;
            std::vector<std::uint8_t> raw(static_cast<std::size_t>(subWidth) * bpp);
            for (int column = 0; column < subWidth; ++column) {
                const int targetX = spec.startX + column * spec.stepX;
                const std::size_t src =
                    static_cast<std::size_t>(targetY) * rowSize +
                    static_cast<std::size_t>(targetX) * bpp;
                const std::size_t dst = static_cast<std::size_t>(column) * bpp;
                for (int byte = 0; byte < bpp; ++byte) {
                    raw[dst + byte] = image[src + byte];
                }
            }
            auto encoded = encodeRow(raw, previousRaw, bpp,
                                     filterForRow(pass, subRow));
            streams[pass].insert(streams[pass].end(), encoded.begin(), encoded.end());
            previousRaw = std::move(raw);
        }
    }
    return streams;
}

}  // namespace imgrecon::test
