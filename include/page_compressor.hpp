#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace pgx {

// A single record. Within the compressed stream records are ordered by
// (key ascending, version descending) so the newest version of a key
// comes first.
struct Record {
  std::string key;
  std::uint64_t version = 0;
  std::string value;

  bool operator==(const Record&) const = default;
};

// Index entry describing one sealed page inside the compressed blob.
struct PageInfo {
  std::string first_key;     // first (uncompressed) key stored in the page
  std::uint64_t offset = 0;  // byte offset of the page inside `data`
  std::uint32_t size = 0;    // page size in bytes, checksum included
  std::uint32_t crc32 = 0;   // CRC-32 of the page payload (checksum excluded)
};

struct CompressedOutput {
  std::string data;             // concatenated pages
  std::vector<PageInfo> index;  // one entry per page, in order
};

// Packs already-sorted records into prefix-compressed pages.
//
// Page layout (all integers little-endian):
//   [u32 entry_count]
//   entry *: [u32 prefix_len][u32 suffix_len][suffix]
//            [u64 version][u32 value_len][value]
//   [u32 crc32 of everything above]
//
// The first entry of a page always stores prefix_len = 0 (restart point).
// A page is sealed when appending the next entry would push the total
// (header + entries + checksum) past the byte budget.
class PageBuilder {
 public:
  explicit PageBuilder(std::size_t page_budget);

  // Records must arrive in (key asc, version desc) order.
  // Returns an error message if the record alone can never fit into an
  // empty page under the budget; the builder state is left unchanged.
  std::optional<std::string> add(const Record& rec);

  // Seals the pending page (if any) and returns the final output.
  CompressedOutput finish();

  std::size_t page_budget() const { return page_budget_; }

 private:
  void seal_page();

  std::size_t page_budget_;
  std::string data_;
  std::vector<PageInfo> index_;

  std::string page_buf_;  // starts with a 4-byte count, patched on seal
  std::uint32_t count_ = 0;
  std::string first_key_;
  std::string last_key_;
};

// Sorts `records` by (key asc, version desc) and packs them into pages.
// Throws std::length_error if any single record exceeds the page budget.
CompressedOutput compress(std::vector<Record> records, std::size_t page_budget);

// Verifies every page checksum and restores the sorted records.
// Throws std::runtime_error on checksum mismatch or malformed data.
std::vector<Record> decompress(const CompressedOutput& output);

}  // namespace pgx
