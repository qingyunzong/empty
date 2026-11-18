#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace dlks {

using page_id = std::uint64_t;
inline constexpr page_id invalid_page = std::numeric_limits<page_id>::max();

// Epoch-based read-side protection.
//
// A reader pins the current epoch before it dereferences a page.  Retiring a
// page advances the global epoch, so every reader that could have observed the
// page has an epoch strictly smaller than the retirement epoch.  The page may
// only be reclaimed after all such readers have left their critical section.
class EpochManager {
public:
    static constexpr std::size_t max_readers = 256;

    class ReaderGuard {
    public:
        ReaderGuard() noexcept = default;
        ReaderGuard(const ReaderGuard&) = delete;
        ReaderGuard& operator=(const ReaderGuard&) = delete;

        ReaderGuard(ReaderGuard&& other) noexcept
            : owner_(other.owner_), slot_(other.slot_), epoch_(other.epoch_) {
            other.owner_ = nullptr;
            other.slot_ = 0;
        }

        ReaderGuard& operator=(ReaderGuard&& other) noexcept {
            if (this != &other) {
                release();
                owner_ = other.owner_;
                slot_ = other.slot_;
                epoch_ = other.epoch_;
                other.owner_ = nullptr;
                other.slot_ = 0;
            }
            return *this;
        }

        ~ReaderGuard() { release(); }

        [[nodiscard]] std::uint64_t epoch() const noexcept { return epoch_; }
        [[nodiscard]] explicit operator bool() const noexcept {
            return owner_ != nullptr;
        }

    private:
        friend class EpochManager;

        ReaderGuard(EpochManager* owner, std::size_t slot,
                    std::uint64_t epoch) noexcept
            : owner_(owner), slot_(slot), epoch_(epoch) {}

        void release() noexcept {
            if (owner_ != nullptr) {
                owner_->slots_[slot_].active.store(false, std::memory_order_release);
                owner_ = nullptr;
            }
        }

        EpochManager* owner_ = nullptr;
        std::size_t slot_ = 0;
        std::uint64_t epoch_ = 0;
    };

    ReaderGuard pin() const {
        const std::uint64_t observed =
            epoch_.load(std::memory_order_acquire);

        for (std::size_t attempt = 0; attempt < max_readers * 2; ++attempt) {
            const std::size_t candidate =
                next_slot_.fetch_add(1, std::memory_order_relaxed) %
                max_readers;
            bool expected = false;
            if (slots_[candidate].active.compare_exchange_strong(
                    expected, true, std::memory_order_acq_rel,
                    std::memory_order_relaxed)) {
                // Publish the epoch after publishing the active bit.  A
                // reclaimer that races with this store sees the previous,
                // conservatively older, epoch and therefore cannot reuse the
                // page too early.
                slots_[candidate].epoch.store(observed,
                                              std::memory_order_release);
                return ReaderGuard(const_cast<EpochManager*>(this),
                                   candidate, observed);
            }
        }

        throw std::runtime_error("dlks::EpochManager: reader slot exhaustion");
    }

    // Advances to a new epoch and returns it.  Page retirement uses the returned
    // value as its reclamation barrier.
    std::uint64_t advance() noexcept {
        return epoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
    }

    [[nodiscard]] std::uint64_t current() const noexcept {
        return epoch_.load(std::memory_order_acquire);
    }

    [[nodiscard]] std::size_t active_readers() const noexcept {
        std::size_t count = 0;
        for (const auto& slot : slots_) {
            if (slot.active.load(std::memory_order_acquire)) {
                ++count;
            }
        }
        return count;
    }

    // A page retired at `retired_epoch` is safe once no reader pinned before
    // that retirement remains active.
    [[nodiscard]] bool safe_to_reclaim(std::uint64_t retired_epoch) const
        noexcept {
        for (const auto& slot : slots_) {
            if (!slot.active.load(std::memory_order_acquire)) {
                continue;
            }
            const std::uint64_t reader_epoch =
                slot.epoch.load(std::memory_order_acquire);
            if (reader_epoch < retired_epoch) {
                return false;
            }
        }
        return true;
    }

private:
    struct alignas(64) Slot {
        std::atomic<bool> active{false};
        std::atomic<std::uint64_t> epoch{0};
    };

    mutable std::array<Slot, max_readers> slots_{};
    std::atomic<std::uint64_t> epoch_{1};
    mutable std::atomic<std::size_t> next_slot_{0};
};

// A fixed-capacity page arena.  The arena owns page objects, but callers own
// their contents.  Page identifiers are never recycled while a reader that
// could still observe the retired page is pinned.
template <typename Page>
class PageManager {
public:
    explicit PageManager(std::size_t capacity)
        : capacity_(capacity),
          slots_(std::make_unique<std::atomic<Page*>[]>(capacity)),
          state_(capacity, 0) {
        if (capacity == 0) {
            throw std::invalid_argument(
                "dlks::PageManager: capacity must be non-zero");
        }
        for (std::size_t index = 0; index < capacity_; ++index) {
            slots_[index].store(nullptr, std::memory_order_relaxed);
        }
    }

    ~PageManager() {
        for (std::size_t index = 0; index < capacity_; ++index) {
            delete slots_[index].load(std::memory_order_relaxed);
        }
    }

    PageManager(const PageManager&) = delete;
    PageManager& operator=(const PageManager&) = delete;

    template <typename... Args>
    page_id create(Args&&... args) {
        page_id id = allocate_id();
        Page* page = nullptr;
        try {
            page = new Page(std::forward<Args>(args)...);
        } catch (...) {
            std::lock_guard<std::mutex> lock(mutex_);
            free_ids_.push_back(id);
            throw;
        }

        slots_[id].store(page, std::memory_order_release);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            state_[id] = 1;
            ++live_pages_;
        }
        return id;
    }

    [[nodiscard]] Page* get(page_id id) const noexcept {
        if (id >= capacity_) {
            return nullptr;
        }
        return slots_[id].load(std::memory_order_acquire);
    }

    void retire(page_id id) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (id >= capacity_ || state_[id] != 1) {
            throw std::logic_error(
                "dlks::PageManager: retire of a non-live page");
        }
        const std::uint64_t epoch = epochs_.advance();
        retired_.push_back(Retired{id, epoch});
        state_[id] = 2;
        --live_pages_;
    }

    // Reclaims every retired page whose reader epoch has drained.  Returns the
    // number of page identifiers made reusable.
    std::size_t reclaim() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::size_t reclaimed = 0;
        std::size_t write = 0;
        for (std::size_t read = 0; read < retired_.size(); ++read) {
            const Retired entry = retired_[read];
            if (!epochs_.safe_to_reclaim(entry.epoch)) {
                retired_[write++] = entry;
                continue;
            }

            Page* page = slots_[entry.id].exchange(nullptr,
                                                   std::memory_order_acq_rel);
            delete page;
            state_[entry.id] = 0;
            free_ids_.push_back(entry.id);
            ++reclaimed;
        }
        retired_.resize(write);
        return reclaimed;
    }

    // Convenience for users of the standalone page manager.  The B+ tree takes
    // the same guard before every optimistic traversal.
    [[nodiscard]] EpochManager::ReaderGuard pin() const {
        return epochs_.pin();
    }

    [[nodiscard]] EpochManager& epochs() noexcept { return epochs_; }
    [[nodiscard]] const EpochManager& epochs() const noexcept {
        return epochs_;
    }

    [[nodiscard]] std::size_t capacity() const noexcept { return capacity_; }

    [[nodiscard]] std::size_t live_pages() const noexcept {
        return live_pages_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] std::size_t retired_pages() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return retired_.size();
    }

    [[nodiscard]] std::size_t reusable_pages() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return free_ids_.size();
    }

private:
    struct Retired {
        page_id id;
        std::uint64_t epoch;
    };

    page_id allocate_id() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!free_ids_.empty()) {
            const page_id id = free_ids_.back();
            free_ids_.pop_back();
            return id;
        }
        if (next_id_ >= capacity_) {
            throw std::length_error(
                "dlks::PageManager: page capacity exhausted");
        }
        return next_id_++;
    }

    std::size_t capacity_;
    std::unique_ptr<std::atomic<Page*>[]> slots_;
    std::vector<std::uint8_t> state_;
    std::vector<page_id> free_ids_;
    std::vector<Retired> retired_;
    page_id next_id_ = 0;
    std::atomic<std::size_t> live_pages_{0};
    mutable std::mutex mutex_;
    EpochManager epochs_;
};

}  // namespace dlks
