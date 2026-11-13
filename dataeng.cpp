#include "dataeng.hpp"

#include <array>
#include <cstring>

namespace dataeng {

namespace {

constexpr uint8_t kMagic[4] = {'B', 'B', 'F', '1'};
// Header: magic(4) version(4) salt(8) num_blocks(4) block_bits(4)
//         payload_bytes(4) crc32(4)
constexpr size_t kHeaderBytes = 32;

uint64_t splitmix64(uint64_t x) {
  x += 0x9E3779B97F4A7C15ULL;
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
  return x ^ (x >> 31);
}

uint32_t crc32_ieee(const uint8_t* data, size_t size) {
  static const std::array<uint32_t, 256> table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k)
        c = (c & 1) ? (0xEDB88320U ^ (c >> 1)) : (c >> 1);
      t[i] = c;
    }
    return t;
  }();
  uint32_t crc = 0xFFFFFFFFU;
  for (size_t i = 0; i < size; ++i)
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
  return crc ^ 0xFFFFFFFFU;
}

void put_u32(std::vector<uint8_t>& out, uint32_t v) {
  out.push_back(static_cast<uint8_t>(v));
  out.push_back(static_cast<uint8_t>(v >> 8));
  out.push_back(static_cast<uint8_t>(v >> 16));
  out.push_back(static_cast<uint8_t>(v >> 24));
}

void put_u64(std::vector<uint8_t>& out, uint64_t v) {
  put_u32(out, static_cast<uint32_t>(v));
  put_u32(out, static_cast<uint32_t>(v >> 32));
}

uint32_t read_u32(const uint8_t*& p) {
  uint32_t v = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
               (static_cast<uint32_t>(p[2]) << 16) |
               (static_cast<uint32_t>(p[3]) << 24);
  p += 4;
  return v;
}

}  // namespace

BlockedBloomFilter::BlockedBloomFilter(uint32_t num_blocks)
    : num_blocks_(num_blocks == 0 ? 1 : num_blocks),
      blocks_(static_cast<size_t>(num_blocks_) * kBlockWords, 0) {}

uint64_t BlockedBloomFilter::hash(std::string_view key) {
  uint64_t h = 14695981039346656037ULL;  // FNV-1a-64 offset basis
  for (unsigned char c : key) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return splitmix64(h ^ kSalt);
}

uint32_t BlockedBloomFilter::block_index(uint64_t h) const {
  return static_cast<uint32_t>(((h >> 32) * num_blocks_) >> 32);
}

void BlockedBloomFilter::insert(std::string_view key) {
  const uint64_t h = hash(key);
  uint32_t* block =
      blocks_.data() + static_cast<size_t>(block_index(h)) * kBlockWords;
  // One bit per hash byte: byte i selects word (bits 7..5) and bit (bits 4..0).
  for (int i = 0; i < 8; ++i) {
    const uint32_t pos = static_cast<uint32_t>((h >> (8 * i)) & 0xFF);
    block[pos >> 5] |= uint32_t{1} << (pos & 31);
  }
}

bool BlockedBloomFilter::may_contain(std::string_view key) const {
  const uint64_t h = hash(key);
  const uint32_t* block =
      blocks_.data() + static_cast<size_t>(block_index(h)) * kBlockWords;
  for (int i = 0; i < 8; ++i) {
    const uint32_t pos = static_cast<uint32_t>((h >> (8 * i)) & 0xFF);
    if ((block[pos >> 5] & (uint32_t{1} << (pos & 31))) == 0) return false;
  }
  return true;
}

bool BlockedBloomFilter::merge(const BlockedBloomFilter& other) {
  if (num_blocks_ != other.num_blocks_) return false;
  for (size_t i = 0; i < blocks_.size(); ++i) blocks_[i] |= other.blocks_[i];
  return true;
}

std::vector<uint8_t> BlockedBloomFilter::serialize() const {
  std::vector<uint8_t> out;
  out.reserve(kHeaderBytes + blocks_.size() * 4);
  out.insert(out.end(), std::begin(kMagic), std::end(kMagic));
  put_u32(out, kFormatVersion);
  put_u64(out, kSalt);
  put_u32(out, num_blocks_);
  put_u32(out, kBlockBits);
  put_u32(out, static_cast<uint32_t>(blocks_.size() * 4));

  std::vector<uint8_t> payload;
  payload.reserve(blocks_.size() * 4);
  for (uint32_t word : blocks_) put_u32(payload, word);

  put_u32(out, crc32_ieee(payload.data(), payload.size()));
  out.insert(out.end(), payload.begin(), payload.end());
  return out;
}

std::optional<BlockedBloomFilter> BlockedBloomFilter::deserialize(
    const uint8_t* data, size_t size) {
  if (data == nullptr || size < kHeaderBytes) return std::nullopt;
  if (std::memcmp(data, kMagic, sizeof(kMagic)) != 0) return std::nullopt;

  const uint8_t* p = data + sizeof(kMagic);
  const uint32_t version = read_u32(p);
  const uint32_t salt_lo = read_u32(p);
  const uint32_t salt_hi = read_u32(p);
  const uint32_t num_blocks = read_u32(p);
  const uint32_t block_bits = read_u32(p);
  const uint32_t payload_bytes = read_u32(p);
  const uint32_t crc = read_u32(p);

  const uint64_t salt =
      static_cast<uint64_t>(salt_lo) | (static_cast<uint64_t>(salt_hi) << 32);
  if (version != kFormatVersion || salt != kSalt || num_blocks == 0 ||
      block_bits != kBlockBits)
    return std::nullopt;
  if (payload_bytes != static_cast<uint64_t>(num_blocks) * kBlockWords * 4)
    return std::nullopt;
  if (size - kHeaderBytes != payload_bytes) return std::nullopt;
  if (crc32_ieee(p, payload_bytes) != crc) return std::nullopt;

  BlockedBloomFilter filter(num_blocks);
  for (size_t i = 0; i < filter.blocks_.size(); ++i)
    filter.blocks_[i] = read_u32(p);
  return filter;
}

std::optional<BlockedBloomFilter> BlockedBloomFilter::deserialize(
    const std::vector<uint8_t>& bytes) {
  return deserialize(bytes.data(), bytes.size());
}

}  // namespace dataeng
