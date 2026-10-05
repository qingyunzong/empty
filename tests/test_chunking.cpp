#include "test_util.hpp"

// IDAT payload may be split into arbitrarily many chunks of arbitrary
// sizes; the decoder must concatenate them before inflating.
static void run_tests() {
    const std::uint32_t w = 19, h = 11;
    const auto pixels = tutil::random_bytes(static_cast<std::size_t>(w) * h);
    std::vector<std::uint8_t> filters(h);
    for (auto& f : filters) f = static_cast<std::uint8_t>(tutil::rng()() % 5);
    const auto filtered = tutil::reference_filter(pixels, w, h, filters);
    const auto zlib = png8::zlib::compress_stored(filtered);

    auto decode_with_split = [&](const std::vector<std::size_t>& split) {
        tutil::PngBuilder builder;
        builder.ihdr(w, h);
        std::size_t pos = 0;
        for (std::size_t n : split) {
            const std::size_t take = n < zlib.size() - pos ? n : zlib.size() - pos;
            builder.idat(std::span<const std::uint8_t>(zlib).subspan(pos, take));
            pos += take;
        }
        if (pos < zlib.size())
            builder.idat(std::span<const std::uint8_t>(zlib).subspan(pos));
        builder.iend();
        return png8::decode(builder.bytes(), png8::zlib::inflate_stored);
    };

    // One byte per IDAT chunk.
    {
        auto result = decode_with_split(std::vector<std::size_t>(zlib.size(), 1));
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == pixels);
    }

    // Fibonacci-ish chunk sizes.
    {
        auto result = decode_with_split({1, 2, 3, 5, 8, 13, 21, 34, 55, 89});
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == pixels);
    }

    // Random splits, including empty IDAT chunks in between.
    for (int trial = 0; trial < 20; ++trial) {
        std::vector<std::size_t> split;
        const std::size_t parts = 1 + tutil::rng()() % 12;
        for (std::size_t i = 0; i < parts; ++i) split.push_back(tutil::rng()() % 40);
        auto result = decode_with_split(split);
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == pixels);
    }

    // Split at every single boundary must always decode identically.
    for (std::size_t cut = 0; cut <= zlib.size(); ++cut) {
        const auto png = tutil::PngBuilder()
                             .ihdr(w, h)
                             .idat(std::span<const std::uint8_t>(zlib).subspan(0, cut))
                             .idat(std::span<const std::uint8_t>(zlib).subspan(cut))
                             .iend()
                             .bytes();
        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
        if (result) CHECK(result.image->pixels == pixels);
    }
}

TEST_MAIN()
