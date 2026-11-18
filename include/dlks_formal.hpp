#pragma once

#include <array>
#include <condition_variable>
#include <cstddef>
#include <initializer_list>
#include <iterator>
#include <mutex>
#include <optional>
#include <span>
#include <type_traits>
#include <utility>

namespace dlks_formal {

// A fixed-capacity, header-only bounded MPMC queue.
//
// All operations are serialized by one mutex.  The mutex is intentional: it
// gives a batch enqueue a single acquire/release publication point, so a batch
// becomes visible as one contiguous run of slots rather than as a collection of
// independently published elements.  The try_* operations are non-blocking with
// respect to a full/empty queue and return false (or a short count) instead of
// overwriting existing elements.
template <typename T, std::size_t Capacity>
class BoundedMpmcQueue {
    static_assert(Capacity > 0, "BoundedMpmcQueue requires a non-zero capacity");
    static_assert(!std::is_reference_v<T>, "BoundedMpmcQueue cannot store references");

public:
    using value_type = T;
    using size_type = std::size_t;

    static constexpr size_type capacity_value = Capacity;
    static constexpr size_type capacity() noexcept { return Capacity; }
    size_type max_size() const noexcept { return Capacity; }

    BoundedMpmcQueue() = default;
    ~BoundedMpmcQueue() = default;

    BoundedMpmcQueue(const BoundedMpmcQueue&) = delete;
    BoundedMpmcQueue& operator=(const BoundedMpmcQueue&) = delete;
    BoundedMpmcQueue(BoundedMpmcQueue&&) = delete;
    BoundedMpmcQueue& operator=(BoundedMpmcQueue&&) = delete;

    // Attempts to enqueue one element.  Returns false if the queue is full or
    // closed; an existing element is never replaced.
    bool try_enqueue(const T& value) { return try_emplace(value); }
    bool try_enqueue(T&& value) { return try_emplace(std::move(value)); }

    template <typename... Args>
    bool try_emplace(Args&&... args) {
        std::lock_guard lock(mutex_);
        if (closed_ || size_ == Capacity) {
            return false;
        }

        slots_[tail_].emplace(std::forward<Args>(args)...);
        advance(tail_, 1);
        ++size_;
        not_empty_.notify_all();
        return true;
    }

    // Enqueues a batch atomically.  The whole batch is accepted only when all
    // slots fit; otherwise the queue is unchanged.  The implementation builds
    // values in contiguous logical slots before publishing the new tail.
    bool try_enqueue_batch(std::span<const T> values) {
        return try_enqueue_batch(values.data(), values.size());
    }

    bool try_enqueue_batch(std::initializer_list<T> values) {
        return try_enqueue_batch(values.begin(), values.size());
    }

    bool try_enqueue_batch(const T* values, size_type count) {
        std::lock_guard lock(mutex_);
        if (closed_ || count > Capacity - size_) {
            return false;
        }
        enqueue_batch_locked(values, count);
        return true;
    }

    // Accepts as much of the batch as currently fits.  The accepted prefix is
    // still published atomically and returned as one contiguous run.
    size_type try_enqueue_batch_partial(std::span<const T> values) {
        std::lock_guard lock(mutex_);
        if (closed_) {
            return 0;
        }
        const size_type count =
            values.size() < Capacity - size_ ? values.size() : Capacity - size_;
        enqueue_batch_locked(values.data(), count);
        return count;
    }

    size_type try_push_batch_partial(std::span<const T> values) {
        return try_enqueue_batch_partial(values);
    }

    size_type try_push_batch_partial(const T* values, size_type count) {
        return try_enqueue_batch_partial(std::span<const T>(values, count));
    }

    template <typename InputIt>
        requires std::forward_iterator<InputIt>
    bool try_enqueue_batch(InputIt first, InputIt last) {
        const auto count = static_cast<size_type>(std::distance(first, last));
        std::lock_guard lock(mutex_);
        if (closed_ || count > Capacity - size_) {
            return false;
        }
        enqueue_batch_locked(first, count);
        return true;
    }

    // Attempts to dequeue one element.  Returns false when the queue is empty.
    bool try_dequeue(T& value) {
        std::lock_guard lock(mutex_);
        if (size_ == 0) {
            return false;
        }

        value = std::move(*slots_[head_]);
        slots_[head_].reset();
        advance(head_, 1);
        --size_;
        not_full_.notify_all();
        return true;
    }

    // Dequeues at most out.size() elements from the front of the queue.  The
    // returned count can be smaller than out.size() when the queue is short.
    size_type try_dequeue_batch(std::span<T> out) {
        std::lock_guard lock(mutex_);
        return dequeue_batch_locked(out);
    }

    size_type try_dequeue_batch(T* out, size_type max_count) {
        return try_dequeue_batch(std::span<T>(out, max_count));
    }

    // Removes exactly out.size() elements, or leaves the queue untouched when
    // it contains fewer elements.
    bool try_dequeue_batch_exact(std::span<T> out) {
        std::lock_guard lock(mutex_);
        if (size_ < out.size()) {
            return false;
        }
        dequeue_batch_locked(out);
        return true;
    }

    bool try_dequeue_batch_exact(T* out, size_type count) {
        return try_dequeue_batch_exact(std::span<T>(out, count));
    }

    bool try_push(const T& value) { return try_enqueue(value); }
    bool try_push(T&& value) { return try_enqueue(std::move(value)); }
    bool try_pop(T& value) { return try_dequeue(value); }
    bool try_push_batch(std::span<const T> values) { return try_enqueue_batch(values); }
    bool try_push_batch(std::initializer_list<T> values) {
        return try_enqueue_batch(values);
    }
    bool try_push_batch(const T* values, size_type count) {
        return try_enqueue_batch(values, count);
    }
    size_type try_pop_batch(std::span<T> out) { return try_dequeue_batch(out); }
    size_type try_pop_batch(T* out, size_type max_count) {
        return try_dequeue_batch(out, max_count);
    }

    // Blocking enqueue.  Returns false only when the queue has been closed
    // while waiting for capacity.
    bool enqueue(const T& value) { return emplace(value); }
    bool enqueue(T&& value) { return emplace(std::move(value)); }
    bool push(const T& value) { return enqueue(value); }
    bool push(T&& value) { return enqueue(std::move(value)); }
    bool pop(T& value) { return dequeue(value); }

    template <typename... Args>
    bool emplace(Args&&... args) {
        std::unique_lock lock(mutex_);
        not_full_.wait(lock, [&] { return closed_ || size_ < Capacity; });
        if (closed_) {
            return false;
        }

        slots_[tail_].emplace(std::forward<Args>(args)...);
        advance(tail_, 1);
        ++size_;
        not_empty_.notify_all();
        return true;
    }

    // Blocking all-or-nothing batch enqueue.
    bool enqueue_batch(std::span<const T> values) {
        if (values.size() > Capacity) {
            return false;
        }
        std::unique_lock lock(mutex_);
        not_full_.wait(lock, [&] {
            return closed_ || values.size() <= Capacity - size_;
        });
        if (closed_) {
            return false;
        }
        enqueue_batch_locked(values.data(), values.size());
        return true;
    }

    bool enqueue_batch(std::initializer_list<T> values) {
        return enqueue_batch(std::span<const T>(values.begin(), values.size()));
    }

    bool enqueue_batch(const T* values, size_type count) {
        return enqueue_batch(std::span<const T>(values, count));
    }

    // Blocking dequeue.  Returns false only when the queue has been closed and
    // drained while waiting.
    bool dequeue(T& value) {
        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [&] { return closed_ || size_ != 0; });
        if (size_ == 0) {
            return false;
        }

        value = std::move(*slots_[head_]);
        slots_[head_].reset();
        advance(head_, 1);
        --size_;
        not_full_.notify_all();
        return true;
    }

    // Waits for at least one element and then dequeues up to out.size() of them.
    size_type dequeue_batch(std::span<T> out) {
        if (out.empty()) {
            return 0;
        }

        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [&] { return closed_ || size_ != 0; });
        return dequeue_batch_locked(out);
    }

    size_type dequeue_batch(T* out, size_type max_count) {
        return dequeue_batch(std::span<T>(out, max_count));
    }

    // Waits until exactly out.size() elements are available.  Returns false if
    // the queue is closed before that many elements can be removed.
    bool dequeue_batch_exact(std::span<T> out) {
        if (out.empty()) {
            return true;
        }
        if (out.size() > Capacity) {
            return false;
        }

        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [&] { return closed_ || size_ >= out.size(); });
        if (size_ < out.size()) {
            return false;
        }
        dequeue_batch_locked(out);
        return true;
    }

    bool dequeue_batch_exact(T* out, size_type count) {
        return dequeue_batch_exact(std::span<T>(out, count));
    }

    // Wakes all blocked producers and consumers.  Producers fail; consumers may
    // still drain elements already in the queue.
    void close() {
        {
            std::lock_guard lock(mutex_);
            closed_ = true;
        }
        not_empty_.notify_all();
        not_full_.notify_all();
    }

    bool is_closed() const {
        std::lock_guard lock(mutex_);
        return closed_;
    }

    bool empty() const {
        std::lock_guard lock(mutex_);
        return size_ == 0;
    }

    bool full() const {
        std::lock_guard lock(mutex_);
        return size_ == Capacity;
    }

    size_type size() const {
        std::lock_guard lock(mutex_);
        return size_;
    }

private:
    using slot_type = std::optional<T>;
    using storage_type = std::array<slot_type, Capacity>;

    static constexpr void advance(size_type& index, size_type count) noexcept {
        index = (index + count) % Capacity;
    }

    // Caller must hold mutex_ and have checked that the batch fits.
    template <typename InputIt>
    void enqueue_batch_locked(InputIt first, size_type count) {
        if (count == 0) {
            return;
        }

        const size_type old_tail = tail_;
        size_type built = 0;
        try {
            for (; built < count; ++built, ++first) {
                slots_[(old_tail + built) % Capacity].emplace(*first);
            }
        } catch (...) {
            for (size_type i = 0; i < built; ++i) {
                slots_[(old_tail + i) % Capacity].reset();
            }
            throw;
        }

        tail_ = (old_tail + count) % Capacity;
        size_ += count;
        not_empty_.notify_all();
    }

    // Caller must hold mutex_.  Values are moved first and the ring metadata is
    // updated only after every move assignment has succeeded.
    size_type dequeue_batch_locked(std::span<T> out) {
        const size_type count = size_ < out.size() ? size_ : out.size();
        if (count == 0) {
            return 0;
        }

        for (size_type i = 0; i < count; ++i) {
            out[i] = std::move(*slots_[(head_ + i) % Capacity]);
        }
        for (size_type i = 0; i < count; ++i) {
            slots_[(head_ + i) % Capacity].reset();
        }

        advance(head_, count);
        size_ -= count;
        not_full_.notify_all();
        return count;
    }

    mutable std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    storage_type slots_{};
    size_type head_ = 0;
    size_type tail_ = 0;
    size_type size_ = 0;
    bool closed_ = false;
};

template <typename T, std::size_t Capacity>
using MpmcQueue = BoundedMpmcQueue<T, Capacity>;

template <typename T, std::size_t Capacity>
using bounded_mpmc_queue = BoundedMpmcQueue<T, Capacity>;

}  // namespace dlks_formal
