// IHDR ordering and field validation.
#include "png_builder.hpp"

using namespace testutil;

namespace {

std::vector<uint8_t> make_valid_raw(uint32_t w, uint32_t h) {
  return std::vector<uint8_t>(size_t(h) * (w + 1), 0); // filter 0 rows
}

pngdec::Error decode_error(const std::vector<uint8_t>& png) {
  pngdec::Decoder dec(PassthroughInflater{});
  dec.feed(png);
  dec.finish();
  CHECK(dec.failed());
  CHECK(!dec.takeImage().has_value());
  return dec.error();
}

std::vector<uint8_t> assemble(std::initializer_list<std::vector<uint8_t>> parts) {
  std::vector<uint8_t> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

} // namespace

int main() {
  const auto raw = make_valid_raw(4, 3);
  const auto good_ihdr = ihdr(4, 3);
  const auto idat = chunk("IDAT", raw);
  const auto iend = chunk("IEND");

  // Baseline works.
  {
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(dec.feed(assemble({signature(), good_ihdr, idat, iend})));
    dec.finish();
    CHECK(dec.done());
  }

  // IHDR must be the first chunk.
  CHECK_EQ(decode_error(assemble({signature(), chunk("tEXt", std::span<const uint8_t>{}),
                                  good_ihdr, idat, iend})),
           pngdec::Error::MissingIhdr);
  CHECK_EQ(decode_error(assemble({signature(), idat, good_ihdr, iend})),
           pngdec::Error::MissingIhdr);
  CHECK_EQ(decode_error(assemble({signature(), iend})),
           pngdec::Error::MissingIhdr);

  // Duplicate IHDR is rejected.
  CHECK_EQ(decode_error(assemble({signature(), good_ihdr, good_ihdr, idat, iend})),
           pngdec::Error::UnexpectedChunk);

  // IHDR payload must be exactly 13 bytes.
  {
    std::vector<uint8_t> short12(12, 0);
    auto bad = assemble({signature(), chunk("IHDR", short12), idat, iend});
    CHECK_EQ(decode_error(bad), pngdec::Error::InvalidIhdr);
    std::vector<uint8_t> long14(14, 0);
    bad = assemble({signature(), chunk("IHDR", long14), idat, iend});
    CHECK_EQ(decode_error(bad), pngdec::Error::InvalidIhdr);
  }

  // Zero dimensions.
  CHECK_EQ(decode_error(assemble({signature(), ihdr(0, 3), idat, iend})),
           pngdec::Error::InvalidIhdr);
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 0), idat, iend})),
           pngdec::Error::InvalidIhdr);

  // Unsupported formats (valid PNGs, outside our subset).
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 16, 0), idat, iend})),
           pngdec::Error::UnsupportedFormat); // 16-bit
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 2), idat, iend})),
           pngdec::Error::UnsupportedFormat); // truecolor
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 3), idat, iend})),
           pngdec::Error::UnsupportedFormat); // palette
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 6), idat, iend})),
           pngdec::Error::UnsupportedFormat); // RGBA
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 0, 0, 0, 1), idat, iend})),
           pngdec::Error::UnsupportedFormat); // Adam7 interlace
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 0, 1, 0, 0), idat, iend})),
           pngdec::Error::UnsupportedFormat); // unknown compression
  CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3, 8, 0, 0, 1, 0), idat, iend})),
           pngdec::Error::UnsupportedFormat); // unknown filter method

  return summary("test_ihdr");
}
