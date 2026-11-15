#include "dataeng.hpp"

#include <cstdio>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(condition)                                                 \
  do {                                                                   \
    if (!(condition)) {                                                  \
      std::printf("CHECK failed: %s (%s:%d)\n", #condition, __FILE__,    \
                  __LINE__);                                             \
      ++g_failures;                                                      \
    }                                                                    \
  } while (0)

#define CHECK_EQ(actual, expected)                                       \
  do {                                                                   \
    auto actual_value = (actual);                                        \
    auto expected_value = (expected);                                    \
    if (!(actual_value == expected_value)) {                             \
      std::printf("CHECK_EQ failed: %s == %s (%s:%d)\n", #actual,        \
                  #expected, __FILE__, __LINE__);                        \
      ++g_failures;                                                      \
    }                                                                    \
  } while (0)

using dataeng::ArrayNode;
using dataeng::MakeLeaf;
using dataeng::MakeUnion;
using dataeng::RewriteSlice;
using dataeng::Slice;
using dataeng::SliceError;
using dataeng::SliceStrategy;
using dataeng::UnionMode;
using dataeng::ZeroCopySlice;

// Sparse union: every child covers all six parent rows.
void TestSparseZeroCopy() {
  const std::vector<std::int8_t> type_ids = {0, 1, 0, 1, 0, 1};
  const std::vector<std::int32_t> a = {1, 2, 3, 4, 5, 6};
  const std::vector<std::int64_t> b = {10, 20, 30, 40, 50, 60};

  ArrayNode root = MakeUnion(
      UnionMode::Sparse, 6, type_ids.data(), nullptr,
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 6),
                             MakeLeaf(b.data(), sizeof(std::int64_t), 6)});

  auto view = ZeroCopySlice(root, 2, 3);
  CHECK(view.status.ok());
  CHECK_EQ(view.array.length, 3);
  CHECK_EQ(view.array.offset, 2);
  CHECK_EQ(view.array.type_ids, type_ids.data());  // shared, zero copy
  CHECK_EQ(dataeng::ReferencedTypeCodes(view.array).size(), 2u);
  CHECK_EQ(dataeng::TypeIdAt(view.array, 0), 0);
  CHECK_EQ(dataeng::TypeIdAt(view.array, 1), 1);

  // Nested slicing is equivalent to a single slice.
  auto nested = ZeroCopySlice(view.array, 1, 2);
  auto single = ZeroCopySlice(root, 3, 2);
  CHECK(nested.status.ok());
  CHECK(single.status.ok());
  CHECK_EQ(nested.array.length, single.array.length);
  CHECK_EQ(nested.array.offset, single.array.offset);
  CHECK(dataeng::LogicalEquals(nested.array, single.array));
}

void TestSparseUnreferencedChildDropped() {
  const std::vector<std::int8_t> type_ids = {0, 0, 0, 0, 0, 0};
  const std::vector<std::int32_t> a = {1, 2, 3, 4, 5, 6};
  const std::vector<std::int64_t> b = {10, 20, 30, 40, 50, 60};

  ArrayNode root = MakeUnion(
      UnionMode::Sparse, 6, type_ids.data(), nullptr,
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 6),
                             MakeLeaf(b.data(), sizeof(std::int64_t), 6)});

  auto view = ZeroCopySlice(root, 1, 4);
  CHECK(view.status.ok());
  CHECK_EQ(view.array.children.size(), 1u);
  CHECK_EQ(view.array.type_codes.size(), 1u);
  CHECK_EQ(view.array.type_codes[0], 0);

  auto rewritten = RewriteSlice(root, 1, 4);
  CHECK(rewritten.status.ok());
  CHECK_EQ(rewritten.array.children.size(), 1u);
  CHECK_EQ(rewritten.array.offset, 0);
  CHECK(rewritten.array.owned_type_ids != nullptr);
  CHECK(rewritten.array.type_ids != type_ids.data());  // copied
}

void TestSparseRewrite() {
  const std::vector<std::int8_t> type_ids = {0, 1, 0, 1, 0, 1};
  const std::vector<std::int32_t> a = {1, 2, 3, 4, 5, 6};
  const std::vector<std::int64_t> b = {10, 20, 30, 40, 50, 60};

  ArrayNode root = MakeUnion(
      UnionMode::Sparse, 6, type_ids.data(), nullptr,
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 6),
                             MakeLeaf(b.data(), sizeof(std::int64_t), 6)});

  auto one = RewriteSlice(root, 1, 4);
  CHECK(one.status.ok());
  CHECK_EQ(one.array.offset, 0);
  CHECK_EQ(one.array.length, 4);
  for (std::int64_t row = 0; row < 4; ++row) {
    CHECK_EQ(one.array.type_ids[row], type_ids[1 + row]);
  }
  CHECK_EQ(one.array.children.size(), 2u);
  CHECK_EQ(one.array.children[0].length, 4);
  CHECK_EQ(one.array.children[0].offset, 1);

  auto nested = RewriteSlice(one.array, 1, 2);
  auto single = RewriteSlice(root, 2, 2);
  CHECK(nested.status.ok());
  CHECK(single.status.ok());
  CHECK(dataeng::LogicalEquals(nested.array, single.array));
  CHECK_EQ(nested.array.length, 2);
  CHECK_EQ(nested.array.type_ids[0], type_ids[2]);
}


void TestNestedUnionComposition() {
  // Outer dense union whose child 1 is itself a sparse union.
  const std::vector<std::int8_t> inner_ids = {5, 6, 5, 6};
  const std::vector<std::int32_t> inner_a = {1, 2, 3, 4};
  const std::vector<std::int64_t> inner_b = {9, 8, 7, 6};
  ArrayNode inner = MakeUnion(
      UnionMode::Sparse, 4, inner_ids.data(), nullptr,
      std::vector<std::int8_t>{5, 6},
      std::vector<ArrayNode>{
          MakeLeaf(inner_a.data(), sizeof(std::int32_t), 4),
          MakeLeaf(inner_b.data(), sizeof(std::int64_t), 4)});

  const std::vector<std::int8_t> outer_ids = {1, 1, 0, 1};
  const std::vector<std::int32_t> outer_offsets = {0, 1, 0, 2};
  const std::vector<std::int32_t> outer_leaf = {42, 43};
  ArrayNode outer = MakeUnion(
      UnionMode::Dense, 4, outer_ids.data(), outer_offsets.data(),
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{
          MakeLeaf(outer_leaf.data(), sizeof(std::int32_t), 2), inner});

  // Zero-copy composition: two slices equal one slice over the original.
  auto first = ZeroCopySlice(outer, 1, 3);
  CHECK(first.status.ok());
  CHECK_EQ(first.array.children.size(), 2u);  // both codes still referenced
  auto nested_zc = ZeroCopySlice(first.array, 1, 1);
  auto single_zc = ZeroCopySlice(outer, 2, 1);
  CHECK(nested_zc.status.ok());
  CHECK(single_zc.status.ok());
  CHECK_EQ(nested_zc.array.offset, single_zc.array.offset);
  CHECK(dataeng::LogicalEquals(nested_zc.array, single_zc.array));

  // Rewrite composition, including recursive child rewrite.
  auto rewritten = RewriteSlice(outer, 0, 4);
  CHECK(rewritten.status.ok());
  CHECK_EQ(rewritten.array.offset, 0);
  auto nested_rw = RewriteSlice(rewritten.array, 1, 2);
  auto single_rw = RewriteSlice(outer, 1, 2);
  CHECK(nested_rw.status.ok());
  CHECK(single_rw.status.ok());
  CHECK(dataeng::LogicalEquals(nested_rw.array, single_rw.array));

  // A slice referencing only type 0 must drop the nested union child entirely.
  const std::vector<std::int8_t> only_zero = {0, 0};
  const std::vector<std::int32_t> zero_offsets = {0, 1};
  ArrayNode filtered = MakeUnion(
      UnionMode::Dense, 2, only_zero.data(), zero_offsets.data(),
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{
          MakeLeaf(outer_leaf.data(), sizeof(std::int32_t), 2), inner});
  auto dropped = RewriteSlice(filtered, 0, 2);
  CHECK(dropped.status.ok());
  CHECK_EQ(dropped.array.children.size(), 1u);
  CHECK_EQ(dropped.array.type_codes[0], 0);
}

void TestLeafSliceAndEmptyWindow() {
  const std::vector<std::int32_t> values = {10, 20, 30, 40};
  ArrayNode leaf = MakeLeaf(values.data(), sizeof(std::int32_t), 4);

  auto view = ZeroCopySlice(leaf, 1, 2);
  CHECK(view.status.ok());
  CHECK_EQ(view.array.offset, 1);
  CHECK_EQ(view.array.length, 2);
  CHECK(dataeng::LogicalEquals(view.array, RewriteSlice(leaf, 1, 2).array));

  auto empty = RewriteSlice(leaf, 4, 0);
  CHECK(empty.status.ok());
  CHECK_EQ(empty.array.length, 0);
}


// Dense union with four rows; child 0 has 4 physical values, child 1 has 3.
ArrayNode MakeDenseRoot(const std::vector<std::int32_t>*& child_a,
                        const std::vector<std::int64_t>*& child_b) {
  static const std::vector<std::int8_t> type_ids = {1, 0, 1, 0};
  static const std::vector<std::int32_t> offsets = {0, 0, 1, 1};
  static const std::vector<std::int32_t> a = {7, 8, 9, 10};
  static const std::vector<std::int64_t> b = {100, 200, 300};
  child_a = &a;
  child_b = &b;
  return MakeUnion(
      UnionMode::Dense, 4, type_ids.data(), offsets.data(),
      std::vector<std::int8_t>{0, 1},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 4),
                             MakeLeaf(b.data(), sizeof(std::int64_t), 3)});
}

void TestDenseZeroCopy() {
  const std::vector<std::int32_t>* a = nullptr;
  const std::vector<std::int64_t>* b = nullptr;
  ArrayNode root = MakeDenseRoot(a, b);

  auto view = ZeroCopySlice(root, 1, 2);
  CHECK(view.status.ok());
  CHECK_EQ(view.array.length, 2);
  CHECK_EQ(view.array.offset, 1);
  CHECK_EQ(view.array.value_offsets, root.value_offsets);  // shared
  CHECK_EQ(dataeng::DenseOffsetAt(view.array, 0), 0);      // row 1
  CHECK_EQ(dataeng::DenseOffsetAt(view.array, 1), 1);      // row 2
  CHECK_EQ(view.array.children.size(), 2u);

  auto nested = ZeroCopySlice(view.array, 1, 1);
  auto single = ZeroCopySlice(root, 2, 1);
  CHECK(nested.status.ok());
  CHECK(single.status.ok());
  CHECK_EQ(nested.array.offset, single.array.offset);
  CHECK(dataeng::LogicalEquals(nested.array, single.array));
}

void TestDenseRewriteRebasesOffsets() {
  const std::vector<std::int32_t>* a = nullptr;
  const std::vector<std::int64_t>* b = nullptr;
  ArrayNode root = MakeDenseRoot(a, b);

  auto rewritten = RewriteSlice(root, 1, 3);  // rows: 0,1,0
  CHECK(rewritten.status.ok());
  CHECK_EQ(rewritten.array.offset, 0);
  CHECK_EQ(rewritten.array.length, 3);
  CHECK_EQ(rewritten.array.type_ids[0], 0);
  CHECK_EQ(rewritten.array.type_ids[1], 1);
  CHECK_EQ(rewritten.array.type_ids[2], 0);

  // Child 0 referenced absolute offsets {0, 1} -> compacted length 2, rebased.
  const ArrayNode& child0 = rewritten.array.children[0];
  const ArrayNode& child1 = rewritten.array.children[1];
  CHECK_EQ(child0.length, 2);
  CHECK_EQ(child1.length, 1);
  CHECK_EQ(rewritten.array.value_offsets[0], 0);
  CHECK_EQ(rewritten.array.value_offsets[1], 0);
  CHECK_EQ(rewritten.array.value_offsets[2], 1);
  CHECK(rewritten.array.owned_value_offsets != nullptr);
  CHECK(dataeng::LogicalEquals(rewritten.array,
                               ZeroCopySlice(root, 1, 3).array));

  // Nested rewrites equal one rewrite over the original.
  auto nested = RewriteSlice(rewritten.array, 1, 2);
  auto single = RewriteSlice(root, 2, 2);
  CHECK(nested.status.ok());
  CHECK(single.status.ok());
  CHECK(dataeng::LogicalEquals(nested.array, single.array));
  CHECK_EQ(nested.array.value_offsets[0], 0);
  CHECK_EQ(nested.array.value_offsets[1], 0);
}

void TestDenseOffsetOutOfBoundsFailsImmediately() {
  const std::vector<std::int8_t> type_ids = {0, 0};
  const std::vector<std::int32_t> bad_offsets = {0, 99};
  const std::vector<std::int32_t> a = {1, 2};
  ArrayNode root = MakeUnion(
      UnionMode::Dense, 2, type_ids.data(), bad_offsets.data(),
      std::vector<std::int8_t>{0},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 2)});

  // Zero-copy must still validate eagerly and fail, not silently alias.
  auto view = ZeroCopySlice(root, 0, 2);
  CHECK(!view.status.ok());
  CHECK_EQ(view.status.code, SliceError::DenseOffsetOutOfBounds);

  auto rewritten = RewriteSlice(root, 0, 2);
  CHECK(!rewritten.status.ok());
  CHECK_EQ(rewritten.status.code, SliceError::DenseOffsetOutOfBounds);

  // A sub-slice avoiding the bad row is valid; including it fails.
  auto safe = ZeroCopySlice(root, 0, 1);
  CHECK(safe.status.ok());
  auto hits_bad = ZeroCopySlice(root, 1, 1);
  CHECK(!hits_bad.status.ok());
  CHECK_EQ(hits_bad.status.code, SliceError::DenseOffsetOutOfBounds);

  const std::vector<std::int32_t> negative_offsets = {-1};
  ArrayNode neg_root = MakeUnion(
      UnionMode::Dense, 1, type_ids.data(), negative_offsets.data(),
      std::vector<std::int8_t>{0},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 2)});
  auto neg = ZeroCopySlice(neg_root, 0, 1);
  CHECK(!neg.status.ok());
  CHECK_EQ(neg.status.code, SliceError::DenseOffsetOutOfBounds);
}

void TestInvalidTypeIdAndParentBounds() {
  const std::vector<std::int8_t> type_ids = {0, 2};
  const std::vector<std::int32_t> offsets = {0, 0};
  const std::vector<std::int32_t> a = {1, 2};
  ArrayNode root = MakeUnion(
      UnionMode::Dense, 2, type_ids.data(), offsets.data(),
      std::vector<std::int8_t>{0},
      std::vector<ArrayNode>{MakeLeaf(a.data(), sizeof(std::int32_t), 2)});

  auto bad_type = ZeroCopySlice(root, 1, 1);
  CHECK(!bad_type.status.ok());
  CHECK_EQ(bad_type.status.code, SliceError::InvalidTypeId);

  auto parent_oob = ZeroCopySlice(root, 1, 5);
  CHECK(!parent_oob.status.ok());
  CHECK_EQ(parent_oob.status.code, SliceError::ParentOutOfBounds);

  auto negative =
      Slice(root, -1, 1, SliceStrategy::ZeroCopy);
  CHECK(!negative.status.ok());
  CHECK_EQ(negative.status.code, SliceError::ParentOutOfBounds);

  auto empty_tail = ZeroCopySlice(root, 2, 0);
  CHECK(empty_tail.status.ok());
  CHECK_EQ(empty_tail.array.length, 0);
  CHECK_EQ(empty_tail.array.children.size(), 0u);
}

}  // namespace

int main() {
  TestSparseZeroCopy();
  TestSparseUnreferencedChildDropped();
  TestSparseRewrite();
  TestDenseZeroCopy();
  TestDenseRewriteRebasesOffsets();
  TestDenseOffsetOutOfBoundsFailsImmediately();
  TestInvalidTypeIdAndParentBounds();
  TestNestedUnionComposition();
  TestLeafSliceAndEmptyWindow();

  if (g_failures == 0) {
    std::printf("all dataeng union slice tests passed\n");
    return 0;
  }
  std::printf("%d check(s) failed\n", g_failures);
  return 1;
}
