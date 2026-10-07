#include "sha1.hpp"

#include <algorithm>
#include <cstring>

namespace ar {

namespace {
uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }
} // namespace

Sha1::Sha1()
    : h_{0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u},
      len_(0), buflen_(0) {}

void Sha1::block(const uint8_t* p) {
  uint32_t w[80];
  for (int i = 0; i < 16; ++i)
    w[i] = (uint32_t(p[4 * i]) << 24) | (uint32_t(p[4 * i + 1]) << 16) |
           (uint32_t(p[4 * i + 2]) << 8) | uint32_t(p[4 * i + 3]);
  for (int i = 16; i < 80; ++i)
    w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4];
  for (int i = 0; i < 80; ++i) {
    uint32_t f, k;
    if (i < 20) {
      f = (b & c) | ((~b) & d);
      k = 0x5A827999u;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ED9EBA1u;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d;
      k = 0xCA62C1D6u;
    }
    uint32_t t = rol(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rol(b, 30);
    b = a;
    a = t;
  }
  h_[0] += a;
  h_[1] += b;
  h_[2] += c;
  h_[3] += d;
  h_[4] += e;
}

void Sha1::update(const void* data, size_t len) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  len_ += len;
  while (len) {
    size_t take = std::min(len, 64 - buflen_);
    std::memcpy(buf_ + buflen_, p, take);
    buflen_ += take;
    p += take;
    len -= take;
    if (buflen_ == 64) {
      block(buf_);
      buflen_ = 0;
    }
  }
}

std::string Sha1::hex() {
  uint64_t bits = len_ * 8;
  uint8_t pad = 0x80;
  update(&pad, 1);
  uint8_t zero = 0;
  while (buflen_ != 56)
    update(&zero, 1);
  uint8_t lenbuf[8];
  for (int i = 0; i < 8; ++i)
    lenbuf[i] = uint8_t(bits >> (56 - 8 * i));
  update(lenbuf, 8);
  static const char* hexd = "0123456789abcdef";
  std::string out;
  out.reserve(40);
  for (uint32_t h : h_)
    for (int i = 7; i >= 0; --i)
      out += hexd[(h >> (4 * i)) & 0xF];
  return out;
}

std::string sha1_hex(const std::string& s) {
  Sha1 h;
  h.update(s.data(), s.size());
  return h.hex();
}

} // namespace ar
