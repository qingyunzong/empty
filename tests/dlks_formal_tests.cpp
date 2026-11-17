#include "dlks_formal.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,        \
                   __LINE__, #cond);                                       \
      std::abort();                                                        \
    }                                                                      \
  } while (false)

template <typename Store>
void check_ok(const Store& store) {
  std::string error;
  if (!store.check_invariants(&error)) {
    std::fprintf(stderr, "invariant failed: %s\n", error.c_str());
    std::abort();
  }
}

using Store = dlks::cow_mapping<std::uint32_t, 4, 6, 12>;

void test_basic_read_write() {
  Store store;
  const auto root = store.root();
  CHECK(root != Store::no_snapshot);
  CHECK(store.live_snapshots() == 1);
  CHECK(store.read(root, 0) == 0);

  CHECK(store.write(root, 0, 101));
  CHECK(store.read(root, 0) == 101);
  CHECK(store.write(root, 3, 303));
  CHECK(store.read(root, 3) == 303);
  CHECK(store.allocated_blocks() == 2);

  Store::block_id block = Store::no_block;
  CHECK(store.resolve_block(root, 0, block));
  CHECK(store.block_allocated(block));
  CHECK(store.block_value(block) == 101);
  CHECK(store.refcount(block) == 1);
  check_ok(store);

  CHECK(!store.write(root, 4, 1));
  CHECK(!store.write(99, 0, 1));
  std::uint32_t ignored = 0;
  CHECK(!store.read(99, 0, ignored));
  check_ok(store);
}

void test_snapshot_isolation_and_lazy_pushdown() {
  Store store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 1));

  Store::block_id root_block = Store::no_block;
  CHECK(store.resolve_block(root, 0, root_block));
  CHECK(store.refcount(root_block) == 1);

  const auto child = store.create_snapshot(root);
  CHECK(child != Store::no_snapshot);
  CHECK(store.read(child, 0) == 1);
  // Inheritance is lazy: the child has no local reference yet.
  CHECK(store.refcount(root_block) == 1);

  // Rewriting the parent freezes the old mapping into the inheriting child.
  CHECK(store.write(root, 0, 2));
  CHECK(store.read(root, 0) == 2);
  CHECK(store.read(child, 0) == 1);
  CHECK(store.refcount(root_block) == 1);
  Store::block_id root_block2 = Store::no_block;
  CHECK(store.resolve_block(root, 0, root_block2));
  CHECK(root_block2 != root_block);
  CHECK(store.refcount(root_block2) == 1);
  check_ok(store);

  const auto grandchild = store.create_snapshot(child);
  CHECK(grandchild != Store::no_snapshot);
  CHECK(store.read(grandchild, 0) == 1);

  // The parent has no local child slot to update, so the grandchild keeps the
  // value it sees through the child.
  CHECK(store.write(root, 0, 3));
  CHECK(store.read(child, 0) == 1);
  CHECK(store.read(grandchild, 0) == 1);

  // Changing the middle snapshot freezes its value into the grandchild.
  CHECK(store.write(child, 0, 4));
  CHECK(store.read(root, 0) == 3);
  CHECK(store.read(child, 0) == 4);
  CHECK(store.read(grandchild, 0) == 1);
  CHECK(store.refcount(root_block) == 1);
  check_ok(store);

  CHECK(store.write(grandchild, 0, 5));
  CHECK(store.read(root, 0) == 3);
  CHECK(store.read(child, 0) == 4);
  CHECK(store.read(grandchild, 0) == 5);
  check_ok(store);
}

void test_discard_shadowing_and_isolation() {
  Store store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 7));
  Store::block_id old_block = Store::no_block;
  CHECK(store.resolve_block(root, 0, old_block));

  const auto child = store.create_snapshot(root);
  CHECK(store.discard(root, 0));
  CHECK(store.read(root, 0) == 0);
  CHECK(store.read(child, 0) == 7);
  CHECK(store.refcount(old_block) == 1);
  check_ok(store);

  CHECK(store.discard(child, 0));
  CHECK(store.read(child, 0) == 0);
  CHECK(store.refcount(old_block) == 0);
  CHECK(!store.block_allocated(old_block));
  check_ok(store);

  // A child can shadow an inherited mapping before the parent changes.
  Store store2;
  const auto root2 = store2.root();
  const auto child2 = store2.create_snapshot(root2);
  CHECK(store2.discard(child2, 1));
  CHECK(store2.write(root2, 1, 9));
  CHECK(store2.read(root2, 1) == 9);
  CHECK(store2.read(child2, 1) == 0);
  check_ok(store2);
}

void test_delete_parent_transfers_shared_blocks() {
  Store store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 1));
  CHECK(store.write(root, 1, 2));

  const auto parent = store.create_snapshot(root);
  CHECK(store.write(parent, 0, 10));
  Store::block_id parent_block = Store::no_block;
  CHECK(store.resolve_block(parent, 0, parent_block));
  Store::block_id root_block1 = Store::no_block;
  CHECK(store.resolve_block(root, 1, root_block1));

  const auto left = store.create_snapshot(parent);
  const auto right = store.create_snapshot(parent);
  CHECK(store.write(left, 1, 20));
  CHECK(store.refcount(parent_block) == 1);

  CHECK(store.delete_snapshot(parent));
  CHECK(!store.is_alive(parent));
  CHECK(store.parent(left) == root);
  CHECK(store.parent(right) == root);
  CHECK(store.read(left, 0) == 10);
  CHECK(store.read(left, 1) == 20);
  CHECK(store.read(right, 0) == 10);
  CHECK(store.read(right, 1) == 2);
  CHECK(store.read(root, 0) == 1);
  CHECK(store.read(root, 1) == 2);
  CHECK(store.refcount(parent_block) == 2);
  CHECK(store.refcount(root_block1) == 1);
  check_ok(store);

  CHECK(store.delete_snapshot(left));
  CHECK(store.read(right, 0) == 10);
  CHECK(store.read(right, 1) == 2);
  CHECK(store.refcount(parent_block) == 1);
  check_ok(store);

  CHECK(store.delete_snapshot(right));
  CHECK(store.refcount(parent_block) == 0);
  CHECK(!store.block_allocated(parent_block));
  CHECK(store.read(root, 0) == 1);
  CHECK(store.read(root, 1) == 2);
  check_ok(store);

  CHECK(!store.delete_snapshot(root));
  CHECK(!store.delete_snapshot(parent));
}

void test_crash_before_and_after_prepare() {
  Store store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 7));
  const auto child = store.create_snapshot(root);
  const auto generation = store.generation();

  Store::block_id old_block = Store::no_block;
  CHECK(store.resolve_block(child, 0, old_block));
  CHECK(store.refcount(old_block) == 1);

  {
    auto txn = store.begin_write(child, 0);
    CHECK(txn);
    CHECK(txn.old_value() == 7);
    CHECK(txn.new_block() != Store::no_block);
    CHECK(!store.block_allocated(txn.new_block()));
    CHECK(txn.stage(11));
    CHECK(txn.staged_value() == 11);

    // Allocation and staging are not visible in the live mapping.
    CHECK(store.read(child, 0) == 7);
    CHECK(store.generation() == generation);
    CHECK(!store.journal_pending());
    txn.abort();
  }
  CHECK(store.read(child, 0) == 7);
  CHECK(store.refcount(old_block) == 1);
  CHECK(store.generation() == generation);
  CHECK(!store.journal_pending());
  check_ok(store);

  {
    auto txn = store.begin_write(child, 0);
    CHECK(txn);
    CHECK(txn.stage(12));
    CHECK(txn.prepare());
    CHECK(store.journal_pending());
    CHECK(store.read(child, 0) == 7);
    CHECK(store.refcount(old_block) == 1);
    check_ok(store);

    txn.crash();
    CHECK(store.journal_pending());
    CHECK(store.read(child, 0) == 7);
  }
  CHECK(store.recover());
  CHECK(!store.journal_pending());
  CHECK(store.read(child, 0) == 12);
  CHECK(store.read(root, 0) == 7);
  CHECK(store.refcount(old_block) == 1);
  Store::block_id new_block = Store::no_block;
  CHECK(store.resolve_block(child, 0, new_block));
  CHECK(new_block != old_block);
  CHECK(store.refcount(new_block) == 1);
  check_ok(store);

  // commit() is prepare + atomic publish.
  CHECK(store.write(child, 0, 13));
  CHECK(store.read(child, 0) == 13);
  CHECK(!store.journal_pending());
  check_ok(store);
}

void test_crash_for_discard_and_delete() {
  Store store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 5));
  const auto parent = store.create_snapshot(root);
  CHECK(store.write(parent, 1, 6));
  const auto child = store.create_snapshot(parent);

  {
    auto txn = store.begin_discard(parent, 0);
    CHECK(txn);
    CHECK(txn.prepare());
    CHECK(store.read(parent, 0) == 5);
    txn.crash();
    CHECK(store.journal_pending());
    CHECK(store.read(parent, 0) == 5);
  }
  CHECK(store.recover());
  CHECK(store.read(parent, 0) == 0);
  CHECK(store.read(child, 0) == 5);
  check_ok(store);

  {
    auto txn = store.begin_delete(parent);
    CHECK(txn);
    CHECK(txn.prepare());
    CHECK(store.is_alive(parent));
    CHECK(store.read(child, 1) == 6);
    txn.crash();
    CHECK(store.journal_pending());
    CHECK(store.is_alive(parent));
  }
  CHECK(store.recover());
  CHECK(!store.is_alive(parent));
  CHECK(store.parent(child) == root);
  CHECK(store.read(child, 0) == 5);
  CHECK(store.read(child, 1) == 6);
  check_ok(store);
}

void test_capacity_and_stale_transactions() {
  using Tiny = dlks::cow_mapping<std::uint32_t, 2, 2, 2>;
  Tiny store;
  const auto root = store.root();
  CHECK(store.write(root, 0, 1));
  const auto child = store.create_snapshot(root);
  CHECK(child != Tiny::no_snapshot);
  CHECK(store.create_snapshot(root) == Tiny::no_snapshot);

  CHECK(store.write(root, 1, 2));
  CHECK(!store.write(root, 1, 3));
  CHECK(store.read(root, 1) == 2);
  check_ok(store);

  auto missing = store.begin_write(root, 1);
  CHECK(!missing);
  CHECK(!store.journal_pending());

  CHECK(store.discard(root, 1));
  CHECK(store.write(root, 1, 4));
  CHECK(store.read(root, 1) == 4);
  check_ok(store);

  Store fresh;
  const auto fresh_root = fresh.root();
  CHECK(fresh.write(fresh_root, 0, 1));
  auto first = fresh.begin_write(fresh_root, 0);
  CHECK(first);
  CHECK(first.stage(10));
  auto stale = fresh.begin_write(fresh_root, 0);
  CHECK(stale);
  CHECK(stale.stage(11));
  CHECK(first.commit());
  CHECK(fresh.read(fresh_root, 0) == 10);
  CHECK(!stale.commit());
  CHECK(fresh.read(fresh_root, 0) == 10);
  check_ok(fresh);
}

}  // namespace

int main() {
  test_basic_read_write();
  test_snapshot_isolation_and_lazy_pushdown();
  test_discard_shadowing_and_isolation();
  test_delete_parent_transfers_shared_blocks();
  test_crash_before_and_after_prepare();
  test_crash_for_discard_and_delete();
  test_capacity_and_stale_transactions();
  std::puts("dlks_formal_tests: all targeted checks passed");
  return 0;
}
