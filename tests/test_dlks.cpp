#include "dlks_formal.hpp"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* expression, const char* file,
           int line) {
    if (!condition) {
        ++failures;
        std::cerr << file << ':' << line << ": check failed: " << expression
                  << '\n';
    }
}

#define CHECK(expression) \
    check(static_cast<bool>(expression), #expression, __FILE__, __LINE__)

void require(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

struct Rng {
    explicit Rng(std::uint64_t seed) : state(seed) {}

    std::uint64_t next() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        return state;
    }

    std::uint32_t bounded(std::uint32_t limit) {
        return static_cast<std::uint32_t>(next() % limit);
    }

    std::uint64_t state;
};

void test_epoch_reclamation() {
    dlks::EpochManager epochs;
    auto guard = epochs.pin();
    const std::uint64_t retired_epoch = epochs.advance();
    CHECK(!epochs.safe_to_reclaim(retired_epoch));
    guard = dlks::EpochManager::ReaderGuard{};
    CHECK(epochs.safe_to_reclaim(retired_epoch));

    dlks::PageManager<int> pages(2);
    const dlks::page_id first = pages.create(42);
    {
        auto page_guard = pages.pin();
        CHECK(pages.get(first) != nullptr);
        CHECK(*pages.get(first) == 42);
        pages.retire(first);
        CHECK(pages.reclaim() == 0);
    }
    CHECK(pages.reclaim() == 1);

    const dlks::page_id reused = pages.create(7);
    CHECK(reused == first);
    CHECK(pages.get(reused) != nullptr);
    CHECK(*pages.get(reused) == 7);
}

void test_sequential_operations() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 4;
    options.internal_max_keys = 4;
    options.page_capacity = 1024;
    dlks::BPlusTree<int, int> tree(options);

    for (int key = 0; key < 300; ++key) {
        CHECK(tree.insert(key, key * 10));
    }
    CHECK(tree.size() == 300);
    CHECK(tree.height() >= 2);
    for (int key = 0; key < 300; ++key) {
        const auto found = tree.find(key);
        CHECK(found.has_value());
        CHECK(found.value_or(-1) == key * 10);
    }

    CHECK(!tree.insert(10, 999));
    CHECK(tree.find(10).value_or(-1) == 100);
    CHECK(!tree.upsert(10, 101));
    CHECK(tree.find(10).value_or(-1) == 101);
    CHECK(tree.upsert(1000, 10000));

    for (int key = 0; key < 300; key += 2) {
        CHECK(tree.erase(key));
    }
    CHECK(tree.size() == 151);
    for (int key = 0; key < 300; ++key) {
        if ((key % 2) == 0) {
            CHECK(!tree.find(key).has_value());
        } else {
            CHECK(tree.find(key).value_or(-1) == key * 10);
        }
    }

    const auto report = tree.check_invariants();
    CHECK(report.ok);
    if (!report.ok) {
        std::cerr << "invariant failure: " << report.message << '\n';
    }

    const auto values = tree.snapshot();
    CHECK(values.size() == tree.size());
    for (std::size_t index = 1; index < values.size(); ++index) {
        CHECK(values[index - 1].first < values[index].first);
    }

    tree.clear();
    CHECK(tree.empty());
    CHECK(!tree.find(1).has_value());
    CHECK(tree.check_invariants().ok);
    for (int key = 0; key < 40; ++key) {
        CHECK(tree.insert(key, key + 7));
    }
    CHECK(tree.size() == 40);
    CHECK(tree.find(17).value_or(-1) == 24);
    CHECK(tree.check_invariants().ok);
}

void test_linearizability_checker_rejects_bad_history() {
    dlks::LinearizabilityChecker<int, int> checker;
    std::map<int, std::optional<int>> absent;

    {
        dlks::OperationHistory<int, int> history;
        history.record_insert(1, 2, 7, 42, true);
        history.record_find(3, 4, 7, std::nullopt);
        const auto report = checker.check(history, absent);
        CHECK(report.status ==
              dlks::LinearizabilityStatus::not_linearizable);
    }

    {
        dlks::OperationHistory<int, int> history;
        history.record_find(1, 4, 7, std::nullopt);
        history.record_insert(2, 3, 7, 42, true);
        const auto report = checker.check(history, absent);
        CHECK(report.ok());
        CHECK(report.explored_states > 0);
    }

    {
        dlks::OperationHistory<int, int> history;
        history.record_insert(1, 2, 7, 42, true);
        history.record_insert(3, 4, 7, 99, false);
        history.record_upsert(5, 6, 7, 77, false);
        history.record_find(7, 8, 7, std::optional<int>{77});
        const auto report = checker.check(history, absent);
        CHECK(report.ok());
    }

    {
        std::map<int, std::optional<int>> present;
        present.emplace(3, std::optional<int>{5});
        dlks::OperationHistory<int, int> history;
        history.record_find(1, 2, 3, std::nullopt);
        const auto report = checker.check(history, present);
        CHECK(report.status ==
              dlks::LinearizabilityStatus::not_linearizable);
    }
}

void test_randomized_against_std_map() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 4;
    options.internal_max_keys = 4;
    options.page_capacity = 8192;
    dlks::BPlusTree<int, int> tree(options);

    std::map<int, int> reference;
    Rng rng(0x123456789abcdef0ULL);

    for (int step = 0; step < 5000; ++step) {
        const int key = static_cast<int>(rng.bounded(260));
        const int value = static_cast<int>(rng.bounded(1000000));
        const std::uint32_t operation = rng.bounded(3);

        if (operation == 0) {
            const auto [it, inserted] = reference.emplace(key, value);
            (void)it;
            CHECK(tree.insert(key, value) == inserted);
        } else if (operation == 1) {
            const bool inserted = !reference.contains(key);
            reference[key] = value;
            CHECK(tree.upsert(key, value) == inserted);
        } else {
            CHECK(tree.erase(key) == (reference.erase(key) != 0));
        }

        if ((step % 100) == 0) {
            CHECK(tree.size() == reference.size());
            for (const auto& [reference_key, reference_value] : reference) {
                const auto found = tree.find(reference_key);
                CHECK(found.has_value());
                CHECK(found.value_or(-1) == reference_value);
            }
            const auto report = tree.check_invariants();
            CHECK(report.ok);
            if (!report.ok) {
                std::cerr << "step " << step << " invariant failure: "
                          << report.message << '\n';
                break;
            }
        }
    }

    CHECK(tree.size() == reference.size());
    const auto values = tree.snapshot();
    CHECK(values.size() == reference.size());
    std::size_t index = 0;
    for (const auto& [key, value] : reference) {
        require(index < values.size(), "snapshot is shorter than reference");
        CHECK(values[index].first == key);
        CHECK(values[index].second == value);
        ++index;
    }
}

void test_descending_comparator() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 3;
    options.internal_max_keys = 3;
    options.page_capacity = 256;
    dlks::BPlusTree<int, int, std::greater<int>> tree(options,
                                                      std::greater<int>{});

    for (int key = 0; key < 80; ++key) {
        CHECK(tree.insert(key, key * 3));
    }
    for (int key = 0; key < 80; ++key) {
        CHECK(tree.find(key).value_or(-1) == key * 3);
    }
    for (int key = 0; key < 40; ++key) {
        CHECK(tree.erase(key));
    }
    const auto report = tree.check_invariants();
    CHECK(report.ok);
    const auto values = tree.snapshot();
    for (std::size_t index = 1; index < values.size(); ++index) {
        CHECK(values[index - 1].first > values[index].first);
    }
}

void test_tree_page_reuse_after_merges() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 2;
    options.internal_max_keys = 2;
    options.page_capacity = 512;
    dlks::BPlusTree<int, int> tree(options);

    for (int key = 0; key < 200; ++key) {
        CHECK(tree.insert(key, key));
    }
    CHECK(tree.page_statistics().live_pages > 1);
    for (int key = 0; key < 200; ++key) {
        CHECK(tree.erase(key));
    }
    tree.reclaim_pages();
    CHECK(tree.empty());
    CHECK(tree.page_statistics().live_pages == 1);
    CHECK(tree.check_invariants().ok);

    for (int key = 0; key < 20; ++key) {
        CHECK(tree.insert(key, key * 2));
    }
    CHECK(tree.find(19).value_or(-1) == 38);
    CHECK(tree.check_invariants().ok);
}

void test_fault_recovery() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 2;
    options.internal_max_keys = 2;
    options.page_capacity = 256;
    dlks::BPlusTree<int, int> tree(options);

    CHECK(tree.insert(0, 0));
    CHECK(tree.insert(1, 10));

    tree.set_fault_injector([](dlks::FaultPoint point) {
        return point == dlks::FaultPoint::after_root_replace;
    });
    bool root_fault = false;
    try {
        (void)tree.insert(2, 20);
    } catch (const dlks::InjectedFault& fault) {
        root_fault =
            fault.point() == dlks::FaultPoint::after_root_replace;
    }
    CHECK(root_fault);
    CHECK(tree.size() == 2);
    CHECK(!tree.find(2).has_value());
    CHECK(tree.check_invariants().ok);
    const auto root_recovery = tree.recover();
    CHECK(root_recovery.rolled_back);
    CHECK(root_recovery.root_restored);
    CHECK(root_recovery.pages_restored > 0);
    tree.clear_fault_injector();

    CHECK(tree.insert(2, 20));
    CHECK(tree.insert(3, 30));
    CHECK(tree.insert(4, 40));
    CHECK(tree.check_invariants().ok);

    CHECK(tree.insert(-1, -10));
    tree.set_fault_injector([](dlks::FaultPoint point) {
        return point == dlks::FaultPoint::after_sibling_update;
    });
    bool sibling_fault = false;
    try {
        (void)tree.insert(-2, -20);
    } catch (const dlks::InjectedFault& fault) {
        sibling_fault =
            fault.point() == dlks::FaultPoint::after_sibling_update;
    }
    CHECK(sibling_fault);
    CHECK(!tree.find(-2).has_value());
    CHECK(tree.check_invariants().ok);
    const auto sibling_recovery = tree.recover();
    CHECK(sibling_recovery.rolled_back);
    CHECK(sibling_recovery.pages_restored > 0);
    tree.clear_fault_injector();

    const auto before_commit_recovery = tree.recovery_stats();
    CHECK(before_commit_recovery.rolled_back >= 2);
    CHECK(tree.insert(-2, -20));
    CHECK(tree.find(-2).value_or(1) == -20);
    CHECK(tree.check_invariants().ok);

    dlks::BPlusTreeOptions crash_options;
    crash_options.leaf_max_keys = 2;
    crash_options.internal_max_keys = 2;
    crash_options.page_capacity = 256;
    crash_options.auto_rollback_on_exception = false;
    dlks::BPlusTree<int, int> crash_tree(crash_options);
    CHECK(crash_tree.insert(0, 0));
    CHECK(crash_tree.insert(1, 10));
    crash_tree.set_fault_injector([](dlks::FaultPoint point) {
        return point == dlks::FaultPoint::after_root_replace;
    });
    try {
        (void)crash_tree.insert(2, 20);
    } catch (const dlks::InjectedFault&) {
    }
    CHECK(crash_tree.size() == 2);
    CHECK(crash_tree.recovery_required());
    bool access_blocked = false;
    try {
        (void)crash_tree.find(0);
    } catch (const std::logic_error&) {
        access_blocked = true;
    }
    CHECK(access_blocked);
    const auto pending_recovery = crash_tree.recover();
    CHECK(pending_recovery.rolled_back);
    CHECK(pending_recovery.root_restored);
    CHECK(!crash_tree.recovery_required());
    CHECK(!crash_tree.find(2).has_value());
    CHECK(crash_tree.check_invariants().ok);
    crash_tree.clear_fault_injector();
    CHECK(crash_tree.insert(2, 20));
    CHECK(crash_tree.find(2).value_or(-1) == 20);
}

struct AuditContext {
    dlks::BPlusTree<int, int>& tree;
    dlks::OperationHistory<int, int>& history;
    std::atomic<std::uint64_t>& clock;
};

void writer_thread(AuditContext context, std::uint64_t seed, int operations) {
    Rng rng(seed);
    for (int index = 0; index < operations; ++index) {
        const int key = static_cast<int>(rng.bounded(192));
        const int value = static_cast<int>(
            (seed & 0xffffU) * 100000U + static_cast<unsigned>(index));
        const std::uint32_t operation = rng.bounded(3);

        if (operation == 0) {
            const auto start = context.clock.fetch_add(1);
            const bool inserted = context.tree.insert(key, value);
            const auto end = context.clock.fetch_add(1);
            context.history.record_insert(start, end, key, value, inserted);
        } else if (operation == 1) {
            const auto start = context.clock.fetch_add(1);
            const bool inserted = context.tree.upsert(key, value);
            const auto end = context.clock.fetch_add(1);
            context.history.record_upsert(start, end, key, value, inserted);
        } else {
            const auto start = context.clock.fetch_add(1);
            const bool erased = context.tree.erase(key);
            const auto end = context.clock.fetch_add(1);
            context.history.record_erase(start, end, key, erased);
        }
    }
}

void reader_thread(AuditContext context, std::uint64_t seed, int operations) {
    Rng rng(seed);
    for (int index = 0; index < operations; ++index) {
        const int key = static_cast<int>(rng.bounded(192));
        const auto start = context.clock.fetch_add(1);
        const auto value = context.tree.find(key);
        const auto end = context.clock.fetch_add(1);
        context.history.record_find(start, end, key, value);
    }
}

void test_concurrent_history() {
    dlks::BPlusTreeOptions options;
    options.leaf_max_keys = 8;
    options.internal_max_keys = 8;
    options.page_capacity = 16384;
    dlks::BPlusTree<int, int> tree(options);

    std::map<int, std::optional<int>> initial;
    for (int key = 0; key < 128; ++key) {
        CHECK(tree.insert(key, key * 1000));
        initial.emplace(key, key * 1000);
    }

    dlks::OperationHistory<int, int> history;
    std::atomic<std::uint64_t> clock{1};
    AuditContext context{tree, history, clock};

    std::vector<std::thread> threads;
    for (int index = 0; index < 4; ++index) {
        threads.emplace_back(writer_thread, context,
                             0x1000ULL + static_cast<std::uint64_t>(index),
                             350);
    }
    for (int index = 0; index < 4; ++index) {
        threads.emplace_back(reader_thread, context,
                             0x2000ULL + static_cast<std::uint64_t>(index),
                             350);
    }
    for (auto& thread : threads) {
        thread.join();
    }

    const auto invariants = tree.check_invariants();
    CHECK(invariants.ok);
    if (!invariants.ok) {
        std::cerr << "concurrent invariant failure: " << invariants.message
                  << '\n';
    }

    dlks::LinearizabilityChecker<int, int> checker;
    const auto linearizability =
        checker.check(history, initial, 8'000'000);
    CHECK(linearizability.ok());
    CHECK(linearizability.explored_states >= history.size());
    CHECK(linearizability.keys > 0);
    if (!linearizability.ok()) {
        std::cerr << "linearizability failure after "
                  << linearizability.operations << " operations on "
                  << linearizability.keys << " keys: "
                  << linearizability.message << '\n';
    }
}

}  // namespace

int main() {
    test_epoch_reclamation();
    test_sequential_operations();
    test_linearizability_checker_rejects_bad_history();
    test_randomized_against_std_map();
    test_descending_comparator();
    test_tree_page_reuse_after_merges();
    test_fault_recovery();
    test_concurrent_history();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all dlks_formal tests passed\n";
    return 0;
}
