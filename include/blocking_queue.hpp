#pragma once

#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>

namespace bq {

// Bounded blocking MPMC queue.
//
// Exception guarantees:
//  - push/emplace: if T's constructor throws, the queue is left untouched
//    (capacity, size and contents are preserved) and the exception propagates.
//  - pop: if moving the front element out throws, the element stays in the
//    queue and the exception propagates.
//
// Close semantics:
//  - close() wakes every blocked producer and consumer.
//  - Producers observe the closed state and fail (return false).
//  - Consumers keep draining the remaining elements; pop() only returns
//    std::nullopt once the queue is both closed and empty.
template <typename T>
class BlockingQueue {
public:
    explicit BlockingQueue(std::size_t capacity)
        : slots_(capacity == 0 ? 1 : capacity), capacity_(capacity == 0 ? 1 : capacity) {}

    BlockingQueue(const BlockingQueue&) = delete;
    BlockingQueue& operator=(const BlockingQueue&) = delete;

    ~BlockingQueue() { close(); }

    // Blocking push. Returns false if the queue is (or becomes) closed.
    // Strong guarantee: a throwing T constructor leaves the queue unchanged.
    bool push(const T& value) { return emplace_impl(value); }
    bool push(T&& value) { return emplace_impl(std::move(value)); }

    template <typename... Args>
    bool emplace(Args&&... args) {
        return emplace_impl(std::forward<Args>(args)...);
    }

    // Non-blocking push. Returns false when full or closed.
    bool try_push(const T& value) { return try_emplace_impl(value); }
    bool try_push(T&& value) { return try_emplace_impl(std::move(value)); }

    // Blocking pop. Returns std::nullopt only when closed AND empty.
    // Strong guarantee: a throwing T move/copy leaves the element queued.
    std::optional<T> pop() {
        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [this] { return size_ != 0 || closed_; });
        if (size_ == 0) {
            return std::nullopt;  // closed and drained
        }
        return take_front(lock);
    }

    // Non-blocking pop. Returns std::nullopt when empty (or closed+empty).
    std::optional<T> try_pop() {
        std::unique_lock lock(mutex_);
        if (size_ == 0) {
            return std::nullopt;
        }
        return take_front(lock);
    }

    // Wake all producers and consumers. Producers stop accepting work;
    // consumers may still drain the remaining elements.
    void close() {
        {
            std::lock_guard lock(mutex_);
            if (closed_) {
                return;
            }
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
        return size_;
    }

    std::size_t capacity() const { return capacity_; }

private:
    template <typename U>
    bool emplace_impl(U&& value) {
        std::unique_lock lock(mutex_);
        not_full_.wait(lock, [this] { return size_ < capacity_ || closed_; });
        if (closed_) {
            return false;
        }
        // If this throws, the slot stays disengaged and no state changed.
        slots_[tail_].emplace(std::forward<U>(value));
        tail_ = (tail_ + 1) % capacity_;
        ++size_;
        lock.unlock();
        not_empty_.notify_one();
        return true;
    }

    template <typename U>
    bool try_emplace_impl(U&& value) {
        {
            std::lock_guard lock(mutex_);
            if (closed_ || size_ == capacity_) {
                return false;
            }
            slots_[tail_].emplace(std::forward<U>(value));
            tail_ = (tail_ + 1) % capacity_;
            ++size_;
        }
        not_empty_.notify_one();
        return true;
    }

    // Precondition: lock held, size_ > 0.
    std::optional<T> take_front(std::unique_lock<std::mutex>& lock) {
        // If this move throws, the slot stays engaged and no state changed.
        std::optional<T> value(std::move(*slots_[head_]));
        slots_[head_].reset();
        head_ = (head_ + 1) % capacity_;
        --size_;
        lock.unlock();
        not_full_.notify_one();
        return value;
    }

    mutable std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    std::vector<std::optional<T>> slots_;
    const std::size_t capacity_;
    std::size_t head_ = 0;
    std::size_t tail_ = 0;
    std::size_t size_ = 0;
    bool closed_ = false;
};

}  // namespace bq
