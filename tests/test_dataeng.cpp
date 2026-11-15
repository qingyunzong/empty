#include "dataeng.hpp"

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include <unistd.h>

namespace {

int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      ++failures;                                                \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " \
                << #cond << "\n";                                \
    }                                                            \
  } while (0)

// Hasher where every row collides, to prove raw-value confirmation.
struct ConstantHasher {
  dataeng::Digest operator()(const dataeng::Row&) const { return {}; }
};

bool contains(const std::vector<dataeng::RowCount>& v, const std::string& row,
              std::uint64_t count) {
  for (const auto& rc : v) {
    if (rc.row == row && rc.count == count) return true;
  }
  return false;
}

void test_basic_diff() {
  std::vector<dataeng::Row> old_rows = {"a", "a", "b"};
  std::vector<dataeng::Row> new_rows = {"a", "c", "c", "c"};
  auto diff = dataeng::diff_snapshots(old_rows.begin(), old_rows.end(),
                                      new_rows.begin(), new_rows.end());
  CHECK(diff.inserts.size() == 1);
  CHECK(diff.deletes.size() == 2);
  CHECK(contains(diff.inserts, "c", 3));
  CHECK(contains(diff.deletes, "a", 1));
  CHECK(contains(diff.deletes, "b", 1));
}

void test_empty_snapshots() {
  std::vector<dataeng::Row> empty;
  auto diff = dataeng::diff_snapshots(empty.begin(), empty.end(),
                                      empty.begin(), empty.end());
  CHECK(diff.inserts.empty());
  CHECK(diff.deletes.empty());
}

void test_identical_snapshots() {
  std::vector<dataeng::Row> rows = {"x", "x", "y", "z", "z", "z"};
  auto diff = dataeng::diff_snapshots(rows.begin(), rows.end(), rows.begin(),
                                      rows.end());
  CHECK(diff.inserts.empty());
  CHECK(diff.deletes.empty());
}

void test_collision_not_merged() {
  // Every row shares one digest; distinct values must stay distinct.
  std::vector<dataeng::Row> old_rows = {"a", "a", "b", "c"};
  std::vector<dataeng::Row> new_rows = {"a", "b", "b", "d"};
  auto diff = dataeng::diff_snapshots<ConstantHasher>(
      old_rows.begin(), old_rows.end(), new_rows.begin(), new_rows.end());
  CHECK(diff.inserts.size() == 2);
  CHECK(diff.deletes.size() == 2);
  CHECK(contains(diff.inserts, "b", 1));
  CHECK(contains(diff.inserts, "d", 1));
  CHECK(contains(diff.deletes, "a", 1));
  CHECK(contains(diff.deletes, "c", 1));
}

void test_heavy_duplicates() {
  std::vector<dataeng::Row> old_rows(10000, "same");
  std::vector<dataeng::Row> new_rows(9999, "same");
  auto diff = dataeng::diff_snapshots(old_rows.begin(), old_rows.end(),
                                      new_rows.begin(), new_rows.end());
  CHECK(diff.inserts.empty());
  CHECK(diff.deletes.size() == 1);
  CHECK(contains(diff.deletes, "same", 1));
}

std::vector<dataeng::Row> random_rows(std::mt19937_64& rng, std::size_t n,
                                      std::size_t distinct) {
  std::uniform_int_distribution<std::uint64_t> pick(0, distinct - 1);
  std::vector<dataeng::Row> rows;
  rows.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    rows.push_back("row_" + std::to_string(pick(rng)));
  }
  return rows;
}

std::size_t count_files(const std::filesystem::path& dir) {
  std::size_t n = 0;
  std::error_code ec;
  for (auto it = std::filesystem::directory_iterator(dir, ec);
       !ec && it != std::filesystem::directory_iterator(); it.increment(ec)) {
    ++n;
  }
  return n;
}

void test_external_matches_memory(const std::filesystem::path& spill_dir) {
  std::mt19937_64 rng(42);
  auto old_rows = random_rows(rng, 20000, 500);
  auto new_rows = random_rows(rng, 20000, 500);

  auto expected = dataeng::diff_snapshots(old_rows.begin(), old_rows.end(),
                                          new_rows.begin(), new_rows.end());

  // Tiny budget and fan-in force many runs and multi-pass merging.
  dataeng::ExternalOptions opts;
  opts.spill_dir = spill_dir;
  opts.memory_budget_bytes = 8 << 10;
  opts.merge_fan_in = 8;

  auto actual = dataeng::diff_snapshots_external(
      old_rows.begin(), old_rows.end(), new_rows.begin(), new_rows.end(),
      opts);

  CHECK(actual == expected);
  // Temp run files must be cleaned up.
  CHECK(count_files(spill_dir) == 0);
}

void test_external_empty_and_single(const std::filesystem::path& spill_dir) {
  std::vector<dataeng::Row> empty;
  std::vector<dataeng::Row> one = {"only"};
  dataeng::ExternalOptions opts;
  opts.spill_dir = spill_dir;
  opts.memory_budget_bytes = 1;  // flush every row
  opts.merge_fan_in = 2;

  auto diff = dataeng::diff_snapshots_external(
      empty.begin(), empty.end(), one.begin(), one.end(), opts);
  CHECK(diff.inserts.size() == 1);
  CHECK(contains(diff.inserts, "only", 1));
  CHECK(diff.deletes.empty());

  auto diff2 = dataeng::diff_snapshots_external(
      one.begin(), one.end(), empty.begin(), empty.end(), opts);
  CHECK(diff2.deletes.size() == 1);
  CHECK(contains(diff2.deletes, "only", 1));
  CHECK(diff2.inserts.empty());
}

void test_external_collision(const std::filesystem::path& spill_dir) {
  std::vector<dataeng::Row> old_rows = {"a", "a", "b", "c"};
  std::vector<dataeng::Row> new_rows = {"a", "b", "b", "d"};
  dataeng::ExternalOptions opts;
  opts.spill_dir = spill_dir;
  opts.memory_budget_bytes = 16;  // force spilling
  opts.merge_fan_in = 2;
  auto diff = dataeng::diff_snapshots_external<ConstantHasher>(
      old_rows.begin(), old_rows.end(), new_rows.begin(), new_rows.end(),
      opts);
  CHECK(diff.inserts.size() == 2);
  CHECK(diff.deletes.size() == 2);
  CHECK(contains(diff.inserts, "b", 1));
  CHECK(contains(diff.inserts, "d", 1));
  CHECK(contains(diff.deletes, "a", 1));
  CHECK(contains(diff.deletes, "c", 1));
}

void test_digest_strength() {
  dataeng::StrongHasher hasher;
  CHECK(hasher("hello") == hasher("hello"));
  CHECK(!(hasher("hello") == hasher("hellp")));
  CHECK(!(hasher("") == hasher("a")));
  CHECK(!(hasher("abc") == hasher("abd")));
}

}  // namespace

int main() {
  test_basic_diff();
  test_empty_snapshots();
  test_identical_snapshots();
  test_collision_not_merged();
  test_heavy_duplicates();
  test_digest_strength();

  // temp_directory_path() honors $TMPDIR.
  auto spill_dir = std::filesystem::temp_directory_path() /
                   ("dataeng_test_" + std::to_string(::getpid()));
  std::filesystem::create_directories(spill_dir);
  test_external_matches_memory(spill_dir);
  test_external_empty_and_single(spill_dir);
  test_external_collision(spill_dir);
  std::error_code ec;
  std::filesystem::remove_all(spill_dir, ec);

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all tests passed\n";
  return 0;
}
