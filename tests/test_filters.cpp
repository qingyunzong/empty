// Cross-checks all five scanline filters: the test forward-filters known
// pixels, the decoder must invert them back; an independent inverse
// implementation in the test validates the test vectors themselves.
#include "png_builder.hpp"

using namespace testutil;

namespace {

void run_case(uint32_t w, uint32_t h, uint8_t filter, uint32_t seed) {
  const auto pixels = random_pixels(size_t(w) * h, seed);
  const auto scan = encode_scanlines(w, h, pixels, [&](uint32_t) { return filter; });

  // Sanity: the test's own independent inverse must reproduce the pixels.
  CHECK(unfilter_independent(w, h, scan) == pixels);

  const auto png = build_png(w, h, scan, /*n_idats=*/3);
  PassthroughInflater inf;
  pngdec::Decoder dec(std::ref(inf));
  CHECK(dec.feed(png));
  dec.finish();
  CHECK(dec.done());
  CHECK_EQ(inf.expected, uint64_t(h) * (w + 1));
  CHECK(inf.received == scan); // IDAT parts concatenated in order
  auto img = dec.takeImage();
  CHECK(img.has_value());
  if (img) {
    CHECK_EQ(img->width, w);
    CHECK_EQ(img->height, h);
    CHECK(img->pixels == pixels);
  }
}

} // namespace

int main() {
  for (uint8_t f = 0; f <= 4; ++f) {
    run_case(37, 11, f, 1000 + f);  // odd width exercises left-edge cases
    run_case(1, 1, f, 2000 + f);    // minimal image
    run_case(1, 9, f, 3000 + f);    // single column
    run_case(64, 1, f, 4000 + f);   // single row
  }

  // Mixed filters, chosen per row like a real encoder would.
  {
    const uint32_t w = 53, h = 41;
    const auto pixels = random_pixels(size_t(w) * h, 7);
    const auto scan = encode_scanlines(w, h, pixels,
                                       [](uint32_t y) { return uint8_t(y % 5); });
    CHECK(unfilter_independent(w, h, scan) == pixels);
    const auto png = build_png(w, h, scan, /*n_idats=*/5);
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(dec.feed(png));
    dec.finish();
    auto img = dec.takeImage();
    CHECK(img && img->pixels == pixels);
  }

  // All-zero and all-0xFF images (filter edge values).
  for (uint8_t value : {uint8_t(0), uint8_t(0xFF)}) {
    const uint32_t w = 16, h = 16;
    std::vector<uint8_t> pixels(size_t(w) * h, value);
    for (uint8_t f = 0; f <= 4; ++f) {
      const auto scan = encode_scanlines(w, h, pixels, [&](uint32_t) { return f; });
      const auto png = build_png(w, h, scan);
      pngdec::Decoder dec(PassthroughInflater{});
      CHECK(dec.feed(png));
      dec.finish();
      auto img = dec.takeImage();
      CHECK(img && img->pixels == pixels);
    }
  }

  return summary("test_filters");
}
