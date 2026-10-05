#include "test_util.hpp"

// Every one of the five scanline filters is exercised on its own and in
// random combinations; library output is cross-checked against both the
// original pixels and the independent reference unfilter.
static void run_tests() {
    const std::pair<std::uint32_t, std::uint32_t> sizes[] = {
        {1, 1}, {1, 9}, {9, 1}, {2, 2}, {17, 13}, {64, 64}, {255, 3},
    };

    for (const auto [w, h] : sizes) {
        const auto pixels = tutil::random_bytes(static_cast<std::size_t>(w) * h);

        // Each filter alone, on every row.
        for (std::uint8_t f = 0; f <= 4; ++f) {
            const std::vector<std::uint8_t> filters(h, f);
            const auto filtered = tutil::reference_filter(pixels, w, h, filters);
            const auto png = tutil::make_png(w, h, filtered);
            auto result = png8::decode(png, png8::zlib::inflate_stored);
            CHECK(result.has_value());
            if (result) {
                CHECK(result.image->pixels == pixels);
                CHECK(result.image->pixels == tutil::reference_unfilter(filtered, w, h));
            }
        }

        // Random per-row filter mix.
        std::vector<std::uint8_t> filters(h);
        for (auto& f : filters) f = static_cast<std::uint8_t>(tutil::rng()() % 5);
        const auto filtered = tutil::reference_filter(pixels, w, h, filters);
        const auto png = tutil::make_png(w, h, filtered);
        auto result = png8::decode(png, png8::zlib::inflate_stored);
        CHECK(result.has_value());
        if (result) {
            CHECK(result.image->pixels == pixels);
            CHECK(result.image->pixels == tutil::reference_unfilter(filtered, w, h));
        }
    }
}

TEST_MAIN()
