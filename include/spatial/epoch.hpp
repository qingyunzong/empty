#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace spatial {

// Teaching-grade epoch-based reclamation (EBR) domain.
//
// Every pin() creates an independent reader record that announces the current
// epoch; a Guard keeps that record alive for the whole read session, so
// multiple concurrent read views in the same thread each retain their own
// announced epoch. Writers retire objects and then advance the global epoch.
// collect() is the barrier: it reclaims exactly those objects whose retire
// epoch is strictly older than every currently-announced reader epoch, i.e.
// objects become reclaimable only after all readers that could still hold a
// reference have passed a quiescent state (unpinned or re-pinned newer).
class EpochDomain {
public:
    struct ThreadRecord {
        std::atomic<bool> active{false};
        std::atomic<std::uint64_t> announced{0};
    };

    // RAII read-side critical section. Movable, not copyable.
    class Guard {
    public:
        Guard(EpochDomain& domain, std::shared_ptr<ThreadRecord> rec)
            : rec_(std::move(rec)) {
            rec_->announced.store(domain.epoch_.load(std::memory_order_acquire),
                                  std::memory_order_seq_cst);
            rec_->active.store(true, std::memory_order_seq_cst);
            // Re-announce after becoming active so a concurrent collect()
            // never observes a stale (too old) epoch from an active reader.
            rec_->announced.store(domain.epoch_.load(std::memory_order_acquire),
                                  std::memory_order_seq_cst);
        }
        ~Guard() {
            if (rec_) rec_->active.store(false, std::memory_order_release);
        }
        Guard(Guard&&) noexcept = default;
        Guard& operator=(Guard&&) noexcept = default;
        Guard(const Guard&) = delete;
        Guard& operator=(const Guard&) = delete;

    private:
        std::shared_ptr<ThreadRecord> rec_;
    };

    EpochDomain() = default;
    ~EpochDomain() {
        for (auto& r : retired_) r.deleter();
    }
    EpochDomain(const EpochDomain&) = delete;
    EpochDomain& operator=(const EpochDomain&) = delete;

    Guard pin() {
        // Allocate and register the record (under the lock) before the Guard
        // announces, so every collect() that can observe the announced epoch
        // is guaranteed to see this reader.
        auto rec = std::make_shared<ThreadRecord>();
        std::lock_guard lk(mutex_);
        records_.emplace_back(rec);
        return Guard(*this, std::move(rec));
    }

    // Retire an object at the current epoch. Call advance() afterwards so
    // that readers pinning later observe a newer epoch.
    template <typename T>
    void retire(T* ptr) {
        std::lock_guard lk(mutex_);
        retired_.push_back({epoch_.load(std::memory_order_acquire),
                            [ptr] { delete ptr; }});
    }

    void advance() { epoch_.fetch_add(1, std::memory_order_acq_rel); }

    // Barrier: reclaim everything retired before the oldest announced epoch
    // among active readers. Returns the number of reclaimed objects.
    std::size_t collect() {
        std::uint64_t min_active = std::numeric_limits<std::uint64_t>::max();
        std::vector<std::function<void()>> reclaim;
        {
            std::lock_guard lk(mutex_);
            for (auto it = records_.begin(); it != records_.end();) {
                const auto rec = it->lock();
                if (!rec) {  // reader thread/session gone: prune
                    it = records_.erase(it);
                    continue;
                }
                if (rec->active.load(std::memory_order_acquire)) {
                    const std::uint64_t a = rec->announced.load(std::memory_order_acquire);
                    if (a < min_active) min_active = a;
                }
                ++it;
            }
            for (auto it = retired_.begin(); it != retired_.end();) {
                if (it->epoch < min_active) {
                    reclaim.push_back(std::move(it->deleter));
                    it = retired_.erase(it);
                } else {
                    ++it;
                }
            }
        }
        for (auto& d : reclaim) d();
        return reclaim.size();
    }

    std::size_t retired_count() const {
        std::lock_guard lk(mutex_);
        return retired_.size();
    }

    std::uint64_t current_epoch() const { return epoch_.load(std::memory_order_acquire); }

private:
    struct Retired {
        std::uint64_t epoch;
        std::function<void()> deleter;
    };

    std::atomic<std::uint64_t> epoch_{0};
    mutable std::mutex mutex_;
    std::vector<std::weak_ptr<ThreadRecord>> records_;
    std::vector<Retired> retired_;
};

}  // namespace spatial
