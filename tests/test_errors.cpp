#include "test_util.hpp"

namespace {

std::vector<std::uint8_t> valid_png() {
    const std::vector<std::uint8_t> filtered = {0, 1, 2, 0, 3, 4};  // 2x2, filter None
    return tutil::make_png(2, 2, filtered);
}

void expect_error(const std::vector<std::uint8_t>& png, png8::Error expected) {
    auto result = png8::decode(png, png8::zlib::inflate_stored);
    CHECK(!result.has_value());         // bad chunk must not publish a partial image
    CHECK(!result.image.has_value());
    if (result.error != expected) {
        std::fprintf(stderr, "  expected error %.*s, got %.*s\n",
                     static_cast<int>(png8::to_string(expected).size()),
                     png8::to_string(expected).data(),
                     static_cast<int>(png8::to_string(result.error).size()),
                     png8::to_string(result.error).data());
    }
    CHECK(result.error == expected);
}

}  // namespace

static void run_tests() {
    // Signature problems.
    expect_error({}, png8::Error::BadSignature);
    expect_error({1, 2, 3}, png8::Error::BadSignature);
    {
        auto png = valid_png();
        png[1] = 'X';
        expect_error(png, png8::Error::BadSignature);
    }

    // Signature only, no chunks at all.
    expect_error({137, 80, 78, 71, 13, 10, 26, 10}, png8::Error::IhdrNotFirst);

    // First chunk is not IHDR.
    {
        const auto png = tutil::PngBuilder().iend().bytes();
        expect_error(png, png8::Error::IhdrNotFirst);
    }
    {
        const std::vector<std::uint8_t> junk = {0};
        const auto png = tutil::PngBuilder().idat(junk).iend().bytes();
        expect_error(png, png8::Error::IhdrNotFirst);
    }

    // Duplicate IHDR.
    {
        const auto png = tutil::PngBuilder().ihdr(1, 1).ihdr(1, 1).iend().bytes();
        expect_error(png, png8::Error::DuplicateIhdr);
    }

    // IHDR with wrong data length.
    {
        const std::vector<std::uint8_t> short_ihdr(12, 0);
        const auto png = tutil::PngBuilder().chunk("IHDR", short_ihdr).iend().bytes();
        expect_error(png, png8::Error::BadIhdrLength);
    }

    // Unsupported IHDR parameters.
    expect_error(tutil::PngBuilder().ihdr(1, 1, 16).iend().bytes(),
                 png8::Error::UnsupportedBitDepth);
    expect_error(tutil::PngBuilder().ihdr(1, 1, 8, 2).iend().bytes(),
                 png8::Error::UnsupportedColorType);
    expect_error(tutil::PngBuilder().ihdr(1, 1, 8, 6).iend().bytes(),
                 png8::Error::UnsupportedColorType);
    expect_error(tutil::PngBuilder().ihdr(1, 1, 8, 0, 1).iend().bytes(),
                 png8::Error::UnsupportedCompression);
    expect_error(tutil::PngBuilder().ihdr(1, 1, 8, 0, 0, 1).iend().bytes(),
                 png8::Error::UnsupportedFilterMethod);
    expect_error(tutil::PngBuilder().ihdr(1, 1, 8, 0, 0, 0, 1).iend().bytes(),
                 png8::Error::UnsupportedInterlace);

    // Zero dimensions.
    expect_error(tutil::PngBuilder().ihdr(0, 5).iend().bytes(), png8::Error::ZeroDimensions);
    expect_error(tutil::PngBuilder().ihdr(5, 0).iend().bytes(), png8::Error::ZeroDimensions);

    // Dimension overflow: 65536 * (65536 + 1) filtered bytes exceeds the cap.
    expect_error(tutil::PngBuilder().ihdr(65536, 65536).iend().bytes(),
                 png8::Error::DimensionOverflow);
    expect_error(tutil::PngBuilder().ihdr(0xFFFFFFFF, 0xFFFFFFFF).iend().bytes(),
                 png8::Error::DimensionOverflow);

    // Missing IEND: stream ends cleanly after IDAT.
    {
        const std::vector<std::uint8_t> filtered = {0, 0};
        const auto zlib = png8::zlib::compress_stored(filtered);
        const auto png = tutil::PngBuilder().ihdr(1, 1).idat(zlib).bytes();
        expect_error(png, png8::Error::MissingIend);
    }

    // Missing IDAT.
    expect_error(tutil::PngBuilder().ihdr(1, 1).iend().bytes(), png8::Error::MissingIdat);

    // Non-consecutive IDAT chunks.
    {
        const std::vector<std::uint8_t> filtered = {0, 0};
        const auto zlib = png8::zlib::compress_stored(filtered);
        const std::size_t half = zlib.size() / 2;
        const std::vector<std::uint8_t> text = {'x'};
        const auto png = tutil::PngBuilder()
                             .ihdr(1, 1)
                             .idat(std::span<const std::uint8_t>(zlib).subspan(0, half))
                             .chunk("tEXt", text)
                             .idat(std::span<const std::uint8_t>(zlib).subspan(half))
                             .iend()
                             .bytes();
        expect_error(png, png8::Error::NonConsecutiveIdat);
    }

    // Unknown critical chunk (uppercase first letter) must fail.
    {
        const std::vector<std::uint8_t> payload = {1, 2, 3, 4};
        const auto png = tutil::PngBuilder().ihdr(1, 1).chunk("ABCD", payload).iend().bytes();
        expect_error(png, png8::Error::UnknownCriticalChunk);
    }

    // IEND must be empty.
    {
        const std::vector<std::uint8_t> filtered = {0, 0};
        const auto zlib = png8::zlib::compress_stored(filtered);
        const std::vector<std::uint8_t> one = {0};
        const auto png = tutil::PngBuilder().ihdr(1, 1).idat(zlib).chunk("IEND", one).bytes();
        expect_error(png, png8::Error::BadIendLength);
    }

    // CRC mismatch in IDAT and in an ancillary chunk.
    {
        auto png = valid_png();
        png[png.size() - 13] ^= 0x01;  // last IDAT data byte (IEND is 12 bytes)
        expect_error(png, png8::Error::CrcMismatch);
    }
    {
        const std::vector<std::uint8_t> text = {'a'};
        const auto png = tutil::PngBuilder()
                             .ihdr(1, 1)
                             .chunk_raw_crc("tEXt", text, 0xDEADBEEF)
                             .iend()
                             .bytes();
        expect_error(png, png8::Error::CrcMismatch);
    }

    // Declared chunk length far beyond the buffer: length overflow rejected.
    {
        auto png = valid_png();
        const std::size_t ihdr_len_pos = 8;
        png[ihdr_len_pos + 0] = 0xFF;
        png[ihdr_len_pos + 1] = 0xFF;
        png[ihdr_len_pos + 2] = 0xFF;
        png[ihdr_len_pos + 3] = 0xFF;
        expect_error(png, png8::Error::ChunkLengthOverflow);
    }
    {
        auto png = valid_png();
        png.resize(png.size() - 4);  // drop IEND's CRC: last chunk header incomplete
        expect_error(png, png8::Error::ChunkLengthOverflow);
    }

    // Truncated between chunks: fewer than 8 header bytes remain.
    {
        auto png = valid_png();
        png.resize(png.size() - 12);     // drop IEND entirely
        png.insert(png.end(), {0, 0, 0});  // 3 dangling bytes
        expect_error(png, png8::Error::UnexpectedEof);
    }

    // Injected adapter fails.
    {
        auto png = valid_png();
        auto nullopt_adapter = [](std::span<const std::uint8_t>)
            -> std::optional<std::vector<std::uint8_t>> { return std::nullopt; };
        auto result = png8::decode(png, nullopt_adapter);
        CHECK(!result.has_value());
        CHECK(result.error == png8::Error::InflateFailed);
    }

    // Inflated length does not match height * (1 + width).
    {
        auto png = valid_png();
        auto short_adapter = [](std::span<const std::uint8_t>)
            -> std::optional<std::vector<std::uint8_t>> {
            return std::vector<std::uint8_t>{0, 1, 2};  // need 2 * (2 + 1) = 6
        };
        auto result = png8::decode(png, short_adapter);
        CHECK(!result.has_value());
        CHECK(result.error == png8::Error::PixelDataLengthMismatch);
    }

    // Unknown scanline filter byte.
    {
        const std::vector<std::uint8_t> filtered = {5, 10, 20, 0, 30, 40};  // filter 5 invalid
        auto png = tutil::make_png(2, 2, filtered);
        expect_error(png, png8::Error::BadScanlineFilter);
    }
}

TEST_MAIN()
