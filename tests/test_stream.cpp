// Stream-level robustness: truncation, bad signature, unknown critical
// chunks, ordering violations, trailing garbage — and in every failure
// path, no partial image may be observed.
#include "png_builder.hpp"

using namespace testutil;

namespace {

std::vector<uint8_t> assemble(std::initializer_list<std::vector<uint8_t>> parts) {
  std::vector<uint8_t> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

} // namespace

int main() {
  const uint32_t w = 6, h = 4;
  const auto pixels = random_pixels(size_t(w) * h, 77);
  const auto scan = encode_scanlines(w, h, pixels, [](uint32_t y) {
    return uint8_t((y * 2) % 5);
  });
  const auto png = build_png(w, h, scan, /*n_idats=*/2);

  // Bad signature.
  {
    auto bad = png;
    bad[0] = 0x00;
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(!dec.feed(bad));
    CHECK_EQ(dec.error(), pngdec::Error::BadSignature);
    CHECK(!dec.takeImage().has_value());
  }

  // Truncation at every prefix length must fail cleanly (never crash,
  // never publish an image).
  for (size_t n = 0; n < png.size(); ++n) {
    pngdec::Decoder dec(PassthroughInflater{});
    dec.feed(std::span<const uint8_t>(png.data(), n));
    dec.finish();
    CHECK(dec.failed());
    CHECK_EQ(dec.error(), pngdec::Error::Truncated);
    CHECK(!dec.done());
    CHECK(!dec.takeImage().has_value());
  }

  // Unknown critical chunk (uppercase first letter) must abort.
  {
    auto bad = assemble({signature(), ihdr(w, h), chunk("XYZZ", scan),
                         chunk("IDAT", scan), chunk("IEND")});
    pngdec::Decoder dec(PassthroughInflater{});
    dec.feed(bad);
    dec.finish();
    CHECK_EQ(dec.error(), pngdec::Error::UnexpectedChunk);
    CHECK(!dec.takeImage().has_value());
  }

  // Unknown ancillary chunks are skipped; decode still succeeds.
  {
    std::vector<uint8_t> text = {'k', 0, 'v'};
    auto ok = assemble({signature(), ihdr(w, h), chunk("tEXt", text),
                        chunk("IDAT", scan),
                        chunk("vpAg", text), // lowercase first letter = ancillary
                        chunk("IEND")});
    pngdec::Decoder dec(PassthroughInflater{});
    // The single IDAT then ancillary then IEND is fine.
    CHECK(dec.feed(ok));
    dec.finish();
    CHECK(dec.done());
    auto img = dec.takeImage();
    CHECK(img && img->pixels == pixels);
  }

  // Non-consecutive IDAT chunks (ancillary in between) are rejected.
  {
    const size_t half = scan.size() / 2;
    std::vector<uint8_t> text = {'x'};
    auto bad = assemble({signature(), ihdr(w, h),
                         chunk("IDAT", std::span<const uint8_t>(scan.data(), half)),
                         chunk("tEXt", text),
                         chunk("IDAT", std::span<const uint8_t>(scan.data() + half,
                                                                scan.size() - half)),
                         chunk("IEND")});
    pngdec::Decoder dec(PassthroughInflater{});
    dec.feed(bad);
    dec.finish();
    CHECK_EQ(dec.error(), pngdec::Error::UnexpectedChunk);
    CHECK(!dec.takeImage().has_value());
  }

  // Trailing garbage after IEND.
  {
    auto bad = png;
    bad.push_back(0x00);
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(!dec.feed(bad));
    CHECK_EQ(dec.error(), pngdec::Error::TrailingData);
    // Image was complete before the error, but after a failure nothing
    // may be published.
    CHECK(!dec.takeImage().has_value());
  }

  // Unknown scanline filter byte.
  {
    auto badscan = scan;
    badscan[0] = 5; // filter bytes are 0..4
    auto bad = build_png(w, h, badscan);
    pngdec::Decoder dec(PassthroughInflater{});
    dec.feed(bad);
    dec.finish();
    CHECK_EQ(dec.error(), pngdec::Error::BadFilter);
    CHECK(!dec.takeImage().has_value());
  }

  // Empty IEND payload required.
  {
    std::vector<uint8_t> junk = {0};
    auto bad = assemble({signature(), ihdr(w, h), chunk("IDAT", scan),
                         chunk("IEND", junk)});
    pngdec::Decoder dec(PassthroughInflater{});
    dec.feed(bad);
    dec.finish();
    CHECK_EQ(dec.error(), pngdec::Error::UnexpectedChunk);
  }

  // No image is observable mid-stream (before IEND), even with all data in.
  {
    const auto partial = assemble({signature(), ihdr(w, h), chunk("IDAT", scan)});
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(dec.feed(partial));
    CHECK(!dec.done());
    CHECK(!dec.takeImage().has_value());
  }

  // takeImage moves the image out; a second call yields nothing.
  {
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(dec.feed(png));
    dec.finish();
    CHECK(dec.takeImage().has_value());
    CHECK(!dec.takeImage().has_value());
  }

  return summary("test_stream");
}
