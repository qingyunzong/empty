// idxgen: emit test fixtures (extreme values, truncated images, data files).
//
// Usage: idxgen emit <dir>
//
// Convention: a case named <n> produces <dir>/<n>.idx; if <dir>/<n>.data
// exists, idxcheck is also run against that data file.

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "binidx/binidx.hpp"

namespace fs = std::filesystem;
using binidx::Segment;

namespace {

void write(const fs::path& path, const std::vector<std::byte>& bytes) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(reinterpret_cast<const char*>(bytes.data()),
            static_cast<std::streamsize>(bytes.size()));
}

std::vector<std::byte> raw(std::initializer_list<std::uint64_t> words) {
  std::vector<std::byte> out;
  for (std::uint64_t w : words) binidx::append_u64_le(out, w);
  return out;
}

constexpr std::uint64_t kMax = UINT64_MAX;

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3 || std::string(argv[1]) != "emit") {
    std::fprintf(stderr, "usage: idxgen emit <dir>\n");
    return 2;
  }
  const fs::path dir = argv[2];
  std::error_code ec;
  fs::create_directories(dir, ec);
  if (ec) {
    std::fprintf(stderr, "error: cannot create '%s': %s\n", dir.c_str(),
                 ec.message().c_str());
    return 2;
  }

  auto idx = [&](const char* name, const std::vector<Segment>& segs) {
    write(dir / (std::string(name) + ".idx"), binidx::serialize_index(segs));
  };

  // ---- valid layouts ----
  idx("valid_basic", {{0, 100}, {100, 50}, {200, 10}});          // disjoint, touching
  idx("valid_shared", {{10, 20}, {10, 20}, {50, 5}});            // identical = shared
  idx("valid_zero_length", {{0, 100}, {50, 0}, {100, 0}});       // empty intervals
  idx("valid_extreme_end", {{kMax - 0xFF, 0xFF}});               // end == 2^64-1 exactly
  idx("valid_empty", {});                                        // zero entries

  // ---- 64-bit boundary overflow ----
  idx("invalid_end_overflow", {{kMax - 0xFF, 0x100}});           // end == 2^64
  idx("invalid_len_max", {{1, kMax}});                           // 1 + MAX wraps
  idx("invalid_offset_max_len1", {{kMax, 1}});                   // MAX + 1 wraps

  // ---- partial overlap (sharing is OK, intersection is not) ----
  idx("invalid_partial_overlap", {{100, 50}, {120, 30}});
  idx("invalid_containment", {{100, 100}, {120, 10}});
  idx("invalid_shared_prefix", {{0, 5}, {0, 10}});               // same start, not identical

  // ---- truncated / malformed images ----
  write(dir / "bad_magic.idx", raw({0xDEADBEEFCAFEBABEULL, 0}));
  write(dir / "truncated_header.idx", raw({binidx::kMagic}) /* 8 of 16 bytes */);
  {
    auto bytes = binidx::serialize_index({{0, 1}, {2, 3}, {4, 5}});
    bytes.resize(binidx::kHeaderSize + 2 * binidx::kEntrySize);  // count=3, 2 entries
    write(dir / "truncated_entries.idx", bytes);
  }
  {
    auto bytes = binidx::serialize_index({{0, 1}});
    bytes.push_back(std::byte{0xAA});                            // 1 trailing byte
    write(dir / "trailing_bytes.idx", bytes);
  }
  write(dir / "count_huge.idx", raw({binidx::kMagic, kMax}));    // count*16 overflows

  // ---- read-only view vs. file size ----
  idx("view_ok", {{0, 150}, {150, 150}});                        // ends exactly at size
  write(dir / "view_ok.data", std::vector<std::byte>(300, std::byte{0x5A}));
  idx("view_exceeds", {{0, 200}, {250, 100}});                   // end 350 > size 300
  write(dir / "view_exceeds.data", std::vector<std::byte>(300, std::byte{0x5A}));

  std::printf("fixtures written to %s\n", dir.c_str());
  return 0;
}
