#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <unordered_set>

// Test element with controllable throwing constructors and global
// construction/destruction accounting.
//
//  - `fail_on_construction(n)`: the n-th construction from now on throws
//    `construction_error`; -1 disables.
//  - `set_throw_on_move(true)`: every move construction throws.
//  - Every live instance is tracked in a global registry; a destructor
//    running twice for the same serial (double destruction) is recorded.
struct Counted {
    struct construction_error : std::runtime_error {
        using std::runtime_error::runtime_error;
    };

    static inline std::atomic<std::int64_t> constructions{0};
    static inline std::atomic<std::int64_t> destructions{0};
    static inline std::atomic<std::int64_t> double_destructions{0};
    static inline std::atomic<std::int64_t> next_serial{1};
    // -1 = never throw; otherwise throw on the n-th construction from now.
    static inline std::atomic<std::int64_t> throw_countdown{-1};
    static inline std::atomic<bool> throw_on_move{false};

    static std::mutex registry_mutex;
    static std::unordered_set<std::int64_t> live_serials;

    static void reset() {
        constructions = 0;
        destructions = 0;
        double_destructions = 0;
        throw_countdown = -1;
        throw_on_move = false;
        std::lock_guard lock(registry_mutex);
        live_serials.clear();
    }

    static void fail_on_construction(std::int64_t n) { throw_countdown = n; }
    static void set_throw_on_move(bool on) { throw_on_move = on; }

    static std::int64_t live_count() {
        std::lock_guard lock(registry_mutex);
        return static_cast<std::int64_t>(live_serials.size());
    }

    static void maybe_throw() {
        auto n = throw_countdown.load(std::memory_order_relaxed);
        while (n > 0) {
            if (throw_countdown.compare_exchange_weak(n, n - 1,
                                                      std::memory_order_relaxed)) {
                if (n == 1) {
                    throw_countdown.store(-1, std::memory_order_relaxed);
                    throw construction_error("controlled construction failure");
                }
                return;
            }
        }
    }

    void register_live() {
        constructions.fetch_add(1, std::memory_order_relaxed);
        serial = next_serial.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard lock(registry_mutex);
        live_serials.insert(serial);
    }

    int value = 0;
    std::int64_t serial = 0;

    Counted() : Counted(0) {}

    explicit Counted(int v) : value(v) {
        maybe_throw();
        register_live();
    }

    Counted(const Counted& other) : value(other.value) {
        maybe_throw();
        register_live();
    }

    Counted(Counted&& other) noexcept(false) : value(other.value) {
        if (throw_on_move.load(std::memory_order_relaxed)) {
            throw construction_error("controlled move failure");
        }
        maybe_throw();
        register_live();
    }

    Counted& operator=(const Counted&) = delete;
    Counted& operator=(Counted&&) = delete;

    ~Counted() {
        destructions.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard lock(registry_mutex);
        if (live_serials.erase(serial) == 0) {
            double_destructions.fetch_add(1, std::memory_order_relaxed);
        }
    }
};

std::mutex Counted::registry_mutex;
std::unordered_set<std::int64_t> Counted::live_serials;
