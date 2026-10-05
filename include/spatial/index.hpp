#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

#include "spatial/aabb.hpp"
#include "spatial/epoch.hpp"

namespace spatial {

// MVCC spatial index over half-open AABBs.
//
// - Every commit() applies a whole batch of upserts/removes atomically: it
//   builds a new immutable snapshot (a bulk-loaded kd-tree) and publishes it
//   with a single atomic swap.
// - open_view() pins the current epoch and hands out a read view onto one
//   immutable snapshot. The view stays valid and unchanged for its whole
//   lifetime, regardless of later commits, removals or id reuse.
// - Replaced snapshots are retired to an epoch domain and reclaimed only
//   after every reader has passed the reclamation barrier (see epoch.hpp).
// - Zero-volume (empty) boxes are ignored: upserting one is a no-op and an
//   empty query range matches nothing.
//
// Writers must be serialized externally or rely on the internal write mutex
// (commit is already thread-safe); readers never block writers.
template <std::size_t Dims, typename Id = std::uint64_t>
class SpatialIndex {
    class Snapshot;  // defined below; referenced by View

public:
    using BoxType = Box<Dims>;

    struct Upsert {
        Id id;
        BoxType box;
    };
    struct Remove {
        Id id;
    };
    using Op = std::variant<Upsert, Remove>;

    SpatialIndex() : current_(new Snapshot({})) {}
    ~SpatialIndex() { delete current_.load(std::memory_order_relaxed); }
    SpatialIndex(const SpatialIndex&) = delete;
    SpatialIndex& operator=(const SpatialIndex&) = delete;

    // Read handle onto one immutable snapshot. Valid while alive.
    class View {
    public:
        View(EpochDomain::Guard guard, const Snapshot* snap)
            : guard_(std::move(guard)), snap_(snap) {}
        View(View&&) = default;
        View& operator=(View&&) = default;
        View(const View&) = delete;
        View& operator=(const View&) = delete;

        // Calls fn(id, box) for every indexed box intersecting `range`.
        template <typename Fn>
        void query(const BoxType& range, Fn&& fn) const {
            snap_->query(range, std::forward<Fn>(fn));
        }

        std::vector<Id> query(const BoxType& range) const {
            std::vector<Id> out;
            snap_->query(range, [&](Id id, const BoxType&) { out.push_back(id); });
            return out;
        }

        std::size_t size() const noexcept { return snap_->size(); }
        bool empty() const noexcept { return snap_->empty(); }

    private:
        EpochDomain::Guard guard_;
        const Snapshot* snap_;
    };

    View open_view() const {
        // Order matters: pin (announce epoch) first, then load the snapshot
        // pointer. Anything retired before our announced epoch is unreachable
        // through current_, and anything reachable is protected by it.
        auto guard = domain_.pin();
        return View(std::move(guard), current_.load(std::memory_order_acquire));
    }

    // Applies the whole batch as one atomic version transition.
    void commit(const std::vector<Op>& ops) {
        std::lock_guard lk(write_mutex_);
        auto next_entries = entries_;
        for (const auto& op : ops) {
            if (const auto* up = std::get_if<Upsert>(&op)) {
                if (up->box.empty()) continue;  // zero volume: ignored
                next_entries[up->id] = up->box;
            } else {
                next_entries.erase(std::get<Remove>(op).id);
            }
        }
        auto* next = new Snapshot(next_entries);
        Snapshot* old = current_.exchange(next, std::memory_order_acq_rel);
        entries_ = std::move(next_entries);
        domain_.retire(old);
        domain_.advance();
        domain_.collect();  // opportunistic; blocked by any pinned old view
    }

    // Barrier reclamation entry points (also used by tests).
    std::size_t collect() { return domain_.collect(); }
    std::size_t retired_count() const { return domain_.retired_count(); }
    static std::size_t live_snapshot_count() {
        return Snapshot::live_instances.load(std::memory_order_acquire);
    }

private:
    struct Entry {
        BoxType box;
        Id id;
    };
    struct Node {
        Entry entry;
        BoxType bounds;  // tight bounds of the whole subtree
    };

    // Immutable bulk-loaded kd-tree. Nodes are stored at their inorder
    // position: the node covering index range [lo, hi) lives at its median,
    // so every position in [0, n) is used exactly once.
    class Snapshot {
    public:
        explicit Snapshot(const std::unordered_map<Id, BoxType>& entries) {
            std::vector<Entry> tmp;
            tmp.reserve(entries.size());
            for (const auto& [id, box] : entries)
                if (!box.empty()) tmp.push_back({box, id});
            nodes_.resize(tmp.size());
            if (!tmp.empty()) build(tmp, 0, tmp.size(), 0);
            live_instances.fetch_add(1, std::memory_order_relaxed);
        }
        ~Snapshot() { live_instances.fetch_sub(1, std::memory_order_relaxed); }
        Snapshot(const Snapshot&) = delete;
        Snapshot& operator=(const Snapshot&) = delete;

        std::size_t size() const noexcept { return nodes_.size(); }
        bool empty() const noexcept { return nodes_.empty(); }

        template <typename Fn>
        void query(const BoxType& range, Fn&& fn) const {
            if (range.empty() || nodes_.empty()) return;
            std::vector<std::pair<std::size_t, std::size_t>> stack;
            stack.emplace_back(0, nodes_.size());
            while (!stack.empty()) {
                const auto [lo, hi] = stack.back();
                stack.pop_back();
                const std::size_t mid = lo + (hi - lo) / 2;
                const Node& node = nodes_[mid];
                if (!intersects(node.bounds, range)) continue;
                if (intersects(node.entry.box, range)) fn(node.entry.id, node.entry.box);
                if (mid > lo) stack.emplace_back(lo, mid);
                if (mid + 1 < hi) stack.emplace_back(mid + 1, hi);
            }
        }

        inline static std::atomic<std::size_t> live_instances{0};

    private:
        BoxType build(std::vector<Entry>& tmp, std::size_t lo, std::size_t hi,
                      std::size_t dim) {
            const std::size_t mid = lo + (hi - lo) / 2;
            std::nth_element(tmp.begin() + static_cast<std::ptrdiff_t>(lo),
                             tmp.begin() + static_cast<std::ptrdiff_t>(mid),
                             tmp.begin() + static_cast<std::ptrdiff_t>(hi),
                             [dim](const Entry& a, const Entry& b) {
                                 return a.box.min[dim] < b.box.min[dim];
                             });
            nodes_[mid].entry = tmp[mid];
            BoxType bounds = tmp[mid].box;
            const std::size_t next = (dim + 1) % Dims;
            if (mid > lo) merge(bounds, build(tmp, lo, mid, next));
            if (mid + 1 < hi) merge(bounds, build(tmp, mid + 1, hi, next));
            nodes_[mid].bounds = bounds;
            return bounds;
        }

        static void merge(BoxType& a, const BoxType& b) {
            for (std::size_t i = 0; i < Dims; ++i) {
                a.min[i] = std::min(a.min[i], b.min[i]);
                a.max[i] = std::max(a.max[i], b.max[i]);
            }
        }

        std::vector<Node> nodes_;
    };

    mutable EpochDomain domain_;
    std::atomic<Snapshot*> current_;
    std::mutex write_mutex_;
    std::unordered_map<Id, BoxType> entries_;
};

}  // namespace spatial
