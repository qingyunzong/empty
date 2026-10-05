// Feeding the same PNG in arbitrary-size pieces must behave identically
// to feeding it all at once.
#include "png_builder.hpp"

using namespace testutil;

namespace {

struct Fixture {
  uint32_t w = 29, h = 17;
  std::vector<uint8_t> pixels = random_pixels(size_t(29) * 17, 42);
  std::vector<uint8_t> png;

  Fixture() {
    const auto scan = encode_scanlines(w, h, pixels,
                                       [](uint32_t y) { return uint8_t(y % 5); });
    png = build_png(w, h, scan, /*n_idats=*/4);
  }
};

void feed_in_pieces(const Fixture& fx, const std::vector<size_t>& pieces) {
  pngdec::Decoder dec(PassthroughInflater{});
  size_t off = 0;
  size_t i = 0;
  while (off < fx.png.size()) {
    const size_t len = pieces[i++ % pieces.size()];
    const size_t take = len > fx.png.size() - off ? fx.png.size() - off : len;
    CHECK(dec.feed(std::span<const uint8_t>(fx.png.data() + off, take)));
    off += take;
  }
  dec.finish();
  CHECK(dec.done());
  auto img = dec.takeImage();
  CHECK(img && img->pixels == fx.pixels);
}

} // namespace

int main() {
  const Fixture fx;

  feed_in_pieces(fx, {fx.png.size()});          // one shot
  feed_in_pieces(fx, {1});                      // byte by byte
  feed_in_pieces(fx, {2});
  feed_in_pieces(fx, {3});
  feed_in_pieces(fx, {7});
  feed_in_pieces(fx, {8});                      // signature-sized
  feed_in_pieces(fx, {13});                     // IHDR payload-sized
  feed_in_pieces(fx, {64});
  feed_in_pieces(fx, {5, 1, 12, 3, 100, 2});    // irregular pattern

  // Random splits (deterministic seed).
  {
    std::mt19937 rng(1234);
    std::vector<size_t> pieces;
    for (int i = 0; i < 50; ++i) pieces.push_back(1 + rng() % 97);
    feed_in_pieces(fx, pieces);
  }

  // Zero-length feeds interleaved with data must be harmless.
  {
    pngdec::Decoder dec(PassthroughInflater{});
    for (uint8_t b : fx.png) {
      CHECK(dec.feed({}));
      CHECK(dec.feed(std::span<const uint8_t>(&b, 1)));
    }
    dec.finish();
    auto img = dec.takeImage();
    CHECK(img && img->pixels == fx.pixels);
  }

  return summary("test_chunking");
}
