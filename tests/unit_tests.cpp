// Unit tests for the binidx library: overflow-safe boundary math,
// sharing/overlap rules, and bounded read-only views.

#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <vector>

#include "binidx/binidx.hpp"

using binidx::Segment;
using binidx::Errc;

namespace {

int g_failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                              \
    }                                                            \
  } while (0)

constexpr std::uint64_t kMax = UINT64_MAX;

void test_segment_end() {
  std::uint64_t end = 0xDEAD;
  CHECK(binidx::segment_end({0, 0}, end) && end == 0);
  CHECK(binidx::segment_end({kMax, 0}, end) && end == kMax);
  CHECK(binidx::segment_end({kMax - 1, 1}, end) && end == kMax);
  CHECK(binidx::segment_end({kMax - 0xFF, 0xFF}, end) && end == kMax);
  end = 0xDEAD;
  CHECK(!binidx::segment_end({kMax, 1}, end) && end == 0xDEAD);        // wraps to 0
  CHECK(!binidx::segment_end({kMax - 1, 2}, end) && end == 0xDEAD);    // wraps to 0
  CHECK(!binidx::segment_end({1, kMax}, end) && end == 0xDEAD);        // wraps to 0
  CHECK(!binidx::segment_end({kMax / 2 + 1, kMax / 2 + 1}, end));      // wraps to 1
}

void test_parse() {
  const std::vector<Segment> segs{{0, 100}, {100, 50}, {kMax - 0xFF, 0xFF}};
  const auto bytes = binidx::serialize_index(segs);
  auto parsed = binidx::parse_index(bytes);
  CHECK(parsed.has_value());
  CHECK(parsed.has_value() && parsed.value() == segs);

  // Truncated at every byte boundary must never crash and must fail.
  for (std::size_t n = 0; n < bytes.size(); ++n) {
    auto p = binidx::parse_index(std::span<const std::byte>(bytes.data(), n));
    CHECK(!p.has_value());
  }
  // One trailing byte.
  {
    auto extra = bytes;
    extra.push_back(std::byte{0});
    auto p = binidx::parse_index(extra);
    CHECK(!p.has_value() && p.error().code == Errc::kTrailingBytes);
  }
  // Bad magic.
  {
    auto bad = bytes;
    bad[0] = std::byte{0xFF};
    auto p = binidx::parse_index(bad);
    CHECK(!p.has_value() && p.error().code == Errc::kBadMagic);
  }
  // Huge count: 16 + count*16 would overflow; reported as truncated.
  {
    std::vector<std::byte> img;
    binidx::append_u64_le(img, binidx::kMagic);
    binidx::append_u64_le(img, kMax);
    auto p = binidx::parse_index(img);
    CHECK(!p.has_value() && p.error().code == Errc::kTruncatedEntries);
  }
}

void test_layout() {
  CHECK(!binidx::validate_layout({{0, 100}, {100, 50}, {200, 10}}));
  CHECK(!binidx::validate_layout({{10, 20}, {10, 20}}));            // shared: OK
  CHECK(!binidx::validate_layout({{0, 100}, {50, 0}, {100, 0}}));   // empty: OK
  CHECK(!binidx::validate_layout({{kMax - 0xFF, 0xFF}}));           // end == 2^64-1: OK
  CHECK(!binidx::validate_layout({}));                              // no entries: OK

  auto code = [](const std::vector<Segment>& s) {
    auto e = binidx::validate_layout(s);
    CHECK(e.has_value());
    return e ? e->code : Errc::kOk;
  };
  CHECK(code({{kMax - 0xFF, 0x100}}) == Errc::kSegmentOverflow);
  CHECK(code({{1, kMax}}) == Errc::kSegmentOverflow);
  CHECK(code({{100, 50}, {120, 30}}) == Errc::kPartialOverlap);
  CHECK(code({{100, 100}, {120, 10}}) == Errc::kPartialOverlap);    // containment
  CHECK(code({{0, 5}, {0, 10}}) == Errc::kPartialOverlap);          // shared prefix
  CHECK(code({{0, 10}, {20, 30}, {25, 5}}) == Errc::kPartialOverlap);
}

void test_file_bounds() {
  CHECK(!binidx::validate_against_file({{0, 150}, {150, 150}}, 300));  // end == size
  CHECK(!binidx::validate_against_file({{300, 0}}, 300));              // empty at EOF
  auto code = [](const std::vector<Segment>& s, std::uint64_t size) {
    auto e = binidx::validate_against_file(s, size);
    CHECK(e.has_value());
    return e ? e->code : Errc::kOk;
  };
  CHECK(code({{0, 301}}, 300) == Errc::kViewExceedsFile);
  CHECK(code({{250, 100}}, 300) == Errc::kViewExceedsFile);
  CHECK(code({{301, 0}}, 300) == Errc::kViewExceedsFile);
}

void test_view() {
  std::vector<std::byte> file(300);
  for (std::size_t i = 0; i < file.size(); ++i) file[i] = std::byte(i & 0xFF);

  auto v = binidx::make_view({150, 150}, file);
  CHECK(v.has_value());
  CHECK(v && v->size() == 150);
  CHECK(v && v->at(0) == file[150]);
  CHECK(v && v->at(149) == file[299]);
  bool threw = false;
  try {
    (void)v->at(150);
  } catch (const std::out_of_range&) {
    threw = true;
  }
  CHECK(threw);

  CHECK(binidx::make_view({300, 0}, file).has_value());   // empty view at EOF
  CHECK(!binidx::make_view({0, 301}, file).has_value());
  CHECK(!binidx::make_view({301, 0}, file).has_value());
  CHECK(!binidx::make_view({kMax, kMax}, file).has_value());
}

}  // namespace

int main() {
  test_segment_end();
  test_parse();
  test_layout();
  test_file_bounds();
  test_view();
  if (g_failures == 0) {
    std::printf("unit_tests: all checks passed\n");
    return 0;
  }
  std::printf("unit_tests: %d check(s) failed\n", g_failures);
  return 1;
}
