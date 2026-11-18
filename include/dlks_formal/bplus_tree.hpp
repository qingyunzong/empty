#pragma once

#include "page_manager.hpp"

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace dlks {

enum class FaultPoint : std::uint8_t {
    after_leaf_split,
    before_sibling_update,
    after_sibling_update,
    before_parent_link,
    after_parent_link,
    before_root_replace,
    after_root_replace,
    before_commit
};

inline const char* to_string(FaultPoint point) noexcept {
    switch (point) {
        case FaultPoint::after_leaf_split:
            return "after_leaf_split";
        case FaultPoint::before_sibling_update:
            return "before_sibling_update";
        case FaultPoint::after_sibling_update:
            return "after_sibling_update";
        case FaultPoint::before_parent_link:
            return "before_parent_link";
        case FaultPoint::after_parent_link:
            return "after_parent_link";
        case FaultPoint::before_root_replace:
            return "before_root_replace";
        case FaultPoint::after_root_replace:
            return "after_root_replace";
        case FaultPoint::before_commit:
            return "before_commit";
    }
    return "unknown";
}

class InjectedFault : public std::runtime_error {
public:
    explicit InjectedFault(FaultPoint point)
        : std::runtime_error(std::string("dlks: injected fault at ") +
                             to_string(point)),
          point_(point) {}

    [[nodiscard]] FaultPoint point() const noexcept { return point_; }

private:
    FaultPoint point_;
};

struct BPlusTreeOptions {
    std::size_t leaf_max_keys = 16;
    std::size_t internal_max_keys = 16;
    std::size_t page_capacity = 65536;

    // Zero requests the derived values:
    //   leaf_min_keys          = (leaf_max_keys + 1) / 2
    //   internal_min_children  = (internal_max_keys + 2) / 2
    std::size_t leaf_min_keys = 0;
    std::size_t internal_min_children = 0;

    // When false, an exception leaves the structural transaction pending so
    // recover() can be called explicitly.  Readers retry while the structural
    // sequence is odd.
    bool auto_rollback_on_exception = true;

    std::function<bool(FaultPoint)> fault_injector;
};

struct InvariantReport {
    bool ok = true;
    std::size_t reachable_pages = 0;
    std::size_t leaf_pages = 0;
    std::size_t internal_pages = 0;
    std::size_t entries = 0;
    std::size_t height = 0;
    std::string message;

    [[nodiscard]] explicit operator bool() const noexcept { return ok; }
};

struct RecoveryReport {
    bool rolled_back = false;
    bool root_restored = false;
    std::uint64_t transaction_id = 0;
    std::size_t pages_restored = 0;
    std::size_t new_pages_retired = 0;
    std::string message;
};

struct RecoveryStats {
    std::uint64_t begun = 0;
    std::uint64_t committed = 0;
    std::uint64_t rolled_back = 0;
    std::uint64_t recoveries = 0;
};

struct PageStatistics {
    std::size_t live_pages = 0;
    std::size_t retired_pages = 0;
    std::size_t reusable_pages = 0;
    std::size_t active_readers = 0;
    std::uint64_t epoch = 0;
};

// A concurrent, in-memory B+ tree with page-id recycling.
//
// Reads are optimistic: they take no page locks, consume immutable node
// snapshots through an epoch guard, and retry if a structural sequence changes.
// Writers use top-down latch coupling.  Data-only writes share the topology
// latch and can proceed in parallel on different leaves.  Structural changes
// (split, merge, root replacement) hold the topology latch exclusively and are
// wrapped in an undo journal.
template <typename Key, typename Value, typename Compare = std::less<Key>>
class BPlusTree {
public:
    using key_type = Key;
    using mapped_type = Value;
    using value_type = std::pair<Key, Value>;
    using key_compare = Compare;

    BPlusTree() : BPlusTree(BPlusTreeOptions{}, Compare{}) {}

    explicit BPlusTree(BPlusTreeOptions options)
        : BPlusTree(std::move(options), Compare{}) {}

    BPlusTree(std::size_t leaf_max_keys, std::size_t internal_max_keys,
              std::size_t page_capacity = 65536)
        : BPlusTree(make_options(leaf_max_keys, internal_max_keys,
                                 page_capacity),
                    Compare{}) {}

    explicit BPlusTree(std::size_t max_keys)
        : BPlusTree(max_keys, max_keys, 65536) {}

    BPlusTree(BPlusTreeOptions options, Compare compare)
        : options_(normalize_options(std::move(options))),
          compare_(std::move(compare)),
          pages_(options_.page_capacity),
          fault_injector_(options_.fault_injector) {
        auto root_data = std::make_shared<NodeData>();
        root_data->kind = NodeKind::leaf;
        const page_id root = pages_.create(root_data);
        root_.store(root, std::memory_order_release);
    }

    ~BPlusTree() = default;
    BPlusTree(const BPlusTree&) = delete;
    BPlusTree& operator=(const BPlusTree&) = delete;
    BPlusTree(BPlusTree&&) = delete;
    BPlusTree& operator=(BPlusTree&&) = delete;

    [[nodiscard]] std::optional<Value> find(const Key& key) const {
        auto reader = pages_.pin();
        for (;;) {
            if (recovery_pending_.load(std::memory_order_acquire)) {
                throw std::logic_error(
                    "dlks::BPlusTree: recover() is required before access");
            }
            const std::uint64_t sequence_before =
                structure_sequence_.load(std::memory_order_acquire);
            if ((sequence_before & 1U) != 0U) {
                std::this_thread::yield();
                continue;
            }

            page_id id = root_.load(std::memory_order_acquire);
            bool retry = false;

            for (std::size_t depth = 0; depth < max_depth; ++depth) {
                const Node* node = page_or_throw(id);
                const auto data = stable_snapshot(node);

                if (data->kind == NodeKind::leaf) {
                    const std::size_t position =
                        leaf_lower_bound(*data, key);
                    std::optional<Value> result;
                    if (position < data->keys.size() &&
                        key_equal(data->keys[position], key)) {
                        result = data->values[position];
                    }

                    const std::uint64_t sequence_after =
                        structure_sequence_.load(std::memory_order_acquire);
                    if (sequence_before != sequence_after ||
                        (sequence_after & 1U) != 0U) {
                        retry = true;
                        break;
                    }
                    return result;
                }

                const std::size_t child = route_index(data->keys, key);
                if (child >= data->children.size()) {
                    throw std::logic_error(
                        "dlks::BPlusTree: internal routing out of range");
                }
                id = data->children[child];
            }

            if (!retry) {
                throw std::logic_error(
                    "dlks::BPlusTree: depth limit exceeded");
            }
            std::this_thread::yield();
        }
    }

    [[nodiscard]] std::optional<Value> get(const Key& key) const {
        return find(key);
    }

    [[nodiscard]] bool contains(const Key& key) const {
        return find(key).has_value();
    }

    // Returns false when the key already exists.
    bool insert(const Key& key, const Value& value) {
        const InsertStatus status = insert_impl(key, value, false);
        reclaim_pages();
        return status == InsertStatus::inserted;
    }

    // Returns true when a new key was inserted, false when an existing value
    // was replaced.
    bool upsert(const Key& key, const Value& value) {
        const InsertStatus status = insert_impl(key, value, true);
        reclaim_pages();
        return status == InsertStatus::inserted;
    }

    bool insert_or_assign(const Key& key, const Value& value) {
        return upsert(key, value);
    }

    bool erase(const Key& key) {
        const bool erased = erase_impl(key);
        reclaim_pages();
        return erased;
    }

    bool remove(const Key& key) { return erase(key); }

    [[nodiscard]] std::size_t size() const noexcept {
        return size_.load(std::memory_order_acquire);
    }

    [[nodiscard]] bool empty() const noexcept { return size() == 0; }

    void clear() {
        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();
        const page_id old_root = root_.load(std::memory_order_acquire);
        const std::vector<page_id> old_pages = collect_page_ids(old_root);

        begin_structural_transaction();
        try {
            const page_id new_root = allocate_page(NodeKind::leaf);
            replace_root(new_root);
            size_.store(0, std::memory_order_release);
            for (const page_id id : old_pages) {
                retire_after_commit(id);
            }
            commit_structural_transaction();
        } catch (...) {
            if (options_.auto_rollback_on_exception) {
                rollback_structural_transaction();
            } else {
                recovery_pending_.store(true, std::memory_order_release);
            }
            throw;
        }
        topology.unlock();
        reader = EpochManager::ReaderGuard{};
        reclaim_pages();
    }

    // Diagnostic snapshot.  It excludes writers and returns entries in key
    // order by following the leaf chain.
    [[nodiscard]] std::vector<value_type> snapshot() const {
        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();
        std::vector<value_type> result;
        page_id id = leftmost_leaf();
        while (id != invalid_page) {
            const auto data = stable_snapshot(page_or_throw(id));
            result.reserve(result.size() + data->keys.size());
            for (std::size_t index = 0; index < data->keys.size(); ++index) {
                result.emplace_back(data->keys[index], data->values[index]);
            }
            id = data->next;
        }
        return result;
    }

    [[nodiscard]] std::vector<value_type> to_vector() const {
        return snapshot();
    }

    [[nodiscard]] std::size_t height() const {
        std::shared_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();
        page_id id = root_.load(std::memory_order_acquire);
        std::size_t height = 0;
        for (;;) {
            const auto data = stable_snapshot(page_or_throw(id));
            ++height;
            if (data->kind == NodeKind::leaf) {
                return height;
            }
            id = data->children.front();
        }
    }

    [[nodiscard]] PageStatistics page_statistics() const {
        PageStatistics stats;
        stats.live_pages = pages_.live_pages();
        stats.retired_pages = pages_.retired_pages();
        stats.reusable_pages = pages_.reusable_pages();
        stats.active_readers = pages_.epochs().active_readers();
        stats.epoch = pages_.epochs().current();
        return stats;
    }

    std::size_t reclaim_pages() { return pages_.reclaim(); }

    [[nodiscard]] bool recovery_required() const noexcept {
        return recovery_pending_.load(std::memory_order_acquire);
    }

    void set_fault_injector(std::function<bool(FaultPoint)> injector) {
        std::lock_guard<std::mutex> lock(fault_mutex_);
        fault_injector_ = std::move(injector);
    }

    void clear_fault_injector() { set_fault_injector({}); }

    [[nodiscard]] RecoveryStats recovery_stats() const {
        return RecoveryStats{recovery_begun_.load(std::memory_order_relaxed),
                             recovery_committed_.load(
                                 std::memory_order_relaxed),
                             recovery_rolled_back_.load(
                                 std::memory_order_relaxed),
                             recovery_count_.load(std::memory_order_relaxed)};
    }

    // With auto_rollback_on_exception this returns the last automatic recovery
    // result.  Otherwise it rolls back the pending structural transaction
    // (root, pages, sibling links, and logical size) before allowing access.
    [[nodiscard]] RecoveryReport recover() {
        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        if (active_transaction_.has_value()) {
            rollback_structural_transaction();
        } else {
            recovery_pending_.store(false, std::memory_order_release);
        }
        recovery_count_.fetch_add(1, std::memory_order_relaxed);
        return last_recovery_;
    }

    // Verifies topology, separator bounds, occupancy, leaf-chain links, strict
    // key ordering, uniqueness, and the logical element count.
    [[nodiscard]] InvariantReport check_invariants(
        bool check_occupancy = true) const {
        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();

        InvariantReport report;
        try {
            if ((structure_sequence_.load(std::memory_order_acquire) & 1U) !=
                0U) {
                fail_invariant("structure sequence is odd");
            }

            const page_id root = root_.load(std::memory_order_acquire);
            if (root >= pages_.capacity()) {
                fail_invariant("root page id is out of range");
            }

            std::vector<bool> visited(pages_.capacity(), false);
            std::vector<page_id> reachable_leaves;
            std::size_t leaf_depth = 0;
            std::size_t entries = 0;

            validate_node(root, true, 0, std::nullopt, std::nullopt, visited,
                          reachable_leaves, leaf_depth, entries,
                          check_occupancy, report);

            report.entries = entries;
            report.leaf_pages = reachable_leaves.size();
            if (entries != size()) {
                fail_invariant("logical size does not match leaf entries");
            }
            if (report.reachable_pages != pages_.live_pages()) {
                fail_invariant("unreachable live page detected");
            }

            std::unordered_set<page_id> chain;
            std::optional<Key> previous;
            page_id id = leftmost_leaf();
            page_id previous_id = invalid_page;
            std::size_t chain_entries = 0;
            while (id != invalid_page) {
                if (!chain.insert(id).second) {
                    fail_invariant("leaf chain contains a cycle");
                }
                const auto data = stable_snapshot(page_or_throw(id));
                if (data->kind != NodeKind::leaf) {
                    fail_invariant("leaf chain reaches an internal page");
                }
                if (data->prev != previous_id) {
                    fail_invariant("leaf prev pointer is inconsistent");
                }
                for (const Key& key : data->keys) {
                    if (previous.has_value() &&
                        !compare_(*previous, key)) {
                        fail_invariant(
                            "leaf-chain keys are not strictly increasing");
                    }
                    previous = key;
                }
                chain_entries += data->keys.size();
                previous_id = id;
                id = data->next;
            }

            if (chain_entries != entries) {
                fail_invariant("leaf chain count does not match traversal");
            }
            if (chain.size() != reachable_leaves.size()) {
                fail_invariant("reachable leaf set differs from leaf chain");
            }
            for (const page_id leaf : reachable_leaves) {
                if (chain.find(leaf) == chain.end()) {
                    fail_invariant("reachable leaf is missing from leaf chain");
                }
            }
        } catch (const InvariantFailure& failure) {
            report.ok = false;
            report.message = failure.what();
        }
        return report;
    }

    [[nodiscard]] InvariantReport validate() const {
        return check_invariants();
    }

private:
    enum class NodeKind : std::uint8_t { leaf, internal };

    struct NodeData {
        NodeKind kind = NodeKind::leaf;
        std::vector<Key> keys;
        std::vector<Value> values;
        std::vector<page_id> children;
        page_id next = invalid_page;
        page_id prev = invalid_page;
    };

    struct Node {
        explicit Node(std::shared_ptr<const NodeData> content)
            : data(std::move(content)) {}

        mutable std::shared_mutex latch;
        std::atomic<std::uint64_t> version{2};
        std::atomic<std::shared_ptr<const NodeData>> data;
    };

    struct UndoEntry {
        page_id id = invalid_page;
        std::shared_ptr<const NodeData> before;
    };

    struct ActiveTransaction {
        std::uint64_t id = 0;
        page_id root_before = invalid_page;
        std::size_t size_before = 0;
        bool root_changed = false;
        std::vector<UndoEntry> undo;
        std::vector<page_id> new_pages;
        std::vector<page_id> retire_after_commit;
    };

    struct LockedPath {
        std::vector<Node*> nodes;
        std::vector<page_id> ids;
        std::vector<std::size_t> positions;
        std::vector<std::unique_lock<std::shared_mutex>> locks;
    };

    struct InvariantFailure : std::runtime_error {
        using std::runtime_error::runtime_error;
    };

    enum class InsertStatus { inserted, replaced, duplicate };
    enum class FastInsertStatus {
        inserted,
        replaced,
        duplicate,
        needs_structural
    };
    enum class FastEraseStatus { erased, absent, needs_structural };

    static constexpr std::size_t max_depth = 256;

    static BPlusTreeOptions make_options(std::size_t leaf_max_keys,
                                         std::size_t internal_max_keys,
                                         std::size_t page_capacity) {
        BPlusTreeOptions options;
        options.leaf_max_keys = leaf_max_keys;
        options.internal_max_keys = internal_max_keys;
        options.page_capacity = page_capacity;
        return options;
    }

    static BPlusTreeOptions normalize_options(BPlusTreeOptions options) {
        if (options.leaf_max_keys < 2) {
            throw std::invalid_argument(
                "dlks::BPlusTree: leaf_max_keys must be at least 2");
        }
        if (options.internal_max_keys < 2) {
            throw std::invalid_argument(
                "dlks::BPlusTree: internal_max_keys must be at least 2");
        }
        if (options.page_capacity == 0) {
            throw std::invalid_argument(
                "dlks::BPlusTree: page_capacity must be non-zero");
        }
        if (options.leaf_min_keys == 0) {
            options.leaf_min_keys = (options.leaf_max_keys + 1) / 2;
        }
        if (options.internal_min_children == 0) {
            options.internal_min_children =
                (options.internal_max_keys + 2) / 2;
        }
        if (options.leaf_min_keys > options.leaf_max_keys) {
            throw std::invalid_argument(
                "dlks::BPlusTree: leaf_min_keys exceeds leaf_max_keys");
        }
        if (options.leaf_min_keys > (options.leaf_max_keys + 1) / 2) {
            throw std::invalid_argument(
                "dlks::BPlusTree: leaf_min_keys exceeds a split half");
        }
        const std::size_t max_children = options.internal_max_keys + 1;
        if (options.internal_min_children < 2 ||
            options.internal_min_children > max_children) {
            throw std::invalid_argument(
                "dlks::BPlusTree: invalid internal_min_children");
        }
        if (options.internal_min_children > (max_children + 1) / 2) {
            throw std::invalid_argument(
                "dlks::BPlusTree: internal_min_children exceeds a split "
                "half");
        }
        return options;
    }

    [[nodiscard]] Node* page_or_throw(page_id id) const {
        Node* node = pages_.get(id);
        if (node == nullptr) {
            throw std::logic_error("dlks::BPlusTree: missing page");
        }
        return node;
    }

    static std::shared_ptr<const NodeData> stable_snapshot(const Node* node) {
        for (;;) {
            const std::uint64_t before =
                node->version.load(std::memory_order_acquire);
            if ((before & 1U) != 0U) {
                std::this_thread::yield();
                continue;
            }
            auto data = node->data.load(std::memory_order_acquire);
            const std::uint64_t after =
                node->version.load(std::memory_order_acquire);
            if (before == after && (after & 1U) == 0U && data) {
                return data;
            }
            std::this_thread::yield();
        }
    }

    static void publish(Node* node,
                        std::shared_ptr<const NodeData> content) {
        const std::uint64_t version =
            node->version.load(std::memory_order_relaxed);
        node->version.store(version + 1, std::memory_order_release);
        node->data.store(std::move(content), std::memory_order_release);
        node->version.store(version + 2, std::memory_order_release);
    }

    [[nodiscard]] std::size_t route_index(const std::vector<Key>& keys,
                                          const Key& key) const {
        return static_cast<std::size_t>(std::distance(
            keys.begin(),
            std::upper_bound(keys.begin(), keys.end(), key,
                             [this](const Key& element, const Key& value) {
                                 return compare_(element, value);
                             })));
    }

    [[nodiscard]] std::size_t leaf_lower_bound(const NodeData& data,
                                               const Key& key) const {
        return static_cast<std::size_t>(std::distance(
            data.keys.begin(),
            std::lower_bound(data.keys.begin(), data.keys.end(), key,
                             [this](const Key& element, const Key& value) {
                                 return compare_(element, value);
                             })));
    }

    [[nodiscard]] bool key_equal(const Key& left, const Key& right) const {
        return !compare_(left, right) && !compare_(right, left);
    }

    [[nodiscard]] page_id allocate_page(NodeKind kind) {
        NodeData initial;
        initial.kind = kind;
        auto content = std::make_shared<NodeData>(std::move(initial));
        const page_id id = pages_.create(content);
        try {
            if (active_transaction_.has_value()) {
                active_transaction_->new_pages.push_back(id);
            }
        } catch (...) {
            pages_.retire(id);
            throw;
        }
        return id;
    }

    void record_undo(page_id id) {
        if (!active_transaction_.has_value()) {
            return;
        }
        for (const UndoEntry& entry : active_transaction_->undo) {
            if (entry.id == id) {
                return;
            }
        }
        active_transaction_->undo.push_back(
            UndoEntry{id, stable_snapshot(page_or_throw(id))});
    }

    void publish_structural(page_id id,
                            std::shared_ptr<const NodeData> content) {
        record_undo(id);
        publish(page_or_throw(id), std::move(content));
    }

    void retire_after_commit(page_id id) {
        if (!active_transaction_.has_value()) {
            pages_.retire(id);
            return;
        }
        const auto& retired = active_transaction_->retire_after_commit;
        if (std::find(retired.begin(), retired.end(), id) == retired.end()) {
            active_transaction_->retire_after_commit.push_back(id);
        }
    }

    void maybe_fault(FaultPoint point) {
        std::function<bool(FaultPoint)> injector;
        {
            std::lock_guard<std::mutex> lock(fault_mutex_);
            injector = fault_injector_;
        }
        if (injector && injector(point)) {
            throw InjectedFault(point);
        }
    }

    void begin_structural_transaction() {
        structure_sequence_.fetch_add(1, std::memory_order_acq_rel);
        ActiveTransaction transaction;
        transaction.id = ++transaction_counter_;
        transaction.root_before = root_.load(std::memory_order_acquire);
        transaction.size_before = size_.load(std::memory_order_acquire);
        active_transaction_.emplace(std::move(transaction));
        recovery_begun_.fetch_add(1, std::memory_order_relaxed);
    }

    void commit_structural_transaction() {
        if (!active_transaction_.has_value()) {
            throw std::logic_error(
                "dlks::BPlusTree: commit without transaction");
        }
        std::vector<page_id> retired =
            active_transaction_->retire_after_commit;
        active_transaction_.reset();
        structure_sequence_.fetch_add(1, std::memory_order_acq_rel);
        for (const page_id id : retired) {
            pages_.retire(id);
        }
        recovery_committed_.fetch_add(1, std::memory_order_relaxed);
    }

    void rollback_structural_transaction() {
        if (!active_transaction_.has_value()) {
            return;
        }

        ActiveTransaction transaction = std::move(*active_transaction_);
        active_transaction_.reset();

        if (transaction.root_changed) {
            root_.store(transaction.root_before, std::memory_order_release);
        }
        size_.store(transaction.size_before, std::memory_order_release);

        std::unordered_set<page_id> new_pages(transaction.new_pages.begin(),
                                              transaction.new_pages.end());
        std::size_t restored = 0;
        for (auto it = transaction.undo.rbegin(); it != transaction.undo.rend();
             ++it) {
            if (new_pages.find(it->id) != new_pages.end()) {
                continue;
            }
            if (it->before) {
                publish(page_or_throw(it->id), it->before);
                ++restored;
            }
        }

        structure_sequence_.fetch_add(1, std::memory_order_acq_rel);
        for (const page_id id : transaction.new_pages) {
            pages_.retire(id);
        }
        recovery_pending_.store(false, std::memory_order_release);

        recovery_rolled_back_.fetch_add(1, std::memory_order_relaxed);
        last_recovery_ = RecoveryReport{
            true,
            transaction.root_changed,
            transaction.id,
            restored,
            transaction.new_pages.size(),
            "structural transaction rolled back"};
    }

    void replace_root(page_id new_root) {
        maybe_fault(FaultPoint::before_root_replace);
        if (active_transaction_.has_value()) {
            active_transaction_->root_changed = true;
        }
        root_.store(new_root, std::memory_order_release);
        maybe_fault(FaultPoint::after_root_replace);
    }

    void throw_if_recovery_pending() const {
        if (recovery_pending_.load(std::memory_order_acquire)) {
            throw std::logic_error(
                "dlks::BPlusTree: recover() is required before access");
        }
    }

    [[nodiscard]] InsertStatus insert_impl(const Key& key, const Value& value,
                                           bool replace_existing) {
        for (;;) {
            const FastInsertStatus fast =
                try_insert_fast(key, value, replace_existing);
            switch (fast) {
                case FastInsertStatus::inserted:
                    return InsertStatus::inserted;
                case FastInsertStatus::replaced:
                    return InsertStatus::replaced;
                case FastInsertStatus::duplicate:
                    return InsertStatus::duplicate;
                case FastInsertStatus::needs_structural:
                    break;
            }
            break;
        }

        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();
        begin_structural_transaction();
        try {
            LockedPath path = lock_path(key);
            Node* leaf = path.nodes.back();
            const page_id leaf_id = path.ids.back();
            auto leaf_data = stable_snapshot(leaf);
            const std::size_t position = leaf_lower_bound(*leaf_data, key);
            const bool exists =
                position < leaf_data->keys.size() &&
                key_equal(leaf_data->keys[position], key);

            if (exists) {
                if (replace_existing) {
                    auto updated =
                        std::make_shared<NodeData>(*leaf_data);
                    updated->values[position] = value;
                    publish_structural(leaf_id, std::move(updated));
                }
                maybe_fault(FaultPoint::before_commit);
                commit_structural_transaction();
                return replace_existing ? InsertStatus::replaced
                                        : InsertStatus::duplicate;
            }

            auto updated = std::make_shared<NodeData>(*leaf_data);
            updated->keys.insert(updated->keys.begin() + position, key);
            updated->values.insert(updated->values.begin() + position, value);

            if (updated->keys.size() <= options_.leaf_max_keys) {
                publish_structural(leaf_id, std::move(updated));
                maybe_fault(FaultPoint::before_commit);
                size_.fetch_add(1, std::memory_order_acq_rel);
                commit_structural_transaction();
                return InsertStatus::inserted;
            }

            const std::size_t split_point = updated->keys.size() / 2;
            auto left = std::make_shared<NodeData>(*updated);
            auto right = std::make_shared<NodeData>();
            right->kind = NodeKind::leaf;
            right->keys.assign(updated->keys.begin() + split_point,
                               updated->keys.end());
            right->values.assign(updated->values.begin() + split_point,
                                 updated->values.end());
            left->keys.resize(split_point);
            left->values.resize(split_point);

            const page_id right_id = allocate_page(NodeKind::leaf);
            const page_id old_next = leaf_data->next;
            right->next = old_next;
            right->prev = leaf_id;
            left->next = right_id;

            publish(page_or_throw(right_id), right);
            publish_structural(leaf_id, left);
            maybe_fault(FaultPoint::after_leaf_split);

            maybe_fault(FaultPoint::before_sibling_update);
            if (old_next != invalid_page) {
                auto next_data =
                    stable_snapshot(page_or_throw(old_next));
                auto next_updated =
                    std::make_shared<NodeData>(*next_data);
                next_updated->prev = right_id;
                publish_structural(old_next, std::move(next_updated));
            }
            maybe_fault(FaultPoint::after_sibling_update);

            Key promote = right->keys.front();
            page_id right_child = right_id;
            std::size_t child_position = path.positions.back();
            bool root_split = false;

            if (path.ids.size() == 1) {
                auto new_root_data = std::make_shared<NodeData>();
                new_root_data->kind = NodeKind::internal;
                new_root_data->keys.push_back(promote);
                new_root_data->children.push_back(leaf_id);
                new_root_data->children.push_back(right_child);
                const page_id new_root = allocate_page(NodeKind::internal);
                publish(page_or_throw(new_root), new_root_data);
                replace_root(new_root);
            } else {

                for (std::ptrdiff_t level =
                         static_cast<std::ptrdiff_t>(path.ids.size()) - 2;
                     level >= 0; --level) {
                const page_id parent_id = path.ids[static_cast<std::size_t>(
                    level)];
                auto parent_data =
                    stable_snapshot(page_or_throw(parent_id));
                auto parent_updated =
                    std::make_shared<NodeData>(*parent_data);

                if (child_position > parent_updated->children.size()) {
                    throw std::logic_error(
                        "dlks::BPlusTree: invalid child position");
                }
                parent_updated->keys.insert(
                    parent_updated->keys.begin() +
                        static_cast<std::ptrdiff_t>(child_position),
                    promote);
                parent_updated->children.insert(
                    parent_updated->children.begin() +
                        static_cast<std::ptrdiff_t>(child_position + 1),
                    right_child);

                maybe_fault(FaultPoint::before_parent_link);
                if (parent_updated->keys.size() <=
                    options_.internal_max_keys) {
                    publish_structural(parent_id, parent_updated);
                    maybe_fault(FaultPoint::after_parent_link);
                    break;
                }

                const std::size_t total_children =
                    parent_updated->children.size();
                const std::size_t middle = total_children / 2;
                auto internal_left =
                    std::make_shared<NodeData>(*parent_updated);
                auto internal_right = std::make_shared<NodeData>();
                internal_right->kind = NodeKind::internal;
                promote = parent_updated->keys[middle - 1];
                internal_left->keys.assign(
                    parent_updated->keys.begin(),
                    parent_updated->keys.begin() +
                        static_cast<std::ptrdiff_t>(middle - 1));
                internal_left->children.assign(
                    parent_updated->children.begin(),
                    parent_updated->children.begin() +
                        static_cast<std::ptrdiff_t>(middle));
                internal_right->keys.assign(
                    parent_updated->keys.begin() +
                        static_cast<std::ptrdiff_t>(middle),
                    parent_updated->keys.end());
                internal_right->children.assign(
                    parent_updated->children.begin() +
                        static_cast<std::ptrdiff_t>(middle),
                    parent_updated->children.end());

                const page_id new_right =
                    allocate_page(NodeKind::internal);
                publish(page_or_throw(new_right), internal_right);
                publish_structural(parent_id, internal_left);
                maybe_fault(FaultPoint::after_parent_link);

                    if (level == 0) {
                        root_split = true;
                        right_child = new_right;
                        break;
                    }

                    child_position =
                        path.positions[static_cast<std::size_t>(level)];
                    right_child = new_right;
                }

                if (root_split) {
                    auto new_root_data = std::make_shared<NodeData>();
                    new_root_data->kind = NodeKind::internal;
                    new_root_data->keys.push_back(promote);
                    new_root_data->children.push_back(path.ids.front());
                    new_root_data->children.push_back(right_child);
                    const page_id new_root =
                        allocate_page(NodeKind::internal);
                    publish(page_or_throw(new_root), new_root_data);
                    replace_root(new_root);
                }
            }

            maybe_fault(FaultPoint::before_commit);
            size_.fetch_add(1, std::memory_order_acq_rel);
            commit_structural_transaction();
            return InsertStatus::inserted;
        } catch (...) {
            if (options_.auto_rollback_on_exception) {
                rollback_structural_transaction();
            } else {
                recovery_pending_.store(true, std::memory_order_release);
            }
            throw;
        }
    }

    [[nodiscard]] FastInsertStatus try_insert_fast(
        const Key& key, const Value& value, bool replace_existing) {
        std::shared_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        const page_id root = root_.load(std::memory_order_acquire);
        Node* root_node = page_or_throw(root);
        const auto root_data = stable_snapshot(root_node);

        if (root_data->kind == NodeKind::leaf) {
            std::unique_lock<std::shared_mutex> leaf_lock(root_node->latch);
            return insert_into_locked_leaf(root_node, key, value,
                                           replace_existing);
        }

        std::shared_lock<std::shared_mutex> current_lock(root_node->latch);
        Node* current = root_node;

        for (std::size_t depth = 0; depth < max_depth; ++depth) {
            const auto data = stable_snapshot(current);
            if (data->kind == NodeKind::leaf) {
                throw std::logic_error(
                    "dlks::BPlusTree: unexpected leaf in traversal");
            }
            const std::size_t child_index = route_index(data->keys, key);
            if (child_index >= data->children.size()) {
                throw std::logic_error(
                    "dlks::BPlusTree: internal routing out of range");
            }
            Node* child = page_or_throw(data->children[child_index]);
            const auto child_data = stable_snapshot(child);

            if (child_data->kind == NodeKind::leaf) {
                std::unique_lock<std::shared_mutex> leaf_lock(child->latch);
                current_lock.unlock();
                return insert_into_locked_leaf(child, key, value,
                                               replace_existing);
            }

            std::shared_lock<std::shared_mutex> child_lock(child->latch);
            current_lock = std::move(child_lock);
            current = child;
        }

        throw std::logic_error("dlks::BPlusTree: depth limit exceeded");
    }

    [[nodiscard]] FastInsertStatus insert_into_locked_leaf(
        Node* leaf, const Key& key, const Value& value,
        bool replace_existing) {
        const auto data = stable_snapshot(leaf);
        if (data->kind != NodeKind::leaf) {
            throw std::logic_error(
                "dlks::BPlusTree: expected a leaf under lock");
        }
        const std::size_t position = leaf_lower_bound(*data, key);
        if (position < data->keys.size() &&
            key_equal(data->keys[position], key)) {
            if (!replace_existing) {
                return FastInsertStatus::duplicate;
            }
            auto updated = std::make_shared<NodeData>(*data);
            updated->values[position] = value;
            publish(leaf, std::move(updated));
            return FastInsertStatus::replaced;
        }

        if (data->keys.size() >= options_.leaf_max_keys) {
            return FastInsertStatus::needs_structural;
        }

        auto updated = std::make_shared<NodeData>(*data);
        updated->keys.insert(updated->keys.begin() +
                                 static_cast<std::ptrdiff_t>(position),
                             key);
        updated->values.insert(updated->values.begin() +
                                   static_cast<std::ptrdiff_t>(position),
                               value);
        publish(leaf, std::move(updated));
        size_.fetch_add(1, std::memory_order_acq_rel);
        return FastInsertStatus::inserted;
    }

    [[nodiscard]] bool erase_impl(const Key& key) {
        for (;;) {
            const FastEraseStatus fast = try_erase_fast(key);
            if (fast == FastEraseStatus::erased) {
                return true;
            }
            if (fast == FastEraseStatus::absent) {
                return false;
            }
            break;
        }

        std::unique_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        auto reader = pages_.pin();
        begin_structural_transaction();
        try {
            LockedPath path = lock_path(key);
            Node* leaf = path.nodes.back();
            const page_id leaf_id = path.ids.back();
            const auto leaf_data = stable_snapshot(leaf);
            const std::size_t position = leaf_lower_bound(*leaf_data, key);
            if (position >= leaf_data->keys.size() ||
                !key_equal(leaf_data->keys[position], key)) {
                maybe_fault(FaultPoint::before_commit);
                commit_structural_transaction();
                return false;
            }

            auto updated = std::make_shared<NodeData>(*leaf_data);
            updated->keys.erase(updated->keys.begin() +
                                static_cast<std::ptrdiff_t>(position));
            updated->values.erase(updated->values.begin() +
                                  static_cast<std::ptrdiff_t>(position));
            publish_structural(leaf_id, updated);

            if (path.ids.size() > 1 &&
                updated->keys.size() < options_.leaf_min_keys) {
                rebalance(path, path.ids.size() - 1);
            }

            maybe_fault(FaultPoint::before_commit);
            size_.fetch_sub(1, std::memory_order_acq_rel);
            commit_structural_transaction();
            return true;
        } catch (...) {
            if (options_.auto_rollback_on_exception) {
                rollback_structural_transaction();
            } else {
                recovery_pending_.store(true, std::memory_order_release);
            }
            throw;
        }
    }

    [[nodiscard]] FastEraseStatus try_erase_fast(const Key& key) {
        std::shared_lock<std::shared_mutex> topology(topology_mutex_);
        throw_if_recovery_pending();
        const page_id root = root_.load(std::memory_order_acquire);
        Node* root_node = page_or_throw(root);
        const auto root_data = stable_snapshot(root_node);

        if (root_data->kind == NodeKind::leaf) {
            std::unique_lock<std::shared_mutex> leaf_lock(root_node->latch);
            return erase_from_locked_leaf(root_node, root, key);
        }

        std::shared_lock<std::shared_mutex> current_lock(root_node->latch);
        Node* current = root_node;

        for (std::size_t depth = 0; depth < max_depth; ++depth) {
            const auto data = stable_snapshot(current);
            if (data->kind == NodeKind::leaf) {
                throw std::logic_error(
                    "dlks::BPlusTree: unexpected leaf in traversal");
            }
            const std::size_t child_index = route_index(data->keys, key);
            if (child_index >= data->children.size()) {
                throw std::logic_error(
                    "dlks::BPlusTree: internal routing out of range");
            }
            Node* child = page_or_throw(data->children[child_index]);
            const auto child_data = stable_snapshot(child);

            if (child_data->kind == NodeKind::leaf) {
                std::unique_lock<std::shared_mutex> leaf_lock(child->latch);
                current_lock.unlock();
                return erase_from_locked_leaf(child, root, key);
            }

            std::shared_lock<std::shared_mutex> child_lock(child->latch);
            current_lock = std::move(child_lock);
            current = child;
        }

        throw std::logic_error("dlks::BPlusTree: depth limit exceeded");
    }

    [[nodiscard]] FastEraseStatus erase_from_locked_leaf(
        Node* leaf, page_id root, const Key& key) {
        const auto data = stable_snapshot(leaf);
        if (data->kind != NodeKind::leaf) {
            throw std::logic_error(
                "dlks::BPlusTree: expected a leaf under lock");
        }
        const std::size_t position = leaf_lower_bound(*data, key);
        if (position >= data->keys.size() ||
            !key_equal(data->keys[position], key)) {
            return FastEraseStatus::absent;
        }

        const bool is_root = leaf == page_or_throw(root);
        if (!is_root && data->keys.size() <= options_.leaf_min_keys) {
            return FastEraseStatus::needs_structural;
        }

        auto updated = std::make_shared<NodeData>(*data);
        updated->keys.erase(updated->keys.begin() +
                            static_cast<std::ptrdiff_t>(position));
        updated->values.erase(updated->values.begin() +
                              static_cast<std::ptrdiff_t>(position));
        publish(leaf, std::move(updated));
        size_.fetch_sub(1, std::memory_order_acq_rel);
        return FastEraseStatus::erased;
    }

    [[nodiscard]] LockedPath lock_path(const Key& key) {
        LockedPath path;
        page_id id = root_.load(std::memory_order_acquire);
        std::size_t position = 0;

        for (std::size_t depth = 0; depth < max_depth; ++depth) {
            Node* node = page_or_throw(id);
            path.locks.emplace_back(node->latch);
            path.nodes.push_back(node);
            path.ids.push_back(id);
            path.positions.push_back(position);

            const auto data = stable_snapshot(node);
            if (data->kind == NodeKind::leaf) {
                return path;
            }
            const std::size_t child = route_index(data->keys, key);
            if (child >= data->children.size()) {
                throw std::logic_error(
                    "dlks::BPlusTree: internal routing out of range");
            }
            position = child;
            id = data->children[child];
        }

        throw std::logic_error("dlks::BPlusTree: depth limit exceeded");
    }

    [[nodiscard]] std::size_t child_index(const NodeData& parent,
                                          page_id child) const {
        const auto it =
            std::find(parent.children.begin(), parent.children.end(), child);
        if (it == parent.children.end()) {
            throw std::logic_error(
                "dlks::BPlusTree: child is absent from parent");
        }
        return static_cast<std::size_t>(
            std::distance(parent.children.begin(), it));
    }

    void rebalance(LockedPath& path, std::size_t level) {
        for (;;) {
            if (level == 0) {
                const auto root_data =
                    stable_snapshot(page_or_throw(path.ids[0]));
                if (root_data->kind == NodeKind::internal &&
                    root_data->children.size() == 1) {
                    const page_id old_root = path.ids[0];
                    replace_root(root_data->children.front());
                    retire_after_commit(old_root);
                }
                return;
            }

            const auto node_data =
                stable_snapshot(page_or_throw(path.ids[level]));
            const bool is_leaf = node_data->kind == NodeKind::leaf;
            const bool underflow =
                is_leaf
                    ? node_data->keys.size() < options_.leaf_min_keys
                    : node_data->children.size() <
                          options_.internal_min_children;
            if (!underflow) {
                return;
            }

            const auto parent_data =
                stable_snapshot(page_or_throw(path.ids[level - 1]));
            if (parent_data->kind != NodeKind::internal) {
                throw std::logic_error(
                    "dlks::BPlusTree: leaf has a leaf parent");
            }
            const std::size_t index =
                child_index(*parent_data, path.ids[level]);

            if (parent_data->children.size() == 1) {
                if (level - 1 == 0) {
                    const page_id old_root = path.ids[0];
                    replace_root(path.ids[level]);
                    retire_after_commit(old_root);
                    return;
                }
                throw std::logic_error(
                    "dlks::BPlusTree: non-root parent has one child");
            }

            const std::size_t left_index =
                index == 0 ? index : index - 1;
            const std::size_t right_index = left_index + 1;
            const page_id left_id = parent_data->children[left_index];
            const page_id right_id = parent_data->children[right_index];

            if (is_leaf) {
                const auto left =
                    stable_snapshot(page_or_throw(left_id));
                const auto right =
                    stable_snapshot(page_or_throw(right_id));
                const std::size_t combined =
                    left->keys.size() + right->keys.size();

                if (combined <= options_.leaf_max_keys) {
                    auto merged = std::make_shared<NodeData>(*left);
                    merged->keys.insert(merged->keys.end(),
                                        right->keys.begin(),
                                        right->keys.end());
                    merged->values.insert(merged->values.end(),
                                          right->values.begin(),
                                          right->values.end());
                    merged->next = right->next;
                    publish_structural(left_id, merged);

                    if (right->next != invalid_page) {
                        auto next = stable_snapshot(
                            page_or_throw(right->next));
                        auto next_updated =
                            std::make_shared<NodeData>(*next);
                        next_updated->prev = left_id;
                        publish_structural(right->next,
                                           std::move(next_updated));
                    }
                    maybe_fault(FaultPoint::after_sibling_update);

                    auto parent_updated =
                        std::make_shared<NodeData>(*parent_data);
                    parent_updated->children.erase(
                        parent_updated->children.begin() +
                        static_cast<std::ptrdiff_t>(right_index));
                    parent_updated->keys.erase(
                        parent_updated->keys.begin() +
                        static_cast<std::ptrdiff_t>(right_index - 1));
                    maybe_fault(FaultPoint::before_parent_link);
                    publish_structural(path.ids[level - 1],
                                       std::move(parent_updated));
                    maybe_fault(FaultPoint::after_parent_link);
                    retire_after_commit(right_id);
                    --level;
                    continue;
                }

                const std::size_t left_count = combined / 2;
                auto left_updated =
                    std::make_shared<NodeData>(*left);
                auto right_updated =
                    std::make_shared<NodeData>(*right);
                left_updated->keys.clear();
                left_updated->values.clear();
                right_updated->keys.clear();
                right_updated->values.clear();

                std::size_t seen = 0;
                for (const Key& key : left->keys) {
                    if (seen < left_count) {
                        left_updated->keys.push_back(key);
                        left_updated->values.push_back(
                            left->values[seen]);
                    } else {
                        right_updated->keys.push_back(key);
                        right_updated->values.push_back(
                            left->values[seen]);
                    }
                    ++seen;
                }
                for (std::size_t offset = 0; offset < right->keys.size();
                     ++offset) {
                    if (seen < left_count) {
                        left_updated->keys.push_back(right->keys[offset]);
                        left_updated->values.push_back(
                            right->values[offset]);
                    } else {
                        right_updated->keys.push_back(right->keys[offset]);
                        right_updated->values.push_back(
                            right->values[offset]);
                    }
                    ++seen;
                }
                publish_structural(left_id, left_updated);
                publish_structural(right_id, right_updated);

                auto parent_updated =
                    std::make_shared<NodeData>(*parent_data);
                parent_updated->keys[right_index - 1] =
                    right_updated->keys.front();
                maybe_fault(FaultPoint::before_parent_link);
                publish_structural(path.ids[level - 1],
                                   std::move(parent_updated));
                maybe_fault(FaultPoint::after_parent_link);
                return;
            }

            const auto left = stable_snapshot(page_or_throw(left_id));
            const auto right = stable_snapshot(page_or_throw(right_id));
            const std::size_t combined_child_count =
                left->children.size() + right->children.size();

            if (combined_child_count <=
                options_.internal_max_keys + 1) {
                auto merged = std::make_shared<NodeData>(*left);
                merged->keys.push_back(parent_data->keys[right_index - 1]);
                merged->keys.insert(merged->keys.end(),
                                    right->keys.begin(),
                                    right->keys.end());
                merged->children.insert(merged->children.end(),
                                        right->children.begin(),
                                        right->children.end());
                publish_structural(left_id, std::move(merged));

                auto parent_updated =
                    std::make_shared<NodeData>(*parent_data);
                parent_updated->children.erase(
                    parent_updated->children.begin() +
                    static_cast<std::ptrdiff_t>(right_index));
                parent_updated->keys.erase(
                    parent_updated->keys.begin() +
                    static_cast<std::ptrdiff_t>(right_index - 1));
                maybe_fault(FaultPoint::before_parent_link);
                publish_structural(path.ids[level - 1],
                                   std::move(parent_updated));
                maybe_fault(FaultPoint::after_parent_link);
                retire_after_commit(right_id);
                --level;
                continue;
            }

            std::vector<Key> combined_keys;
            combined_keys.reserve(left->keys.size() + right->keys.size() +
                                  1);
            combined_keys.insert(combined_keys.end(), left->keys.begin(),
                                 left->keys.end());
            combined_keys.push_back(parent_data->keys[right_index - 1]);
            combined_keys.insert(combined_keys.end(), right->keys.begin(),
                                 right->keys.end());

            std::vector<page_id> combined_children;
            combined_children.reserve(combined_child_count);
            combined_children.insert(combined_children.end(),
                                     left->children.begin(),
                                     left->children.end());
            combined_children.insert(combined_children.end(),
                                     right->children.begin(),
                                     right->children.end());

            std::size_t left_children = combined_children.size() / 2;
            left_children =
                std::max(left_children, options_.internal_min_children);
            if (left_children >= combined_children.size()) {
                throw std::logic_error(
                    "dlks::BPlusTree: invalid internal redistribution");
            }

            auto left_updated = std::make_shared<NodeData>(*left);
            auto right_updated = std::make_shared<NodeData>(*right);
            left_updated->keys.assign(
                combined_keys.begin(),
                combined_keys.begin() +
                    static_cast<std::ptrdiff_t>(left_children - 1));
            left_updated->children.assign(
                combined_children.begin(),
                combined_children.begin() +
                    static_cast<std::ptrdiff_t>(left_children));
            const Key promote = combined_keys[left_children - 1];
            right_updated->keys.assign(
                combined_keys.begin() +
                    static_cast<std::ptrdiff_t>(left_children),
                combined_keys.end());
            right_updated->children.assign(
                combined_children.begin() +
                    static_cast<std::ptrdiff_t>(left_children),
                combined_children.end());

            publish_structural(left_id, left_updated);
            publish_structural(right_id, right_updated);

            auto parent_updated =
                std::make_shared<NodeData>(*parent_data);
            parent_updated->keys[right_index - 1] = promote;
            maybe_fault(FaultPoint::before_parent_link);
            publish_structural(path.ids[level - 1],
                               std::move(parent_updated));
            maybe_fault(FaultPoint::after_parent_link);
            return;
        }
    }

    [[nodiscard]] page_id leftmost_leaf() const {
        page_id id = root_.load(std::memory_order_acquire);
        for (std::size_t depth = 0; depth < max_depth; ++depth) {
            const auto data = stable_snapshot(page_or_throw(id));
            if (data->kind == NodeKind::leaf) {
                return id;
            }
            if (data->children.empty()) {
                throw std::logic_error(
                    "dlks::BPlusTree: internal page has no children");
            }
            id = data->children.front();
        }
        throw std::logic_error("dlks::BPlusTree: depth limit exceeded");
    }

    [[nodiscard]] std::vector<page_id> collect_page_ids(
        page_id root) const {
        std::vector<page_id> result;
        std::vector<page_id> stack{root};
        std::unordered_set<page_id> seen;
        while (!stack.empty()) {
            const page_id id = stack.back();
            stack.pop_back();
            if (!seen.insert(id).second) {
                continue;
            }
            result.push_back(id);
            const auto data = stable_snapshot(page_or_throw(id));
            for (const page_id child : data->children) {
                stack.push_back(child);
            }
        }
        return result;
    }

    static void fail_invariant(const std::string& message) {
        throw InvariantFailure(message);
    }

    void validate_node(page_id id, bool is_root, std::size_t depth,
                       const std::optional<Key>& lower,
                       const std::optional<Key>& upper,
                       std::vector<bool>& visited,
                       std::vector<page_id>& reachable_leaves,
                       std::size_t& leaf_depth, std::size_t& entries,
                       bool check_occupancy, InvariantReport& report) const {
        if (id >= pages_.capacity()) {
            fail_invariant("page id is out of range");
        }
        if (visited[id]) {
            fail_invariant("page graph contains a cycle or shared child");
        }
        visited[id] = true;
        ++report.reachable_pages;

        const Node* node = page_or_throw(id);
        if ((node->version.load(std::memory_order_acquire) & 1U) != 0U) {
            fail_invariant("page version is odd in a quiescent tree");
        }
        const auto data = stable_snapshot(node);

        const auto check_bounds = [&](const Key& key) {
            if (lower.has_value() && compare_(key, *lower)) {
                fail_invariant("key is below its separator lower bound");
            }
            if (upper.has_value() && !compare_(key, *upper)) {
                fail_invariant("key is at or above its separator upper bound");
            }
        };

        for (std::size_t index = 0; index < data->keys.size(); ++index) {
            if (index > 0 &&
                !compare_(data->keys[index - 1], data->keys[index])) {
                fail_invariant("page keys are not strictly increasing");
            }
            check_bounds(data->keys[index]);
        }

        if (data->kind == NodeKind::leaf) {
            if (!data->children.empty()) {
                fail_invariant("leaf page has children");
            }
            if (data->keys.size() != data->values.size()) {
                fail_invariant("leaf key/value arity differs");
            }
            if (check_occupancy) {
                if (data->keys.size() > options_.leaf_max_keys) {
                    fail_invariant("leaf exceeds maximum occupancy");
                }
                if (!is_root &&
                    data->keys.size() < options_.leaf_min_keys) {
                    fail_invariant("non-root leaf is below minimum occupancy");
                }
            }
            if (leaf_depth == 0) {
                leaf_depth = depth;
            } else if (leaf_depth != depth) {
                fail_invariant("leaves occur at different depths");
            }
            report.height = std::max(report.height, depth + 1);
            entries += data->keys.size();
            reachable_leaves.push_back(id);
            return;
        }

        ++report.internal_pages;
        if (!data->values.empty()) {
            fail_invariant("internal page has values");
        }
        if (data->children.size() != data->keys.size() + 1) {
            fail_invariant("internal key/child arity differs");
        }
        if (data->children.empty()) {
            fail_invariant("internal page has no children");
        }
        if (check_occupancy) {
            if (data->keys.size() > options_.internal_max_keys) {
                fail_invariant("internal page exceeds maximum occupancy");
            }
            if (is_root) {
                if (data->children.size() < 2) {
                    fail_invariant(
                        "root internal page was not collapsed");
                }
            } else if (data->children.size() <
                       options_.internal_min_children) {
                fail_invariant(
                    "non-root internal page is below minimum occupancy");
            }
        }

        for (std::size_t index = 0; index < data->children.size();
             ++index) {
            std::optional<Key> child_lower = lower;
            std::optional<Key> child_upper = upper;
            if (index > 0) {
                child_lower = data->keys[index - 1];
            }
            if (index < data->keys.size()) {
                child_upper = data->keys[index];
            }
            validate_node(data->children[index], false, depth + 1,
                          child_lower, child_upper, visited,
                          reachable_leaves, leaf_depth, entries,
                          check_occupancy, report);
        }
    }

    BPlusTreeOptions options_;
    Compare compare_;
    PageManager<Node> pages_;
    std::atomic<page_id> root_{invalid_page};
    std::atomic<std::size_t> size_{0};
    std::atomic<std::uint64_t> structure_sequence_{0};
    mutable std::shared_mutex topology_mutex_;
    std::optional<ActiveTransaction> active_transaction_;
    std::uint64_t transaction_counter_ = 0;
    RecoveryReport last_recovery_{};
    std::atomic<std::uint64_t> recovery_begun_{0};
    std::atomic<std::uint64_t> recovery_committed_{0};
    std::atomic<std::uint64_t> recovery_rolled_back_{0};
    std::atomic<std::uint64_t> recovery_count_{0};
    std::atomic<bool> recovery_pending_{false};
    mutable std::mutex fault_mutex_;
    std::function<bool(FaultPoint)> fault_injector_;
};

}  // namespace dlks
