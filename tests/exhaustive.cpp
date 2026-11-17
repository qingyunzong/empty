#include "dlks_formal.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <string>
#include <unordered_set>
#include <utility>

namespace {

#ifndef DLKS_EXH_LBAS
#define DLKS_EXH_LBAS 2
#endif
#ifndef DLKS_EXH_SNAPSHOTS
#define DLKS_EXH_SNAPSHOTS 3
#endif
#ifndef DLKS_EXH_BLOCKS
#define DLKS_EXH_BLOCKS 4
#endif

constexpr std::size_t kLbas = DLKS_EXH_LBAS;
constexpr std::size_t kSnapshots = DLKS_EXH_SNAPSHOTS;
constexpr std::size_t kBlocks = DLKS_EXH_BLOCKS;
constexpr std::size_t kStateLimit = 100000;

using Store =
    dlks::cow_mapping<std::uint32_t, kLbas, kSnapshots, kBlocks>;

[[noreturn]] void fail(const char* what, const char* where, int line) {
  std::fprintf(stderr, "exhaustive CHECK failed at %s:%d (%s): %s\n", where,
               line, where, what);
  std::abort();
}

#define CHECK(cond) \
  do {              \
    if (!(cond)) fail(#cond, __FILE__, __LINE__); \
  } while (false)

struct Model {
  struct Snapshot {
    bool alive = false;
    std::uint32_t parent = Store::no_snapshot;
    std::array<std::uint32_t, kLbas> value{};
  };

  std::array<Snapshot, kSnapshots> snapshots{};

  Model() {
    snapshots[0].alive = true;
    snapshots[0].parent = Store::no_snapshot;
  }

  std::uint32_t create(std::uint32_t parent) {
    for (std::size_t i = 0; i < kSnapshots; ++i) {
      if (snapshots[i].alive) continue;
      snapshots[i].alive = true;
      snapshots[i].parent = parent;
      snapshots[i].value = snapshots[parent].value;
      return static_cast<std::uint32_t>(i);
    }
    return Store::no_snapshot;
  }

  bool write(std::uint32_t snap, std::uint32_t lba, std::uint32_t value) {
    if (snap >= kSnapshots || !snapshots[snap].alive || lba >= kLbas)
      return false;
    snapshots[snap].value[lba] = value;
    return true;
  }

  bool discard(std::uint32_t snap, std::uint32_t lba) {
    return write(snap, lba, 0);
  }

  bool remove(std::uint32_t snap) {
    if (snap >= kSnapshots || !snapshots[snap].alive || snap == 0) return false;
    const std::uint32_t new_parent = snapshots[snap].parent;
    snapshots[snap].alive = false;
    snapshots[snap].parent = Store::no_snapshot;
    snapshots[snap].value = {};
    for (auto& candidate : snapshots) {
      if (candidate.alive && candidate.parent == snap)
        candidate.parent = new_parent;
    }
    return true;
  }
};

struct Node {
  Store store;
  Model model;
};

void verify(const Store& store, const Model& model, const char* where) {
  std::string error;
  if (!store.check_invariants(&error)) {
    std::fprintf(stderr, "invariant failure at %s: %s\n", where,
                 error.c_str());
    std::abort();
  }
  for (std::size_t s = 0; s < kSnapshots; ++s) {
    if (store.is_alive(static_cast<std::uint32_t>(s)) !=
        model.snapshots[s].alive) {
      std::fprintf(stderr, "alive mismatch at %s: snapshot %zu\n", where, s);
      std::abort();
    }
    if (!model.snapshots[s].alive) {
      std::uint32_t value = 0;
      CHECK(!store.read(static_cast<std::uint32_t>(s), 0, value));
      continue;
    }
    if (store.parent(static_cast<std::uint32_t>(s)) !=
        model.snapshots[s].parent) {
      std::fprintf(stderr, "parent mismatch at %s: snapshot %zu got %u want %u\n",
                   where, s, store.parent(static_cast<std::uint32_t>(s)),
                   model.snapshots[s].parent);
      std::abort();
    }
    for (std::size_t lba = 0; lba < kLbas; ++lba) {
      std::uint32_t value = 0;
      CHECK(store.read(static_cast<std::uint32_t>(s),
                       static_cast<std::uint32_t>(lba), value));
      if (value != model.snapshots[s].value[lba]) {
        std::fprintf(stderr,
                     "value mismatch at %s: snap %zu lba %zu got %u want %u\n",
                     where, s, lba, value, model.snapshots[s].value[lba]);
        std::abort();
      }
    }
  }
}

void put_u32(std::string& key, std::uint32_t value) {
  for (int i = 0; i < 4; ++i)
    key.push_back(static_cast<char>((value >> (8 * i)) & 0xff));
}

// Physical block numbering is an implementation detail.  Canonicalize blocks
// by first appearance so isomorphic states with different allocator histories
// share one visited key.
std::string canonical_key(const Store& store) {
  std::array<int, kBlocks> canonical;
  canonical.fill(-1);
  std::array<Store::block_id, kBlocks> raw{};
  raw.fill(Store::no_block);
  int next_block = 0;

  std::string key;
  key.reserve(256);
  for (std::size_t s = 0; s < kSnapshots; ++s) {
    const auto snap = static_cast<std::uint32_t>(s);
    const bool alive = store.is_alive(snap);
    put_u32(key, alive ? 1 : 0);
    put_u32(key, alive ? store.parent(snap) : 0xffffffffu);
    if (!alive) continue;
    for (std::size_t lba = 0; lba < kLbas; ++lba) {
      Store::slot_view view;
      CHECK(store.inspect_slot(snap, static_cast<std::uint32_t>(lba), view));
      put_u32(key, static_cast<std::uint32_t>(view.kind));
      if (view.kind != Store::slot_kind::block) {
        put_u32(key, 0xffffffffu);
        continue;
      }
      CHECK(view.block < kBlocks);
      int id = canonical[view.block];
      if (id < 0) {
        id = next_block++;
        canonical[view.block] = id;
        raw[static_cast<std::size_t>(id)] = view.block;
      }
      put_u32(key, static_cast<std::uint32_t>(id));
    }
  }
  for (int i = 0; i < next_block; ++i) {
    const auto index = static_cast<std::size_t>(i);
    put_u32(key, store.block_value(raw[index]));
    put_u32(key, store.refcount(raw[index]));
  }
  return key;
}

void check_write_abort(const Node& base, std::uint32_t snap, std::uint32_t lba,
                       std::uint32_t value) {
  Node node = base;
  const auto generation = node.store.generation();
  auto txn = node.store.begin_write(snap, lba);
  if (!txn) {
    CHECK(node.store.generation() == generation);
    CHECK(!node.store.journal_pending());
    verify(node.store, base.model, "write-abort-no-capacity");
    return;
  }
  CHECK(txn.old_value() == base.model.snapshots[snap].value[lba]);
  CHECK(txn.stage(value));
  CHECK(node.store.generation() == generation);
  CHECK(!node.store.journal_pending());
  verify(node.store, base.model, "write-staged");
  txn.abort();
  CHECK(node.store.generation() == generation);
  CHECK(!node.store.journal_pending());
  verify(node.store, base.model, "write-aborted");
}

void check_write_crash_before_prepare(const Node& base, std::uint32_t snap,
                                      std::uint32_t lba, std::uint32_t value) {
  Node node = base;
  auto txn = node.store.begin_write(snap, lba);
  if (!txn) return;
  CHECK(txn.stage(value));
  txn.crash();
  CHECK(!node.store.journal_pending());
  verify(node.store, base.model, "write-crash-before-prepare");
}

bool check_write_recover(const Node& base, std::uint32_t snap,
                         std::uint32_t lba, std::uint32_t value) {
  Node node = base;
  auto txn = node.store.begin_write(snap, lba);
  if (!txn) return false;
  CHECK(txn.stage(value));
  CHECK(txn.prepare());
  CHECK(node.store.journal_pending());

  // A prepared record is durable but not visible yet: readers still see the
  // complete old mapping, never a half-written one.
  verify(node.store, base.model, "write-prepared-before-recover");
  txn.crash();
  CHECK(node.store.journal_pending());
  verify(node.store, base.model, "write-crashed-before-recover");

  CHECK(node.store.recover());
  Model expected = base.model;
  CHECK(expected.write(snap, lba, value));
  CHECK(!node.store.journal_pending());
  verify(node.store, expected, "write-recovered");
  return true;
}

void check_discard_abort(const Node& base, std::uint32_t snap,
                         std::uint32_t lba) {
  Node node = base;
  auto txn = node.store.begin_discard(snap, lba);
  CHECK(txn);
  txn.abort();
  verify(node.store, base.model, "discard-aborted");
}

bool check_discard_recover(const Node& base, std::uint32_t snap,
                           std::uint32_t lba) {
  Node node = base;
  auto txn = node.store.begin_discard(snap, lba);
  CHECK(txn);
  CHECK(txn.prepare());
  CHECK(node.store.journal_pending());
  verify(node.store, base.model, "discard-prepared");
  txn.crash();
  CHECK(node.store.recover());
  Model expected = base.model;
  CHECK(expected.discard(snap, lba));
  verify(node.store, expected, "discard-recovered");
  return true;
}

void check_remove_abort(const Node& base, std::uint32_t snap) {
  Node node = base;
  auto txn = node.store.begin_delete(snap);
  CHECK(txn);
  txn.abort();
  verify(node.store, base.model, "remove-aborted");
}

bool check_remove_recover(const Node& base, std::uint32_t snap) {
  Node node = base;
  auto txn = node.store.begin_delete(snap);
  CHECK(txn);
  CHECK(txn.prepare());
  CHECK(node.store.journal_pending());
  verify(node.store, base.model, "remove-prepared");
  txn.crash();
  CHECK(node.store.recover());
  Model expected = base.model;
  CHECK(expected.remove(snap));
  verify(node.store, expected, "remove-recovered");
  return true;
}

}  // namespace

int main() {
  std::deque<Node> queue;
  std::unordered_set<std::string> seen;

  Node initial;
  seen.insert(canonical_key(initial.store));
  queue.push_back(std::move(initial));

  std::size_t expanded = 0;
  std::size_t committed_writes = 0;
  std::size_t committed_discards = 0;
  std::size_t committed_removes = 0;
  std::size_t crash_recoveries = 0;
  std::size_t two_child_shared_transfers = 0;
  constexpr std::uint32_t kValues[] = {1, 2};

  while (!queue.empty()) {
    Node current = std::move(queue.front());
    queue.pop_front();
    ++expanded;
    verify(current.store, current.model, "expanded-node");

    for (std::size_t s = 0; s < kSnapshots; ++s) {
      const auto snap = static_cast<std::uint32_t>(s);
      if (!current.store.is_alive(snap)) continue;

      for (std::size_t l = 0; l < kLbas; ++l) {
        const auto lba = static_cast<std::uint32_t>(l);
        for (std::uint32_t value : kValues) {
          check_write_abort(current, snap, lba, value);
          check_write_crash_before_prepare(current, snap, lba, value);
          if (check_write_recover(current, snap, lba, value))
            ++crash_recoveries;

          Node next = current;
          if (next.store.write(snap, lba, value)) {
            ++committed_writes;
            CHECK(next.model.write(snap, lba, value));
            verify(next.store, next.model, "write-committed");
            auto key = canonical_key(next.store);
            if (seen.insert(std::move(key)).second)
              queue.push_back(std::move(next));
          } else {
            verify(next.store, current.model, "write-refused");
          }
        }

        check_discard_abort(current, snap, lba);
        if (check_discard_recover(current, snap, lba)) ++crash_recoveries;
        Node next = current;
        if (next.store.discard(snap, lba)) {
          ++committed_discards;
          CHECK(next.model.discard(snap, lba));
          verify(next.store, next.model, "discard-committed");
          auto key = canonical_key(next.store);
          if (seen.insert(std::move(key)).second)
            queue.push_back(std::move(next));
        } else {
          verify(next.store, current.model, "discard-refused");
        }
      }
    }

    for (std::size_t s = 0; s < kSnapshots; ++s) {
      const auto snap = static_cast<std::uint32_t>(s);
      if (!current.store.is_alive(snap)) continue;
      Node next = current;
      const auto created = next.store.create_snapshot(snap);
      if (created == Store::no_snapshot) {
        verify(next.store, current.model, "create-refused");
        continue;
      }
      const auto modeled = next.model.create(snap);
      CHECK(modeled == created);
      verify(next.store, next.model, "create-committed");
      auto key = canonical_key(next.store);
      if (seen.insert(std::move(key)).second) queue.push_back(std::move(next));
    }

    for (std::size_t s = 0; s < kSnapshots; ++s) {
      const auto snap = static_cast<std::uint32_t>(s);
      if (!current.store.is_alive(snap) || snap == current.store.root())
        continue;
      check_remove_abort(current, snap);
      if (check_remove_recover(current, snap)) ++crash_recoveries;

      // Record that the exhaustive run really exercised a parent with two
      // children sharing a local block, i.e. the transfer case required by the
      // snapshot-deletion contract.
      std::size_t child_count = 0;
      bool shared_block = false;
      for (std::size_t c = 0; c < kSnapshots; ++c) {
        const auto child = static_cast<std::uint32_t>(c);
        if (!current.store.is_alive(child) || child == snap) continue;
        if (current.store.parent(child) != snap) continue;
        ++child_count;
        for (std::size_t l = 0; l < kLbas; ++l) {
          Store::slot_view child_slot;
          CHECK(current.store.inspect_slot(
              child, static_cast<std::uint32_t>(l), child_slot));
          if (child_slot.kind != Store::slot_kind::inherit) continue;
          Store::slot_view dead_slot;
          CHECK(current.store.inspect_slot(
              snap, static_cast<std::uint32_t>(l), dead_slot));
          if (dead_slot.kind == Store::slot_kind::block) shared_block = true;
        }
      }
      if (child_count >= 2 && shared_block) ++two_child_shared_transfers;

      Node next = current;
      CHECK(next.store.delete_snapshot(snap));
      ++committed_removes;
      CHECK(next.model.remove(snap));
      verify(next.store, next.model, "remove-committed");
      auto key = canonical_key(next.store);
      if (seen.insert(std::move(key)).second) queue.push_back(std::move(next));
    }

    if (expanded % 20000 == 0)
      std::fprintf(stderr, "exhaustive: expanded=%zu discovered=%zu\n",
                   expanded, seen.size());
    if (seen.size() > kStateLimit) {
      std::fprintf(stderr, "exhaustive: state limit exceeded (%zu)\n",
                   seen.size());
      return 2;
    }
  }

  std::printf(
      "dlks_formal_exhaustive: explored %zu reachable states (%zu "
      "expansions), writes=%zu discards=%zu removes=%zu recoveries=%zu\n",
      seen.size(), expanded, committed_writes, committed_discards,
      committed_removes, crash_recoveries);
  CHECK(committed_writes > 0);
  CHECK(committed_discards > 0);
  CHECK(committed_removes > 0);
  CHECK(crash_recoveries > 0);
  if (kSnapshots >= 4) CHECK(two_child_shared_transfers > 0);
  return 0;
}
