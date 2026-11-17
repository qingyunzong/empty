#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>

namespace dlks {

// A fixed-capacity, embeddable copy-on-write block mapping.
//
// Snapshots form a tree.  Every snapshot owns a sparse local mapping over the
// same logical block address (LBA) space.  A local mapping is either a physical
// block, an explicit zero ("discard") marker, or "inherit" (look in the parent).
//
// Snapshot isolation is maintained lazily:
//   * creating a snapshot costs O(1) metadata and shares all blocks,
//   * before a snapshot changes one of its slots, the old effective mapping is
//     first pushed into every direct child that still inherits that slot,
//   * deleting a snapshot transfers its local mappings to inheriting children
//     before releasing the deleted snapshot's references.
//
// Writes are two-phase.  A new physical block is reserved and fully staged
// before a compact redo record is prepared.  Only commit/recovery publishes the
// mapping with a single state swap.  A crash before prepare leaves the old
// state untouched; a crash after prepare is replayed by recover().  There is no
// observable state in which an LBA points at a partially initialized block.
//
// The component uses only fixed-size arrays: no heap allocation and no
// dependencies beyond the C++20 standard library.
template <typename Word = std::uint32_t,
          std::size_t LbaCount = 16,
          std::size_t SnapshotCapacity = 8,
          std::size_t BlockCapacity = 64>
class cow_mapping {
  static_assert(LbaCount > 0, "at least one LBA is required");
  static_assert(SnapshotCapacity > 0, "at least one snapshot slot is required");
  static_assert(BlockCapacity > 0, "at least one block is required");

public:
  using word_type = Word;
  using lba_type = std::uint32_t;
  using snapshot_id = std::uint32_t;
  using block_id = std::uint32_t;

  static_assert(LbaCount <= std::numeric_limits<lba_type>::max(),
                "LBA capacity does not fit lba_type");
  static_assert(SnapshotCapacity <= std::numeric_limits<snapshot_id>::max(),
                "snapshot capacity does not fit snapshot_id");
  static_assert(BlockCapacity <= std::numeric_limits<block_id>::max(),
                "block capacity does not fit block_id");

  static constexpr lba_type lba_capacity = static_cast<lba_type>(LbaCount);
  static constexpr snapshot_id no_snapshot =
      std::numeric_limits<snapshot_id>::max();
  static constexpr block_id no_block = std::numeric_limits<block_id>::max();

  enum class slot_kind : std::uint8_t { inherit, block, zero };

  struct slot_view {
    slot_kind kind = slot_kind::inherit;
    block_id block = no_block;
  };

private:
  struct slot {
    slot_kind kind = slot_kind::inherit;
    block_id block = no_block;
  };

  struct snapshot_record {
    bool alive = false;
    snapshot_id parent = no_snapshot;
    std::array<slot, LbaCount> slots{};
  };

  struct state {
    std::array<snapshot_record, SnapshotCapacity> snapshots{};
    std::array<word_type, BlockCapacity> data{};
    std::array<std::uint32_t, BlockCapacity> refs{};
    std::array<bool, BlockCapacity> allocated{};
    snapshot_id root = no_snapshot;
    std::uint64_t generation = 0;
  };

  enum class record_kind : std::uint8_t { none, write, discard, remove };

  struct commit_record {
    bool valid = false;
    record_kind kind = record_kind::none;
    snapshot_id snap = no_snapshot;
    lba_type lba = 0;
    block_id new_block = no_block;
    word_type value{};
    std::uint64_t token = 0;
    std::uint64_t base_generation = 0;
  };

public:
  class transaction {
  public:
    transaction() = default;
    transaction(const transaction&) = delete;
    transaction& operator=(const transaction&) = delete;
    transaction(transaction&& other) noexcept { move_from(other); }
    transaction& operator=(transaction&& other) noexcept {
      if (this != &other) {
        abandon_unprepared();
        move_from(other);
      }
      return *this;
    }

    // Destruction models process death.  An unprepared transaction vanishes;
    // a prepared redo record remains available to cow_mapping::recover().
    ~transaction() { abandon_unprepared(); }

    explicit operator bool() const noexcept { return owner_ != nullptr; }
    bool valid() const noexcept { return owner_ != nullptr; }

    // Stage the complete new word for a write transaction.  begin_write()
    // already copies the old word into the staged block, so a transaction is a
    // true allocate-then-modify COW operation even if stage() is never called.
    bool stage(word_type value) noexcept {
      if (!valid() || kind_ != record_kind::write) return false;
      value_ = value;
      return true;
    }

    // Durably record the intent to publish.  After a successful prepare a
    // simulated crash must be followed by cow_mapping::recover().
    bool prepare() {
      if (!valid() || prepared_) return prepared_;
      return owner_->prepare_transaction(*this);
    }

    // Atomically publish the staged change.  commit() implies prepare().
    bool commit() {
      if (!valid()) return false;
      if (!prepared_ && !prepare()) return false;
      return owner_->commit_transaction(*this);
    }

    // Roll back a transaction that has not been prepared.  A prepared
    // transaction is already durable and is left for recover().
    void abort() noexcept {
      owner_ = nullptr;
      prepared_ = false;
    }

    // Model process death.  Unprepared staging is discarded; a prepared redo
    // record stays in the journal for cow_mapping::recover().
    void crash() noexcept {
      owner_ = nullptr;
      prepared_ = false;
    }

    block_id new_block() const noexcept { return new_block_; }
    word_type staged_value() const noexcept { return value_; }
    word_type old_value() const noexcept { return old_value_; }
    snapshot_id snapshot() const noexcept { return snap_; }
    lba_type lba() const noexcept { return lba_; }
    bool prepared() const noexcept { return prepared_; }

  private:
    friend class cow_mapping;

    void move_from(transaction& other) noexcept {
      owner_ = other.owner_;
      kind_ = other.kind_;
      snap_ = other.snap_;
      lba_ = other.lba_;
      new_block_ = other.new_block_;
      value_ = other.value_;
      old_value_ = other.old_value_;
      token_ = other.token_;
      base_generation_ = other.base_generation_;
      prepared_ = other.prepared_;
      other.owner_ = nullptr;
      other.prepared_ = false;
    }

    void abandon_unprepared() noexcept {
      if (valid() && !prepared_) owner_ = nullptr;
    }

    cow_mapping* owner_ = nullptr;
    record_kind kind_ = record_kind::none;
    snapshot_id snap_ = no_snapshot;
    lba_type lba_ = 0;
    block_id new_block_ = no_block;
    word_type value_{};
    word_type old_value_{};
    std::uint64_t token_ = 0;
    std::uint64_t base_generation_ = 0;
    bool prepared_ = false;
  };

  cow_mapping() {
    state_.snapshots[0].alive = true;
    state_.snapshots[0].parent = no_snapshot;
    state_.root = 0;
  }

  cow_mapping(const cow_mapping&) = default;
  cow_mapping& operator=(const cow_mapping&) = default;
  cow_mapping(cow_mapping&&) = default;
  cow_mapping& operator=(cow_mapping&&) = default;

  snapshot_id root() const noexcept { return state_.root; }

  bool is_alive(snapshot_id snap) const noexcept {
    return snap < SnapshotCapacity && state_.snapshots[snap].alive;
  }

  snapshot_id parent(snapshot_id snap) const noexcept {
    if (!is_alive(snap)) return no_snapshot;
    return state_.snapshots[snap].parent;
  }

  std::size_t live_snapshots() const noexcept {
    std::size_t count = 0;
    for (const auto& snap : state_.snapshots)
      if (snap.alive) ++count;
    return count;
  }

  bool read(snapshot_id snap, lba_type lba, word_type& out) const noexcept {
    if (!is_alive(snap) || lba >= LbaCount) return false;
    slot effective;
    if (!effective_slot(state_, snap, lba, effective)) return false;
    if (effective.kind == slot_kind::block) {
      out = state_.data[effective.block];
      return true;
    }
    out = word_type{};
    return true;
  }

  word_type read(snapshot_id snap, lba_type lba) const noexcept {
    word_type value{};
    (void)read(snap, lba, value);
    return value;
  }

  bool inspect_slot(snapshot_id snap, lba_type lba, slot_view& out) const
      noexcept {
    if (!is_alive(snap) || lba >= LbaCount) return false;
    const slot& local = state_.snapshots[snap].slots[lba];
    out.kind = local.kind;
    out.block = local.block;
    return true;
  }

  bool resolve_block(snapshot_id snap, lba_type lba, block_id& out) const
      noexcept {
    if (!is_alive(snap) || lba >= LbaCount) return false;
    slot effective;
    if (!effective_slot(state_, snap, lba, effective)) return false;
    if (effective.kind != slot_kind::block) return false;
    out = effective.block;
    return true;
  }

  snapshot_id create_snapshot(snapshot_id parent_snap) {
    if (journal_.valid) return no_snapshot;
    if (!is_alive(parent_snap)) return no_snapshot;
    snapshot_id free_id = no_snapshot;
    for (std::size_t i = 0; i < SnapshotCapacity; ++i) {
      if (!state_.snapshots[i].alive) {
        free_id = static_cast<snapshot_id>(i);
        break;
      }
    }
    if (free_id == no_snapshot) return no_snapshot;

    state next = state_;
    next.snapshots[free_id].alive = true;
    next.snapshots[free_id].parent = parent_snap;
    next.snapshots[free_id].slots = {};
    ++next.generation;
    state_ = std::move(next);
    return free_id;
  }

  transaction begin_write(snapshot_id snap, lba_type lba) {
    transaction txn;
    if (journal_.valid || !is_alive(snap) || lba >= LbaCount) return txn;

    slot effective;
    if (!effective_slot(state_, snap, lba, effective)) return txn;
    block_id new_block = no_block;
    for (std::size_t i = 0; i < BlockCapacity; ++i) {
      if (!state_.allocated[i]) {
        new_block = static_cast<block_id>(i);
        break;
      }
    }
    if (new_block == no_block) return txn;

    txn.owner_ = this;
    txn.kind_ = record_kind::write;
    txn.snap_ = snap;
    txn.lba_ = lba;
    txn.new_block_ = new_block;
    txn.old_value_ =
        effective.kind == slot_kind::block ? state_.data[effective.block]
                                           : word_type{};
    txn.value_ = txn.old_value_;
    txn.token_ = ++next_token_;
    txn.base_generation_ = state_.generation;
    return txn;
  }

  transaction begin_discard(snapshot_id snap, lba_type lba) {
    transaction txn;
    if (journal_.valid || !is_alive(snap) || lba >= LbaCount) return txn;
    txn.owner_ = this;
    txn.kind_ = record_kind::discard;
    txn.snap_ = snap;
    txn.lba_ = lba;
    txn.token_ = ++next_token_;
    txn.base_generation_ = state_.generation;
    return txn;
  }

  transaction begin_delete(snapshot_id snap) {
    transaction txn;
    if (journal_.valid || !is_alive(snap) || snap == state_.root) return txn;
    txn.owner_ = this;
    txn.kind_ = record_kind::remove;
    txn.snap_ = snap;
    txn.token_ = ++next_token_;
    txn.base_generation_ = state_.generation;
    return txn;
  }

  bool write(snapshot_id snap, lba_type lba, word_type value) {
    transaction txn = begin_write(snap, lba);
    if (!txn) return false;
    if (!txn.stage(value)) return false;
    return txn.commit();
  }

  bool discard(snapshot_id snap, lba_type lba) {
    transaction txn = begin_discard(snap, lba);
    if (!txn) return false;
    return txn.commit();
  }

  bool delete_snapshot(snapshot_id snap) {
    transaction txn = begin_delete(snap);
    if (!txn) return false;
    return txn.commit();
  }

  bool journal_pending() const noexcept { return journal_.valid; }

  // Replay a prepared record.  This is the only path by which a prepared but
  // unpublished mapping becomes visible.  State and journal are replaced by one
  // atomic swap, so recovery cannot expose a half-written mapping.
  bool recover() {
    if (!journal_.valid) return false;
    if (state_.generation != journal_.base_generation) {
      journal_.valid = false;
      return false;
    }
    state next = state_;
    if (!apply_record(next, journal_)) {
      journal_.valid = false;
      return false;
    }
    ++next.generation;
    state_ = std::move(next);
    journal_ = commit_record{};
    return true;
  }

  std::uint32_t refcount(block_id block) const noexcept {
    if (block >= BlockCapacity) return 0;
    return state_.refs[block];
  }

  bool block_allocated(block_id block) const noexcept {
    return block < BlockCapacity && state_.allocated[block];
  }

  word_type block_value(block_id block) const noexcept {
    if (block >= BlockCapacity) return word_type{};
    return state_.data[block];
  }

  std::size_t allocated_blocks() const noexcept {
    std::size_t count = 0;
    for (bool allocated : state_.allocated)
      if (allocated) ++count;
    return count;
  }

  std::uint64_t generation() const noexcept { return state_.generation; }

  bool check_invariants(std::string* error = nullptr) const {
    auto fail = [&](const char* what) {
      if (error) *error = what;
      return false;
    };

    if (state_.root >= SnapshotCapacity ||
        !state_.snapshots[state_.root].alive)
      return fail("invalid root snapshot");
    if (state_.snapshots[state_.root].parent != no_snapshot)
      return fail("root has a parent");

    std::array<std::uint64_t, BlockCapacity> mapping_refs{};
    for (std::size_t s = 0; s < SnapshotCapacity; ++s) {
      const snapshot_record& snap = state_.snapshots[s];
      if (!snap.alive) {
        for (const slot& local : snap.slots) {
          if (local.kind == slot_kind::block || local.block != no_block)
            return fail("dead snapshot retains a slot");
        }
        continue;
      }

      if (snap.parent != no_snapshot) {
        if (snap.parent >= SnapshotCapacity ||
            !state_.snapshots[snap.parent].alive)
          return fail("live snapshot has a dead parent");
        if (snap.parent == s) return fail("snapshot is its own parent");
      } else if (static_cast<snapshot_id>(s) != state_.root) {
        return fail("non-root live snapshot has no parent");
      }

      // Walk to the root with a hard bound to reject cycles.
      snapshot_id cursor = static_cast<snapshot_id>(s);
      std::size_t depth = 0;
      while (cursor != no_snapshot) {
        if (depth++ > SnapshotCapacity) return fail("snapshot parent cycle");
        if (cursor >= SnapshotCapacity || !state_.snapshots[cursor].alive)
          return fail("parent chain leaves live snapshots");
        cursor = state_.snapshots[cursor].parent;
      }

      for (const slot& local : snap.slots) {
        if (local.kind == slot_kind::inherit) {
          if (local.block != no_block) return fail("inherit slot has a block");
          continue;
        }
        if (local.kind == slot_kind::zero) {
          if (local.block != no_block) return fail("zero slot has a block");
          continue;
        }
        if (local.block >= BlockCapacity)
          return fail("slot references an out-of-range block");
        if (!state_.allocated[local.block])
          return fail("slot references an unallocated block");
        ++mapping_refs[local.block];
      }
    }

    for (std::size_t b = 0; b < BlockCapacity; ++b) {
      if (state_.allocated[b] != (state_.refs[b] != 0))
        return fail("allocated flag does not match refcount");
      if (state_.refs[b] != mapping_refs[b])
        return fail("refcount does not match mapping references");
    }
    return true;
  }

private:
  static bool effective_slot(const state& st, snapshot_id snap, lba_type lba,
                             slot& out) noexcept {
    snapshot_id cursor = snap;
    for (std::size_t guard = 0; guard <= SnapshotCapacity; ++guard) {
      if (cursor >= SnapshotCapacity || !st.snapshots[cursor].alive)
        return false;
      const slot& local = st.snapshots[cursor].slots[lba];
      if (local.kind != slot_kind::inherit) {
        out = local;
        return true;
      }
      cursor = st.snapshots[cursor].parent;
      if (cursor == no_snapshot) {
        out = slot{slot_kind::zero, no_block};
        return true;
      }
    }
    return false;
  }

  static void incref(state& st, block_id block) noexcept {
    if (block < BlockCapacity) ++st.refs[block];
  }

  static void release(state& st, block_id block) noexcept {
    if (block >= BlockCapacity || st.refs[block] == 0) return;
    if (--st.refs[block] == 0) {
      st.allocated[block] = false;
      st.data[block] = word_type{};
    }
  }

  template <typename Fn>
  static void for_each_child(const state& st, snapshot_id snap, Fn&& fn) {
    for (std::size_t i = 0; i < SnapshotCapacity; ++i) {
      const snapshot_record& child = st.snapshots[i];
      if (child.alive && static_cast<snapshot_id>(i) != snap &&
          child.parent == snap)
        fn(static_cast<snapshot_id>(i));
    }
  }

  // Freeze inherited slots before the parent changes its own local slot.  A
  // child that already has a local block/zero is independent and is untouched.
  static void push_to_children(state& st, snapshot_id snap, lba_type lba,
                               const slot& old_effective) {
    for_each_child(st, snap, [&](snapshot_id child) {
      slot& local = st.snapshots[child].slots[lba];
      if (local.kind != slot_kind::inherit) return;
      local = old_effective;
      if (old_effective.kind == slot_kind::block)
        incref(st, old_effective.block);
    });
  }

  static bool apply_write(state& st, const commit_record& rec) {
    if (rec.snap >= SnapshotCapacity || rec.lba >= LbaCount ||
        !st.snapshots[rec.snap].alive || rec.new_block >= BlockCapacity)
      return false;

    // A prepared write's block is free in the base state.  Re-applying an
    // already-published record is treated as success (idempotent recovery).
    if (st.allocated[rec.new_block]) {
      const slot& local = st.snapshots[rec.snap].slots[rec.lba];
      return local.kind == slot_kind::block &&
             local.block == rec.new_block &&
             st.data[rec.new_block] == rec.value;
    }

    slot old_effective;
    if (!effective_slot(st, rec.snap, rec.lba, old_effective)) return false;
    push_to_children(st, rec.snap, rec.lba, old_effective);

    const slot old_local = st.snapshots[rec.snap].slots[rec.lba];
    st.data[rec.new_block] = rec.value;
    st.refs[rec.new_block] = 1;
    st.allocated[rec.new_block] = true;
    st.snapshots[rec.snap].slots[rec.lba] =
        slot{slot_kind::block, rec.new_block};
    if (old_local.kind == slot_kind::block) release(st, old_local.block);
    return true;
  }

  static bool apply_discard(state& st, const commit_record& rec) {
    if (rec.snap >= SnapshotCapacity || rec.lba >= LbaCount ||
        !st.snapshots[rec.snap].alive)
      return false;
    slot old_effective;
    if (!effective_slot(st, rec.snap, rec.lba, old_effective)) return false;
    push_to_children(st, rec.snap, rec.lba, old_effective);
    const slot old_local = st.snapshots[rec.snap].slots[rec.lba];
    st.snapshots[rec.snap].slots[rec.lba] =
        slot{slot_kind::zero, no_block};
    if (old_local.kind == slot_kind::block) release(st, old_local.block);
    return true;
  }

  static bool apply_remove(state& st, const commit_record& rec) {
    const snapshot_id dead = rec.snap;
    if (dead >= SnapshotCapacity || !st.snapshots[dead].alive ||
        dead == st.root)
      return false;

    const snapshot_id new_parent = st.snapshots[dead].parent;
    const auto dead_slots = st.snapshots[dead].slots;

    // Transfer the dead snapshot's local mappings to children that still
    // inherit.  Inherited-from-grandparent slots need no transfer: the child is
    // simply reparented and continues to inherit the same value.
    for_each_child(st, dead, [&](snapshot_id child) {
      for (std::size_t lba = 0; lba < LbaCount; ++lba) {
        const slot local = st.snapshots[child].slots[lba];
        if (local.kind != slot_kind::inherit) continue;
        const slot inherited = dead_slots[lba];
        if (inherited.kind == slot_kind::block) {
          st.snapshots[child].slots[lba] = inherited;
          incref(st, inherited.block);
        } else if (inherited.kind == slot_kind::zero) {
          st.snapshots[child].slots[lba] = inherited;
        }
      }
      st.snapshots[child].parent = new_parent;
    });

    for (const slot& local : dead_slots)
      if (local.kind == slot_kind::block) release(st, local.block);

    st.snapshots[dead].alive = false;
    st.snapshots[dead].parent = no_snapshot;
    st.snapshots[dead].slots = {};
    return true;
  }

  static bool apply_record(state& st, const commit_record& rec) {
    switch (rec.kind) {
      case record_kind::write:
        return apply_write(st, rec);
      case record_kind::discard:
        return apply_discard(st, rec);
      case record_kind::remove:
        return apply_remove(st, rec);
      case record_kind::none:
        break;
    }
    return false;
  }

  bool prepare_transaction(transaction& txn) {
    if (!txn.valid() || txn.owner_ != this) return false;
    if (state_.generation != txn.base_generation_) {
      txn.owner_ = nullptr;
      return false;
    }
    if (journal_.valid) {
      if (journal_.token != txn.token_) return false;
      txn.prepared_ = true;
      return true;
    }

    commit_record rec;
    rec.valid = true;
    rec.kind = txn.kind_;
    rec.snap = txn.snap_;
    rec.lba = txn.lba_;
    rec.new_block = txn.new_block_;
    rec.value = txn.value_;
    rec.token = txn.token_;
    rec.base_generation = state_.generation;
    journal_ = rec;
    txn.prepared_ = true;
    return true;
  }

  bool commit_transaction(transaction& txn) {
    if (!txn.valid() || txn.owner_ != this) return false;
    if (state_.generation != txn.base_generation_) {
      txn.owner_ = nullptr;
      return false;
    }
    if (!journal_.valid) {
      if (!prepare_transaction(txn)) return false;
    } else if (journal_.token != txn.token_) {
      return false;
    }

    const bool applied = recover();
    txn.owner_ = nullptr;
    txn.prepared_ = false;
    return applied;
  }

  state state_{};
  commit_record journal_{};
  std::uint64_t next_token_ = 0;
};

}  // namespace dlks
