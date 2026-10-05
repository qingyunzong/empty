#include "test_util.hpp"

static void run_tests() {
    // 1x1 black pixel, filter None, default stored-zlib adapter.
    {
        const std::vector<std::uint8_t> filtered = {0, 0};
        const auto png = tutil::make_png(1, 1, filtered);
        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
        CHECK(result.error == png8::Error::None);
        if (result) {
            CHECK_EQ(result.image->width, 1u);
            CHECK_EQ(result.image->height, 1u);
            CHECK_EQ(result.image->pixels, (std::vector<std::uint8_t>{0}));
        }
    }

    // Gradient image with mixed filters, cross-checked against the
    // independent reference unfilter.
    {
        const std::uint32_t w = 37, h = 23;
        std::vector<std::uint8_t> pixels(static_cast<std::size_t>(w) * h);
        for (std::size_t i = 0; i < pixels.size(); ++i)
            pixels[i] = static_cast<std::uint8_t>((i * 7 + 13) & 0xFF);
        std::vector<std::uint8_t> filters(h);
        for (std::uint32_t y = 0; y < h; ++y) filters[y] = static_cast<std::uint8_t>(y % 5);
        const auto filtered = tutil::reference_filter(pixels, w, h, filters);
        const auto png = tutil::make_png(w, h, filtered);

        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
        if (result) {
            CHECK(result.image->pixels == pixels);
            CHECK(result.image->pixels == tutil::reference_unfilter(filtered, w, h));
        }
    }

    // The injected adapter receives exactly the concatenated IDAT bytes.
    {
        const std::vector<std::uint8_t> filtered = {0, 200, 0, 100};
        const auto zlib = png8::zlib::compress_stored(filtered);
        const auto png = tutil::PngBuilder().ihdr(1, 2).idat(zlib).iend().bytes();
        std::vector<std::uint8_t> seen;
        auto spy = [&](std::span<const std::uint8_t> in)
            -> std::optional<std::vector<std::uint8_t>> {
            seen.assign(in.begin(), in.end());
            return png8::zlib::inflate_stored(in);
        };
        auto result = png8::decode(png, spy);
        CHECK(result.has_value());
        CHECK(seen == zlib);
    }

    // Ready-made-bytes adapter: returns prepared bytes without real inflate.
    {
        const std::vector<std::uint8_t> prepared = {0, 42};
        const auto png = tutil::PngBuilder()
                             .ihdr(1, 1)
                             .idat(std::vector<std::uint8_t>{1, 2, 3})
                             .iend()
                             .bytes();
        auto stub = [&](std::span<const std::uint8_t>) { return prepared; };
        auto result = png8::decode(png, stub);
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == (std::vector<std::uint8_t>{42}));
    }

    // Unknown ancillary chunks are skipped (CRC still verified).
    {
        const std::vector<std::uint8_t> filtered = {0, 7};
        const auto zlib = png8::zlib::compress_stored(filtered);
        const std::vector<std::uint8_t> text = {'k', '=', 'v'};
        const auto png =
            tutil::PngBuilder().ihdr(1, 1).chunk("tEXt", text).idat(zlib).iend().bytes();
        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == (std::vector<std::uint8_t>{7}));
    }

    // Trailing bytes after IEND are ignored.
    {
        const std::vector<std::uint8_t> filtered = {0, 9};
        auto png = tutil::make_png(1, 1, filtered);
        png.insert(png.end(), {0xDE, 0xAD, 0xBE, 0xEF});
        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
    }
}

TEST_MAIN()
