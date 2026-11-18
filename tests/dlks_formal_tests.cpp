#include "dlks_formal.hpp"

#include <atomic>
#include <barrier>
#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

using namespace std::chrono_literals;

[[noreturn]] void fail(const std::string& message) {
    throw std::runtime_error(message);
}

void require(bool condition, const std::string& message) {
    if (!condition) {
        fail(message);
    }
}

class SequentialSkipListModel {
public:
    static constexpr std::size_t max_height = 20;

    explicit SequentialSkipListModel(std::uint64_t seed) : seed_(seed) {}

    bool insert(int key, int value) {
        if (data_.contains(key)) {
            return false;
        }
        data_.emplace(key, value);
        heights_.emplace(key, next_height());
        return true;
    }

    bool erase(int key) {
        heights_.erase(key);
        return data_.erase(key) != 0;
    }

    std::optional<int> find(int key) const {
        const auto found = data_.find(key);
        if (found == data_.end()) {
            return std::nullopt;
        }
        return found->second;
    }

    const std::map<int, int>& data() const { return data_; }

    std::vector<std::pair<int, std::size_t>> heights() const {
        return {heights_.begin(), heights_.end()};
    }

private:
    std::size_t next_height() {
        const std::uint64_t sequence = sequence_++;
        std::uint64_t bits =
            splitmix64(seed_ + (sequence + 1) * 0x9e3779b97f4a7c15ULL);
        std::size_t height = 1;
        while (height < max_height && (bits & 0x3U) == 0) {
            ++height;
            bits >>= 2;
        }
        return height;
    }

    static std::uint64_t splitmix64(std::uint64_t value) noexcept {
        value += 0x9e3779b97f4a7c15ULL;
        value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
        value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
        return value ^ (value >> 31U);
    }

    std::uint64_t seed_;
    std::uint64_t sequence_ = 0;
    std::map<int, int> data_;
    std::map<int, std::size_t> heights_;
};

template <class List>
void require_matches_model(const List& list,
                           const std::map<int, int>& model,
                           const std::string& context) {
    const auto snapshot = list.snapshot();
    require(snapshot.size() == model.size(), context + ": size mismatch");
    auto it = model.begin();
    for (const auto& [key, value] : snapshot) {
        require(it != model.end(), context + ": extra key");
        require(key == it->first, context + ": key order mismatch");
        require(value == it->second, context + ": value mismatch");
        ++it;
    }
    require(it == model.end(), context + ": missing key");
    require(list.size() == model.size(), context + ": size() mismatch");
    require(list.validate_structure(), context + ": invariant failure");
}

void test_sequential_model() {
    constexpr std::uint64_t seed = 0x123456789abcdef0ULL;
    dlks_formal::ConcurrentSkipList<int, int> list(seed);
    SequentialSkipListModel model(seed);
    std::mt19937 rng(20261119);

    for (int step = 0; step < 30000; ++step) {
        const int key = static_cast<int>(rng() % 2500);
        const int operation = static_cast<int>(rng() % 3);

        if (operation == 0) {
            const bool actual = list.insert(key, key * 7);
            const bool expected = model.insert(key, key * 7);
            require(actual == expected, "insert return mismatch");
        } else if (operation == 1) {
            const bool actual = list.erase(key);
            const bool expected = model.erase(key);
            require(actual == expected, "erase return mismatch");
        } else {
            const auto actual = list.find(key);
            const auto expected = model.find(key);
            require(actual.has_value() == expected.has_value(),
                    "find presence mismatch");
            if (actual) {
                require(*actual == *expected, "find value mismatch");
            }
        }

        if (step % 250 == 0) {
            require_matches_model(list, model.data(), "sequential model");
            require(list.heights() == model.heights(),
                    "tower layout differs from sequential skip-list model");
        }
    }

    require_matches_model(list, model.data(), "sequential final");
    require(list.heights() == model.heights(),
            "final tower layout differs from sequential skip-list model");

    std::map<int, int> rebuilt;
    for (const auto& entry : model.data()) {
        rebuilt.insert(entry);
    }
    require(rebuilt == model.data(), "model sanity");
}

void test_deterministic_levels() {
    constexpr std::uint64_t seed = 0xfeedfacecafebeefULL;
    dlks_formal::ConcurrentSkipList<int, int> first(seed);
    dlks_formal::ConcurrentSkipList<int, int> second(seed);
    dlks_formal::ConcurrentSkipList<int, int> other(seed + 1);

    for (int key = 0; key < 2000; ++key) {
        require(first.insert(key, key), "first deterministic insert");
        require(second.insert(key, key), "second deterministic insert");
        require(other.insert(key, key), "other deterministic insert");
    }

    const auto first_heights = first.heights();
    const auto second_heights = second.heights();
    const auto other_heights = other.heights();
    require(first_heights == second_heights,
            "same seed must produce identical tower heights");
    require(first_heights != other_heights,
            "different seeds should produce a different level stream");

    bool saw_upper_level = false;
    for (const auto& [key, height] : first_heights) {
        (void)key;
        saw_upper_level = saw_upper_level || height > 1;
        require(height >= 1 && height <= first.max_height, "height bounds");
    }
    require(saw_upper_level, "geometric levels never exceeded one");
    require(first.seed() == seed, "seed accessor");
}

void test_repeated_lifetimes() {
    for (int generation = 0; generation < 200; ++generation) {
        dlks_formal::ConcurrentSkipList<int, int, std::less<int>, 6> list(
            static_cast<std::uint64_t>(generation));
        for (int key = 0; key < 64; ++key) {
            require(list.insert(key, generation + key), "generation insert");
        }
        for (int key = 0; key < 64; key += 2) {
            require(list.erase(key), "generation erase");
        }
        require(list.size() == 32, "generation size");
        require(list.validate_structure(), "generation structure");
    }
}

void test_same_key_contention() {
    constexpr int threads = 8;
    constexpr int rounds = 120;
    dlks_formal::ConcurrentSkipList<int, int, std::less<int>, 8> list(99);
    std::barrier sync(threads);
    std::atomic<int> insert_wins{0};
    std::atomic<int> erase_wins{0};
    std::atomic<bool> bad{false};

    std::vector<std::thread> workers;
    workers.reserve(threads);
    for (int thread_id = 0; thread_id < threads; ++thread_id) {
        workers.emplace_back([&, thread_id] {
            for (int round = 0; round < rounds; ++round) {
                const int key = 10000 + round;
                if (thread_id == 0) {
                    insert_wins.store(0, std::memory_order_relaxed);
                }
                sync.arrive_and_wait();

                if (list.insert(key, key * 3)) {
                    insert_wins.fetch_add(1, std::memory_order_relaxed);
                }
                sync.arrive_and_wait();
                if (insert_wins.load(std::memory_order_relaxed) != 1) {
                    bad.store(true, std::memory_order_relaxed);
                }
                if (thread_id == 0) {
                    std::string error;
                    if (!list.validate_structure(&error)) {
                        std::cerr << "post-insert invariant: " << error << '\n';
                        bad.store(true, std::memory_order_relaxed);
                    }
                }
                const auto found = list.find(key);
                if (!found || *found != key * 3) {
                    bad.store(true, std::memory_order_relaxed);
                }
                sync.arrive_and_wait();

                if (thread_id == 0) {
                    erase_wins.store(0, std::memory_order_relaxed);
                }
                sync.arrive_and_wait();
                if (list.erase(key)) {
                    erase_wins.fetch_add(1, std::memory_order_relaxed);
                }
                sync.arrive_and_wait();
                if (erase_wins.load(std::memory_order_relaxed) != 1 ||
                    list.contains(key)) {
                    bad.store(true, std::memory_order_relaxed);
                }
                if (thread_id == 0) {
                    std::string error;
                    if (!list.validate_structure(&error)) {
                        std::cerr << "post-erase invariant: " << error << '\n';
                        bad.store(true, std::memory_order_relaxed);
                    }
                }
                sync.arrive_and_wait();
            }
        });
    }
    for (auto& worker : workers) {
        worker.join();
    }

    require(!bad.load(), "same-key insert/erase contention");
    require(list.empty(), "same-key rounds should end empty");
    require(list.validate_structure(), "same-key final structure");
    list.reclaim_epochs();
}

void test_distinct_key_tower_churn() {
    constexpr int threads = 8;
    constexpr int rounds = 400;
    dlks_formal::ConcurrentSkipList<int, int, std::less<int>, 8> list(123);
    std::barrier sync(threads);
    std::atomic<bool> bad{false};

    std::vector<std::thread> workers;
    workers.reserve(threads);
    for (int thread_id = 0; thread_id < threads; ++thread_id) {
        workers.emplace_back([&, thread_id] {
            for (int round = 0; round < rounds; ++round) {
                const int key = round * threads * 2 + thread_id;
                sync.arrive_and_wait();
                list.insert(key, key);
                sync.arrive_and_wait();
                if (thread_id == 0) {
                    std::string error;
                    if (!list.validate_structure(&error)) {
                        std::cerr << "distinct insert invariant: " << error
                                  << '\n';
                        bad.store(true, std::memory_order_relaxed);
                    }
                }
                sync.arrive_and_wait();
                list.erase(key);
                sync.arrive_and_wait();
                if (thread_id == 0) {
                    std::string error;
                    if (!list.validate_structure(&error)) {
                        std::cerr << "distinct erase invariant: " << error
                                  << '\n';
                        bad.store(true, std::memory_order_relaxed);
                    }
                }
                sync.arrive_and_wait();
            }
        });
    }
    for (auto& worker : workers) {
        worker.join();
    }

    require(!bad.load(), "distinct-key tower invariant");
    require(list.empty(), "distinct-key rounds should end empty");
    require(list.validate_structure(), "distinct-key final structure");
}

struct HistoryOp {
    enum class Type { insert, erase, find };

    Type type;
    std::uint64_t start;
    std::uint64_t end;
    bool result;
    int observed_value;
};

bool history_is_linearizable(std::vector<HistoryOp> ops) {
    const std::size_t count = ops.size();
    if (count == 0) {
        return true;
    }

    const std::uint64_t all = (std::uint64_t{1} << count) - 1;
    std::unordered_set<std::uint64_t> impossible;

    std::function<bool(std::uint64_t, bool, int)> search =
        [&](std::uint64_t used, bool present, int present_value) -> bool {
        if (used == all) {
            return true;
        }

        const std::uint64_t state =
            (used << 1U) | static_cast<std::uint64_t>(present);
        if (impossible.contains(state)) {
            return false;
        }

        for (std::size_t index = 0; index < count; ++index) {
            const std::uint64_t bit = std::uint64_t{1} << index;
            if ((used & bit) != 0) {
                continue;
            }

            bool ready = true;
            for (std::size_t predecessor = 0; predecessor < count;
                 ++predecessor) {
                const std::uint64_t predecessor_bit =
                    std::uint64_t{1} << predecessor;
                if ((used & predecessor_bit) == 0 &&
                    ops[predecessor].end < ops[index].start) {
                    ready = false;
                    break;
                }
            }
            if (!ready) {
                continue;
            }

            const HistoryOp& op = ops[index];
            if (op.type == HistoryOp::Type::find) {
                if (op.result != present ||
                    (op.result && op.observed_value != present_value)) {
                    continue;
                }
                if (search(used | bit, present, present_value)) {
                    return true;
                }
            } else if (op.type == HistoryOp::Type::insert) {
                if (op.result) {
                    if (present) {
                        continue;
                    }
                    if (search(used | bit, true, 100)) {
                        return true;
                    }
                } else {
                    if (!present) {
                        continue;
                    }
                    if (search(used | bit, present, present_value)) {
                        return true;
                    }
                }
            } else {
                if (op.result == present) {
                    const bool old_present = present;
                    const int old_value = present_value;
                    if (search(used | bit, false, 0)) {
                        return true;
                    }
                    present = old_present;
                    present_value = old_value;
                }
            }
        }

        impossible.insert(state);
        return false;
    };

    return search(0, false, 0);
}

void test_linearizable_operation_history() {
    constexpr int threads = 4;
    constexpr int operations_per_thread = 3;
    constexpr int key = 7;

    dlks_formal::ConcurrentSkipList<int, int> list(444);
    std::barrier sync(threads);
    std::atomic<std::uint64_t> clock{0};
    std::mutex history_mutex;
    std::vector<HistoryOp> history;

    std::vector<std::thread> workers;
    workers.reserve(threads);
    for (int thread_id = 0; thread_id < threads; ++thread_id) {
        workers.emplace_back([&, thread_id] {
            sync.arrive_and_wait();
            for (int step = 0; step < operations_per_thread; ++step) {
                const int selector = (thread_id * 5 + step * 7) % 3;
                const std::uint64_t start =
                    clock.fetch_add(1, std::memory_order_acq_rel);

                HistoryOp op{};
                op.start = start;
                op.observed_value = 0;
                if (selector == 0) {
                    op.type = HistoryOp::Type::insert;
                    op.result = list.insert(key, 100);
                } else if (selector == 1) {
                    op.type = HistoryOp::Type::erase;
                    op.result = list.erase(key);
                } else {
                    op.type = HistoryOp::Type::find;
                    const auto found = list.find(key);
                    op.result = found.has_value();
                    op.observed_value = found.value_or(0);
                }
                op.end = clock.fetch_add(1, std::memory_order_acq_rel);

                {
                    std::lock_guard<std::mutex> lock(history_mutex);
                    history.push_back(op);
                }
                std::this_thread::yield();
            }
        });
    }
    for (auto& worker : workers) {
        worker.join();
    }

    require(history.size() ==
                static_cast<std::size_t>(threads * operations_per_thread),
            "history size");
    require(history_is_linearizable(history),
            "operation history is not linearizable");

    bool saw_insert = false;
    bool saw_erase = false;
    bool saw_find = false;
    for (const auto& op : history) {
        saw_insert = saw_insert || op.type == HistoryOp::Type::insert;
        saw_erase = saw_erase || op.type == HistoryOp::Type::erase;
        saw_find = saw_find || op.type == HistoryOp::Type::find;
    }
    require(saw_insert && saw_erase && saw_find,
            "history should exercise all operation kinds");
    require(list.validate_structure(), "history final structure");
}

void test_concurrent_writers_and_readers() {
    constexpr int writer_count = 6;
    constexpr int reader_count = 6;
    constexpr int operations_per_writer = 7000;
    constexpr int keys_per_writer = 700;

    dlks_formal::ConcurrentSkipList<int, int> list(0xabcdef0123456789ULL);
    std::barrier start(writer_count + reader_count);
    std::atomic<bool> writers_done{false};
    std::atomic<bool> reader_bad{false};
    std::vector<std::thread> readers;
    std::vector<std::thread> writers;

    readers.reserve(reader_count);
    writers.reserve(writer_count);
    for (int reader_id = 0; reader_id < reader_count; ++reader_id) {
        readers.emplace_back([&, reader_id] {
            std::mt19937 rng(
                static_cast<std::uint32_t>(9000 + reader_id));
            start.arrive_and_wait();
            std::size_t iteration = 0;
            while (!writers_done.load(std::memory_order_acquire)) {
                const int key =
                    static_cast<int>(rng() % (writer_count * keys_per_writer));
                const auto value = list.find(key);
                if (value && *value != key * 2) {
                    reader_bad.store(true, std::memory_order_relaxed);
                    return;
                }

                if ((iteration++ & 127U) == 0) {
                    const auto snapshot = list.snapshot();
                    for (std::size_t index = 0; index < snapshot.size();
                         ++index) {
                        if (snapshot[index].second != snapshot[index].first * 2 ||
                            (index != 0 &&
                             snapshot[index - 1].first >=
                                 snapshot[index].first)) {
                            reader_bad.store(true, std::memory_order_relaxed);
                            return;
                        }
                    }
                }
            }
        });
    }

    std::vector<std::vector<std::pair<bool, int>>> writer_history(writer_count);
    for (int writer_id = 0; writer_id < writer_count; ++writer_id) {
        writers.emplace_back([&, writer_id] {
            std::mt19937 rng(
                static_cast<std::uint32_t>(4000 + writer_id));
            auto& history =
                writer_history[static_cast<std::size_t>(writer_id)];
            history.reserve(operations_per_writer);
            start.arrive_and_wait();
            const int base = writer_id * keys_per_writer;
            for (int step = 0; step < operations_per_writer; ++step) {
                const int key = base + static_cast<int>(rng() % keys_per_writer);
                if ((rng() & 3U) != 0) {
                    list.insert(key, key * 2);
                    history.emplace_back(true, key);
                } else {
                    list.erase(key);
                    history.emplace_back(false, key);
                }
            }
        });
    }

    for (auto& writer : writers) {
        writer.join();
    }
    writers_done.store(true, std::memory_order_release);
    for (auto& reader : readers) {
        reader.join();
    }

    require(!reader_bad.load(), "reader observed corrupt value or ordering");

    std::map<int, int> model;
    for (int writer_id = 0; writer_id < writer_count; ++writer_id) {
        for (const auto& [is_insert, key] :
             writer_history[static_cast<std::size_t>(writer_id)]) {
            if (is_insert) {
                model[key] = key * 2;
            } else {
                model.erase(key);
            }
        }
    }
    require_matches_model(list, model, "concurrent writers/readers");
    list.reclaim_epochs();
    require_matches_model(list, model, "concurrent after reclaim");
}

struct AllocationCounter {
    inline static std::atomic<long> live{0};
};

template <class T>
struct TrackingAllocator {
    using value_type = T;

    TrackingAllocator() = default;
    template <class U>
    TrackingAllocator(const TrackingAllocator<U>&) noexcept {}

    T* allocate(std::size_t count) {
        T* result = std::allocator<T>{}.allocate(count);
        AllocationCounter::live.fetch_add(static_cast<long>(count),
                                          std::memory_order_relaxed);
        return result;
    }

    void deallocate(T* pointer, std::size_t count) noexcept {
        AllocationCounter::live.fetch_sub(static_cast<long>(count),
                                          std::memory_order_relaxed);
        std::allocator<T>{}.deallocate(pointer, count);
    }

    template <class U>
    bool operator==(const TrackingAllocator<U>&) const noexcept {
        return true;
    }
};

struct BlockingValue {
    inline static std::atomic<bool> armed{false};
    inline static std::atomic<bool> entered_copy{false};
    inline static std::atomic<bool> release_copy{false};

    int value = 0;

    BlockingValue() = default;
    explicit BlockingValue(int input) : value(input) {}

    BlockingValue(const BlockingValue& other) : value(other.value) {
        if (armed.load(std::memory_order_acquire)) {
            entered_copy.store(true, std::memory_order_release);
            while (!release_copy.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        }
    }

    BlockingValue(BlockingValue&& other) noexcept : value(other.value) {}

    BlockingValue& operator=(const BlockingValue& other) {
        value = other.value;
        if (armed.load(std::memory_order_acquire)) {
            entered_copy.store(true, std::memory_order_release);
            while (!release_copy.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        }
        return *this;
    }

    BlockingValue& operator=(BlockingValue&& other) noexcept {
        value = other.value;
        return *this;
    }
};

void test_epoch_delays_memory_reuse() {
    using List = dlks_formal::ConcurrentSkipList<
        int, BlockingValue, std::less<int>, 8, TrackingAllocator<std::byte>>;

    require(AllocationCounter::live.load() == 0,
            "allocation counter should start at zero");
    BlockingValue::armed.store(false);
    BlockingValue::entered_copy.store(false);
    BlockingValue::release_copy.store(false);

    {
        List list(777);
        require(AllocationCounter::live.load() == 2,
                "only sentinels should be allocated initially");
        require(list.insert(1, BlockingValue(123)), "blocking insert");
        require(AllocationCounter::live.load() == 3,
                "one live node should be allocated");

        BlockingValue::armed.store(true, std::memory_order_release);
        std::optional<BlockingValue> reader_result;
        std::thread reader([&] { reader_result = list.find(1); });

        const auto deadline = std::chrono::steady_clock::now() + 5s;
        while (!BlockingValue::entered_copy.load(std::memory_order_acquire)) {
            require(std::chrono::steady_clock::now() < deadline,
                    "reader never reached the value copy");
            std::this_thread::yield();
        }

        require(list.erase(1), "erase while reader is pinned");
        require(AllocationCounter::live.load() == 3,
                "erase must not free a node immediately");

        list.reclaim_epochs();
        require(AllocationCounter::live.load() == 3,
                "reclaim must wait for the pinned reader epoch");

        BlockingValue::release_copy.store(true, std::memory_order_release);
        reader.join();
        require(reader_result.has_value() && reader_result->value == 123,
                "blocked reader result");

        const auto freed = list.reclaim_epochs();
        require(freed == 1, "the erased node should be reclaimed");
        require(AllocationCounter::live.load() == 2,
                "node memory should be reusable after the epoch drains");
        require(list.validate_structure(), "epoch test structure");
    }

    BlockingValue::armed.store(false);
    require(AllocationCounter::live.load() == 0,
            "destructor should release every node");
}

}  // namespace

int main() {
    const std::vector<std::pair<std::string, std::function<void()>>> tests = {
        {"sequential model", test_sequential_model},
        {"deterministic levels", test_deterministic_levels},
        {"repeated lifetimes", test_repeated_lifetimes},
        {"same-key contention", test_same_key_contention},
        {"distinct-key tower churn", test_distinct_key_tower_churn},
        {"linearizable history", test_linearizable_operation_history},
        {"concurrent writers and readers", test_concurrent_writers_and_readers},
        {"epoch delayed reuse", test_epoch_delays_memory_reuse},
    };

    try {
        for (const auto& [name, test] : tests) {
            const auto started = std::chrono::steady_clock::now();
            test();
            const auto elapsed = std::chrono::duration_cast<
                std::chrono::milliseconds>(std::chrono::steady_clock::now() -
                                           started);
            std::cout << "[ PASS ] " << name << " (" << elapsed.count()
                      << " ms)\n";
        }
    } catch (const std::exception& error) {
        std::cerr << "[ FAIL ] " << error.what() << '\n';
        return 1;
    }

    std::cout << "All skip-list tests passed.\n";
    return 0;
}
