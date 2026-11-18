#include "dlks_formal.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <iostream>
#include <latch>
#include <span>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using dlks_formal::BoundedMpmcQueue;

bool check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
    }
    return condition;
}

class NaiveBoundedQueue {
public:
    explicit NaiveBoundedQueue(std::size_t capacity) : capacity_(capacity) {}

    bool enqueue(int value) {
        if (queue_.size() == capacity_) {
            return false;
        }
        queue_.push_back(value);
        return true;
    }

    bool enqueue_batch(const int* values, std::size_t count) {
        if (count > capacity_ - queue_.size()) {
            return false;
        }
        for (std::size_t i = 0; i < count; ++i) {
            queue_.push_back(values[i]);
        }
        return true;
    }

    bool dequeue(int& value) {
        if (queue_.empty()) {
            return false;
        }
        value = queue_.front();
        queue_.pop_front();
        return true;
    }

    std::size_t dequeue_batch(int* values, std::size_t max_count) {
        const std::size_t count = queue_.size() < max_count ? queue_.size() : max_count;
        for (std::size_t i = 0; i < count; ++i) {
            values[i] = queue_.front();
            queue_.pop_front();
        }
        return count;
    }

    std::size_t size() const { return queue_.size(); }
    bool empty() const { return queue_.empty(); }
    std::size_t capacity() const { return capacity_; }
    int front() const { return queue_.front(); }
    void pop_front() { queue_.pop_front(); }

private:
    std::size_t capacity_;
    std::deque<int> queue_;
};

bool test_full_rejects_without_overwrite() {
    BoundedMpmcQueue<int, 4> queue;

    if (!check(queue.capacity() == 4, "capacity is compile-time bounded")) {
        return false;
    }
    if (!check(queue.try_enqueue_batch({1, 2, 3}), "batch fits in empty queue")) {
        return false;
    }
    if (!check(queue.try_enqueue(4), "single enqueue fills the last slot")) {
        return false;
    }
    if (!check(!queue.try_enqueue(5), "single enqueue rejects when full")) {
        return false;
    }
    if (!check(!queue.try_enqueue_batch({6}), "batch enqueue rejects when full")) {
        return false;
    }
    if (!check(queue.size() == 4 && queue.full(),
               "failed enqueue does not change size")) {
        return false;
    }

    std::array<int, 4> values{};
    const auto count = queue.try_dequeue_batch(values);
    if (!check(count == 4, "all original elements remain after rejected enqueue")) {
        return false;
    }
    return check(values[0] == 1 && values[1] == 2 && values[2] == 3 && values[3] == 4,
                 "rejected enqueue never overwrites existing elements");
}

bool test_batch_is_all_or_nothing_across_wrap() {
    BoundedMpmcQueue<int, 5> queue;
    std::array<int, 3> first{1, 2, 3};
    std::array<int, 3> second{4, 5, 6};
    std::array<int, 2> third{6, 7};
    std::array<int, 5> out{};

    if (!check(queue.try_enqueue_batch(first), "first batch accepted")) {
        return false;
    }
    int value = 0;
    if (!check(queue.try_dequeue(value) && value == 1, "dequeue advances head")) {
        return false;
    }
    if (!check(queue.try_enqueue_batch(second), "wrap-around batch accepted")) {
        return false;
    }
    if (!check(!queue.try_enqueue_batch(third),
               "batch larger than free capacity is rejected as a whole")) {
        return false;
    }

    const auto count = queue.try_dequeue_batch(out);
    if (!check(count == 5, "failed batch did not partially insert elements")) {
        return false;
    }
    if (!check(out[0] == 2 && out[1] == 3 && out[2] == 4 && out[3] == 5 &&
                   out[4] == 6,
               "FIFO order is preserved across ring wrap")) {
        return false;
    }

    return check(queue.empty(), "queue is empty after draining wrapped batch");
}

struct MoveOnly {
    explicit MoveOnly(int input) : value(input) {}

    MoveOnly(const MoveOnly&) = delete;
    MoveOnly& operator=(const MoveOnly&) = delete;
    MoveOnly(MoveOnly&&) noexcept = default;
    MoveOnly& operator=(MoveOnly&&) noexcept = default;

    int value = 0;
};

bool test_move_only_values() {
    BoundedMpmcQueue<MoveOnly, 2> queue;
    if (!check(queue.try_emplace(11), "try_emplace supports non-copyable values")) {
        return false;
    }
    if (!check(queue.try_enqueue(MoveOnly(22)), "rvalue enqueue supports move-only values")) {
        return false;
    }

    MoveOnly first(0);
    MoveOnly second(0);
    if (!check(queue.try_dequeue(first) && first.value == 11, "first move-only value dequeued")) {
        return false;
    }
    return check(queue.try_dequeue(second) && second.value == 22,
                 "second move-only value dequeued");
}

bool test_partial_and_exact_batches() {
    BoundedMpmcQueue<int, 5> queue;
    std::array<int, 5> incoming{3, 4, 5, 6, 7};
    std::array<int, 5> out{};

    if (!check(queue.try_enqueue_batch({1, 2}), "initial partial-batch prefix")) {
        return false;
    }
    if (!check(queue.try_enqueue_batch_partial(incoming) == 3,
               "partial batch accepts only the available prefix")) {
        return false;
    }
    if (!check(queue.full(), "partial batch filled the remaining capacity")) {
        return false;
    }

    int first = 0;
    if (!check(queue.try_dequeue(first) && first == 1, "dequeue before exact-batch test")) {
        return false;
    }
    if (!check(!queue.try_dequeue_batch_exact(out),
               "exact batch rejects when fewer than requested are available")) {
        return false;
    }
    if (!check(queue.size() == 4, "failed exact batch leaves all elements in place")) {
        return false;
    }

    std::array<int, 4> exact{};
    if (!check(queue.try_dequeue_batch_exact(exact),
               "exact batch succeeds when enough elements are available")) {
        return false;
    }
    return check(exact[0] == 2 && exact[1] == 3 && exact[2] == 4 && exact[3] == 5 &&
                     queue.empty(),
                 "partial and exact batch operations preserve FIFO order");
}

struct GatedValue {
    GatedValue() = default;
    explicit GatedValue(int input) : value(input) {}

    GatedValue(const GatedValue& other) : value(other.value) {
        if (block.load(std::memory_order_acquire) &&
            copies.fetch_add(1, std::memory_order_acq_rel) == 1) {
            entered.store(true, std::memory_order_release);
            while (!release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        }
    }

    GatedValue(GatedValue&& other) noexcept : value(other.value) {}
    GatedValue& operator=(const GatedValue&) = default;
    GatedValue& operator=(GatedValue&&) noexcept = default;

    inline static std::atomic<int> copies{0};
    inline static std::atomic<bool> block{false};
    inline static std::atomic<bool> entered{false};
    inline static std::atomic<bool> release{false};

    int value = 0;
};

bool test_batch_commit_is_atomic() {
    BoundedMpmcQueue<GatedValue, 4> queue;
    std::array<GatedValue, 4> source{
        GatedValue(10), GatedValue(20), GatedValue(30), GatedValue(40)};
    std::array<GatedValue, 4> out{
        GatedValue(-1), GatedValue(-1), GatedValue(-1), GatedValue(-1)};

    GatedValue::copies.store(0, std::memory_order_relaxed);
    GatedValue::entered.store(false, std::memory_order_relaxed);
    GatedValue::release.store(false, std::memory_order_relaxed);
    GatedValue::block.store(true, std::memory_order_release);

    std::atomic<bool> producer_result{false};
    std::thread producer([&] {
        producer_result.store(
            queue.try_enqueue_batch(std::span<const GatedValue>(source)),
            std::memory_order_release);
    });

    while (!GatedValue::entered.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }

    std::atomic<std::size_t> consumer_count{0};
    std::atomic<bool> consumer_done{false};
    std::thread consumer([&] {
        consumer_count.store(queue.try_dequeue_batch(out), std::memory_order_release);
        consumer_done.store(true, std::memory_order_release);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const bool stayed_invisible = !consumer_done.load(std::memory_order_acquire);
    GatedValue::release.store(true, std::memory_order_release);
    producer.join();
    consumer.join();
    GatedValue::block.store(false, std::memory_order_release);

    if (!check(stayed_invisible, "consumer cannot observe a partially constructed batch")) {
        return false;
    }
    if (!check(producer_result.load(std::memory_order_acquire),
               "batch producer commits after construction completes")) {
        return false;
    }
    if (!check(consumer_count.load(std::memory_order_acquire) == 4,
               "consumer receives the whole committed batch")) {
        return false;
    }
    return check(out[0].value == 10 && out[1].value == 20 && out[2].value == 30 &&
                     out[3].value == 40,
                 "committed batch is observed as one contiguous run");
}

bool test_backpressure_and_close() {
    BoundedMpmcQueue<int, 3> queue;
    if (!check(queue.enqueue_batch({1, 2, 3}), "blocking batch fills queue")) {
        return false;
    }

    std::atomic<bool> producer_started{false};
    std::atomic<bool> producer_finished{false};
    std::atomic<bool> producer_result{false};
    std::thread producer([&] {
        producer_started.store(true, std::memory_order_release);
        producer_result.store(queue.enqueue_batch({4, 5}), std::memory_order_release);
        producer_finished.store(true, std::memory_order_release);
    });

    while (!producer_started.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    if (!check(!producer_finished.load(std::memory_order_acquire),
               "blocking batch producer waits for capacity")) {
        producer.join();
        return false;
    }

    std::array<int, 2> out{};
    const auto count = queue.dequeue_batch(out);
    producer.join();
    if (!check(count == 2 && out[0] == 1 && out[1] == 2,
               "consumer drains from the front before producer proceeds")) {
        return false;
    }
    if (!check(producer_result.load(std::memory_order_acquire),
               "blocked batch producer succeeds after capacity is released")) {
        return false;
    }

    std::array<int, 3> remaining{};
    const auto remaining_count = queue.try_dequeue_batch(remaining);
    if (!check(remaining_count == 3 && remaining[0] == 3 && remaining[1] == 4 &&
                   remaining[2] == 5,
               "blocking batch is appended behind existing elements")) {
        return false;
    }

    BoundedMpmcQueue<int, 1> waiting;
    std::atomic<bool> waiter_started{false};
    std::atomic<bool> waiter_result{true};
    std::thread waiter([&] {
        waiter_started.store(true, std::memory_order_release);
        int value = 0;
        waiter_result.store(waiting.dequeue(value), std::memory_order_release);
    });
    while (!waiter_started.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    waiting.close();
    waiter.join();
    if (!check(!waiter_result.load(std::memory_order_acquire),
               "close wakes a blocked consumer and reports failure")) {
        return false;
    }

    if (!check(waiting.enqueue(7) == false, "closed queue rejects new elements")) {
        return false;
    }

    BoundedMpmcQueue<int, 2> oversized;
    std::array<int, 3> too_many{1, 2, 3};
    std::array<int, 3> too_many_out{};
    return check(!oversized.enqueue_batch(too_many),
                 "oversized blocking batch fails immediately") &&
           check(!oversized.dequeue_batch_exact(too_many_out),
                 "oversized exact dequeue fails immediately");
}

template <std::size_t Capacity>
bool replay_history(std::uint64_t code, unsigned depth, std::uint64_t history_id) {
    BoundedMpmcQueue<int, Capacity> queue;
    NaiveBoundedQueue model(Capacity);
    std::uint64_t digits = code;

    for (unsigned step = 0; step < depth; ++step) {
        const unsigned operation = static_cast<unsigned>(digits % 6);
        digits /= 6;

        const int base = static_cast<int>(step) * 100;
        if (operation == 0) {
            const bool actual = queue.try_enqueue(base + 1);
            const bool expected = model.enqueue(base + 1);
            if (!check(actual == expected, "history: single enqueue result")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
        } else if (operation == 1) {
            std::array<int, 2> values{base + 1, base + 2};
            const bool actual = queue.try_enqueue_batch(values);
            const bool expected = model.enqueue_batch(values.data(), values.size());
            if (!check(actual == expected, "history: two-element batch result")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
        } else if (operation == 2) {
            std::array<int, Capacity + 1> values{};
            for (std::size_t i = 0; i < values.size(); ++i) {
                values[i] = base + static_cast<int>(i) + 1;
            }
            const bool actual = queue.try_enqueue_batch(values);
            const bool expected = model.enqueue_batch(values.data(), values.size());
            if (!check(actual == expected, "history: oversized batch result")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
        } else if (operation == 3) {
            int actual = 0;
            int expected = 0;
            const bool actual_ok = queue.try_dequeue(actual);
            const bool expected_ok = model.dequeue(expected);
            if (!check(actual_ok == expected_ok, "history: single dequeue result")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
            if (actual_ok && !check(actual == expected, "history: single dequeue order")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
        } else if (operation == 4) {
            std::array<int, 2> actual{};
            std::array<int, 2> expected{};
            const auto actual_count = queue.try_dequeue_batch(actual);
            const auto expected_count = model.dequeue_batch(expected.data(), expected.size());
            if (!check(actual_count == expected_count, "history: short batch dequeue count")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
            for (std::size_t i = 0; i < actual_count; ++i) {
                if (!check(actual[i] == expected[i], "history: short batch dequeue order")) {
                    std::cerr << "  capacity=" << Capacity << " history=" << history_id
                              << " step=" << step << '\n';
                    return false;
                }
            }
        } else {
            std::array<int, Capacity + 1> actual{};
            std::array<int, Capacity + 1> expected{};
            const auto actual_count = queue.try_dequeue_batch(actual);
            const auto expected_count = model.dequeue_batch(expected.data(), expected.size());
            if (!check(actual_count == expected_count, "history: long batch dequeue count")) {
                std::cerr << "  capacity=" << Capacity << " history=" << history_id
                          << " step=" << step << '\n';
                return false;
            }
            for (std::size_t i = 0; i < actual_count; ++i) {
                if (!check(actual[i] == expected[i], "history: long batch dequeue order")) {
                    std::cerr << "  capacity=" << Capacity << " history=" << history_id
                              << " step=" << step << '\n';
                    return false;
                }
            }
        }

        if (queue.size() != model.size()) {
            check(false, "history: size matches naive bounded model");
            std::cerr << "  capacity=" << Capacity << " history=" << history_id
                      << " step=" << step << " actual=" << queue.size()
                      << " expected=" << model.size() << '\n';
            return false;
        }
        if (queue.empty() != model.empty() ||
            queue.full() != (model.size() == model.capacity())) {
            check(false, "history: capacity predicates match naive model");
            std::cerr << "  capacity=" << Capacity << " history=" << history_id
                      << " step=" << step << '\n';
            return false;
        }
    }

    int actual = 0;
    while (queue.try_dequeue(actual)) {
        if (model.empty() || !check(actual == model.front(),
                                    "history: final queue contents match model")) {
            std::cerr << "  capacity=" << Capacity << " history=" << history_id << '\n';
            return false;
        }
        model.pop_front();
    }
    if (!check(model.empty(), "history: model drained together with queue")) {
        std::cerr << "  capacity=" << Capacity << " history=" << history_id << '\n';
        return false;
    }
    return check(queue.empty(), "history: queue is empty after final drain");
}

template <std::size_t Capacity>
bool exhaust_capacity(unsigned depth) {
    std::uint64_t history_count = 1;
    for (unsigned i = 0; i < depth; ++i) {
        history_count *= 6;
    }

    for (std::uint64_t history = 0; history < history_count; ++history) {
        if (!replay_history<Capacity>(history, depth, history)) {
            return false;
        }
    }
    return true;
}

bool test_exhaustive_operation_histories() {
    constexpr unsigned depth = 7;
    return exhaust_capacity<1>(depth) && exhaust_capacity<2>(depth) &&
           exhaust_capacity<3>(depth) && exhaust_capacity<4>(depth);
}

struct Item {
    int id = 0;
    std::uint32_t checksum = 0;
};

bool test_concurrent_batch_exactly_once() {
    constexpr int producers = 4;
    constexpr int consumers = 4;
    constexpr int items_per_producer = 3000;
    constexpr int max_batch = 8;
    constexpr std::size_t capacity = 64;
    constexpr int total = producers * items_per_producer;

    BoundedMpmcQueue<Item, capacity> queue;
    std::vector<std::atomic<unsigned char>> seen(static_cast<std::size_t>(total));
    for (auto& count : seen) {
        count.store(0, std::memory_order_relaxed);
    }
    std::atomic<int> producers_done{0};
    std::atomic<int> consumed{0};
    std::atomic<std::size_t> rejected_batches{0};
    std::atomic<bool> invalid{false};
    std::atomic<int> duplicate_id{-1};
    std::latch producer_start(producers);

    std::vector<Item> sentinels(capacity, Item{-1, 0});
    if (!check(queue.try_enqueue_batch(sentinels),
               "concurrent test pre-fills capacity with sentinels")) {
        return false;
    }

    auto producer = [&](int producer_id) {
        std::uint32_t state = static_cast<std::uint32_t>(producer_id + 1) * 0x9e3779b9u;
        int produced = 0;
        producer_start.arrive_and_wait();

        while (produced < items_per_producer) {
            state = state * 1664525u + 1013904223u;
            int count = 1 + static_cast<int>(state % max_batch);
            if (count > items_per_producer - produced) {
                count = items_per_producer - produced;
            }

            std::array<Item, max_batch> batch{};
            for (int i = 0; i < count; ++i) {
                const int id = producer_id * items_per_producer + produced + i;
                batch[static_cast<std::size_t>(i)] = Item{
                    id, static_cast<std::uint32_t>(id) * 2654435761u};
            }

            if (!queue.try_enqueue_batch(
                    std::span<const Item>(batch.data(), static_cast<std::size_t>(count)))) {
                rejected_batches.fetch_add(1, std::memory_order_relaxed);
                std::this_thread::yield();
                continue;
            }
            produced += count;
        }
        producers_done.fetch_add(1, std::memory_order_release);
    };

    auto consumer = [&] {
        std::array<Item, max_batch> batch{};

        while (true) {
            const auto count = queue.try_dequeue_batch(batch);
            if (count == 0) {
                if (producers_done.load(std::memory_order_acquire) == producers &&
                    queue.empty()) {
                    return;
                }
                std::this_thread::yield();
                continue;
            }

            for (std::size_t i = 0; i < count; ++i) {
                const int id = batch[i].id;
                if (id == -1) {
                    continue;
                }
                if (id < 0 || id >= total ||
                    batch[i].checksum != static_cast<std::uint32_t>(id) * 2654435761u) {
                    invalid.store(true, std::memory_order_release);
                    continue;
                }
                const auto previous =
                    seen[static_cast<std::size_t>(id)].fetch_add(1, std::memory_order_relaxed);
                if (previous != 0) {
                    duplicate_id.store(id, std::memory_order_release);
                }
                consumed.fetch_add(1, std::memory_order_relaxed);
            }
        }
    };

    std::vector<std::thread> threads;
    threads.reserve(producers + consumers);
    for (int i = 0; i < producers; ++i) {
        threads.emplace_back(producer, i);
    }
    while (rejected_batches.load(std::memory_order_acquire) == 0) {
        std::this_thread::yield();
    }
    for (int i = 0; i < consumers; ++i) {
        threads.emplace_back(consumer);
    }
    for (auto& thread : threads) {
        thread.join();
    }

    if (!check(!invalid.load(std::memory_order_acquire),
               "concurrent batches contain only valid complete items")) {
        return false;
    }
    if (!check(duplicate_id.load(std::memory_order_acquire) == -1,
               "no element is consumed by more than one consumer")) {
        std::cerr << "  duplicate id=" << duplicate_id.load(std::memory_order_acquire) << '\n';
        return false;
    }
    if (!check(consumed.load(std::memory_order_acquire) == total,
               "every produced element is consumed exactly once")) {
        std::cerr << "  consumed=" << consumed.load(std::memory_order_acquire)
                  << " expected=" << total << '\n';
        return false;
    }
    for (int id = 0; id < total; ++id) {
        if (!check(seen[static_cast<std::size_t>(id)].load(std::memory_order_relaxed) == 1,
                   "per-element receive count is exactly one")) {
            return false;
        }
    }
    return true;
}

}  // namespace

int main() {
    if (!test_full_rejects_without_overwrite() || !test_batch_is_all_or_nothing_across_wrap() ||
        !test_move_only_values() || !test_partial_and_exact_batches() ||
        !test_batch_commit_is_atomic() || !test_backpressure_and_close() ||
        !test_exhaustive_operation_histories() || !test_concurrent_batch_exactly_once()) {
        return 1;
    }

    std::cout << "All bounded MPMC queue tests passed.\n";
    return 0;
}
