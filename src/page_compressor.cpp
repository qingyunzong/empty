#include "page_compressor.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>

namespace pgx {
namespace {

constexpr std::size_t kHeaderSize = 4;  // entry count
constexpr std::size_t kCrcSize = 4;
constexpr std::size_t kEntryFixed =
    4 + 4 + 8 + 4;  // prefix_len + suffix_len + version + value_len

std::uint32_t crc32(const char* data, std::size_t len) {
  static const std::array<std::uint32_t, 256> table = [] {
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t i = 0; i < 256; ++i) {
      std::uint32_t c = i;
      for (int k = 0; k < 8; ++k)
        c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      t[i] = c;
    }
    return t;
  }();
  std::uint32_t c = 0xFFFFFFFFu;
  for (std::size_t i = 0; i < len; ++i)
    c = table[(c ^ static_cast<unsigned char>(data[i])) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

void append_u32(std::string& out, std::uint32_t v) {
  char b[4];
  std::memcpy(b, &v, 4);  // little-endian on all supported targets
  out.append(b, 4);
}

void append_u64(std::string& out, std::uint64_t v) {
  char b[8];
  std::memcpy(b, &v, 8);
  out.append(b, 8);
}

class Reader {
 public:
  Reader(const char* p, std::size_t n) : p_(p), n_(n) {}

  std::uint32_t u32() {
    std::uint32_t v;
    take(&v, 4);
    return v;
  }
  std::uint64_t u64() {
    std::uint64_t v;
    take(&v, 8);
    return v;
  }
  std::string bytes(std::size_t n) {
    if (n > n_) throw std::runtime_error("malformed page: truncated field");
    std::string s(p_, n);
    p_ += n;
    n_ -= n;
    return s;
  }
  std::size_t remaining() const { return n_; }

 private:
  void take(void* dst, std::size_t n) {
    if (n > n_) throw std::runtime_error("malformed page: truncated field");
    std::memcpy(dst, p_, n);
    p_ += n;
    n_ -= n;
  }
  const char* p_;
  std::size_t n_;
};

std::size_t shared_prefix(const std::string& a, const std::string& b) {
  std::size_t n = 0;
  while (n < a.size() && n < b.size() && a[n] == b[n]) ++n;
  return n;
}

// Compressed size of one entry given the previous key in the same page.
std::size_t entry_size(const Record& rec, std::size_t prefix_len) {
  return kEntryFixed + (rec.key.size() - prefix_len) + rec.value.size();
}

void append_entry(std::string& page, const Record& rec,
                  std::size_t prefix_len) {
  append_u32(page, static_cast<std::uint32_t>(prefix_len));
  append_u32(page, static_cast<std::uint32_t>(rec.key.size() - prefix_len));
  page.append(rec.key, prefix_len, std::string::npos);
  append_u64(page, rec.version);
  append_u32(page, static_cast<std::uint32_t>(rec.value.size()));
  page.append(rec.value);
}

}  // namespace

PageBuilder::PageBuilder(std::size_t page_budget) : page_budget_(page_budget) {
  append_u32(page_buf_, 0);  // count placeholder
}

std::optional<std::string> PageBuilder::add(const Record& rec) {
  const std::size_t standalone = kHeaderSize + entry_size(rec, 0) + kCrcSize;
  if (standalone > page_budget_) {
    return "record too large: needs " + std::to_string(standalone) +
           " bytes, page budget is " + std::to_string(page_budget_);
  }

  if (count_ > 0) {
    const std::size_t prefix = shared_prefix(last_key_, rec.key);
    if (page_buf_.size() + entry_size(rec, prefix) + kCrcSize >
        page_budget_) {
      seal_page();
    }
  }

  const std::size_t prefix =
      (count_ == 0) ? 0 : shared_prefix(last_key_, rec.key);
  if (count_ == 0) first_key_ = rec.key;
  append_entry(page_buf_, rec, prefix);
  last_key_ = rec.key;
  ++count_;
  return std::nullopt;
}

void PageBuilder::seal_page() {
  if (count_ == 0) return;
  std::memcpy(page_buf_.data(), &count_, 4);  // patch entry count
  const std::uint32_t crc = crc32(page_buf_.data(), page_buf_.size());
  PageInfo info;
  info.first_key = first_key_;
  info.offset = data_.size();
  info.size = static_cast<std::uint32_t>(page_buf_.size() + kCrcSize);
  info.crc32 = crc;
  index_.push_back(std::move(info));
  data_ += page_buf_;
  append_u32(data_, crc);

  page_buf_.clear();
  append_u32(page_buf_, 0);
  count_ = 0;
  first_key_.clear();
  last_key_.clear();
}

CompressedOutput PageBuilder::finish() {
  seal_page();
  return CompressedOutput{std::move(data_), std::move(index_)};
}

CompressedOutput compress(std::vector<Record> records,
                          std::size_t page_budget) {
  std::sort(records.begin(), records.end(), [](const Record& a,
                                               const Record& b) {
    if (a.key != b.key) return a.key < b.key;
    return a.version > b.version;  // newest version first
  });
  PageBuilder builder(page_budget);
  for (const Record& rec : records) {
    if (auto err = builder.add(rec)) throw std::length_error(*err);
  }
  return builder.finish();
}

std::vector<Record> decompress(const CompressedOutput& output) {
  std::vector<Record> records;
  for (const PageInfo& page : output.index) {
    if (page.offset + page.size > output.data.size())
      throw std::runtime_error("page index out of bounds");
    const char* base = output.data.data() + page.offset;
    if (page.size < kHeaderSize + kCrcSize)
      throw std::runtime_error("malformed page: too small");

    const std::uint32_t stored_crc = crc32(base, page.size - kCrcSize);
    std::uint32_t expected_crc;
    std::memcpy(&expected_crc, base + page.size - kCrcSize, 4);
    if (stored_crc != expected_crc)
      throw std::runtime_error("page checksum mismatch at offset " +
                               std::to_string(page.offset));
    if (expected_crc != page.crc32)
      throw std::runtime_error("page index checksum mismatch at offset " +
                               std::to_string(page.offset));

    Reader r(base, page.size - kCrcSize);
    const std::uint32_t count = r.u32();
    std::string prev_key;
    for (std::uint32_t i = 0; i < count; ++i) {
      const std::uint32_t prefix_len = r.u32();
      const std::uint32_t suffix_len = r.u32();
      if (prefix_len > prev_key.size())
        throw std::runtime_error("malformed page: bad prefix length");
      Record rec;
      rec.key = prev_key.substr(0, prefix_len) + r.bytes(suffix_len);
      rec.version = r.u64();
      rec.value = r.bytes(r.u32());
      prev_key = rec.key;
      records.push_back(std::move(rec));
    }
    if (r.remaining() != 0)
      throw std::runtime_error("malformed page: trailing bytes");
  }
  return records;
}

}  // namespace pgx
