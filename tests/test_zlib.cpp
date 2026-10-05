#include "test_util.hpp"

static void run_tests() {
    // Round-trip: empty, small, exactly one block, multi-block, random.
    for (std::size_t n : {std::size_t{0}, std::size_t{1}, std::size_t{5}, std::size_t{65534},
                          std::size_t{65535}, std::size_t{65536}, std::size_t{200000}}) {
        const auto raw = tutil::random_bytes(n);
        const auto packed = png8::zlib::compress_stored(raw);
        const auto back = png8::zlib::inflate_stored(packed);
        CHECK(back.has_value());
        CHECK(back && *back == raw);
    }

    const auto raw = tutil::random_bytes(1000);
    const auto packed = png8::zlib::compress_stored(raw);

    // Truncation must be rejected.
    for (std::size_t cut : {std::size_t{0}, std::size_t{1}, std::size_t{2}, std::size_t{6},
                            packed.size() / 2, packed.size() - 1})
        CHECK(!png8::zlib::inflate_stored(
                  std::span<const std::uint8_t>(packed).subspan(0, cut))
                  .has_value());

    // Corrupted Adler-32 must be rejected.
    auto bad_sum = packed;
    bad_sum.back() ^= 0xFF;
    CHECK(!png8::zlib::inflate_stored(bad_sum).has_value());

    // Corrupted NLEN must be rejected.
    auto bad_nlen = packed;
    bad_nlen[4] ^= 0xFF;
    CHECK(!png8::zlib::inflate_stored(bad_nlen).has_value());

    // Bad zlib header check bits must be rejected.
    auto bad_header = packed;
    bad_header[1] ^= 0x01;
    CHECK(!png8::zlib::inflate_stored(bad_header).has_value());

    // Non-stored block type must be rejected.
    auto bad_btype = packed;
    bad_btype[2] = 0x02;  // BTYPE=01 (fixed Huffman) unsupported here
    CHECK(!png8::zlib::inflate_stored(bad_btype).has_value());
}

TEST_MAIN()
