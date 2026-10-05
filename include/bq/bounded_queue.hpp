#pragma once

#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

namespace bq {

// Bounded, blocking, multi-producer / multi-consumer FIFO queue.
//
// Exception safety (strong guarantee):
//  - push/emplace/try_emplace: if element construction throws, the queue is
//    left untouched: capacity is preserved (no slot is consumed) and the
//    original contents are intact.
//  - pop/try_pop: if moving the head element out throws, the element stays
//    in the queue and the queue is left untouched.
//
// Close semantics:
//  - close() wakes every blocked producer and consumer.
//  - After close, push/emplace/try_emplace fail (return false).
//  - Elements already queued can still be drained via pop/try_pop; pop
//    returns std::nullopt once the queue is closed and empty.
//
// The queue must not be destroyed while other threads are still using it.
template <typename T>
class bounded_queue {
public:
    explicit bounded_queue(std::size_t capacity)
        : capacity_(capacity), slots_(std::make_unique<std::optional<T>[]>(capacity)) {}

    ~bounded_queue() = default;
    bounded_queue(const bounded_queue&) = delete;
    bounded_queue& operator=(const bounded_queue&) = delete;

    // Blocks until there is space or the queue is closed.
    // Returns false iff the queue is closed (element was not enqueued).
    template <typename... Args>
    bool emplace(Args&&... args) {
        std::unique_lock lock(mutex_);
        not_full_.wait(lock, [&] { return closed_ || count_ < capacity_; });
        if (closed_)
            return false;
        // If this throws, the slot stays disengaged and count_/tail_ are
        // untouched: capacity and contents are preserved.
        slots_[tail_].emplace(std::forward<Args>(args)...);
        tail_ = (tail_ + 1) % capacity_;
        ++count_;
        lock.unlock();
        not_empty_.notify_one();
        return true;
    }

    bool push(const T& value) { return emplace(value); }
    bool push(T&& value) { return emplace(std::move(value)); }

    // Non-blocking. Returns false iff the queue is closed or full.
    template <typename... Args>
    bool try_emplace(Args&&... args) {
        {
            std::lock_guard lock(mutex_);
            if (closed_ || count_ == capacity_)
                return false;
            slots_[tail_].emplace(std::forward<Args>(args)...);
            tail_ = (tail_ + 1) % capacity_;
            ++count_;
        }
        not_empty_.notify_one();
        return true;
    }

    bool try_push(const T& value) { return try_emplace(value); }
    bool try_push(T&& value) { return try_emplace(std::move(value)); }

    // Blocks until an element is available or the queue is closed and empty.
    // Returns std::nullopt iff the queue is closed and has been drained.
    std::optional<T> pop() {
        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [&] { return closed_ || count_ > 0; });
        if (count_ == 0)
            return std::nullopt;
        // If this move throws, the slot stays engaged: the element and the
        // queue are preserved.
        std::optional<T> out(std::move(*slots_[head_]));
        slots_[head_].reset();
        head_ = (head_ + 1) % capacity_;
        --count_;
        lock.unlock();
        not_full_.notify_one();
        return out;
    }

    // Non-blocking. Returns std::nullopt iff the queue is empty.
    std::optional<T> try_pop() {
        std::unique_lock lock(mutex_);
        if (count_ == 0)
            return std::nullopt;
        std::optional<T> out(std::move(*slots_[head_]));
        slots_[head_].reset();
        head_ = (head_ + 1) % capacity_;
        --count_;
        lock.unlock();
        not_full_.notify_one();
        return out;
    }

    // Wakes all blocked producers and consumers. Producers fail their push;
    // consumers keep draining remaining elements, then observe nullopt.
    void close() {
        {
            std::lock_guard lock(mutex_);
            if (closed_)
                return;
            closed_ = true;
        }
        not_empty_.notify_all();
        not_full_.notify_all();
    }

    bool closed() const {
        std::lock_guard lock(mutex_);
        return closed_;
    }

    std::size_t size() const {
        std::lock_guard lock(mutex_);
        return count_;
    }

    std::size_t capacity() const { return capacity_; }

private:
    const std::size_t capacity_;
    std::unique_ptr<std::optional<T>[]> slots_;
    std::size_t head_ = 0;
    std::size_t tail_ = 0;
    std::size_t count_ = 0;
    bool closed_ = false;
    mutable std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
};

}  // namespace bq
