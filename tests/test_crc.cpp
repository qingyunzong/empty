#include "test_util.hpp"

static void run_tests() {
    // Standard CRC-32 check vectors.
    CHECK_EQ(png8::crc32({}), 0u);
    const std::vector<std::uint8_t> digits = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    CHECK_EQ(png8::crc32(digits), 0xCBF43926u);
    const std::vector<std::uint8_t> iend = {'I', 'E', 'N', 'D'};
    CHECK_EQ(png8::crc32(iend), 0xAE426082u);

    // Library table-driven CRC must match the independent bitwise one.
    for (int trial = 0; trial < 50; ++trial) {
        const auto data = tutil::random_bytes(tutil::rng()() % 300);
        CHECK_EQ(png8::crc32(data), tutil::PngBuilder::crc_bitwise(data));
    }
}

TEST_MAIN()
