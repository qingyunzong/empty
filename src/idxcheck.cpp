// idxcheck: validate a BINIDX01 index, optionally against a data file.
//
// Usage: idxcheck <index-file> [--data <data-file>]
//
// Exit codes: 0 = valid, 1 = invalid index/layout/view, 2 = usage/IO error.
// The final stdout line is machine readable:
//   RESULT: OK
//   RESULT: INVALID <CODE>: <message>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "binidx/binidx.hpp"

namespace {

std::vector<std::byte> read_file(const std::string& path, bool& ok) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    ok = false;
    return {};
  }
  const std::vector<char> chars{std::istreambuf_iterator<char>(in),
                                std::istreambuf_iterator<char>()};
  std::vector<std::byte> bytes(chars.size());
  if (!chars.empty()) std::memcpy(bytes.data(), chars.data(), chars.size());
  ok = true;
  return bytes;
}

int report_invalid(const binidx::Error& err) {
  std::printf("RESULT: INVALID %s: %s\n", binidx::to_string(err.code), err.message.c_str());
  return 1;
}

}  // namespace

int main(int argc, char** argv) {
  std::string index_path;
  std::string data_path;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--data" && i + 1 < argc) {
      data_path = argv[++i];
    } else if (index_path.empty()) {
      index_path = arg;
    } else {
      std::fprintf(stderr, "usage: idxcheck <index-file> [--data <data-file>]\n");
      return 2;
    }
  }
  if (index_path.empty()) {
    std::fprintf(stderr, "usage: idxcheck <index-file> [--data <data-file>]\n");
    return 2;
  }

  bool ok = false;
  const std::vector<std::byte> index_bytes = read_file(index_path, ok);
  if (!ok) {
    std::fprintf(stderr, "error: cannot read index file '%s'\n", index_path.c_str());
    return 2;
  }

  auto parsed = binidx::parse_index(index_bytes);
  if (!parsed) return report_invalid(parsed.error());
  const std::vector<binidx::Segment>& segments = parsed.value();

  std::printf("segments: %zu\n", segments.size());
  for (std::size_t i = 0; i < segments.size(); ++i) {
    std::uint64_t end = 0;
    if (binidx::segment_end(segments[i], end)) {
      std::printf("  segment[%zu] offset=%llu length=%llu end=%llu\n", i,
                  (unsigned long long)segments[i].offset,
                  (unsigned long long)segments[i].length, (unsigned long long)end);
    } else {
      std::printf("  segment[%zu] offset=%llu length=%llu end=OVERFLOW(>2^64-1)\n", i,
                  (unsigned long long)segments[i].offset,
                  (unsigned long long)segments[i].length);
    }
  }

  if (auto err = binidx::validate_layout(segments)) return report_invalid(*err);
  std::printf("layout: OK (overflow-safe bounds, sharing allowed, no partial overlap)\n");

  if (!data_path.empty()) {
    const std::vector<std::byte> data = read_file(data_path, ok);
    if (!ok) {
      std::fprintf(stderr, "error: cannot read data file '%s'\n", data_path.c_str());
      return 2;
    }
    if (auto err = binidx::validate_against_file(segments,
                                                static_cast<std::uint64_t>(data.size()))) {
      return report_invalid(*err);
    }
    std::printf("file: OK (all %zu segment(s) fit in %zu bytes)\n", segments.size(),
                data.size());
  }

  std::printf("RESULT: OK\n");
  return 0;
}
