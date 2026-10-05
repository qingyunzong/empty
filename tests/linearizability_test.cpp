// Linearizability test: worker threads hammer a small BlockingQueue with
// try_push/try_pop (plus one close), starting together on a std::barrier.
// The element type is Counted, with controlled construction/move failures
// injected at random. Every operation is recorded into a history with
// real-time invoke/response stamps; afterwards a Wing-Gong style
// backtracking checker verifies that the history is linearizable against
// the sequential queue-with-close specification. Destruction accounting
// proves no element was destroyed twice (or leaked).
#include "blocking_queue.hpp"
#include "counted.hpp"

#include <algorithm>
#include <atomic>
#include <barrier>
#include <bitset>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <unordered_set>
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

// ---------------------------------------------------------------- history

enum class Kind { Push, PushThrow, Pop, PopThrow, Close };

struct Op {
    Kind kind;
    int value = -1;   // pushed value / popped value
    bool success = false;  // push accepted / pop returned a value
    long invoke = 0;
    long response = 0;
};

std::atomic<long> g_tick{0};
std::mutex g_history_mutex;
std::vector<Op> g_history;

void record(Kind kind, int value, bool success, long invoke) {
    const long response = g_tick.fetch_add(1, std::memory_order_acq_rel);
    std::lock_guard lock(g_history_mutex);
    g_history.push_back(Op{kind, value, success, invoke, response});
}

// ------------------------------------------------------- sequential spec

struct Config {
    std::deque<int> contents;
    bool closed = false;
};

// Applies `op` to `config` if the recorded response is legal; returns false
// if the op cannot happen next in any sequential execution.
bool step(Config& config, const Op& op, std::size_t capacity) {
    switch (op.kind) {
        case Kind::Push:
            if (op.success) {
                if (config.closed || config.contents.size() >= capacity) {
                    return false;
                }
                config.contents.push_back(op.value);
                return true;
            }
            return config.closed || config.contents.size() >= capacity;
        case Kind::PushThrow:
            return true;  // strong guarantee: queue unchanged
        case Kind::Pop:
            if (op.success) {
                if (config.contents.empty() || config.contents.front() != op.value) {
                    return false;
                }
                config.contents.pop_front();
                return true;
            }
            return config.contents.empty();
        case Kind::PopThrow:
            return true;  // strong guarantee: element stays queued
        case Kind::Close:
            config.closed = true;
            return true;
    }
    return false;
}

// ------------------------------------------- Wing-Gong style checker

constexpr std::size_t kMaxOps = 128;
using Mask = std::bitset<kMaxOps>;

std::string memo_key(const Config& config, const Mask& done) {
    std::string key = config.closed ? "1|" : "0|";
    for (int v : config.contents) {
        key += std::to_string(v);
        key += ',';
    }
    key += '|';
    key += done.to_string();
    return key;
}

bool search(Config config, const std::vector<Op>& ops,
            const std::vector<Mask>& predecessors, Mask done,
            std::size_t capacity, std::unordered_set<std::string>& dead) {
    if (done.count() == ops.size()) {
        return true;
    }
    if (!dead.insert(memo_key(config, done)).second) {
        return false;  // already proved impossible from here
    }
    for (std::size_t i = 0; i < ops.size(); ++i) {
        if (done.test(i)) {
            continue;
        }
        if ((predecessors[i] & ~done).any()) {
            continue;  // real-time predecessors not linearized yet
        }
        Config next = config;
        if (!step(next, ops[i], capacity)) {
            continue;
        }
        if (search(next, ops, predecessors, done | Mask{}.set(i), capacity,
                   dead)) {
            return true;
        }
    }
    return false;
}

bool linearizable(const std::vector<Op>& ops, std::size_t capacity) {
    std::vector<Mask> predecessors(ops.size());
    for (std::size_t i = 0; i < ops.size(); ++i) {
        for (std::size_t j = 0; j < ops.size(); ++j) {
            if (i != j && ops[j].response < ops[i].invoke) {
                predecessors[i].set(j);
            }
        }
    }
    std::unordered_set<std::string> dead;
    return search(Config{}, ops, predecessors, Mask{}, capacity, dead);
}

// ------------------------------------------------------------- workload

// The checker must reject histories that violate the specification;
// otherwise a "linearizable" verdict would be meaningless.
void checker_self_test() {
    // FIFO violation: push 1, push 2, then pop 2 (all non-overlapping).
    std::vector<Op> bad = {
        {Kind::Push, 1, true, 0, 1},
        {Kind::Push, 2, true, 2, 3},
        {Kind::Pop, 2, true, 4, 5},
    };
    CHECK(!linearizable(bad, 3));

    // Pop of a value that was never pushed.
    std::vector<Op> bad2 = {
        {Kind::Pop, 7, true, 0, 1},
    };
    CHECK(!linearizable(bad2, 3));

    // Push reported successful on a full (capacity 1) queue.
    std::vector<Op> bad3 = {
        {Kind::Push, 1, true, 0, 1},
        {Kind::Push, 2, true, 2, 3},
    };
    CHECK(!linearizable(bad3, 1));

    // Legal: push 1, push 2, pop 1, pop 2; plus a failed push on full.
    std::vector<Op> good = {
        {Kind::Push, 1, true, 0, 1},
        {Kind::Push, 2, true, 2, 3},
        {Kind::Push, 3, false, 4, 5},  // full at capacity 2 -> rejected
        {Kind::Pop, 1, true, 6, 7},
        {Kind::Pop, 2, true, 8, 9},
        {Kind::Pop, -1, false, 10, 11},  // empty
    };
    CHECK(linearizable(good, 2));

    // Overlapping ops may be reordered: pop 2 overlaps push 1/push 2.
    std::vector<Op> reordered = {
        {Kind::Push, 2, true, 0, 3},
        {Kind::Push, 1, true, 1, 4},
        {Kind::Pop, 2, true, 2, 5},
    };
    CHECK(linearizable(reordered, 3));
}

void linearizability_run() {
    constexpr std::size_t kCapacity = 3;
    constexpr int kWorkers = 4;
    constexpr int kOpsPerWorker = 15;

    Counted::reset();
    g_history.clear();
    g_tick = 0;

    bq::BlockingQueue<Counted> q(kCapacity);
    std::barrier start(kWorkers + 2);  // workers + closer + main

    auto worker = [&](int id) {
        std::mt19937 rng(1234 + id);
        start.arrive_and_wait();
        for (int i = 0; i < kOpsPerWorker; ++i) {
            const bool do_push = (rng() % 2) == 0;
            // Randomly arm a controlled failure for this operation.
            if (rng() % 4 == 0) {
                Counted::fail_on_construction(1);
            }
            if (rng() % 7 == 0) {
                Counted::set_throw_on_move(true);
            }
            const long invoke = g_tick.fetch_add(1, std::memory_order_acq_rel);
            if (do_push) {
                const int value = id * 1000 + i;
                try {
                    Counted tmp(value);  // throwing here is not an op
                    try {
                        const bool ok = q.try_push(std::move(tmp));
                        record(Kind::Push, value, ok, invoke);
                    } catch (const Counted::construction_error&) {
                        record(Kind::PushThrow, value, false, invoke);
                    }
                } catch (const Counted::construction_error&) {
                    // The temporary never existed; nothing to record.
                }
            } else {
                try {
                    auto result = q.try_pop();
                    record(Kind::Pop, result ? result->value : -1,
                           result.has_value(), invoke);
                } catch (const Counted::construction_error&) {
                    record(Kind::PopThrow, -1, false, invoke);
                }
            }
            Counted::set_throw_on_move(false);
        }
    };

    std::vector<std::thread> threads;
    for (int w = 0; w < kWorkers; ++w) {
        threads.emplace_back(worker, w);
    }
    std::thread closer([&] {
        start.arrive_and_wait();
        std::this_thread::sleep_for(std::chrono::microseconds(50));
        const long invoke = g_tick.fetch_add(1, std::memory_order_acq_rel);
        q.close();
        record(Kind::Close, -1, true, invoke);
    });

    start.arrive_and_wait();
    for (auto& t : threads) {
        t.join();
    }
    closer.join();

    // Drain whatever is left so every element is destroyed before checks.
    while (q.try_pop().has_value()) {
    }

    std::vector<Op> history;
    {
        std::lock_guard lock(g_history_mutex);
        history = g_history;
    }
    std::cout << "linearizability_test: checking " << history.size()
              << " operations... " << std::flush;
    const auto begin = std::chrono::steady_clock::now();
    CHECK(linearizable(history, kCapacity));
    const auto elapsed = std::chrono::steady_clock::now() - begin;
    std::cout << "done in "
              << std::chrono::duration_cast<std::chrono::milliseconds>(elapsed)
                     .count()
              << " ms\n";

    // No double destruction, no leak, balanced accounting.
    CHECK(Counted::double_destructions == 0);
    CHECK(Counted::live_count() == 0);
    CHECK(Counted::constructions == Counted::destructions);
}

}  // namespace

int main() {
    checker_self_test();
    linearizability_run();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "linearizability_test: history is linearizable; "
              << "constructions=" << Counted::constructions
              << ", destructions=" << Counted::destructions
              << ", double_destructions=" << Counted::double_destructions
              << '\n';
    return EXIT_SUCCESS;
}
