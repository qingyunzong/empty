// Close semantics: close() wakes blocked producers and consumers; the
// remaining elements stay drainable afterwards.
#include "blocking_queue.hpp"

#include <algorithm>
#include <atomic>
#include <barrier>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <numeric>
#include <thread>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            ++failures;                                                   \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "   \
                      << #cond << '\n';                                   \
        }                                                                 \
    } while (0)

void close_wakes_blocked_producers() {
    constexpr int kProducers = 4;
    bq::BlockingQueue<int> q(2);
    CHECK(q.push(1));
    CHECK(q.push(2));  // full now

    std::barrier start(kProducers + 1);
    std::atomic<int> push_failed{0};
    std::atomic<int> push_succeeded{0};
    std::vector<std::thread> producers;
    for (int i = 0; i < kProducers; ++i) {
        producers.emplace_back([&, i] {
            start.arrive_and_wait();
            if (q.push(100 + i)) {
                ++push_succeeded;
            } else {
                ++push_failed;
            }
        });
    }
    start.arrive_and_wait();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));  // let them block
    q.close();
    for (auto& t : producers) {
        t.join();
    }

    CHECK(push_failed == kProducers);
    CHECK(push_succeeded == 0);
    CHECK(q.closed());
    CHECK(!q.push(5));  // closed queue rejects new pushes

    // Original elements remain drainable after close.
    CHECK(q.pop() == 1);
    CHECK(q.pop() == 2);
    CHECK(!q.pop().has_value());  // closed and empty
}

void close_wakes_blocked_consumers() {
    constexpr int kConsumers = 4;
    bq::BlockingQueue<int> q(4);

    std::barrier start(kConsumers + 1);
    std::atomic<int> woke_empty{0};
    std::vector<std::thread> consumers;
    for (int i = 0; i < kConsumers; ++i) {
        consumers.emplace_back([&] {
            start.arrive_and_wait();
            if (!q.pop().has_value()) {
                ++woke_empty;
            }
        });
    }
    start.arrive_and_wait();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));  // let them block
    q.close();
    for (auto& t : consumers) {
        t.join();
    }
    CHECK(woke_empty == kConsumers);
}

void remaining_elements_drain_after_close() {
    constexpr int kItems = 200;
    constexpr int kConsumers = 4;
    bq::BlockingQueue<int> q(16);

    std::barrier start(kConsumers + 1);
    std::atomic<int> pushed{0};
    std::atomic<bool> done_filling{false};
    std::vector<std::vector<int>> consumed(kConsumers);
    std::vector<std::thread> consumers;
    for (int c = 0; c < kConsumers; ++c) {
        consumers.emplace_back([&, c] {
            start.arrive_and_wait();
            while (auto v = q.pop()) {
                consumed[c].push_back(*v);
            }
        });
    }

    std::thread filler([&] {
        start.arrive_and_wait();
        for (int i = 0; i < kItems; ++i) {
            if (q.push(i)) {
                ++pushed;
            }
        }
        done_filling = true;
        q.close();  // consumers must still drain everything already queued
    });

    filler.join();
    for (auto& t : consumers) {
        t.join();
    }

    CHECK(pushed == kItems);
    std::vector<int> all;
    for (const auto& bucket : consumed) {
        all.insert(all.end(), bucket.begin(), bucket.end());
    }
    std::sort(all.begin(), all.end());
    CHECK(all.size() == static_cast<std::size_t>(kItems));
    std::vector<int> expected(kItems);
    std::iota(expected.begin(), expected.end(), 0);
    CHECK(all == expected);  // every element drained exactly once
}

void close_is_idempotent() {
    bq::BlockingQueue<int> q(1);
    q.close();
    q.close();
    CHECK(q.closed());
    CHECK(!q.push(1));
    CHECK(!q.pop().has_value());
}

}  // namespace

int main() {
    close_wakes_blocked_producers();
    close_wakes_blocked_consumers();
    remaining_elements_drain_after_close();
    close_is_idempotent();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "close_test: all checks passed\n";
    return EXIT_SUCCESS;
}
