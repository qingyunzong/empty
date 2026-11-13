#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace dataeng {

// Blocked Bloom filter for partition pruning in the lakehouse metadata layer.
//
// The on-disk and in-memory formats are fully fixed so that filters can be
// exchanged and merged across platforms:
//   - Hash:            FNV-1a-64 over the key bytes, mixed with kSalt via the
//                      splitmix64 finalizer.
//   - Salt:            kSalt (compile-time constant, identical everywhere).
//   - Block selection: multiply-shift of the high 32 hash bits:
//                      block = (hi32(hash) * num_blocks) >> 32.
//   - Bit endianness:  each block is 8 x uint32 words; bit b of word w is
//                      (word >> b) & 1 (little-endian within a word), and all
//                      serialized integers are little-endian.
//
// A filter never produces false negatives for keys that were inserted into it
// (or into a filter merged into it). False positives are possible.
class BlockedBloomFilter {
public:
  static constexpr uint32_t kBlockBits = 256;
  static constexpr uint32_t kBlockWords = kBlockBits / 32;
  static constexpr uint64_t kSalt = 0x9E3779B97F4A7C15ULL;
  static constexpr uint32_t kFormatVersion = 1;

  // num_blocks must be > 0. It is the only tuneable parameter and is part of
  // the filter identity: only filters with equal num_blocks can be merged.
  explicit BlockedBloomFilter(uint32_t num_blocks);

  void insert(std::string_view key);
  bool may_contain(std::string_view key) const;

  // OR-merges `other` into this filter. Returns false and leaves this filter
  // unchanged if the parameters (num_blocks) differ.
  bool merge(const BlockedBloomFilter& other);

  uint32_t num_blocks() const { return num_blocks_; }

  // Deterministic, platform-independent little-endian serialization with a
  // CRC-32 (IEEE) checksum over the payload.
  std::vector<uint8_t> serialize() const;

  // Returns std::nullopt if the bytes are malformed, truncated, or fail the
  // checksum (e.g. a corrupted tail block).
  static std::optional<BlockedBloomFilter> deserialize(const uint8_t* data,
                                                       size_t size);
  static std::optional<BlockedBloomFilter> deserialize(
      const std::vector<uint8_t>& bytes);

  friend bool operator==(const BlockedBloomFilter& a,
                         const BlockedBloomFilter& b) {
    return a.num_blocks_ == b.num_blocks_ && a.blocks_ == b.blocks_;
  }

private:
  static uint64_t hash(std::string_view key);
  uint32_t block_index(uint64_t h) const;

  uint32_t num_blocks_;
  std::vector<uint32_t> blocks_;  // num_blocks_ * kBlockWords words
};

}  // namespace dataeng
