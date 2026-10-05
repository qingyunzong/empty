// Lifetime tests.
//
// The index is instantiated with a *poisoning allocator*: whenever a node
// is reclaimed, its storage is overwritten with 0xCD and deliberately not
// returned to the OS, so any stale read of a reclaimed node deterministi-
// cally observes poison instead of a plausible value.  std::barrier is
// used to force the dangerous interleavings: readers querying an old
// snapshot exactly while the writer publishes batches that reclaim the
// nodes of previous versions.
#include <interval_index/interval_index.hpp>

#include <atomic>
#include <barrier>
#include <cstring>
#include <new>
#include <optional>
#include <thread>
#include <vector>

#include "test_util.hpp"

using interval_index::batch;
// NB: no `using interval_index::index` -- glibc declares a legacy POSIX
// function named `index` in <string.h>, which would conflict.

namespace {

std::atomic<std::size_t> g_allocs{0};
std::atomic<std::size_t> g_deallocs{0};

template <typename T>
struct poisoning_alloc {
    using value_type = T;
    poisoning_alloc() = default;
    template <typename U>
    poisoning_alloc(const poisoning_alloc<U>&) {}
    T* allocate(std::size_t n) {
        g_allocs.fetch_add(1, std::memory_order_relaxed);
        return static_cast<T*>(::operator new(n * sizeof(T)));
    }
    void deallocate(T* p, std::size_t n) {
        g_deallocs.fetch_add(1, std::memory_order_relaxed);
        std::memset(reinterpret_cast<unsigned char*>(p), 0xCD, n * sizeof(T));
        // Storage deliberately leaked: poisoned bytes stay observable.
    }
    bool operator==(const poisoning_alloc&) const = default;
};

using poisoned_index = interval_index::index<int, poisoning_alloc<int>>;

constexpr int kPoisonInt = static_cast<int>(0xCDCDCDCDu);

void check_not_poison(std::optional<int> v) {
    if (v) CHECK(*v != kPoisonInt);
}

// Reader hammers an old snapshot while the writer publishes batches that
// reclaim every node the reader is not holding on to.
void test_snapshot_outlives_reclamation() {
    g_allocs = 0;
    g_deallocs = 0;
    {
        poisoned_index idx;
        idx.assign(0, 4096, 7);
        idx.add(100, 3000, 5);
        idx.assign(2048, 2100, 42);

        auto snap = idx.snap();
        std::vector<std::optional<int>> expected(4096);
        for (int x = 0; x < 4096; ++x) expected[x] = snap.query(x);

        std::barrier sync(2);
        std::atomic<bool> writer_done{false};
        std::thread writer([&] {
            sync.arrive_and_wait();
            for (int v = 0; v < 300; ++v) {
                // Each batch replaces the whole coverage, so every node of
                // the previous version becomes garbage immediately.
                idx.apply(batch<int>()
                              .assign(0, 4096, 1000 + v)
                              .add(17, 3000, 1)
                              .assign(500, 900, v));
            }
            writer_done.store(true, std::memory_order_release);
        });

        sync.arrive_and_wait();
        while (!writer_done.load(std::memory_order_acquire)) {
            for (int x = 0; x < 4096; x += 13) {
                auto got = snap.query(x);
                check_not_poison(got);
                CHECK_EQ(got, expected[x]);
            }
        }
        writer.join();

        // Reclamation really happened while we were reading.
        CHECK(g_deallocs.load() > 0);

        // Final full verification of the old snapshot.
        for (int x = 0; x < 4096; ++x) {
            auto got = snap.query(x);
            check_not_poison(got);
            CHECK_EQ(got, expected[x]);
        }
    }
    // Index and snapshot destroyed: every allocation must have been
    // reclaimed exactly once (no leak, no double free).
    CHECK_EQ(g_allocs.load(), g_deallocs.load());
    std::printf("test_lifetime: snapshot survived reclamation "
                "(%zu nodes recycled)\n",
                g_deallocs.load());
}

// One writer, many readers: every published version is constant over the
// whole domain, so any consistent snapshot must read one single value at
// every point.  A torn or poisoned read violates this immediately.
void test_single_writer_multi_reader() {
    g_allocs = 0;
    g_deallocs = 0;
    constexpr int kDomain = 512;
    constexpr int kVersions = 2000;
    constexpr int kReaders = 4;
    {
        poisoned_index idx;
        idx.assign(0, kDomain, 0);

        std::barrier sync(kReaders + 1);
        std::atomic<bool> stop{false};
        std::atomic<long long> reads{0};

        std::thread writer([&] {
            sync.arrive_and_wait();
            for (int v = 1; v <= kVersions; ++v)
                idx.assign(0, kDomain, v);
            stop.store(true, std::memory_order_release);
        });

        std::vector<std::thread> readers;
        for (int t = 0; t < kReaders; ++t) {
            readers.emplace_back([&, t] {
                sync.arrive_and_wait();
                rng r(1000 + t);
                while (!stop.load(std::memory_order_acquire)) {
                    auto s = idx.snap();
                    auto base = s.query(static_cast<int>(r.below(kDomain)));
                    CHECK(base.has_value());
                    check_not_poison(base);
                    for (int probe = 0; probe < 32; ++probe) {
                        auto got =
                            s.query(static_cast<int>(r.below(kDomain)));
                        check_not_poison(got);
                        CHECK_EQ(got, base);  // version is constant
                    }
                    reads.fetch_add(1, std::memory_order_relaxed);
                }
            });
        }
        writer.join();
        for (auto& th : readers) th.join();

        CHECK_EQ(idx.query(0), std::optional<int>(kVersions));
        CHECK(reads.load() > 0);
        std::printf("test_lifetime: %d readers x %lld consistent reads, "
                    "%d versions published\n",
                    kReaders, reads.load(), kVersions);
    }
    CHECK_EQ(g_allocs.load(), g_deallocs.load());
}

}  // namespace

int main() {
    test_snapshot_outlives_reclamation();
    test_single_writer_multi_reader();
    std::puts("test_lifetime: all checks passed");
    return 0;
}
