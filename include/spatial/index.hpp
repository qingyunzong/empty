#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <utility>
#include <vector>

#include "spatial/aabb.hpp"
#include "spatial/reclaimer.hpp"
#include "spatial/snapshot.hpp"

namespace spatial {

// A batch of mutations applied atomically: every upsert and remove in the
// batch becomes visible together, in a single published snapshot. Readers
// holding an older snapshot never observe a partially applied batch.
struct Batch {
    // Insert a new object or move an existing one. Zero-volume boxes are
    // ignored: the upsert is a no-op (an existing object keeps its box).
    std::vector<std::pair<std::uint64_t, Aabb2>> upserts;
    std::vector<std::uint64_t> removes;
};

// Concurrent spatial index with snapshot isolation.
//
// snapshot() returns an immutable view that stays valid forever, regardless
// of later mutations, removals, or id reuse. apply() builds a full new
// snapshot and publishes it atomically; the retired snapshot is handed to
// the reclaimer and freed at the next reclamation barrier once no reader
// references it anymore.
class SpatialIndex {
public:
    explicit SpatialIndex(double cell_size = 1.0)
        : cell_size_(cell_size),
          current_(std::make_shared<const Snapshot>(std::vector<Snapshot::Entry>{},
                                                    cell_size)) {}

    SpatialIndex(const SpatialIndex&) = delete;
    SpatialIndex& operator=(const SpatialIndex&) = delete;

    std::shared_ptr<const Snapshot> snapshot() const {
        return current_.load(std::memory_order_acquire);
    }

    void apply(const Batch& batch) {
        std::lock_guard lk(write_mu_);
        std::shared_ptr<const Snapshot> old =
            current_.load(std::memory_order_relaxed);

        std::unordered_map<std::uint64_t, Aabb2> state;
        state.reserve(old->size() + batch.upserts.size());
        for (const auto& e : old->entries()) state.emplace(e.id, e.box);
        for (std::uint64_t id : batch.removes) state.erase(id);
        for (const auto& [id, box] : batch.upserts) {
            if (box.empty()) continue;  // zero-volume boxes are ignored
            state[id] = box;
        }

        std::vector<Snapshot::Entry> entries;
        entries.reserve(state.size());
        for (const auto& [id, box] : state) entries.push_back({id, box});

        auto next = std::make_shared<const Snapshot>(std::move(entries),
                                                     cell_size_);
        current_.store(std::move(next), std::memory_order_release);
        reclaimer_.retire(std::move(old));
    }

    Reclaimer& reclaimer() { return reclaimer_; }

private:
    double cell_size_;
    std::atomic<std::shared_ptr<const Snapshot>> current_;
    std::mutex write_mu_;
    Reclaimer reclaimer_;
};

}  // namespace spatial
