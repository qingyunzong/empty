#pragma once

// Test helpers: build PNG byte streams in memory and independently
// compute filters/CRC so the library is checked against a second,
// deliberately separate implementation.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <random>
#include <span>
#include <vector>

#include "pngdec/pngdec.hpp"

namespace testutil {

inline int& failures() {
  static int n = 0;
  return n;
}

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      ++::testutil::failures();                                                \
    }                                                                          \
  } while (0)

#define CHECK_EQ(a, b)                                                         \
  do {                                                                         \
    if (!((a) == (b))) {                                                       \
      std::fprintf(stderr, "FAIL %s:%d: %s == %s\n", __FILE__, __LINE__, #a,   \
                   #b);                                                        \
      ++::testutil::failures();                                                \
    }                                                                          \
  } while (0)

inline int summary(const char* name) {
  if (failures() == 0) {
    std::printf("PASS %s\n", name);
    return 0;
  }
  std::printf("FAIL %s (%d checks failed)\n", name, failures());
  return 1;
}

// Independent CRC-32 (bitwise, no table) — intentionally different from the
// library's table-driven implementation.
inline uint32_t crc32_slow(std::span<const uint8_t> data) {
  uint32_t crc = 0xFFFFFFFFu;
  for (uint8_t b : data) {
    crc ^= b;
    for (int k = 0; k < 8; ++k)
      crc = (crc & 1u) ? (0xEDB88320u ^ (crc >> 1)) : (crc >> 1);
  }
  return crc ^ 0xFFFFFFFFu;
}

inline void append_u32be(std::vector<uint8_t>& out, uint32_t v) {
  out.push_back(uint8_t(v >> 24));
  out.push_back(uint8_t(v >> 16));
  out.push_back(uint8_t(v >> 8));
  out.push_back(uint8_t(v));
}

inline std::vector<uint8_t> chunk(const char type[4], std::span<const uint8_t> data) {
  std::vector<uint8_t> out;
  append_u32be(out, uint32_t(data.size()));
  const uint8_t* t = reinterpret_cast<const uint8_t*>(type);
  out.insert(out.end(), t, t + 4);
  out.insert(out.end(), data.begin(), data.end());
  std::vector<uint8_t> crc_input(t, t + 4);
  crc_input.insert(crc_input.end(), data.begin(), data.end());
  append_u32be(out, crc32_slow(crc_input));
  return out;
}

inline std::vector<uint8_t> chunk(const char type[4]) { return chunk(type, {}); }

inline std::vector<uint8_t> ihdr(uint32_t w, uint32_t h, uint8_t depth = 8,
                                 uint8_t color = 0, uint8_t comp = 0,
                                 uint8_t filt = 0, uint8_t inter = 0) {
  std::vector<uint8_t> d;
  append_u32be(d, w);
  append_u32be(d, h);
  d.insert(d.end(), {depth, color, comp, filt, inter});
  return chunk("IHDR", d);
}

inline const std::vector<uint8_t>& signature() {
  static const std::vector<uint8_t> sig = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
  return sig;
}

// Assemble a PNG: signature + IHDR + raw scanlines split into `n_idats`
// consecutive IDAT chunks + IEND.
inline std::vector<uint8_t> build_png(uint32_t w, uint32_t h,
                                      std::span<const uint8_t> raw_scanlines,
                                      int n_idats = 1) {
  std::vector<uint8_t> out = signature();
  auto ih = ihdr(w, h);
  out.insert(out.end(), ih.begin(), ih.end());
  const size_t per = raw_scanlines.size() / size_t(n_idats);
  size_t off = 0;
  for (int i = 0; i < n_idats; ++i) {
    const size_t len = (i == n_idats - 1) ? raw_scanlines.size() - off : per;
    auto idat = chunk("IDAT", raw_scanlines.subspan(off, len));
    out.insert(out.end(), idat.begin(), idat.end());
    off += len;
  }
  auto ie = chunk("IEND");
  out.insert(out.end(), ie.begin(), ie.end());
  return out;
}

// Passthrough inflater: treats IDAT payload as ready-made (uncompressed)
// scanline bytes. Records what it received for inspection.
struct PassthroughInflater {
  std::vector<uint8_t> received;
  uint64_t expected = 0;
  std::optional<std::vector<uint8_t>> operator()(std::span<const uint8_t> c,
                                                 uint64_t expected_size) {
    received.assign(c.begin(), c.end());
    expected = expected_size;
    return std::vector<uint8_t>(c.begin(), c.end());
  }
};

// Forward PNG filters (per spec): filtered[x] = raw[x] - predictor (mod 256).
inline std::vector<uint8_t> filter_row(uint8_t filter, std::span<const uint8_t> raw,
                                       std::span<const uint8_t> prev) {
  const size_t w = raw.size();
  std::vector<uint8_t> out(w);
  for (size_t x = 0; x < w; ++x) {
    const uint8_t a = x > 0 ? raw[x - 1] : 0;
    const uint8_t b = prev.empty() ? 0 : prev[x];
    const uint8_t c = (x > 0 && !prev.empty()) ? prev[x - 1] : 0;
    uint8_t pred = 0;
    switch (filter) {
    case 1: pred = a; break;
    case 2: pred = b; break;
    case 3: pred = uint8_t((unsigned(a) + unsigned(b)) / 2); break;
    case 4: {
      const int p = int(a) + int(b) - int(c);
      const int pa = p > int(a) ? p - int(a) : int(a) - p;
      const int pb = p > int(b) ? p - int(b) : int(b) - p;
      const int pc = p > int(c) ? p - int(c) : int(c) - p;
      pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      break;
    }
    default: pred = 0; break;
    }
    out[x] = uint8_t(raw[x] - pred);
  }
  return out;
}

// Build filtered scanline stream (filter byte + filtered data per row) from
// raw pixels, using `filter_for_row(y)` per row.
template <typename F>
inline std::vector<uint8_t> encode_scanlines(uint32_t w, uint32_t h,
                                             const std::vector<uint8_t>& pixels,
                                             F filter_for_row) {
  std::vector<uint8_t> out;
  out.reserve(size_t(h) * (w + 1));
  std::vector<uint8_t> prev;
  for (uint32_t y = 0; y < h; ++y) {
    const uint8_t f = filter_for_row(y);
    std::span<const uint8_t> row(pixels.data() + size_t(y) * w, w);
    auto filtered = filter_row(f, row, prev);
    out.push_back(f);
    out.insert(out.end(), filtered.begin(), filtered.end());
    prev.assign(row.begin(), row.end());
  }
  return out;
}

// Independent inverse filter (second implementation for cross-checking).
inline std::vector<uint8_t> unfilter_independent(uint32_t w, uint32_t h,
                                                 std::span<const uint8_t> scan) {
  std::vector<uint8_t> out(size_t(w) * h);
  std::vector<uint8_t> prev(w, 0);
  const uint8_t* src = scan.data();
  for (uint32_t y = 0; y < h; ++y) {
    const uint8_t f = *src++;
    std::vector<uint8_t> row(w);
    for (size_t x = 0; x < w; ++x) {
      const uint8_t a = x > 0 ? row[x - 1] : 0;
      const uint8_t b = prev[x];
      const uint8_t c = x > 0 ? prev[x - 1] : 0;
      uint8_t pred = 0;
      switch (f) {
      case 1: pred = a; break;
      case 2: pred = b; break;
      case 3: pred = uint8_t((unsigned(a) + unsigned(b)) / 2); break;
      case 4: {
        const int p = int(a) + int(b) - int(c);
        const int pa = p > int(a) ? p - int(a) : int(a) - p;
        const int pb = p > int(b) ? p - int(b) : int(b) - p;
        const int pc = p > int(c) ? p - int(c) : int(c) - p;
        pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        break;
      }
      default: pred = 0; break;
      }
      row[x] = uint8_t(src[x] + pred);
    }
    std::copy(row.begin(), row.end(), out.begin() + size_t(y) * w);
    prev = std::move(row);
    src += w;
  }
  return out;
}

inline std::vector<uint8_t> random_pixels(size_t n, uint32_t seed) {
  std::mt19937 rng(seed);
  std::vector<uint8_t> p(n);
  for (auto& b : p) b = uint8_t(rng());
  return p;
}

} // namespace testutil
