#pragma once

#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace dlks_formal {

// A header-only, embeddable concurrent skip list for cache indexes.
//
// The bottom level is the authoritative ordered set. Insertions and erasures
// use Harris-style clean/delete marks and CAS loops; no operation takes a
// per-key or global data-structure lock. Readers are optimistic: they descend
// the upper levels as a hint and finish by scanning the bottom level without
// taking a lock or writing to the list.
//
// Reclamation is epoch based. A node is put on the retired list only after it
// has been unlinked from every level. Its memory is not handed back to the
// allocator until every reader that could have observed the unlink has left
// its announced epoch.
template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
class ConcurrentSkipList {
    static_assert(MaxHeight >= 1, "MaxHeight must be at least one");
    static_assert(std::atomic<std::uintptr_t>::is_always_lock_free,
                  "lock-free pointer atomics are required");
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                  "lock-free 64-bit epoch atomics are required");

public:
    using key_type = Key;
    using mapped_type = Value;
    using value_type = std::pair<Key, Value>;
    using key_compare = Compare;
    using allocator_type = Allocator;
    using size_type = std::size_t;

    static constexpr std::size_t max_height = MaxHeight;
    static constexpr std::uint64_t default_seed = 0x6a09e667f3bcc909ULL;

    ConcurrentSkipList()
        : ConcurrentSkipList(Compare{}, default_seed, Allocator{}) {}

    explicit ConcurrentSkipList(std::uint64_t seed)
        : ConcurrentSkipList(Compare{}, seed, Allocator{}) {}

    explicit ConcurrentSkipList(Compare comp,
                                std::uint64_t seed = default_seed)
        : ConcurrentSkipList(std::move(comp), seed, Allocator{}) {}

    ConcurrentSkipList(Compare comp, std::uint64_t seed, Allocator alloc)
        : compare_(std::move(comp)),
          seed_(seed),
          node_alloc_(std::move(alloc)),
          epoch_(*this) {
        head_ = make_sentinel(Kind::head);
        try {
            tail_ = make_sentinel(Kind::tail);
        } catch (...) {
            destroy_node(head_);
            throw;
        }
        for (std::size_t level = 0; level < MaxHeight; ++level) {
            head_->next[level].store(pack(tail_), std::memory_order_relaxed);
        }
    }

    ConcurrentSkipList(const ConcurrentSkipList&) = delete;
    ConcurrentSkipList& operator=(const ConcurrentSkipList&) = delete;
    ConcurrentSkipList(ConcurrentSkipList&&) = delete;
    ConcurrentSkipList& operator=(ConcurrentSkipList&&) = delete;

    ~ConcurrentSkipList() {
        // Destruction is a quiescent operation, like destruction of standard
        // containers. No writer or reader may be using the list here.
        epoch_.drain();
        destroy_node(head_);
        destroy_node(tail_);
        head_ = nullptr;
        tail_ = nullptr;
    }

    // Inserts key/value only when key is absent. Returns true iff this call
    // linearized as the insertion of key.
    bool insert(const Key& key, const Value& value) {
        Key key_copy = key;
        Value value_copy = value;
        return insert_impl(std::move(key_copy), std::move(value_copy));
    }

    bool insert(Key&& key, Value&& value) {
        return insert_impl(std::move(key), std::move(value));
    }

    bool insert(const Key& key) {
        return insert(key, Value{});
    }

    bool insert(Key&& key) {
        return insert(std::move(key), Value{});
    }

    // Erases key when present. Returns true iff this call marked key deleted.
    bool erase(const Key& key) {
        bool erased = false;
        {
            typename Epoch::Guard guard(epoch_);
            Node* pred = nullptr;
            Node* curr = nullptr;
            if (!locate_bottom(key, pred, curr)) {
                return false;
            }

            std::uintptr_t old_next =
                curr->next[0].load(std::memory_order_acquire);
            for (;;) {
                if (is_marked(old_next)) {
                    // A concurrent erase won the linearization point.
                    return false;
                }
                if (curr->next[0].compare_exchange_strong(
                        old_next, old_next | mark_bit,
                        std::memory_order_acq_rel,
                        std::memory_order_acquire)) {
                    break;
                }
            }

            curr->state.store(State::deleted, std::memory_order_release);
            unlink_all_levels(curr);
            size_.fetch_sub(1, std::memory_order_relaxed);
            epoch_.retire(curr);
            erased = true;
        }
        epoch_.maybe_reclaim();
        return erased;
    }

    bool remove(const Key& key) { return erase(key); }

    // The read path is lock free. It pins an epoch, descends the index levels
    // without validation writes, then performs the exact comparison on the
    // authoritative bottom level.
    std::optional<Value> find(const Key& key) const {
        typename Epoch::Guard guard(epoch_);
        for (;;) {
            Node* pred = head_;

            for (std::size_t level = MaxHeight; level-- > 1;) {
                std::uintptr_t raw =
                    pred->next[level].load(std::memory_order_acquire);
                for (;;) {
                    Node* curr = unmark(raw);
                    if (curr == tail_) {
                        break;
                    }
                    if (!less(curr->key_ref(), key)) {
                        break;
                    }
                    // A tower is linked level by level and receives its bottom
                    // link last. A not-yet-live tower is safe to pass over,
                    // but it is not a valid descent point.
                    if (can_be_indexed(curr)) {
                        pred = curr;
                    }
                    raw = curr->next[level].load(std::memory_order_acquire);
                }
            }

            std::uintptr_t raw =
                pred->next[0].load(std::memory_order_acquire);
            for (;;) {
                Node* curr = unmark(raw);
                if (curr == tail_) {
                    return std::nullopt;
                }

                std::uintptr_t next =
                    curr->next[0].load(std::memory_order_acquire);
                if (is_marked(next)) {
                    // Logically deleted nodes are skipped; their memory is
                    // protected by the current epoch.
                    raw = next & ~mark_bit;
                    continue;
                }

                if (!less(curr->key_ref(), key)) {
                    if (!less(key, curr->key_ref())) {
                        return curr->value_ref();
                    }
                    return std::nullopt;
                }
                raw = next;
            }
        }
    }

    std::optional<Value> lookup(const Key& key) const { return find(key); }

    std::optional<Value> get(const Key& key) const { return find(key); }

    bool contains(const Key& key) const { return find(key).has_value(); }

    // Approximate during a concurrent mutation, exact once writers quiesce.
    size_type size() const {
        const auto value = size_.load(std::memory_order_relaxed);
        return value < 0 ? size_type{0} : static_cast<size_type>(value);
    }

    bool empty() const { return size() == 0; }

    std::uint64_t seed() const noexcept { return seed_; }

    std::vector<value_type> snapshot() const {
        typename Epoch::Guard guard(epoch_);
        std::vector<value_type> result;
        Node* curr =
            next_live(head_->next[0].load(std::memory_order_acquire));
        while (curr != tail_) {
            result.emplace_back(curr->key_ref(), curr->value_ref());
            curr = next_live(curr->next[0].load(std::memory_order_acquire));
        }
        return result;
    }

    std::vector<Key> keys() const {
        typename Epoch::Guard guard(epoch_);
        std::vector<Key> result;
        Node* curr =
            next_live(head_->next[0].load(std::memory_order_acquire));
        while (curr != tail_) {
            result.push_back(curr->key_ref());
            curr = next_live(curr->next[0].load(std::memory_order_acquire));
        }
        return result;
    }

    // Height of each key in the currently linked structure. Intended for
    // diagnostics and tests; this is a quiescent-state operation.
    std::vector<std::pair<Key, std::size_t>> heights() const {
        typename Epoch::Guard guard(epoch_);
        std::vector<std::pair<Key, std::size_t>> result;
        Node* curr =
            next_live(head_->next[0].load(std::memory_order_acquire));
        while (curr != tail_) {
            result.emplace_back(curr->key_ref(),
                                static_cast<std::size_t>(curr->height));
            curr = next_live(curr->next[0].load(std::memory_order_acquire));
        }
        return result;
    }

    // Checks ordering, uniqueness, level membership, delete marks, and size.
    // Useful after joining writers and readers.
    bool validate_structure() const { return validate_structure(nullptr); }

    bool validate_structure(std::string* error) const {
        typename Epoch::Guard guard(epoch_);
        const auto invalid = [error](std::string message) {
            if (error != nullptr) {
                *error = std::move(message);
            }
            return false;
        };

        std::vector<std::vector<Node*>> levels(MaxHeight);
        for (std::size_t level = 0; level < MaxHeight; ++level) {
            std::uintptr_t raw =
                head_->next[level].load(std::memory_order_acquire);
            if (is_marked(raw)) {
                return invalid("marked head pointer at level " +
                               std::to_string(level));
            }

            Node* curr = unmark(raw);
            Node* previous = nullptr;
            while (curr != tail_) {
                if (curr == nullptr || curr->kind != Kind::node) {
                    return invalid("null or sentinel node at level " +
                                   std::to_string(level));
                }
                if (is_marked(curr->next[level].load(
                        std::memory_order_acquire))) {
                    return invalid("marked link at level " +
                                   std::to_string(level));
                }
                if (curr->state.load(std::memory_order_acquire) !=
                    State::live) {
                    return invalid("non-live linked node at level " +
                                   std::to_string(level) + " state " +
                                   std::to_string(static_cast<int>(
                                       curr->state.load(
                                           std::memory_order_acquire))) +
                                   " height " +
                                   std::to_string(curr->height));
                }
                if (curr->height <= level) {
                    return invalid("node linked above its height at level " +
                                   std::to_string(level));
                }
                if (previous != nullptr &&
                    !less(previous->key_ref(), curr->key_ref())) {
                    return invalid("order or uniqueness violation at level " +
                                   std::to_string(level));
                }
                levels[level].push_back(curr);
                previous = curr;

                raw = curr->next[level].load(std::memory_order_acquire);
                if (is_marked(raw)) {
                    return invalid("marked successor at level " +
                                   std::to_string(level));
                }
                curr = unmark(raw);
            }
        }

        for (Node* node : levels[0]) {
            for (std::size_t level = 1; level < node->height; ++level) {
                if (std::find(levels[level].begin(), levels[level].end(),
                              node) == levels[level].end()) {
                    return invalid("bottom node missing from level " +
                                   std::to_string(level));
                }
            }
        }

        for (std::size_t level = 1; level < MaxHeight; ++level) {
            for (Node* upper : levels[level]) {
                if (std::find(levels[level - 1].begin(),
                              levels[level - 1].end(),
                              upper) == levels[level - 1].end()) {
                    return invalid("upper node missing from level " +
                                   std::to_string(level - 1));
                }
            }
        }

        const auto recorded_size =
            static_cast<size_type>(size_.load(std::memory_order_relaxed));
        if (recorded_size != levels[0].size()) {
            return invalid("size mismatch: recorded " +
                           std::to_string(recorded_size) + ", linked " +
                           std::to_string(levels[0].size()));
        }
        return true;
    }

    bool validate() const { return validate_structure(); }

    // Explicitly run a reclamation pass. This is normally done automatically
    // in batches after mutations, but exposing it lets an embedder force a
    // pass at a quiescent point.
    std::size_t reclaim_epochs() { return epoch_.reclaim(); }

private:
    static constexpr std::uintptr_t mark_bit = std::uintptr_t{1};

    enum class Kind : std::uint8_t { head, tail, node };
    enum class State : std::uint8_t { inserting, live, deleted };

    struct Node {
        Node(Kind node_kind, Key node_key, Value node_value,
             std::size_t node_height)
            : kind(node_kind),
              key(std::move(node_key)),
              value(std::move(node_value)),
              height(node_height),
              state(State::inserting) {
            for (auto& link : next) {
                link.store(0, std::memory_order_relaxed);
            }
        }

        explicit Node(Kind node_kind)
            : kind(node_kind), height(MaxHeight), state(State::live) {
            for (auto& link : next) {
                link.store(0, std::memory_order_relaxed);
            }
        }

        Kind kind;
        std::optional<Key> key;
        std::optional<Value> value;
        std::size_t height;
        std::atomic<State> state;
        std::atomic<std::uintptr_t> next[MaxHeight];

        // Reclamation links are only touched after a node has been unlinked
        // from every list level.
        Node* retire_next = nullptr;
        std::uint64_t retire_epoch = 0;

        const Key& key_ref() const { return *key; }
        const Value& value_ref() const { return *value; }
    };

    using NodeAllocator =
        typename std::allocator_traits<Allocator>::template rebind_alloc<Node>;
    using NodeAllocatorTraits = std::allocator_traits<NodeAllocator>;

    class Epoch {
        struct Slot {
            std::atomic<std::uint64_t> announced{
                0};  // 0 = inactive; otherwise epoch + 1
            int depth = 0;  // owned by the thread that owns this slot
            Node* retired_head = nullptr;  // owner-thread only
            std::int64_t retired_count = 0;
        };

        struct SlotNode {
            Slot slot;
            SlotNode* next = nullptr;
        };

        struct DomainToken {
            std::atomic<bool> alive{true};
        };

        struct TlsEntry {
            std::uint64_t domain_id;
            SlotNode* node;
            std::shared_ptr<DomainToken> token;
        };

    public:
        class Guard {
        public:
            explicit Guard(Epoch& epoch)
                : epoch_(&epoch), slot_(epoch.enter()) {}
            ~Guard() {
                if (slot_ != nullptr) {
                    epoch_->leave(slot_);
                }
            }

            Guard(const Guard&) = delete;
            Guard& operator=(const Guard&) = delete;
            Guard(Guard&& other) noexcept
                : epoch_(other.epoch_), slot_(other.slot_) {
                other.epoch_ = nullptr;
                other.slot_ = nullptr;
            }
            Guard& operator=(Guard&&) = delete;

        private:
            Epoch* epoch_;
            Slot* slot_;
        };

        explicit Epoch(ConcurrentSkipList& owner) : owner_(owner) {}

        ~Epoch() {
            token_->alive.store(false, std::memory_order_release);
            drain();
            SlotNode* node = slots_.load(std::memory_order_acquire);
            while (node != nullptr) {
                SlotNode* following = node->next;
                delete node;
                node = following;
            }
        }

        Slot* enter() {
            auto& entries = tls_entries();
            Slot* slot = find_slot(entries);
            if (slot == nullptr) {
                auto* fresh = new SlotNode();
                SlotNode* old_head =
                    slots_.load(std::memory_order_relaxed);
                do {
                    fresh->next = old_head;
                } while (!slots_.compare_exchange_weak(
                    old_head, fresh, std::memory_order_release,
                    std::memory_order_relaxed));
                entries.push_back(TlsEntry{id_, fresh, token_});
                slot = &fresh->slot;
            }

            if (slot->depth++ != 0) {
                return slot;
            }

            for (;;) {
                const std::uint64_t observed =
                    epoch_.load(std::memory_order_seq_cst);
                slot->announced.store(observed + 1,
                                      std::memory_order_seq_cst);
                if (epoch_.load(std::memory_order_seq_cst) == observed) {
                    break;
                }
            }
            return slot;
        }

        void leave(Slot* slot) noexcept {
            if (--slot->depth == 0) {
                slot->announced.store(0, std::memory_order_release);
            }
        }

        void retire(Node* node) {
            Slot* slot = find_slot(tls_entries());
            assert(slot != nullptr &&
                   "retire must run while the current thread is pinned");
            if (slot == nullptr) {
                return;
            }
            node->retire_epoch = epoch_.load(std::memory_order_acquire);
            node->retire_next = slot->retired_head;
            slot->retired_head = node;
            ++slot->retired_count;
        }

        void maybe_reclaim() {
            Slot* slot = find_slot(tls_entries());
            if (slot != nullptr && slot->retired_count >= reclaim_batch) {
                reclaim();
            }
        }

        std::size_t reclaim() {
            Slot* slot = find_slot(tls_entries());
            if (slot == nullptr || slot->retired_head == nullptr) {
                return 0;
            }
            Node* list = slot->retired_head;
            slot->retired_head = nullptr;
            slot->retired_count = 0;

            const std::uint64_t prior =
                epoch_.fetch_add(1, std::memory_order_seq_cst);
            const std::uint64_t next_epoch = prior + 1;

            std::uint64_t oldest =
                std::numeric_limits<std::uint64_t>::max();
            for (SlotNode* node = slots_.load(std::memory_order_acquire);
                 node != nullptr; node = node->next) {
                const std::uint64_t announced =
                    node->slot.announced.load(std::memory_order_seq_cst);
                if (announced != 0) {
                    oldest = std::min(oldest, announced - 1);
                }
            }
            if (oldest == std::numeric_limits<std::uint64_t>::max()) {
                oldest = next_epoch;
            }

            Node* keep = nullptr;
            std::size_t freed = 0;
            std::int64_t kept = 0;
            while (list != nullptr) {
                Node* following = list->retire_next;
                if (list->retire_epoch < oldest) {
                    owner_.destroy_node(list);
                    ++freed;
                } else {
                    list->retire_next = keep;
                    keep = list;
                    ++kept;
                }
                list = following;
            }

            if (keep != nullptr) {
                Node* tail = keep;
                while (tail->retire_next != nullptr) {
                    tail = tail->retire_next;
                }
                tail->retire_next = slot->retired_head;
                slot->retired_head = keep;
                slot->retired_count += kept;
            }
            return freed;
        }

        void drain() {
            for (SlotNode* node = slots_.load(std::memory_order_acquire);
                 node != nullptr; node = node->next) {
                Node* list = node->slot.retired_head;
                node->slot.retired_head = nullptr;
                node->slot.retired_count = 0;
                while (list != nullptr) {
                    Node* following = list->retire_next;
                    owner_.destroy_node(list);
                    list = following;
                }
            }
        }

    private:
        static std::vector<TlsEntry>& tls_entries() {
            thread_local std::vector<TlsEntry> entries;
            return entries;
        }

        Slot* find_slot(std::vector<TlsEntry>& entries) {
            for (auto it = entries.begin(); it != entries.end();) {
                if (!it->token->alive.load(std::memory_order_acquire)) {
                    it = entries.erase(it);
                    continue;
                }
                if (it->domain_id == id_) {
                    return &it->node->slot;
                }
                ++it;
            }
            return nullptr;
        }

        static constexpr std::int64_t reclaim_batch = 32;

        inline static std::atomic<std::uint64_t> next_domain_id_{1};

        ConcurrentSkipList& owner_;
        const std::uint64_t id_ =
            next_domain_id_.fetch_add(1, std::memory_order_relaxed);
        std::shared_ptr<DomainToken> token_ =
            std::make_shared<DomainToken>();
        std::atomic<std::uint64_t> epoch_{1};
        std::atomic<SlotNode*> slots_{nullptr};
    };

    bool insert_impl(Key&& key, Value&& value) {
        bool inserted = false;
        bool retired_node = false;
        {
            typename Epoch::Guard guard(epoch_);

            Node* pred = nullptr;
            Node* curr = nullptr;
            if (locate_bottom(key, pred, curr)) {
                return false;
            }

            const std::size_t height = random_height();
            Node* node = make_node(std::move(key), std::move(value), height);

            for (std::size_t level = 1; level < height; ++level) {
                link_upper(node, level);
            }

            size_.fetch_add(1, std::memory_order_relaxed);
            for (;;) {
                if (!locate_bottom(node->key_ref(), pred, curr)) {
                    node->next[0].store(pack(curr),
                                        std::memory_order_release);
                    std::uintptr_t expected = pack(curr);
                    if (pred->next[0].compare_exchange_strong(
                            expected, pack(node), std::memory_order_acq_rel,
                            std::memory_order_acquire)) {
                        State expected_state = State::inserting;
                        node->state.compare_exchange_strong(
                            expected_state, State::live,
                            std::memory_order_release,
                            std::memory_order_relaxed);
                        inserted = true;
                        break;
                    }
                    continue;
                }

                // A same-key insert won while this tower was being built.
                size_.fetch_sub(1, std::memory_order_relaxed);
                unlink_upper_levels(node);
                epoch_.retire(node);
                retired_node = true;
                break;
            }
        }
        if (retired_node) {
            epoch_.maybe_reclaim();
        }
        return inserted;
    }

    bool locate_bottom(const Key& key, Node*& pred_out,
                       Node*& curr_out) const {
        Node* pred = head_;
        std::uintptr_t raw = pred->next[0].load(std::memory_order_acquire);
        for (;;) {
            if (is_marked(raw)) {
                pred = head_;
                raw = pred->next[0].load(std::memory_order_acquire);
                continue;
            }

            Node* curr = unmark(raw);
            if (curr == tail_) {
                pred_out = pred;
                curr_out = curr;
                return false;
            }

            std::uintptr_t next =
                curr->next[0].load(std::memory_order_acquire);
            if (is_marked(next)) {
                const std::uintptr_t replacement = next & ~mark_bit;
                std::uintptr_t expected = pack(curr);
                if (!pred->next[0].compare_exchange_strong(
                        expected, replacement, std::memory_order_acq_rel,
                        std::memory_order_acquire)) {
                    raw = pred->next[0].load(std::memory_order_acquire);
                } else {
                    raw = replacement;
                }
                continue;
            }

            if (!less(curr->key_ref(), key)) {
                pred_out = pred;
                curr_out = curr;
                return !less(key, curr->key_ref());
            }

            pred = curr;
            raw = curr->next[0].load(std::memory_order_acquire);
        }
    }

    void link_upper(Node* node, std::size_t level) const {
        for (;;) {
            Node* pred = head_;
            std::uintptr_t expected =
                pred->next[level].load(std::memory_order_acquire);
            for (;;) {
                Node* curr = unmark(expected);
                if (curr == tail_) {
                    break;
                }
                if (!less(curr->key_ref(), node->key_ref())) {
                    break;
                }
                pred = curr;
                expected = pred->next[level].load(std::memory_order_acquire);
            }

            node->next[level].store(expected, std::memory_order_release);
            if (pred->next[level].compare_exchange_strong(
                    expected, pack(node), std::memory_order_acq_rel,
                    std::memory_order_acquire)) {
                // As with erasure, pred may have been concurrently unlinked.
                // In that case the CAS only updated a stale chain, so retry
                // until the new tower is reachable from this level's head.
                if (linked_at_level(node, level)) {
                    return;
                }
            }
        }
    }

    bool linked_at_level(const Node* node, std::size_t level) const {
        Node* curr = unmark(head_->next[level].load(std::memory_order_acquire));
        while (curr != tail_) {
            if (curr == node) {
                return true;
            }
            const std::uintptr_t raw =
                curr->next[level].load(std::memory_order_acquire);
            curr = unmark(raw);
        }
        return false;
    }

    void unlink_upper_levels(Node* node) const {
        for (;;) {
            for (std::size_t level = node->height; level-- > 1;) {
                unlink_from_level(node, level);
            }
            bool still_linked = false;
            for (std::size_t level = 1; level < node->height; ++level) {
                still_linked = still_linked || linked_at_level(node, level);
            }
            if (!still_linked) {
                return;
            }
        }
    }

    void unlink_all_levels(Node* node) const {
        for (;;) {
            for (std::size_t level = node->height; level-- > 0;) {
                unlink_from_level(node, level);
            }
            bool still_linked = false;
            for (std::size_t level = 0; level < node->height; ++level) {
                still_linked = still_linked || linked_at_level(node, level);
            }
            if (!still_linked) {
                return;
            }
        }
    }

    void unlink_from_level(Node* victim, std::size_t level) const {
        for (;;) {
            Node* pred = head_;
            bool found = false;
            for (;;) {
                std::uintptr_t raw =
                    pred->next[level].load(std::memory_order_acquire);
                if (is_marked(raw)) {
                    break;
                }
                Node* curr = unmark(raw);
                if (curr == tail_) {
                    return;
                }
                if (curr == victim) {
                    found = true;
                    break;
                }

                if (level == 0) {
                    std::uintptr_t next =
                        curr->next[0].load(std::memory_order_acquire);
                    if (is_marked(next)) {
                        const std::uintptr_t replacement = next & ~mark_bit;
                        std::uintptr_t expected = pack(curr);
                        if (!pred->next[0].compare_exchange_strong(
                                expected, replacement,
                                std::memory_order_acq_rel,
                                std::memory_order_acquire)) {
                            break;
                        }
                        continue;
                    }
                }

                pred = curr;
            }
            if (!found) {
                continue;
            }

            std::uintptr_t replacement =
                victim->next[level].load(std::memory_order_acquire);
            if (level == 0) {
                replacement &= ~mark_bit;
            }

            std::uintptr_t expected = pack(victim);
            if (pred->next[level].compare_exchange_strong(
                    expected, replacement, std::memory_order_acq_rel,
                    std::memory_order_acquire)) {
                // The predecessor may itself have been unlinked after we
                // selected it.  Restart from the head and verify that victim
                // is no longer reachable before declaring the level clean.
                continue;
            }
        }
    }

    [[nodiscard]] std::size_t random_height() {
        const std::uint64_t sequence =
            level_sequence_.fetch_add(1, std::memory_order_relaxed);
        std::uint64_t bits =
            splitmix64(seed_ + (sequence + 1) * 0x9e3779b97f4a7c15ULL);
        std::size_t height = 1;
        while (height < MaxHeight && (bits & 0x3U) == 0) {
            ++height;
            bits >>= 2;
        }
        return height;
    }

    static std::uint64_t splitmix64(std::uint64_t value) noexcept {
        value += 0x9e3779b97f4a7c15ULL;
        value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
        value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
        return value ^ (value >> 31U);
    }

    [[nodiscard]] bool can_be_indexed(const Node* node) const {
        if (node->kind != Kind::node ||
            node->state.load(std::memory_order_acquire) != State::live) {
            return false;
        }
        return !is_marked(
            node->next[0].load(std::memory_order_acquire));
    }

    static bool is_marked(std::uintptr_t value) noexcept {
        return (value & mark_bit) != 0;
    }

    static std::uintptr_t pack(const Node* node) noexcept {
        return reinterpret_cast<std::uintptr_t>(node);
    }

    static Node* unmark(std::uintptr_t value) noexcept {
        return reinterpret_cast<Node*>(value & ~mark_bit);
    }

    Node* next_live(std::uintptr_t raw) const noexcept {
        for (;;) {
            Node* candidate = unmark(raw);
            if (candidate == tail_) {
                return candidate;
            }
            const std::uintptr_t next =
                candidate->next[0].load(std::memory_order_acquire);
            if (!is_marked(next)) {
                return candidate;
            }
            raw = next;
        }
    }

    bool less(const Key& left, const Key& right) const {
        return compare_(left, right);
    }

    Node* make_sentinel(Kind kind) {
        Node* node = NodeAllocatorTraits::allocate(node_alloc_, 1);
        try {
            NodeAllocatorTraits::construct(node_alloc_, node, kind);
        } catch (...) {
            NodeAllocatorTraits::deallocate(node_alloc_, node, 1);
            throw;
        }
        return node;
    }

    Node* make_node(Key&& key, Value&& value, std::size_t height) {
        Node* node = NodeAllocatorTraits::allocate(node_alloc_, 1);
        try {
            NodeAllocatorTraits::construct(node_alloc_, node, Kind::node,
                                           std::move(key), std::move(value),
                                           height);
        } catch (...) {
            NodeAllocatorTraits::deallocate(node_alloc_, node, 1);
            throw;
        }
        return node;
    }

    void destroy_node(Node* node) noexcept {
        NodeAllocatorTraits::destroy(node_alloc_, node);
        NodeAllocatorTraits::deallocate(node_alloc_, node, 1);
    }

    Compare compare_;
    const std::uint64_t seed_;
    NodeAllocator node_alloc_;
    std::atomic<std::int64_t> size_{0};
    std::atomic<std::uint64_t> level_sequence_{0};
    mutable Epoch epoch_;
    Node* head_ = nullptr;
    Node* tail_ = nullptr;
};

template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
using SkipList = ConcurrentSkipList<Key, Value, Compare, MaxHeight, Allocator>;

template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
using LockFreeSkipList =
    ConcurrentSkipList<Key, Value, Compare, MaxHeight, Allocator>;

template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
using EpochSkipList =
    ConcurrentSkipList<Key, Value, Compare, MaxHeight, Allocator>;

template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
using ConcurrentSkipListMap =
    ConcurrentSkipList<Key, Value, Compare, MaxHeight, Allocator>;

}  // namespace dlks_formal
