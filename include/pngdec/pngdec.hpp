#pragma once

// pngdec: a minimal, strict PNG decoder.
//
// Supported subset: 8-bit grayscale, non-interlaced PNG images.
//  - Every chunk CRC is verified; any mismatch aborts the decode.
//  - IHDR must be the first chunk and is fully validated.
//  - All five scanline filters (None/Sub/Up/Average/Paeth) are inverted.
//  - zlib decompression is injected by the caller (Inflater), so the
//    library itself has no zlib dependency.
//  - No partial image is ever published: an Image becomes observable
//    only after a complete, error-free decode (IEND processed).

#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <vector>

namespace pngdec {

enum class Error {
  None = 0,
  BadSignature,      // not a PNG byte stream
  Truncated,         // input ended before IEND
  CrcMismatch,       // chunk CRC check failed
  InvalidIhdr,       // structurally malformed IHDR
  UnsupportedFormat, // valid PNG, but outside the 8-bit gray non-interlaced subset
  MissingIhdr,       // first chunk was not IHDR / data before IHDR
  UnexpectedChunk,   // unknown critical chunk, duplicate IHDR, bad ordering
  LengthOverflow,    // declared/derived length exceeds limits or size_t
  InflateFailed,     // the injected inflater reported failure
  SizeMismatch,      // inflated size != expected raw size
  BadFilter,         // scanline filter byte not in 0..4
  TrailingData,      // bytes fed after IEND
};

const char* to_string(Error e) noexcept;

struct Image {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> pixels; // width*height bytes, row-major, 8-bit gray
};

struct Limits {
  uint64_t max_raw_bytes = 512ull * 1024 * 1024;        // cap on decoded size
  uint64_t max_compressed_bytes = 256ull * 1024 * 1024; // cap on total IDAT payload
  uint64_t max_chunk_bytes = 64ull * 1024 * 1024;       // cap on any single chunk
};

// Injected zlib adapter. Receives the concatenated IDAT payload and the exact
// expected inflated size in bytes. Returns the inflated bytes, or nullopt if
// decompression failed. Implementations may wrap zlib, or return ready-made
// bytes (e.g. in tests).
using Inflater = std::function<std::optional<std::vector<uint8_t>>(
    std::span<const uint8_t> compressed, uint64_t expected_size)>;

class Decoder {
public:
  explicit Decoder(Inflater inflater, Limits limits = {});
  Decoder(const Decoder&) = delete;
  Decoder& operator=(const Decoder&) = delete;

  // Feed an arbitrary chunk of the byte stream. Returns false once the
  // decoder has failed (inspect error()); further feeds are ignored.
  bool feed(std::span<const uint8_t> data);

  // Signal end of input. If the stream is incomplete, fails with Truncated.
  void finish();

  bool done() const noexcept { return image_.has_value(); }
  bool failed() const noexcept { return error_ != Error::None; }
  Error error() const noexcept { return error_; }

  // The decoded image, only after a fully successful decode. Never partial.
  std::optional<Image> takeImage();

private:
  enum class State { Signature, ChunkLength, ChunkType, ChunkData, ChunkCrc, Complete };

  void parse();
  void onChunk();
  bool handleIhdr();
  void inflateAndUnfilter();
  void fail(Error e);

  Inflater inflater_;
  Limits limits_;
  Error error_ = Error::None;
  State state_ = State::Signature;

  std::vector<uint8_t> buf_;   // unparsed bytes
  size_t pos_ = 0;             // parse cursor inside buf_
  uint32_t chunk_len_ = 0;     // current chunk payload length
  uint8_t chunk_type_[4] = {}; // current chunk type
  std::vector<uint8_t> chunk_; // current chunk payload accumulator

  bool seen_ihdr_ = false;
  bool idat_open_ = false;    // inside a consecutive IDAT run
  bool idat_closed_ = false;  // an IDAT run has ended; more IDAT is an error
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint64_t expected_raw_ = 0; // height * (1 + width)
  std::vector<uint8_t> compressed_;
  std::optional<Image> image_;
};

} // namespace pngdec
