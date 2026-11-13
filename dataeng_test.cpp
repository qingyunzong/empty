#include "dataeng.hpp"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

using dataeng::DictionaryBatch;
using dataeng::IndexWidth;
using dataeng::StringDictionaryUnifier;
using dataeng::UnifyError;

namespace {

std::vector<std::uint8_t> Bitmap(std::initializer_list<bool> bits) {
  std::vector<std::uint8_t> out((bits.size() + 7) / 8, 0);
  std::size_t i = 0;
  for (bool bit : bits) {
    if (bit) dataeng::BitmapSet(out.data(), i);
    ++i;
  }
  return out;
}

void ExpectDecodeEquals(const StringDictionaryUnifier& unifier, std::size_t slot,
                        const DictionaryBatch<std::string>& original) {
  const auto decoded = unifier.Decode(slot);
  const auto expected = dataeng::DecodeBatch(original);
  assert(decoded == expected);
}

void TestMultiBatchUnify() {
  StringDictionaryUnifier unifier;

  DictionaryBatch<std::string> b0;
  b0.dictionary_id = 1;
  b0.ordered = true;
  b0.dictionary = {"apple", "banana", "cherry"};
  b0.indices = {0, 2, 1, 0, 2};
  b0.null_bitmap = Bitmap({true, true, false, true, true});

  DictionaryBatch<std::string> b1;
  b1.dictionary_id = 2;
  b1.ordered = true;
  b1.dictionary = {"banana", "date", "apple"};
  b1.indices = {1, 0, 2, 1};
  b1.null_bitmap = Bitmap({true, true, true, false});

  const std::size_t s0 = unifier.AddBatch(b0);
  const std::size_t s1 = unifier.AddBatch(b1);

  // Stable mode: global dictionary keeps first-appearance order.
  const std::vector<std::string> expected_global = {"apple", "cherry", "banana", "date"};
  assert(unifier.GlobalDictionary() == expected_global);
  assert(unifier.ordered());
  assert(unifier.width() == IndexWidth::kInt8);

  // Remapped indices point into the global dictionary.
  const auto& u0 = unifier.batch(s0);
  const std::vector<std::int64_t> expect0 = {0, 2, -1, 1, 2};
  assert(u0.indices == expect0);
  assert(u0.null_bitmap == Bitmap({true, true, false, true, true}));

  const auto& u1 = unifier.batch(s1);
  const std::vector<std::int64_t> expect1 = {3, 2, 0, -1};
  assert(u1.indices == expect1);

  // Decode of unified output matches value-by-value decode of the input.
  ExpectDecodeEquals(unifier, s0, b0);
  ExpectDecodeEquals(unifier, s1, b1);
}

void TestDeltaDictionary() {
  StringDictionaryUnifier unifier;

  DictionaryBatch<std::string> base;
  base.dictionary_id = 7;
  base.dictionary = {"a", "b"};
  base.indices = {0, 1};
  const std::size_t s0 = unifier.AddBatch(base);

  // Delta on the correct predecessor: indices address the merged dictionary.
  DictionaryBatch<std::string> delta;
  delta.dictionary_id = 7;
  delta.is_delta = true;
  delta.dictionary = {"c"};
  delta.indices = {2, 0, 2};
  const std::size_t s1 = unifier.AddBatch(delta);

  const std::vector<std::string> expected_global = {"a", "b", "c"};
  assert(unifier.GlobalDictionary() == expected_global);
  const std::vector<std::int64_t> expect1 = {2, 0, 2};
  assert(unifier.batch(s1).indices == expect1);

  // Full replacement resets the base for the id; a later delta builds on it.
  DictionaryBatch<std::string> replacement;
  replacement.dictionary_id = 7;
  replacement.dictionary = {"x"};
  replacement.indices = {0};
  unifier.AddBatch(replacement);

  DictionaryBatch<std::string> delta2;
  delta2.dictionary_id = 7;
  delta2.is_delta = true;
  delta2.dictionary = {"y"};
  delta2.indices = {1, 0};
  const std::size_t s3 = unifier.AddBatch(delta2);
  const auto decoded = unifier.Decode(s3);
  assert(decoded.size() == 2);
  assert(decoded[0] == std::optional<std::string>("y"));
  assert(decoded[1] == std::optional<std::string>("x"));

  // Delta without a predecessor is rejected.
  DictionaryBatch<std::string> orphan;
  orphan.dictionary_id = 99;
  orphan.is_delta = true;
  orphan.dictionary = {"z"};
  orphan.indices = {0};
  bool threw = false;
  try {
    unifier.AddBatch(orphan);
  } catch (const UnifyError&) {
    threw = true;
  }
  assert(threw);

  ExpectDecodeEquals(unifier, s0, base);
}

void TestIndexWidthUpgrade() {
  StringDictionaryUnifier unifier;
  assert(unifier.width() == IndexWidth::kInt8);

  DictionaryBatch<std::string> batch;
  batch.dictionary_id = 1;
  const std::size_t kCount = 40000;  // forces int8 -> int16 -> int32
  for (std::size_t i = 0; i < kCount; ++i) {
    batch.dictionary.push_back("v" + std::to_string(i));
    batch.indices.push_back(static_cast<std::int64_t>(i));
  }
  const std::size_t slot = unifier.AddBatch(batch);
  assert(unifier.width() == IndexWidth::kInt32);
  assert(unifier.GlobalDictionary().size() == kCount);

  // Narrow materialization is rejected once the width has upgraded.
  bool threw = false;
  try {
    unifier.Indices<std::int8_t>(slot);
  } catch (const UnifyError&) {
    threw = true;
  }
  assert(threw);

  const auto wide = unifier.Indices<std::int32_t>(slot);
  assert(wide.size() == kCount);
  for (std::size_t i = 0; i < kCount; ++i) {
    assert(wide[i] == static_cast<std::int32_t>(i));
  }

  // Width never downgrades on later small batches.
  DictionaryBatch<std::string> small;
  small.dictionary_id = 2;
  small.dictionary = {"only"};
  small.indices = {0};
  unifier.AddBatch(small);
  assert(unifier.width() == IndexWidth::kInt32);
}

void TestOrderedFlagAggregation() {
  StringDictionaryUnifier unifier;
  DictionaryBatch<std::string> batch;
  batch.dictionary_id = 1;
  batch.dictionary = {"a"};
  batch.indices = {0};
  batch.ordered = true;
  unifier.AddBatch(batch);
  assert(unifier.ordered());

  batch.dictionary_id = 2;
  batch.ordered = false;
  unifier.AddBatch(batch);
  assert(!unifier.ordered());
}

void TestInvalidInputs() {
  StringDictionaryUnifier unifier;

  DictionaryBatch<std::string> bad_bitmap;
  bad_bitmap.dictionary = {"a", "b"};
  bad_bitmap.indices = {0, 1, 0, 1, 0, 1, 0, 1, 0};  // 9 rows -> 2 bytes needed
  bad_bitmap.null_bitmap = {0xFF};
  bool threw = false;
  try {
    unifier.AddBatch(bad_bitmap);
  } catch (const UnifyError&) {
    threw = true;
  }
  assert(threw);

  DictionaryBatch<std::string> bad_index;
  bad_index.dictionary = {"a"};
  bad_index.indices = {1};
  threw = false;
  try {
    unifier.AddBatch(bad_index);
  } catch (const UnifyError&) {
    threw = true;
  }
  assert(threw);
}

}  // namespace

int main() {
  TestMultiBatchUnify();
  TestDeltaDictionary();
  TestIndexWidthUpgrade();
  TestOrderedFlagAggregation();
  TestInvalidInputs();
  std::cout << "all dataeng tests passed\n";
  return 0;
}
