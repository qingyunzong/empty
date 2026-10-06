#include "page_compressor.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      ++failures;                                                       \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  "       \
                << #cond << std::endl;                                  \
    }                                                                   \
  } while (0)

using pgx::Record;

// Wire sizes, kept in sync with the documented page layout.
constexpr std::size_t kHeader = 4;
constexpr std::size_t kCrc = 4;
std::size_t entry_bytes(std::size_t key_len, std::size_t value_len,
                        std::size_t prefix_len = 0) {
  return 4 + 4 + (key_len - prefix_len) + 8 + 4 + value_len;
}

void test_sort_order() {
  std::vector<Record> in = {
      {"b", 1, "vb1"}, {"a", 3, "va3"}, {"a", 9, "va9"},
      {"a", 5, "va5"}, {"b", 2, "vb2"}, {"c", 0, "vc0"},
  };
  auto out = pgx::compress(in, 1 << 20);
  auto back = pgx::decompress(out);
  std::vector<Record> want = {
      {"a", 9, "va9"}, {"a", 5, "va5"}, {"a", 3, "va3"},
      {"b", 2, "vb2"}, {"b", 1, "vb1"}, {"c", 0, "vc0"},
  };
  CHECK(back == want);
}

void test_round_trip() {
  std::vector<Record> in;
  for (int i = 0; i < 500; ++i) {
    in.push_back({"user/" + std::to_string(i % 50) + "/profile",
                  static_cast<std::uint64_t>(i),
                  std::string(i % 97, 'x')});
  }
  auto sorted = in;
  auto out_small = pgx::compress(sorted, 256);
  auto out_big = pgx::compress(in, 1 << 20);
  CHECK(pgx::decompress(out_small) == pgx::decompress(out_big));
  CHECK(out_small.index.size() > 1);
  CHECK(out_big.index.size() == 1);
}

void test_prefix_compression_saves_space() {
  std::vector<Record> in;
  for (int i = 0; i < 100; ++i)
    in.push_back({"common/prefix/that/is/fairly/long/key" +
                      std::to_string(i),
                  1, "v"});
  auto compressed = pgx::compress(in, 1 << 20);
  std::size_t raw = kHeader + kCrc;
  for (const auto& r : in) raw += entry_bytes(r.key.size(), r.value.size());
  CHECK(compressed.data.size() < raw / 2);
  CHECK(pgx::decompress(compressed).size() == 100);
}

void test_page_boundary_exact_fit() {
  // Two records whose combined size exactly equals the budget stay together.
  Record a{"aaa", 1, ""};
  Record b{"aab", 1, ""};  // shares 2-byte prefix with "aaa"
  const std::size_t need =
      kHeader + entry_bytes(3, 0) + entry_bytes(3, 0, 2) + kCrc;
  auto one = pgx::compress({a, b}, need);
  CHECK(one.index.size() == 1);
  CHECK(one.data.size() == need);
  CHECK(one.index[0].size == need);
  CHECK(pgx::decompress(one) == std::vector<Record>({a, b}));

  // One byte less forces a page split.
  auto two = pgx::compress({a, b}, need - 1);
  CHECK(two.index.size() == 2);
  CHECK(two.index[0].first_key == "aaa");
  CHECK(two.index[1].first_key == "aab");
  CHECK(two.index[1].offset == two.index[0].size);
  CHECK(pgx::decompress(two) == std::vector<Record>({a, b}));
}

void test_oversized_record_rejected() {
  const std::size_t budget = 64;
  Record huge{"key", 1, std::string(200, 'z')};

  pgx::PageBuilder builder(budget);
  auto err = builder.add(huge);
  CHECK(err.has_value());

  // Builder state is untouched: a fitting record still lands in page 0.
  Record small{"ok", 1, "v"};
  CHECK(!builder.add(small).has_value());
  auto out = builder.finish();
  CHECK(out.index.size() == 1);
  CHECK(pgx::decompress(out) == std::vector<Record>({small}));

  bool threw = false;
  try {
    (void)pgx::compress({huge}, budget);
  } catch (const std::length_error&) {
    threw = true;
  }
  CHECK(threw);
}

void test_index_and_checksum() {
  std::vector<Record> in;
  for (int i = 0; i < 40; ++i)
    in.push_back({"k" + std::to_string(100 + i), 7, "payload"});
  auto out = pgx::compress(in, 128);
  CHECK(out.index.size() > 1);

  std::uint64_t offset = 0;
  for (const auto& p : out.index) {
    CHECK(p.offset == offset);
    CHECK(p.size > 0);
    offset += p.size;
  }
  CHECK(offset == out.data.size());
  CHECK(out.index.front().first_key == "k100");
  CHECK(pgx::decompress(out).size() == 40);
}

void test_corruption_detected() {
  std::vector<Record> in;
  for (int i = 0; i < 20; ++i)
    in.push_back({"key" + std::to_string(i), 1, "value"});
  auto out = pgx::compress(in, 96);
  CHECK(out.index.size() > 1);

  // Flip a payload byte inside the second page.
  auto bad = out;
  bad.data[bad.index[1].offset + 6] ^= 0xFF;
  bool threw = false;
  try {
    (void)pgx::decompress(bad);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);

  // Tamper with the checksum stored in the index.
  auto bad_index = out;
  bad_index.index[0].crc32 ^= 1;
  threw = false;
  try {
    (void)pgx::decompress(bad_index);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);

  // Untouched output still verifies.
  CHECK(pgx::decompress(out).size() == 20);
}

void test_empty_input() {
  auto out = pgx::compress({}, 128);
  CHECK(out.data.empty());
  CHECK(out.index.empty());
  CHECK(pgx::decompress(out).empty());
}

}  // namespace

int main() {
  test_sort_order();
  test_round_trip();
  test_prefix_compression_saves_space();
  test_page_boundary_exact_fit();
  test_oversized_record_rejected();
  test_index_and_checksum();
  test_corruption_detected();
  test_empty_input();

  if (failures == 0) {
    std::cout << "all tests passed" << std::endl;
    return EXIT_SUCCESS;
  }
  std::cerr << failures << " check(s) failed" << std::endl;
  return EXIT_FAILURE;
}
