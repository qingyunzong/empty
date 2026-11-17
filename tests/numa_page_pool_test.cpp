#include "dlks_formal.hpp"

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <random>
#include <thread>
#include <unordered_set>
#include <vector>

namespace {

void fail(const char* expression, const char* file, int line) {
    std::cerr << file << ':' << line << ": check failed: " << expression << '\n';
    std::abort();
}

#define CHECK(expression) \
    do { \
        if (!(expression)) { \
            fail(#expression, __FILE__, __LINE__); \
        } \
    } while (false)

class LivePageRegistry {
public:
    void add(dlks::Page* page) {
        std::lock_guard<std::mutex> lock(mutex_);
        CHECK(pages_.insert(page).second);
    }

    void remove(dlks::Page* page) {
        std::lock_guard<std::mutex> lock(mutex_);
        CHECK(pages_.erase(page) == 1);
    }

    [[nodiscard]] std::size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return pages_.size();
    }

private:
    mutable std::mutex mutex_;
    std::unordered_set<dlks::Page*> pages_;
};

void check_page_accounting(
    const dlks::NumaPagePool& pool,
    std::size_t expected_total) {
    const auto stats = pool.statistics();
    CHECK(stats.total_pages == expected_total);
    CHECK(stats.central_free_pages + stats.cached_pages +
              stats.allocated_pages + stats.recycling_pages ==
          expected_total);
    CHECK(stats.central_free_by_node.size() == stats.page_budget_by_node.size());
}

void test_unique_ownership_and_budget() {
    const dlks::NumaTopology topology(
        {{2, 50}, {2, 60}, {2, 70}},
        {
            {50, 50, 300},
            {50, 60, 80},
            {300, 80, 70},
        });

    dlks::NumaPoolConfig config;
    config.page_size = 256;
    config.local_batch = 2;
    config.local_cache_limit = 3;
    config.borrow_threshold = 2;
    config.return_batch = 1;
    config.max_remote_pages = 4;

    dlks::NumaPagePool pool(topology, config);
    std::vector<dlks::Page*> pages;

    while (dlks::Page* page = pool.acquire_page(0)) {
        CHECK(page->state() == dlks::PageState::allocated);
        CHECK(page->home_node() < topology.node_count());
        CHECK(reinterpret_cast<std::uintptr_t>(page->data()) % config.page_size == 0);
        for (dlks::Page* existing : pages) {
            CHECK(existing != page);
        }
        pages.push_back(page);
    }

    CHECK(pages.size() == 6);
    CHECK(pages[0]->home_node() == 0);
    CHECK(pages[1]->home_node() == 0);
    CHECK(pages[2]->home_node() == 1);
    CHECK(pages[3]->home_node() == 1);
    CHECK(pages[4]->home_node() == 2);
    CHECK(pages[5]->home_node() == 2);

    auto stats = pool.statistics();
    CHECK(stats.total_pages == topology.total_pages());
    CHECK(stats.page_budget_by_node ==
          std::vector<std::size_t>({2, 2, 2}));
    CHECK(stats.local_allocations == 2);
    CHECK(stats.remote_allocations == 4);
    CHECK(stats.remote_borrows == 4);
    CHECK(stats.remote_pages_live == 4);
    CHECK(stats.remote_peak_per_cache == 4);
    CHECK(stats.remote_peak_per_cache <= config.max_remote_pages);
    check_page_accounting(pool, topology.total_pages());
    CHECK(pool.audit().ok);

    for (dlks::Page* page : pages) {
        pool.release_page(page);
    }
    pool.reclaim_current_thread();

    stats = pool.statistics();
    CHECK(stats.allocated_pages == 0);
    CHECK(stats.cached_pages == 0);
    CHECK(stats.central_free_pages == stats.total_pages);
    CHECK(stats.remote_pages_live == 0);
    CHECK(stats.double_free_rejections == 0);
    check_page_accounting(pool, topology.total_pages());
    CHECK(pool.audit().ok);
}

void test_double_free_rejected() {
    dlks::NumaPoolConfig config;
    config.page_size = 256;
    config.local_batch = 1;
    config.local_cache_limit = 1;
    config.borrow_threshold = 2;
    config.return_batch = 1;
    config.max_remote_pages = 2;

    dlks::NumaPagePool pool(dlks::NumaTopology::uniform(2, 2), config);
    dlks::Page* page = pool.acquire_page(0);
    CHECK(page != nullptr);
    pool.release_page(page);
    pool.release_page(page);
    pool.release_page(nullptr);

    const auto stats = pool.statistics();
    CHECK(stats.double_free_rejections == 1);
    CHECK(stats.invalid_release_rejections == 1);
    check_page_accounting(pool, pool.topology().total_pages());
    CHECK(pool.audit().ok);
}

void test_concurrent_double_release() {
    dlks::NumaPoolConfig config;
    config.page_size = 256;
    config.local_batch = 1;
    config.local_cache_limit = 2;
    config.borrow_threshold = 2;
    config.return_batch = 1;
    config.max_remote_pages = 2;

    dlks::NumaPagePool pool(dlks::NumaTopology::uniform(2, 4), config);
    dlks::Page* page = pool.acquire_page(0);
    CHECK(page != nullptr);

    constexpr std::size_t kReleasers = 8;
    std::atomic<bool> start{false};
    std::vector<std::thread> threads;
    threads.reserve(kReleasers);
    for (std::size_t i = 0; i < kReleasers; ++i) {
        threads.emplace_back([&] {
            while (!start.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            pool.release_page(page);
        });
    }
    start.store(true, std::memory_order_release);
    for (std::thread& thread : threads) {
        thread.join();
    }

    auto stats = pool.statistics();
    CHECK(stats.double_free_rejections == kReleasers - 1);
    CHECK(stats.invalid_release_rejections == 0);
    check_page_accounting(pool, pool.topology().total_pages());
    CHECK(pool.audit().ok);

    pool.reclaim_current_thread();
    stats = pool.statistics();
    CHECK(stats.allocated_pages == 0);
    CHECK(stats.cached_pages == 0);
    CHECK(stats.central_free_pages == pool.topology().total_pages());
    check_page_accounting(pool, pool.topology().total_pages());
    CHECK(pool.audit().ok);
}

void test_progressive_remote_reclamation() {
    dlks::NumaPoolConfig config;
    config.page_size = 256;
    config.local_batch = 1;
    config.local_cache_limit = 1;
    config.borrow_threshold = 3;
    config.return_batch = 1;
    config.max_remote_pages = 5;

    dlks::NumaPagePool pool(
        dlks::NumaTopology::from_page_counts({1, 8}), config);

    std::vector<dlks::Page*> pages;
    dlks::Page* local = pool.acquire_page(0);
    CHECK(local != nullptr);
    CHECK(local->home_node() == 0);
    pages.push_back(local);

    for (int i = 0; i < 5; ++i) {
        dlks::Page* page = pool.acquire_page(0);
        CHECK(page != nullptr);
        CHECK(page->home_node() == 1);
        pages.push_back(page);
    }
    CHECK(pool.acquire_page(0) == nullptr);

    auto stats = pool.statistics();
    CHECK(stats.remote_pages_live == config.max_remote_pages);
    CHECK(stats.remote_peak_per_cache == config.max_remote_pages);

    for (int i = 0; i < 3; ++i) {
        dlks::Page* page = pages.back();
        pages.pop_back();
        pool.release_page(page);
    }

    stats = pool.statistics();
    CHECK(stats.progressive_returns == 3);
    CHECK(stats.progressive_return_events == 3);
    CHECK(stats.remote_pages_live == 2);
    check_page_accounting(pool, 9);
    CHECK(pool.audit().ok);

    for (dlks::Page* page : pages) {
        pool.release_page(page);
    }
    pool.reclaim_current_thread();

    stats = pool.statistics();
    CHECK(stats.allocated_pages == 0);
    CHECK(stats.cached_pages == 0);
    CHECK(stats.central_free_pages == 9);
    CHECK(stats.remote_pages_live == 0);
    CHECK(stats.remote_peak_per_cache <= stats.max_remote_pages_per_cache);
    check_page_accounting(pool, 9);
    CHECK(pool.audit().ok);
}

void test_randomized_concurrent_operations() {
    constexpr std::size_t kWorkers = 8;
    constexpr int kOperationsPerWorker = 5000;

    const dlks::NumaTopology topology =
        dlks::NumaTopology::from_page_counts({28, 24, 20, 16}, 70, 170);
    dlks::NumaPoolConfig config;
    config.page_size = 256;
    config.local_batch = 2;
    config.local_cache_limit = 4;
    config.borrow_threshold = 4;
    config.return_batch = 2;
    config.max_remote_pages = 8;

    dlks::NumaPagePool pool(topology, config);
    LivePageRegistry live;
    std::atomic<bool> stop_reclaimer{false};
    std::atomic<std::uint64_t> reclaimer_passes{0};
    std::atomic<std::uint64_t> successful_acquires{0};

    std::thread reclaimer([&] {
        while (!stop_reclaimer.load(std::memory_order_acquire)) {
            (void)pool.reclaim_all_threads();
            reclaimer_passes.fetch_add(1, std::memory_order_relaxed);
            std::this_thread::yield();
        }
    });

    std::vector<std::thread> workers;
    workers.reserve(kWorkers);
    for (std::size_t worker = 0; worker < kWorkers; ++worker) {
        workers.emplace_back([&, worker] {
            std::mt19937_64 rng(0x5eed1234ULL + worker * 7919ULL);
            std::vector<dlks::Page*> owned;
            owned.reserve(32);
            const auto preferred = static_cast<dlks::NodeId>(worker % 4);

            for (int operation = 0; operation < kOperationsPerWorker; ++operation) {
                const bool want_acquire =
                    owned.empty() || (owned.size() < 32 && (rng() % 100) < 58);

                if (want_acquire) {
                    dlks::Page* page = pool.acquire_page(preferred);
                    if (page != nullptr) {
                        CHECK(page->state() == dlks::PageState::allocated);
                        CHECK(page->home_node() < topology.node_count());
                        live.add(page);
                        owned.push_back(page);
                        successful_acquires.fetch_add(1, std::memory_order_relaxed);
                    }
                } else {
                    const std::size_t index =
                        static_cast<std::size_t>(rng() % owned.size());
                    dlks::Page* page = owned[index];
                    owned[index] = owned.back();
                    owned.pop_back();
                    live.remove(page);
                    pool.release_page(page);
                }

                if ((rng() % 701) == 0) {
                    (void)pool.reclaim_current_thread();
                }
            }

            for (dlks::Page* page : owned) {
                live.remove(page);
                pool.release_page(page);
            }
            (void)pool.reclaim_current_thread();
        });
    }

    for (std::thread& worker : workers) {
        worker.join();
    }
    stop_reclaimer.store(true, std::memory_order_release);
    reclaimer.join();

    (void)pool.reclaim_all_threads();
    const auto stats = pool.statistics();
    CHECK(live.size() == 0);
    CHECK(stats.allocated_pages == 0);
    CHECK(stats.cached_pages == 0);
    CHECK(stats.central_free_pages == topology.total_pages());
    CHECK(stats.remote_pages_live == 0);
    CHECK(stats.remote_peak_per_cache <= config.max_remote_pages);
    CHECK(stats.double_free_rejections == 0);
    CHECK(stats.invalid_release_rejections == 0);
    CHECK(stats.budget_violations == 0);
    CHECK(reclaimer_passes.load(std::memory_order_relaxed) > 0);
    CHECK(successful_acquires.load(std::memory_order_relaxed) > 0);
    check_page_accounting(pool, topology.total_pages());

    const auto audit = pool.audit();
    CHECK(audit.ok);
}

}  // namespace

int main() {
    test_unique_ownership_and_budget();
    test_double_free_rejected();
    test_concurrent_double_release();
    test_progressive_remote_reclamation();
    test_randomized_concurrent_operations();
    std::cout << "numa_page_pool tests passed\n";
    return 0;
}
