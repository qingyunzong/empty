#include "check.hpp"
#include "counting_mapper.hpp"

#include <atomic>
#include <chrono>
#include <latch>
#include <thread>
#include <vector>

using pagefile::PageFile;

// Worker threads on other cores acquire, read, and release views while the
// main thread repeatedly expands and finally closes the file. Views must
// never dangle: every byte read from a live view must be a generation byte
// stamped by the mapper (1..current generation), never 0 or garbage, and
// every mapping must be unmapped exactly once by the end.
int main() {
    constexpr int kWorkers = 8;
    constexpr int kExpansions = 64;
    constexpr std::size_t kInitialSize = 4096;

    auto mapper = std::make_shared<CountingMapper>();
    PageFile file(mapper, kInitialSize);

    std::latch start(kWorkers + 1);
    std::atomic<bool> stop{false};
    std::atomic<long> acquired{0};
    std::atomic<long> rejected_after_close{0};
    std::atomic<long> content_failures{0};

    std::vector<std::thread> workers;
    for (int w = 0; w < kWorkers; ++w) {
        workers.emplace_back([&] {
            start.arrive_and_wait();
            while (!stop.load(std::memory_order_relaxed)) {
                auto view = file.acquire();
                if (!view.has_value()) {
                    if (file.is_closed()) {
                        ++rejected_after_close;
                        break;
                    }
                    continue;
                }
                ++acquired;
                const unsigned int gen_ceiling = mapper->generation();
                for (const std::byte b : *view) {
                    const auto value = static_cast<unsigned int>(b);
                    if (value == 0 || value > gen_ceiling) {
                        ++content_failures;
                        break;
                    }
                }
                // Hold the view briefly so expansions/close race with it.
                std::this_thread::yield();
            }
        });
    }

    start.arrive_and_wait();
    std::size_t size = kInitialSize;
    for (int i = 0; i < kExpansions; ++i) {
        size += kInitialSize;
        file.expand(size);
    }
    file.close();
    stop.store(true);
    for (auto& worker : workers) {
        worker.join();
    }

    // Closed file keeps rejecting; outstanding views are all gone by now, so
    // every mapping must have been released exactly once.
    CHECK(!file.acquire().has_value());
    CHECK(rejected_after_close.load() > 0);
    CHECK(acquired.load() > 0);
    CHECK(content_failures.load() == 0);
    CHECK(mapper->live() == 0);
    CHECK(mapper->map_calls() == mapper->unmap_calls());
    CHECK(mapper->map_calls() == kExpansions + 1);

    std::printf("workers=%d expansions=%d views_acquired=%ld rejected=%ld\n",
                kWorkers, kExpansions, acquired.load(),
                rejected_after_close.load());
    return test::summarize("threading_test");
}
