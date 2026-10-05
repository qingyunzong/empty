#pragma once

#include <atomic>
#include <mutex>
#include <stdexcept>
#include <unordered_set>

struct injected_failure : std::runtime_error {
    injected_failure() : std::runtime_error("injected failure") {}
};

// Element with fault injection and lifetime tracking.
//
// Fault injection (intended for single-threaded fault points):
//  - arm(n): the n-th subsequent construction throws injected_failure.
//  - throw_on_copy / throw_on_move: every copy/move construction throws.
//
// Lifetime tracking (thread-safe):
//  - stats(): constructed/destructed/copies/moves counters.
//  - live_ids(): ids of currently live instances; a destructor running for
//    an id that is not live increments double_destroys.
struct tracked {
    struct counters {
        std::atomic<long> constructed{0};
        std::atomic<long> destructed{0};
        std::atomic<long> copies{0};
        std::atomic<long> moves{0};
        std::atomic<long> double_destroys{0};
    };

    static counters& stats() {
        static counters c;
        return c;
    }
    static std::atomic<long>& throw_countdown() {
        static std::atomic<long> v{-1};
        return v;
    }
    static std::atomic<bool>& throw_on_copy() {
        static std::atomic<bool> v{false};
        return v;
    }
    static std::atomic<bool>& throw_on_move() {
        static std::atomic<bool> v{false};
        return v;
    }
    static std::unordered_set<long>& live_ids() {
        static std::unordered_set<long> s;
        return s;
    }
    static std::mutex& live_mutex() {
        static std::mutex m;
        return m;
    }
    static std::atomic<long>& id_source() {
        static std::atomic<long> v{0};
        return v;
    }

    static void arm(long constructions_until_throw) {
        throw_countdown() = constructions_until_throw;
    }
    static void disarm() {
        throw_countdown() = -1;
        throw_on_copy() = false;
        throw_on_move() = false;
    }

    long id;
    int value;

    explicit tracked(int v = 0) : id(0), value(v) { construct(false); }
    tracked(const tracked& other) : id(0), value(other.value) {
        construct(false);
        stats().copies.fetch_add(1, std::memory_order_relaxed);
    }
    tracked(tracked&& other) : id(0), value(other.value) {
        construct(true);
        stats().moves.fetch_add(1, std::memory_order_relaxed);
    }
    tracked& operator=(const tracked&) = delete;
    tracked& operator=(tracked&&) = delete;

    ~tracked() {
        stats().destructed.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard lock(live_mutex());
        if (live_ids().erase(id) == 0)
            stats().double_destroys.fetch_add(1, std::memory_order_relaxed);
    }

private:
    static void maybe_throw(bool is_move) {
        if (is_move && throw_on_move().load(std::memory_order_relaxed))
            throw injected_failure{};
        if (!is_move && throw_on_copy().load(std::memory_order_relaxed))
            throw injected_failure{};
        if (throw_countdown().load(std::memory_order_relaxed) > 0 &&
            throw_countdown().fetch_sub(1, std::memory_order_relaxed) == 1)
            throw injected_failure{};
    }

    void construct(bool is_move) {
        maybe_throw(is_move);
        id = id_source().fetch_add(1, std::memory_order_relaxed);
        stats().constructed.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard lock(live_mutex());
        live_ids().insert(id);
    }
};
