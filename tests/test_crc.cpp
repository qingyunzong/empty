// Any chunk with a bad CRC must abort the decode and publish nothing.
#include "png_builder.hpp"

using namespace testutil;

namespace {

struct Fixture {
  uint32_t w = 9, h = 5;
  std::vector<uint8_t> pixels = random_pixels(45, 9);
  std::vector<uint8_t> png;
  Fixture() {
    const auto scan = encode_scanlines(w, h, pixels, [](uint32_t) { return uint8_t(2); });
    png = build_png(w, h, scan, /*n_idats=*/2);
  }
};

// Locate the start of the n-th chunk with the given 4-byte type.
size_t find_chunk(const std::vector<uint8_t>& png, const char type[4], int n = 0) {
  size_t off = 8;
  while (off + 8 <= png.size()) {
    const uint32_t len = (uint32_t(png[off]) << 24) | (uint32_t(png[off + 1]) << 16) |
                         (uint32_t(png[off + 2]) << 8) | uint32_t(png[off + 3]);
    if (std::equal(type, type + 4, png.begin() + off + 4) && n-- == 0) return off;
    off += 12 + len;
  }
  return SIZE_MAX;
}

void expect_crc_failure(std::vector<uint8_t> png, size_t flip_at, const char* what) {
  png[flip_at] ^= 0x01;
  pngdec::Decoder dec(PassthroughInflater{});
  const bool ok = dec.feed(png);
  dec.finish();
  CHECK(!ok || dec.failed());
  CHECK(dec.error() == pngdec::Error::CrcMismatch);
  if (dec.error() != pngdec::Error::CrcMismatch)
    std::fprintf(stderr, "  (%s: got error '%s')\n", what, to_string(dec.error()));
  CHECK(!dec.done());
  CHECK(!dec.takeImage().has_value()); // no partial image
}

} // namespace

int main() {
  const Fixture fx;

  // Sanity: unmodified stream decodes.
  {
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(dec.feed(fx.png));
    dec.finish();
    CHECK(dec.done());
  }

  // Corrupt CRC field of IHDR, each IDAT, and IEND.
  for (const char* t : {"IHDR", "IEND"}) {
    const size_t at = find_chunk(fx.png, t);
    CHECK(at != SIZE_MAX);
    const uint32_t len = (uint32_t(fx.png[at]) << 24) | (uint32_t(fx.png[at + 1]) << 16) |
                         (uint32_t(fx.png[at + 2]) << 8) | uint32_t(fx.png[at + 3]);
    expect_crc_failure(fx.png, at + 8 + len, t); // first CRC byte
  }
  for (int i = 0; i < 2; ++i) {
    const size_t at = find_chunk(fx.png, "IDAT", i);
    CHECK(at != SIZE_MAX);
    const uint32_t len = (uint32_t(fx.png[at]) << 24) | (uint32_t(fx.png[at + 1]) << 16) |
                         (uint32_t(fx.png[at + 2]) << 8) | uint32_t(fx.png[at + 3]);
    expect_crc_failure(fx.png, at + 8 + len + 3, "IDAT crc"); // last CRC byte
  }

  // Corrupt payload inside IHDR and IDAT (CRC no longer matches data).
  {
    const size_t at = find_chunk(fx.png, "IHDR");
    expect_crc_failure(fx.png, at + 8, "IHDR data");
  }
  {
    const size_t at = find_chunk(fx.png, "IDAT");
    expect_crc_failure(fx.png, at + 9, "IDAT data");
  }

  // Corrupt a chunk type byte: CRC covers the type, so this must fail too.
  {
    const size_t at = find_chunk(fx.png, "IDAT");
    expect_crc_failure(fx.png, at + 5, "IDAT type");
  }

  return summary("test_crc");
}
