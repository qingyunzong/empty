// Length overflow and size-mismatch rejection.
#include "png_builder.hpp"

using namespace testutil;

namespace {

pngdec::Error decode_error(const std::vector<uint8_t>& png,
                           pngdec::Inflater inf = PassthroughInflater{},
                           pngdec::Limits limits = {}) {
  pngdec::Decoder dec(std::move(inf), limits);
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
  const auto iend = chunk("IEND");

  // Absurd dimensions: derived raw size overflows the configured cap.
  CHECK_EQ(decode_error(assemble({signature(), ihdr(0xFFFFFFFFu, 0xFFFFFFFFu), iend})),
           pngdec::Error::LengthOverflow);
  CHECK_EQ(decode_error(assemble({signature(), ihdr(0x10000u, 0x10000u), iend})),
           pngdec::Error::LengthOverflow); // ~4.3 GB raw > 512 MB cap
  CHECK_EQ(decode_error(assemble({signature(), ihdr(0xFFFFFFFFu, 1), iend})),
           pngdec::Error::LengthOverflow);

  // A small custom limit rejects even modest images.
  {
    pngdec::Limits lim;
    lim.max_raw_bytes = 14; // image needs 3 * (1+4) = 15
    CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3),
                                    chunk("IDAT", std::vector<uint8_t>(15, 0)), iend}),
                          PassthroughInflater{}, lim),
             pngdec::Error::LengthOverflow);
  }

  // Declared chunk length beyond the per-chunk cap is rejected immediately,
  // without waiting for the (nonexistent) data.
  {
    std::vector<uint8_t> png = signature();
    auto ih = ihdr(4, 3);
    png.insert(png.end(), ih.begin(), ih.end());
    append_u32be(png, 0xFFFFFFFFu); // IDAT header with huge length
    png.insert(png.end(), {'I', 'D', 'A', 'T'});
    pngdec::Decoder dec(PassthroughInflater{});
    CHECK(!dec.feed(png));
    CHECK_EQ(dec.error(), pngdec::Error::LengthOverflow);
  }

  // Total IDAT payload exceeding the compressed cap.
  {
    pngdec::Limits lim;
    lim.max_compressed_bytes = 8;
    std::vector<uint8_t> raw(15, 0); // 3 rows * (1+4)
    CHECK_EQ(decode_error(assemble({signature(), ihdr(4, 3), chunk("IDAT", raw), iend}),
                          PassthroughInflater{}, lim),
             pngdec::Error::LengthOverflow);
  }

  // Inflater returns fewer / more bytes than the expected raw size.
  {
    const auto png = build_png(4, 3, std::vector<uint8_t>(15, 0));
    auto short_inf = [](std::span<const uint8_t>, uint64_t) {
      return std::optional<std::vector<uint8_t>>(std::vector<uint8_t>(14, 0));
    };
    CHECK_EQ(decode_error(png, short_inf), pngdec::Error::SizeMismatch);
    auto long_inf = [](std::span<const uint8_t>, uint64_t) {
      return std::optional<std::vector<uint8_t>>(std::vector<uint8_t>(16, 0));
    };
    CHECK_EQ(decode_error(png, long_inf), pngdec::Error::SizeMismatch);
  }

  // Inflater reports failure.
  {
    const auto png = build_png(4, 3, std::vector<uint8_t>(15, 0));
    auto failing = [](std::span<const uint8_t>, uint64_t)
        -> std::optional<std::vector<uint8_t>> { return std::nullopt; };
    CHECK_EQ(decode_error(png, failing), pngdec::Error::InflateFailed);
  }

  // Boundary: exactly at the cap is accepted.
  {
    pngdec::Limits lim;
    lim.max_raw_bytes = 15; // 3 * (1+4)
    pngdec::Decoder dec(PassthroughInflater{}, lim);
    CHECK(dec.feed(build_png(4, 3, std::vector<uint8_t>(15, 0))));
    dec.finish();
    CHECK(dec.done());
  }

  return summary("test_overflow");
}
