#include "pngdec/pngdec.hpp"

#include <array>
#include <cstddef>
#include <cstring>

namespace pngdec {

namespace {

constexpr std::array<uint32_t, 256> make_crc_table() {
  std::array<uint32_t, 256> t{};
  for (uint32_t n = 0; n < 256; ++n) {
    uint32_t c = n;
    for (int k = 0; k < 8; ++k)
      c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
    t[n] = c;
  }
  return t;
}
constexpr auto kCrcTable = make_crc_table();

uint32_t crc32_update(uint32_t crc, std::span<const uint8_t> data) {
  for (uint8_t b : data)
    crc = kCrcTable[(crc ^ b) & 0xFFu] ^ (crc >> 8);
  return crc;
}

uint32_t read_be32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) |
         uint32_t(p[3]);
}

uint32_t type_id(const uint8_t t[4]) { return read_be32(t); }

constexpr uint32_t kIhdr = 0x49484452u; // "IHDR"
constexpr uint32_t kPlte = 0x504C5445u; // "PLTE"
constexpr uint32_t kIdat = 0x49444154u; // "IDAT"
constexpr uint32_t kIend = 0x49454E44u; // "IEND"

constexpr uint8_t kSignature[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};

uint8_t paeth(uint8_t a, uint8_t b, uint8_t c) {
  const int p = int(a) + int(b) - int(c);
  const int pa = p > int(a) ? p - int(a) : int(a) - p;
  const int pb = p > int(b) ? p - int(b) : int(b) - p;
  const int pc = p > int(c) ? p - int(c) : int(c) - p;
  if (pa <= pb && pa <= pc) return uint8_t(a);
  return pb <= pc ? uint8_t(b) : uint8_t(c);
}

} // namespace

const char* to_string(Error e) noexcept {
  switch (e) {
  case Error::None: return "none";
  case Error::BadSignature: return "bad signature";
  case Error::Truncated: return "truncated stream";
  case Error::CrcMismatch: return "chunk CRC mismatch";
  case Error::InvalidIhdr: return "invalid IHDR";
  case Error::UnsupportedFormat: return "unsupported format (need 8-bit gray, non-interlaced)";
  case Error::MissingIhdr: return "missing IHDR";
  case Error::UnexpectedChunk: return "unexpected chunk";
  case Error::LengthOverflow: return "length overflow";
  case Error::InflateFailed: return "inflate failed";
  case Error::SizeMismatch: return "inflated size mismatch";
  case Error::BadFilter: return "unknown scanline filter";
  case Error::TrailingData: return "trailing data after IEND";
  }
  return "unknown";
}

Decoder::Decoder(Inflater inflater, Limits limits)
    : inflater_(std::move(inflater)), limits_(limits) {}

void Decoder::fail(Error e) {
  if (error_ == Error::None) error_ = e;
}

bool Decoder::feed(std::span<const uint8_t> data) {
  if (failed()) return false;
  if (state_ == State::Complete) {
    if (!data.empty()) fail(Error::TrailingData);
    return false;
  }
  buf_.insert(buf_.end(), data.begin(), data.end());
  parse();
  if (state_ == State::Complete && !buf_.empty()) fail(Error::TrailingData);
  return !failed();
}

void Decoder::finish() {
  if (failed() || state_ == State::Complete) return;
  fail(Error::Truncated);
}

std::optional<Image> Decoder::takeImage() {
  if (failed()) return std::nullopt;
  auto out = std::move(image_);
  image_.reset();
  return out;
}

void Decoder::parse() {
  while (!failed() && state_ != State::Complete) {
    const size_t avail = buf_.size() - pos_;
    switch (state_) {
    case State::Signature: {
      if (avail < 8) return;
      if (std::memcmp(buf_.data() + pos_, kSignature, 8) != 0) {
        fail(Error::BadSignature);
        return;
      }
      pos_ += 8;
      state_ = State::ChunkLength;
      break;
    }
    case State::ChunkLength: {
      if (avail < 4) return;
      chunk_len_ = read_be32(buf_.data() + pos_);
      pos_ += 4;
      if (uint64_t(chunk_len_) > limits_.max_chunk_bytes) {
        fail(Error::LengthOverflow);
        return;
      }
      chunk_.clear();
      chunk_.reserve(chunk_len_);
      state_ = State::ChunkType;
      break;
    }
    case State::ChunkType: {
      if (avail < 4) return;
      std::memcpy(chunk_type_, buf_.data() + pos_, 4);
      pos_ += 4;
      state_ = State::ChunkData;
      break;
    }
    case State::ChunkData: {
      const size_t need = chunk_len_ - chunk_.size();
      if (need == 0) {
        state_ = State::ChunkCrc;
        break;
      }
      if (avail == 0) return;
      const size_t take = avail < need ? avail : need;
      chunk_.insert(chunk_.end(), buf_.data() + pos_, buf_.data() + pos_ + take);
      pos_ += take;
      if (chunk_.size() == chunk_len_) state_ = State::ChunkCrc;
      break;
    }
    case State::ChunkCrc: {
      if (avail < 4) return;
      const uint32_t expected = read_be32(buf_.data() + pos_);
      pos_ += 4;
      uint32_t crc = 0xFFFFFFFFu;
      crc = crc32_update(crc, std::span<const uint8_t>(chunk_type_, 4));
      crc = crc32_update(crc, chunk_);
      crc ^= 0xFFFFFFFFu;
      if (crc != expected) {
        fail(Error::CrcMismatch);
        return;
      }
      onChunk();
      if (state_ != State::Complete) state_ = State::ChunkLength;
      break;
    }
    case State::Complete:
      break;
    }
  }
  // Drop consumed bytes so the buffer does not grow without bound.
  if (pos_ > 0) {
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(pos_));
    pos_ = 0;
  }
}

void Decoder::onChunk() {
  const uint32_t t = type_id(chunk_type_);
  const bool critical = (chunk_type_[0] & 0x20u) == 0;

  if (!seen_ihdr_) {
    if (t != kIhdr) {
      fail(Error::MissingIhdr);
      return;
    }
    if (handleIhdr()) seen_ihdr_ = true;
    return;
  }

  switch (t) {
  case kIhdr:
    fail(Error::UnexpectedChunk); // duplicate IHDR (first one handled above)
    return;
  case kIdat:
    if (idat_closed_) {
      fail(Error::UnexpectedChunk); // IDAT chunks must be consecutive
      return;
    }
    idat_open_ = true;
    if (uint64_t(compressed_.size()) + chunk_.size() > limits_.max_compressed_bytes) {
      fail(Error::LengthOverflow);
      return;
    }
    compressed_.insert(compressed_.end(), chunk_.begin(), chunk_.end());
    return;
  case kIend:
    if (chunk_len_ != 0) {
      fail(Error::UnexpectedChunk);
      return;
    }
    inflateAndUnfilter();
    if (!failed()) state_ = State::Complete;
    return;
  case kPlte:
    idat_closed_ = idat_closed_ || idat_open_;
    idat_open_ = false;
    return; // allowed (suggested palette); contents not needed for gray
  default:
    if (critical) {
      fail(Error::UnexpectedChunk); // unknown critical chunk: must not continue
      return;
    }
    idat_closed_ = idat_closed_ || idat_open_;
    idat_open_ = false;
    return; // ancillary chunk: skip
  }
}

bool Decoder::handleIhdr() {
  if (chunk_len_ != 13) {
    fail(Error::InvalidIhdr);
    return false;
  }
  const uint8_t* d = chunk_.data();
  width_ = read_be32(d);
  height_ = read_be32(d + 4);
  const uint8_t bit_depth = d[8];
  const uint8_t color_type = d[9];
  const uint8_t compression = d[10];
  const uint8_t filter = d[11];
  const uint8_t interlace = d[12];

  if (width_ == 0 || height_ == 0) {
    fail(Error::InvalidIhdr);
    return false;
  }
  if (bit_depth != 8 || color_type != 0) {
    fail(Error::UnsupportedFormat);
    return false;
  }
  if (compression != 0 || filter != 0) {
    fail(Error::UnsupportedFormat);
    return false;
  }
  if (interlace != 0) {
    fail(Error::UnsupportedFormat);
    return false;
  }
  // Expected raw size: height rows of (1 filter byte + width gray bytes).
  // Checked against 64-bit overflow, size_t range, and the configured cap.
  const uint64_t stride = uint64_t(width_) + 1;
  const uint64_t total = stride * uint64_t(height_); // cannot overflow: < 2^63
  if (total / stride != uint64_t(height_) || total > uint64_t(SIZE_MAX) ||
      total > limits_.max_raw_bytes) {
    fail(Error::LengthOverflow);
    return false;
  }
  expected_raw_ = total;
  return true;
}

void Decoder::inflateAndUnfilter() {
  auto raw = inflater_(compressed_, expected_raw_);
  if (!raw) {
    fail(Error::InflateFailed);
    return;
  }
  if (raw->size() != expected_raw_) {
    fail(Error::SizeMismatch);
    return;
  }

  const size_t w = width_;
  const size_t stride = w + 1;
  Image img;
  img.width = width_;
  img.height = height_;
  img.pixels.assign(size_t(width_) * size_t(height_), 0);

  std::vector<uint8_t> prev(w, 0);
  std::vector<uint8_t> recon(w, 0);
  const uint8_t* src = raw->data();

  for (uint32_t y = 0; y < height_; ++y) {
    const uint8_t filter = src[0];
    const uint8_t* cur = src + 1;
    switch (filter) {
    case 0: // None
      std::memcpy(recon.data(), cur, w);
      break;
    case 1: // Sub (bpp = 1)
      for (size_t x = 0; x < w; ++x) {
        const uint8_t a = x > 0 ? recon[x - 1] : 0;
        recon[x] = uint8_t(cur[x] + a);
      }
      break;
    case 2: // Up
      for (size_t x = 0; x < w; ++x)
        recon[x] = uint8_t(cur[x] + prev[x]);
      break;
    case 3: // Average
      for (size_t x = 0; x < w; ++x) {
        const uint8_t a = x > 0 ? recon[x - 1] : 0;
        recon[x] = uint8_t(cur[x] + uint8_t((unsigned(a) + unsigned(prev[x])) / 2));
      }
      break;
    case 4: // Paeth
      for (size_t x = 0; x < w; ++x) {
        const uint8_t a = x > 0 ? recon[x - 1] : 0;
        const uint8_t c = x > 0 ? prev[x - 1] : 0;
        recon[x] = uint8_t(cur[x] + paeth(a, prev[x], c));
      }
      break;
    default:
      fail(Error::BadFilter);
      return;
    }
    std::memcpy(img.pixels.data() + size_t(y) * w, recon.data(), w);
    std::swap(prev, recon);
    src += stride;
  }
  image_ = std::move(img);
}

} // namespace pngdec
