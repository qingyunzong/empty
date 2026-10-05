#include "bq/bounded_queue.hpp"

#include <atomic>
#include <barrier>
#include <chrono>
#include <optional>
#include <thread>
#include <vector>

#include "check.hpp"

using namespace std::chrono_literals;

int main() {
    // 1. close() wakes blocked producers; their pushes fail; queued
    //    elements remain drainable.
    {
        bq::bounded_queue<int> q(2);
        CHECK(q.push(1));
        CHECK(q.push(2));  // full

        std::barrier ready(4);
        std::atomic<int> failed_pushes{0};
        std::vector<std::thread> producers;
        for (int i = 0; i < 3; ++i)
            producers.emplace_back([&] {
                ready.arrive_and_wait();
                if (!q.push(100))
                    failed_pushes.fetch_add(1);
            });
        ready.arrive_and_wait();
        std::this_thread::sleep_for(50ms);  // let producers block on the full queue
        q.close();
        for (auto& t : producers)
            t.join();

        CHECK(failed_pushes == 3);
        CHECK(q.closed());
        auto v1 = q.pop();
        auto v2 = q.pop();
        CHECK(v1 && *v1 == 1);
        CHECK(v2 && *v2 == 2);
        CHECK(q.pop() == std::nullopt);  // closed and drained
    }

    // 2. close() wakes consumers blocked on an empty queue with nullopt.
    {
        bq::bounded_queue<int> q(4);
        std::barrier ready(3);
        std::atomic<int> null_pops{0};
        std::vector<std::thread> consumers;
        for (int i = 0; i < 2; ++i)
            consumers.emplace_back([&] {
                ready.arrive_and_wait();
                if (!q.pop())
                    null_pops.fetch_add(1);
            });
        ready.arrive_and_wait();
        std::this_thread::sleep_for(50ms);  // let consumers block on the empty queue
        q.close();
        for (auto& t : consumers)
            t.join();
        CHECK(null_pops == 2);
    }

    // 3. After close, remaining elements drain in FIFO order; pushes fail.
    {
        bq::bounded_queue<int> q(8);
        for (int i = 0; i < 5; ++i)
            CHECK(q.push(i));
        q.close();
        CHECK(!q.push(9));
        CHECK(!q.try_push(9));
        for (int i = 0; i < 5; ++i) {
            auto v = q.pop();
            CHECK(v && *v == i);
        }
        CHECK(q.pop() == std::nullopt);
        CHECK(q.try_pop() == std::nullopt);
    }

    // 4. Concurrent stress: close mid-flight; every successfully pushed
    //    element is drained exactly once, nothing lost or duplicated.
    {
        constexpr int kProducers = 4;
        constexpr int kConsumers = 3;
        constexpr int kPerProducer = 500;
        constexpr int kTotal = kProducers * kPerProducer;

        bq::bounded_queue<int> q(16);
        std::barrier start(kProducers + kConsumers + 1);
        std::vector<std::atomic<int>> pushed(kTotal);
        std::vector<std::atomic<int>> popped(kTotal);
        std::vector<std::thread> threads;

        for (int p = 0; p < kProducers; ++p)
            threads.emplace_back([&, p] {
                start.arrive_and_wait();
                for (int i = 0; i < kPerProducer; ++i) {
                    int v = p * kPerProducer + i;
                    if (q.push(v))
                        pushed[v].fetch_add(1, std::memory_order_relaxed);
                }
            });
        for (int c = 0; c < kConsumers; ++c)
            threads.emplace_back([&] {
                start.arrive_and_wait();
                while (auto v = q.pop())
                    popped[*v].fetch_add(1, std::memory_order_relaxed);
            });

        start.arrive_and_wait();
        std::this_thread::sleep_for(2ms);
        q.close();
        for (auto& t : threads)
            t.join();

        for (int v = 0; v < kTotal; ++v) {
            int p = pushed[v].load();
            CHECK(p == 0 || p == 1);         // pushed at most once
            CHECK(popped[v].load() == p);    // drained iff pushed, exactly once
        }
        CHECK(q.pop() == std::nullopt);
    }

    PASS("test_close");
}
