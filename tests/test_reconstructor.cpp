#include "interlaced_reconstructor.h"
#include "forward_filter_fixture.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <random>
#include <stdexcept>
#include <vector>

namespace {

using imgrecon::InterlacedReconstructor;
namespace tst = imgrecon::test;

int g_checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #cond,       \
                         __FILE__, __LINE__);                                \
            throw std::runtime_error("test failure");                       \
        }                                                                    \
    } while (0)

std::vector<std::uint8_t> makeImage(int width, int height, int bpp,
                                    std::uint32_t seed) {
    std::mt19937 rng(seed);
    std::vector<std::uint8_t> image(
        static_cast<std::size_t>(width) * height * bpp);
    for (auto& byte : image) {
        byte = static_cast<std::uint8_t>(rng() & 0xFF);
    }
    return image;
}

// Drives every encoded stream through feed() in random chunk sizes and random
// stream order, then validates all rows arrived in order, byte for byte.
void roundTripChunks(const std::vector<std::uint8_t>& image, int width, int height,
                     int bpp,
                     const std::function<std::uint8_t(int, int)>& filterForRow,
                     std::uint32_t seed, int maxChunk) {
    auto streams = tst::encodeImage(image, width, height, bpp, filterForRow);

    std::vector<std::size_t> emitted;
    std::vector<std::uint8_t> reconstructed(image.size(), 0xCD);
    const std::size_t rowSize = static_cast<std::size_t>(width) * bpp;

    InterlacedReconstructor decoder(
        width, height, bpp,
        [&](std::size_t index, const std::uint8_t* row) {
            emitted.push_back(index);
            std::copy(row, row + rowSize,
                      reconstructed.begin() + index * rowSize);
        });

    std::mt19937 rng(seed);

    // Per-stream FIFO chunk queues so each stream's byte order is preserved.
    std::array<std::vector<std::vector<std::uint8_t>>, 7> queues;
    for (int pass = 0; pass < 7; ++pass) {
        std::size_t pos = 0;
        const auto& data = streams[pass];
        while (pos < data.size()) {
            std::size_t remaining = data.size() - pos;
            std::size_t chunk = 1 + rng() % static_cast<std::uint32_t>(maxChunk);
            chunk = std::min(chunk, remaining);
            queues[pass].push_back(
                {data.begin() + pos, data.begin() + pos + chunk});
            pos += chunk;
        }
    }

    // Randomly interleave whole chunks across streams while keeping every
    // stream's chunks in FIFO order (a byte stream cannot be reordered).
    std::array<std::size_t, 7> head{};
    while (true) {
        std::vector<int> ready;
        for (int pass = 0; pass < 7; ++pass) {
            if (head[pass] < queues[pass].size()) {
                ready.push_back(pass);
            }
        }
        if (ready.empty()) {
            break;
        }
        const int pass = ready[rng() % ready.size()];
        CHECK(decoder.feed(pass, queues[pass][head[pass]++]));
    }
    CHECK(decoder.finish());
    CHECK(!decoder.failed());

    CHECK(emitted.size() == static_cast<std::size_t>(height));
    for (std::size_t row = 0; row < emitted.size(); ++row) {
        CHECK(emitted[row] == row);  // rows delivered strictly in order
    }
    CHECK(reconstructed == image);
}

std::uint8_t rotatingFilter(int pass, int subRow) {
    return static_cast<std::uint8_t>((pass + subRow) % 5);
}

void testOddSizes() {
    const struct Case {
        int width;
        int height;
        int bpp;
    } cases[] = {
        {1, 1, 1},   {3, 5, 1},   {7, 9, 1},   {11, 13, 4},
        {13, 7, 4},  {5, 1, 4},   {1, 11, 4},  {17, 3, 1},
        {9, 17, 4},  {31, 23, 1}, {2, 2, 1},   {8, 8, 4},
    };
    std::uint32_t seed = 100;
    for (const Case& c : cases) {
        auto image = makeImage(c.width, c.height, c.bpp, seed++);
        roundTripChunks(image, c.width, c.height, c.bpp, rotatingFilter, seed, 7);
    }
}

void testEmptyStreams() {
    // 1x1: only stream 0 carries a pixel; the other six are empty and must
    // accept zero bytes while still completing the single target row.
    for (int bpp : {1, 4}) {
        auto image = makeImage(1, 1, bpp, 7);
        auto streams =
            tst::encodeImage(image, 1, 1, bpp, [](int, int) { return 0; });
        std::vector<std::size_t> emitted;
        InterlacedReconstructor decoder(
            1, 1, bpp, [&](std::size_t i, const std::uint8_t*) {
                emitted.push_back(i);
            });
        for (int pass = 0; pass < 7; ++pass) {
            CHECK(decoder.expectedStreamBytes(pass) == streams[pass].size());
            CHECK(decoder.feed(pass, streams[pass]));
        }
        CHECK(decoder.finish());
        CHECK(emitted.size() == 1 && emitted[0] == 0);
    }

    // A 4x4 image leaves several later passes empty as well.
    auto image = makeImage(4, 4, 1, 11);
    auto streams = tst::encodeImage(image, 4, 4, 1, rotatingFilter);
    InterlacedReconstructor decoder(4, 4, 1, nullptr);
    for (int pass = 0; pass < 7; ++pass) {
        CHECK(decoder.feed(pass, streams[pass]));
    }
    CHECK(decoder.finish());
}

void testSingleByteChunks() {
    // Worst case for row interruption: every byte arrives on its own and the
    // seven streams are interleaved round-robin.
    for (int bpp : {1, 4}) {
        auto image = makeImage(19, 11, bpp, 42);
        auto streams = tst::encodeImage(image, 19, 11, bpp, rotatingFilter);
        std::vector<std::size_t> emitted;
        std::vector<std::uint8_t> reconstructed(image.size(), 0);
        const std::size_t rowSize = 19u * bpp;
        InterlacedReconstructor decoder(
            19, 11, bpp, [&](std::size_t i, const std::uint8_t* row) {
                emitted.push_back(i);
                std::copy(row, row + rowSize,
                          reconstructed.begin() + i * rowSize);
            });
        bool anyLeft = true;
        std::array<std::size_t, 7> pos{};
        while (anyLeft) {
            anyLeft = false;
            for (int pass = 0; pass < 7; ++pass) {
                if (pos[pass] < streams[pass].size()) {
                    anyLeft = true;
                    std::uint8_t byte = streams[pass][pos[pass]++];
                    CHECK(decoder.feed(pass, &byte, 1));
                }
            }
        }
        CHECK(decoder.finish());
        CHECK(emitted.size() == 11);
        CHECK(reconstructed == image);
    }
}

void testEachFilterPure() {
    // One whole image per filter type so each predictor is exercised alone.
    for (int filter = 0; filter <= 4; ++filter) {
        for (int bpp : {1, 4}) {
            auto image = makeImage(23, 17, bpp, 200 + filter * 13 + bpp);
            roundTripChunks(
                image, 23, 17, bpp,
                [filter](int, int) { return static_cast<std::uint8_t>(filter); },
                500 + filter, 5);
        }
    }
}

void testPaethTiesRandom() {
    // All-filter-4 on dense data forces every Paeth tie branch (a/b, b/c,
    // unique c, all-equal) across first and later rows of each stream.
    for (int bpp : {1, 4}) {
        auto image = makeImage(16, 16, bpp, 909);
        roundTripChunks(image, 16, 16, bpp, [](int, int) { return 4; }, 910, 3);
    }
}

void testPaethTieBreakOrder() {
    // Hand-built 4x1, bpp=1 case pins down the exact tie-breaking rules.
    InterlacedReconstructor decoder(4, 1, 1, nullptr);

    // Stream 0 row 0: a=b=c=0 -> filter 4 reconstructs raw byte 200.
    std::vector<std::uint8_t> pass0 = {4, 200};
    CHECK(decoder.feed(0, pass0));

    // Stream 3 (startX=2, stepX=4) owns target column 2; one pixel, no above.
    CHECK(decoder.subImageWidth(3) == 1);
    std::vector<std::uint8_t> pass3 = {4, 70};  // raw byte 70, predictor 0
    CHECK(decoder.feed(3, pass3));

    // Stream 5 (startX=1, stepX=2) covers target columns 1 and 3, so its
    // sub-row holds two pixels. The above row is absent, hence b=c=0 and the
    // predictor must pick the left byte `a` for the second pixel.
    CHECK(decoder.subImageWidth(5) == 2);
    std::vector<std::uint8_t> raw = {10, 30};
    std::vector<std::uint8_t> previous;
    auto encoded = tst::encodeRow(raw, previous, 1, 4);
    CHECK(encoded.size() == 3 && encoded[0] == 4);
    CHECK(encoded[1] == 10);  // first byte: a=0 -> delta 10
    CHECK(encoded[2] == 20);  // second: a=10 -> delta 20
    CHECK(decoder.feed(5, encoded));
    CHECK(decoder.finish());

    // Direct checks of the documented tie-break ordering.
    const auto pa = [](int a, int b, int c) {
        return tst::paethForward(a, b, c);
    };
    CHECK(pa(10, 10, 0) == 10);   // a/b tie -> a
    CHECK(pa(0, 3, 1) == 3);      // b/c tie -> b
    CHECK(pa(0, 2, 1) == 1);      // c uniquely closest -> c
    CHECK(pa(7, 7, 7) == 7);      // all equal -> a
    CHECK(pa(0, 0, 0) == 0);
}

void testIllegalFilterAborts() {
    auto image = makeImage(8, 8, 1, 3);
    auto streams = tst::encodeImage(image, 8, 8, 1, [](int, int) { return 0; });
    InterlacedReconstructor decoder(8, 8, 1, nullptr);
    streams[0][0] = 5;  // filter byte out of range
    CHECK(!decoder.feed(0, streams[0]));
    CHECK(decoder.failed());
    CHECK(decoder.error() == InterlacedReconstructor::Error::IllegalFilter);
    // Whole image is revoked: every later feed is rejected.
    CHECK(!decoder.feed(1, streams[1]));
    CHECK(!decoder.finish());
}

void testTruncatedStreamAborts() {
    auto image = makeImage(10, 6, 4, 5);
    auto streams = tst::encodeImage(image, 10, 6, 4, rotatingFilter);
    InterlacedReconstructor decoder(10, 6, 4, nullptr);
    for (int pass = 0; pass < 7; ++pass) {
        if (pass == 4) {
            CHECK(!streams[pass].empty());
            CHECK(decoder.feed(pass, streams[pass].data(),
                               streams[pass].size() - 2));  // short
        } else {
            CHECK(decoder.feed(pass, streams[pass]));
        }
    }
    CHECK(!decoder.finish());
    CHECK(decoder.error() == InterlacedReconstructor::Error::StreamTruncated);
}

void testTooLongStreamAborts() {
    auto image = makeImage(8, 8, 1, 9);
    auto streams = tst::encodeImage(image, 8, 8, 1, [](int, int) { return 0; });
    InterlacedReconstructor decoder(8, 8, 1, nullptr);
    streams[0].push_back(0);  // one byte beyond expected length
    CHECK(!decoder.feed(0, streams[0]));
    CHECK(decoder.error() == InterlacedReconstructor::Error::StreamTooLong);
    CHECK(decoder.failed());
}

void testInvalidStreamId() {
    InterlacedReconstructor decoder(4, 4, 1, nullptr);
    std::uint8_t byte = 0;
    CHECK(!decoder.feed(-1, &byte, 1));
    CHECK(decoder.error() == InterlacedReconstructor::Error::InvalidStreamId);
    InterlacedReconstructor other(4, 4, 1, nullptr);
    CHECK(!other.feed(7, &byte, 1));
    CHECK(other.failed());
}

void testConstructorValidation() {
    bool threw = false;
    try {
        InterlacedReconstructor bad(0, 4, 1, nullptr);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        InterlacedReconstructor bad(4, 4, 2, nullptr);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

void testRowOnlyWhenComplete() {
    // Feed an early stream fully before any late stream: rows that still need
    // later streams must not be emitted prematurely.
    auto image = makeImage(9, 9, 4, 77);
    auto streams = tst::encodeImage(image, 9, 9, 4, rotatingFilter);
    std::vector<std::size_t> emitted;
    InterlacedReconstructor decoder(
        9, 9, 4, [&](std::size_t i, const std::uint8_t*) { emitted.push_back(i); });

    // Stream 0 touches only rows 0 (y=0) for a 9-high image (y=8 out of range).
    CHECK(decoder.feed(0, streams[0]));
    CHECK(emitted.empty());  // row 0 still needs streams 1..6

    for (int pass = 1; pass < 7; ++pass) {
        CHECK(decoder.feed(pass, streams[pass]));
    }
    CHECK(decoder.finish());
    CHECK(emitted.size() == 9);
    for (std::size_t row = 0; row < emitted.size(); ++row) {
        CHECK(emitted[row] == row);
    }
}

}  // namespace

int main() {
    testOddSizes();
    testEmptyStreams();
    testSingleByteChunks();
    testEachFilterPure();
    testPaethTiesRandom();
    testPaethTieBreakOrder();
    testIllegalFilterAborts();
    testTruncatedStreamAborts();
    testTooLongStreamAborts();
    testInvalidStreamId();
    testConstructorValidation();
    testRowOnlyWhenComplete();
    std::printf("All tests passed (%d checks).\n", g_checks);
    return 0;
}
