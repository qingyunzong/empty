#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "dataeng.hpp"

using dataeng::BlockedBloomFilter;

namespace {

std::string key(const char* prefix, int i) {
  return std::string(prefix) + "/" + std::to_string(i);
}

// Inserted values must always be found: no false negatives.
void test_inserted_values_found() {
  BlockedBloomFilter filter(1024);
  std::vector<std::string> keys;
  for (int i = 0; i < 10000; ++i) keys.push_back(key("partition", i));
  for (const auto& k : keys) filter.insert(k);
  for (const auto& k : keys) assert(filter.may_contain(k));
}

// Non-inserted values: false positives allowed but bounded.
void test_non_inserted_values() {
  BlockedBloomFilter filter(1024);
  for (int i = 0; i < 10000; ++i) filter.insert(key("partition", i));
  int false_positives = 0;
  const int probes = 100000;
  for (int i = 0; i < probes; ++i)
    if (filter.may_contain(key("other", i))) ++false_positives;
  assert(false_positives < probes / 100);  // < 1%
}

// Merge only succeeds for identical parameters and never loses members.
void test_merge() {
  BlockedBloomFilter a(512), b(512), different(256);
  std::vector<std::string> keys_a, keys_b;
  for (int i = 0; i < 2000; ++i) {
    keys_a.push_back(key("a", i));
    keys_b.push_back(key("b", i));
  }
  for (const auto& k : keys_a) a.insert(k);
  for (const auto& k : keys_b) b.insert(k);

  const BlockedBloomFilter before = a;
  assert(!a.merge(different));  // parameter mismatch rejected
  assert(a == before);          // and filter left unchanged

  assert(a.merge(b));
  for (const auto& k : keys_a) assert(a.may_contain(k));
  for (const auto& k : keys_b) assert(a.may_contain(k));
}

// Serialization is deterministic and round-trips exactly.
void test_serialization_round_trip() {
  BlockedBloomFilter filter(1024);
  std::vector<std::string> keys;
  for (int i = 0; i < 5000; ++i) keys.push_back(key("serde", i));
  for (const auto& k : keys) filter.insert(k);

  const std::vector<uint8_t> bytes1 = filter.serialize();
  const std::vector<uint8_t> bytes2 = filter.serialize();
  assert(bytes1 == bytes2);  // deterministic

  auto restored = BlockedBloomFilter::deserialize(bytes1);
  assert(restored.has_value());
  assert(*restored == filter);
  for (const auto& k : keys) assert(restored->may_contain(k));

  // Empty filter also round-trips.
  BlockedBloomFilter empty(8);
  auto empty_restored = BlockedBloomFilter::deserialize(empty.serialize());
  assert(empty_restored.has_value() && *empty_restored == empty);
}

// Corrupted or truncated tail blocks must be rejected.
void test_corrupted_tail_block() {
  BlockedBloomFilter filter(64);
  for (int i = 0; i < 500; ++i) filter.insert(key("tail", i));
  const std::vector<uint8_t> bytes = filter.serialize();

  // Bit flip inside the final block of the payload.
  for (size_t offset : {bytes.size() - 1, bytes.size() - 17, bytes.size() - 32}) {
    std::vector<uint8_t> corrupted = bytes;
    corrupted[offset] ^= 0x01;
    assert(!BlockedBloomFilter::deserialize(corrupted).has_value());
  }

  // Truncated tail (missing bytes from the last block).
  for (size_t dropped : {size_t{1}, size_t{4}, size_t{31}}) {
    std::vector<uint8_t> truncated(bytes.begin(), bytes.end() - dropped);
    assert(!BlockedBloomFilter::deserialize(truncated).has_value());
  }

  // Trailing garbage after the last block.
  {
    std::vector<uint8_t> extended = bytes;
    extended.push_back(0xAB);
    assert(!BlockedBloomFilter::deserialize(extended).has_value());
  }

  // Bad magic and tampered header fields.
  {
    std::vector<uint8_t> bad = bytes;
    bad[0] = 'X';
    assert(!BlockedBloomFilter::deserialize(bad).has_value());
    bad = bytes;
    bad[12] ^= 0x01;  // num_blocks field
    assert(!BlockedBloomFilter::deserialize(bad).has_value());
  }

  // Empty / null input.
  assert(!BlockedBloomFilter::deserialize(nullptr, 0).has_value());
  assert(!BlockedBloomFilter::deserialize(std::vector<uint8_t>{}).has_value());
}

}  // namespace

int main() {
  test_inserted_values_found();
  test_non_inserted_values();
  test_merge();
  test_serialization_round_trip();
  test_corrupted_tail_block();
  std::puts("all bloom filter tests passed");
  return 0;
}
