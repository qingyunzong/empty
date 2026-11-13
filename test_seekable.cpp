#include "dataeng.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <vector>

// Minimal libzstd C API surface used to build test fixtures.
extern "C" {
std::size_t ZSTD_compressBound(std::size_t srcSize);
void* ZSTD_createCCtx();
std::size_t ZSTD_freeCCtx(void* cctx);
std::size_t ZSTD_CCtx_setParameter(void* cctx, int param, int value);
std::size_t ZSTD_compress2(void* cctx, void* dst, std::size_t dstCapacity,
                           const void* src, std::size_t srcSize);
unsigned ZSTD_isError(std::size_t code);
}

namespace {

constexpr int kZstdCCompressionLevel = 100;
constexpr int kZstdCContentSizeFlag = 200;
constexpr int kZstdCChecksumFlag = 201;

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
        }                                                                  \
    } while (0)

#define CHECK_THROWS_SEEKABLE(expr)                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        bool threw = false;                                                \
        try {                                                              \
            (void)(expr);                                                  \
        } catch (const dataeng::SeekableIndexError&) {                     \
            threw = true;                                                  \
        }                                                                  \
        if (!threw) {                                                      \
            ++g_failures;                                                  \
            std::printf("FAIL %s:%d: expected SeekableIndexError: %s\n",   \
                        __FILE__, __LINE__, #expr);                        \
        }                                                                  \
    } while (0)

void appendLe32(std::vector<std::byte>& out, std::uint32_t value) {
    for (int i = 0; i < 4; ++i) {
        out.push_back(static_cast<std::byte>((value >> (8 * i)) & 0xFF));
    }
}

struct XorShift {
    std::uint64_t state = 0x9E3779B97F4A7C15ull;
    std::uint64_t next() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        return state;
    }
};

std::vector<std::byte> randomBytes(std::size_t n, XorShift& rng) {
    std::vector<std::byte> out(n);
    for (auto& b : out) {
        b = static_cast<std::byte>(rng.next() & 0xFF);
    }
    return out;
}

std::vector<std::byte> textBytes(std::size_t n) {
    std::vector<std::byte> out(n);
    for (std::size_t i = 0; i < n; ++i) {
        out[i] = static_cast<std::byte>('a' + (i * 7 + i / 13) % 26);
    }
    return out;
}

std::vector<std::byte> compressFrame(const std::vector<std::byte>& src,
                                     bool checksum) {
    void* cctx = ZSTD_createCCtx();
    ZSTD_CCtx_setParameter(cctx, kZstdCCompressionLevel, 3);
    ZSTD_CCtx_setParameter(cctx, kZstdCContentSizeFlag, 1);
    ZSTD_CCtx_setParameter(cctx, kZstdCChecksumFlag, checksum ? 1 : 0);
    std::vector<std::byte> out(ZSTD_compressBound(src.size()));
    const std::size_t r = ZSTD_compress2(cctx, out.data(), out.size(),
                                         src.data(), src.size());
    ZSTD_freeCCtx(cctx);
    if (ZSTD_isError(r)) {
        std::fprintf(stderr, "fixture compression failed\n");
        std::abort();
    }
    out.resize(r);
    return out;
}

struct Fixture {
    std::vector<std::byte> file;
    std::vector<std::byte> plain;  // concatenated decompressed contents
    std::vector<std::size_t> frame_offsets;  // compressed offsets
};

// Builds a seekable file from raw chunks. `table_checksums` controls the
// seek table checksum column; `frame_checksums` the per-frame checksums.
// `frames_in_table` limits how many leading frames the table describes
// (used to build count-mismatch corruption cases).
Fixture buildSeekable(const std::vector<std::vector<std::byte>>& chunks,
                      bool frame_checksums, bool table_checksums,
                      std::size_t frames_in_table = ~0ull) {
    Fixture fx;
    std::vector<std::vector<std::byte>> frames;
    for (const auto& chunk : chunks) {
        frames.push_back(compressFrame(chunk, frame_checksums));
    }
    for (const auto& frame : frames) {
        fx.frame_offsets.push_back(fx.file.size());
        fx.file.insert(fx.file.end(), frame.begin(), frame.end());
    }
    for (const auto& chunk : chunks) {
        fx.plain.insert(fx.plain.end(), chunk.begin(), chunk.end());
    }

    const std::size_t count =
        std::min(frames_in_table, frames.size());
    std::vector<std::byte> table;
    appendLe32(table, static_cast<std::uint32_t>(count));
    table.push_back(static_cast<std::byte>(table_checksums ? 0x20 : 0x00));
    for (std::size_t i = 0; i < count; ++i) {
        appendLe32(table, static_cast<std::uint32_t>(frames[i].size()));
        appendLe32(table, static_cast<std::uint32_t>(chunks[i].size()));
        if (table_checksums) {
            // Frame trailer holds the content checksum.
            table.insert(table.end(), frames[i].end() - 4, frames[i].end());
        }
    }
    appendLe32(table, 0x8F92EAB1u);

    appendLe32(fx.file, 0x184D2A5Eu);
    appendLe32(fx.file, static_cast<std::uint32_t>(table.size()));
    fx.file.insert(fx.file.end(), table.begin(), table.end());
    return fx;
}

std::vector<std::byte> slice(const std::vector<std::byte>& v, std::size_t off,
                             std::size_t len) {
    return {v.begin() + off, v.begin() + off + len};
}

void testRoundTrip(bool frame_checksums, bool table_checksums) {
    XorShift rng;
    std::vector<std::vector<std::byte>> chunks = {
        textBytes(1000), randomBytes(65536, rng), textBytes(1),
        randomBytes(100000, rng), {}, textBytes(4096),
    };
    Fixture fx =
        buildSeekable(chunks, frame_checksums, table_checksums);

    dataeng::SeekableIndex index = dataeng::SeekableIndex::parse(fx.file);
    CHECK(index.frameCount() == chunks.size());
    CHECK(index.hasChecksums() == table_checksums);
    CHECK(index.decompressedSize() == fx.plain.size());

    std::uint64_t coff = 0, doff = 0;
    for (std::size_t i = 0; i < chunks.size(); ++i) {
        const auto& e = index.entries()[i];
        CHECK(e.compressed_offset == coff);
        CHECK(e.decompressed_offset == doff);
        CHECK(e.decompressed_size == chunks[i].size());
        CHECK(e.compressed_offset == fx.frame_offsets[i]);
        CHECK(e.checksum.has_value() == table_checksums);
        coff += e.compressed_size;
        doff += e.decompressed_size;
    }
    CHECK(index.compressedSize() == coff);

    // Full range.
    CHECK(index.readRange(fx.file, 0, fx.plain.size()) == fx.plain);
    // Empty ranges, including at the very end.
    CHECK(index.readRange(fx.file, 0, 0).empty());
    CHECK(index.readRange(fx.file, fx.plain.size(), 0).empty());

    // Deterministic random ranges.
    for (int i = 0; i < 300; ++i) {
        const std::uint64_t off = rng.next() % fx.plain.size();
        const std::uint64_t max_len = fx.plain.size() - off;
        const std::uint64_t len = 1 + rng.next() % std::min<std::uint64_t>(max_len, 70000);
        auto got = index.readRange(fx.file, off, len);
        CHECK(got == slice(fx.plain, off, len));
    }

    // Out-of-range requests are rejected.
    bool range_threw = false;
    try {
        index.readRange(fx.file, fx.plain.size(), 1);
    } catch (const dataeng::SeekableRangeError&) {
        range_threw = true;
    }
    CHECK(range_threw);
    range_threw = false;
    try {
        index.readRange(fx.file, fx.plain.size() - 1, 2);
    } catch (const dataeng::SeekableRangeError&) {
        range_threw = true;
    }
    CHECK(range_threw);

    // Owning reader.
    dataeng::SeekableReader reader(fx.file);
    CHECK(reader.readRange(3, 100) == slice(fx.plain, 3, 100));
}

void testCorruptions() {
    XorShift rng;
    std::vector<std::vector<std::byte>> chunks = {
        textBytes(5000), randomBytes(20000, rng), textBytes(3000),
    };
    const Fixture fx = buildSeekable(chunks, true, true);
    const std::size_t table_payload = 5 + 3 * 12 + 4;
    const std::size_t table_start = fx.file.size() - (8 + table_payload);
    const std::size_t entries_start = table_start + 8 + 5;

    CHECK(dataeng::SeekableIndex::parse(fx.file).frameCount() == 3);

    // Truncations.
    for (std::size_t cut : {1ul, 4ul, 7ul, 20ul, fx.file.size() - 1ul}) {
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(
            std::span<const std::byte>(fx.file.data(), fx.file.size() - cut)));
    }
    // Trailing garbage after the seek table.
    {
        auto bad = fx.file;
        bad.push_back(std::byte{0});
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Bad footer magic.
    {
        auto bad = fx.file;
        bad[bad.size() - 1] ^= std::byte{0xFF};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Reserved descriptor bits set.
    {
        auto bad = fx.file;
        bad[table_start + 8 + 4] |= std::byte{0x01};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Compressed size off by one: boundaries no longer line up.
    {
        auto bad = fx.file;
        bad[entries_start] ^= std::byte{0x01};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Decompressed size altered.
    {
        auto bad = fx.file;
        bad[entries_start + 4] ^= std::byte{0x01};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Checksum altered.
    {
        auto bad = fx.file;
        bad[entries_start + 8] ^= std::byte{0x01};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Frame count mismatch: table only describes the first two frames.
    {
        Fixture short_table = buildSeekable(chunks, true, true, 2);
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(short_table.file));
    }
    // Missing seek table entirely.
    {
        std::vector<std::byte> no_table(
            fx.file.begin(), fx.file.begin() + fx.frame_offsets.back());
        // Drop everything from the third frame on, leaving only zstd frames.
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(no_table));
    }
    // Foreign skippable frame in the middle.
    {
        std::vector<std::byte> bad;
        bad.insert(bad.end(), fx.file.begin(),
                   fx.file.begin() + fx.frame_offsets[1]);
        appendLe32(bad, 0x184D2A51u);
        appendLe32(bad, 3u);
        bad.insert(bad.end(), {std::byte{1}, std::byte{2}, std::byte{3}});
        bad.insert(bad.end(), fx.file.begin() + fx.frame_offsets[1],
                   fx.file.end());
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Corrupted zstd frame magic.
    {
        auto bad = fx.file;
        bad[fx.frame_offsets[1]] ^= std::byte{0xFF};
        CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse(bad));
    }
    // Empty input.
    CHECK_THROWS_SEEKABLE(dataeng::SeekableIndex::parse({}));
}

void testSelectiveDecompression() {
    XorShift rng;
    std::vector<std::vector<std::byte>> chunks = {
        textBytes(8000), randomBytes(40000, rng), textBytes(8000),
    };
    // Frames carry content checksums; the table has no checksum column, so
    // parsing does not inspect frame trailers.
    Fixture fx = buildSeekable(chunks, true, false);
    dataeng::SeekableIndex index = dataeng::SeekableIndex::parse(fx.file);

    // Corrupt the checksum trailer of the middle frame.
    const std::size_t frame1_end =
        fx.frame_offsets[1] + (fx.frame_offsets[2] - fx.frame_offsets[1]);
    fx.file[frame1_end - 1] ^= std::byte{0xFF};

    // Ranges touching only intact frames still work: only the frames
    // intersecting the range are decompressed.
    const auto& e0 = index.entries()[0];
    CHECK(index.readRange(fx.file, 0, e0.decompressed_size) == chunks[0]);
    const auto& e2 = index.entries()[2];
    CHECK(index.readRange(fx.file, e2.decompressed_offset,
                          e2.decompressed_size) == chunks[2]);

    // A range intersecting the corrupted frame fails instead of silently
    // returning data or falling back to a scan.
    const auto& e1 = index.entries()[1];
    CHECK_THROWS_SEEKABLE(
        index.readRange(fx.file, e1.decompressed_offset, e1.decompressed_size));
    CHECK_THROWS_SEEKABLE(index.readRange(fx.file, 0, index.decompressedSize()));
}

}  // namespace

int main() {
    testRoundTrip(true, true);
    testRoundTrip(true, false);
    testRoundTrip(false, false);
    testCorruptions();
    testSelectiveDecompression();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
