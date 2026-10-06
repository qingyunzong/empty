#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <thread>

#include <detreduce/bigint.hpp>
#include <detreduce/rational.hpp>
#include <detreduce/reduce.hpp>

#include "check.hpp"

using detreduce::bigint;
using detreduce::cancel_token;
using detreduce::rational;
using detreduce::reduce_options;
using detreduce::reduce_stats;
using detreduce::reduce_status;
using detreduce::serial_tree_reduce;
using detreduce::tree_reduce;

// Deterministic pseudo-random delay so thread completion and barrier
// arrival order vary per seed without data races.
static void jitter(std::size_t i, unsigned seed) {
    std::uint64_t h = (i + 1) * 0x9E3779B97F4A7C15ull ^ (seed * 0xD1B54A32D192ED03ull);
    h ^= h >> 33;
    if ((h & 0xF) == 0) std::this_thread::sleep_for(std::chrono::microseconds(100));
    if ((h & 0x3) == 0) std::this_thread::yield();
}

int main() {
    // 1. Exact rational reduction: parallel == serial tree model,
    //    for several worker counts. Sum of 1/(i+1) for i in [0, 120).
    {
        const std::size_t n = 120;
        const std::size_t chunk = 8;
        auto map = [](std::size_t i) { return rational(1, static_cast<long long>(i + 1)); };
        auto combine = [](const rational& a, const rational& b) { return a + b; };
        const rational expect = serial_tree_reduce<rational>(n, map, combine, chunk);
        for (unsigned w : {1u, 2u, 3u, 4u, 8u}) {
            reduce_stats stats;
            reduce_options o;
            o.chunk_size = chunk;
            o.workers = w;
            o.stats = &stats;
            auto out = tree_reduce<rational>(n, map, combine, o);
            CHECK(out.status == reduce_status::ok);
            CHECK(out.value.has_value() && *out.value == expect);
            CHECK(stats.live_buffers == 0);
            if (w > 1) CHECK(stats.barrier_phases > 0);
        }
    }

    // 2. Barrier disorder vs serial tree model: non-associative combine
    //    makes the combination order observable; jitter shuffles thread
    //    completion and barrier arrival order. Every seed must still
    //    reproduce the serial model bit for bit.
    {
        const std::size_t n = 100000;
        const std::size_t chunk = 128;
        auto map = [](std::size_t i) {
            return static_cast<std::uint64_t>(i * 2654435761u + 7u);
        };
        // Non-associative, non-commutative: order fully determines result.
        auto combine = [](std::uint64_t a, std::uint64_t b) { return a * 3 + b + 1; };
        const std::uint64_t expect =
            serial_tree_reduce<std::uint64_t>(n, map, combine, chunk);
        for (unsigned seed = 0; seed < 12; ++seed) {
            auto jmap = [&](std::size_t i) {
                jitter(i, seed);
                return map(i);
            };
            reduce_stats stats;
            reduce_options o;
            o.chunk_size = chunk;
            o.workers = 8;
            o.stats = &stats;
            auto out = tree_reduce<std::uint64_t>(n, jmap, combine, o);
            CHECK(out.status == reduce_status::ok);
            CHECK(out.value.has_value() && *out.value == expect);
            CHECK(stats.live_buffers == 0);
        }
    }

    // 3. Exact bigint reduction checked against a closed form:
    //    sum_{k=1..n} k^2 = n(n+1)(2n+1)/6.
    {
        const std::size_t n = 1000;
        auto map = [](std::size_t i) {
            const bigint k(static_cast<long long>(i + 1));
            return k * k;
        };
        auto combine = [](const bigint& a, const bigint& b) { return a + b; };
        const bigint bn(static_cast<long long>(n));
        const bigint expect = bn * (bn + 1) * (2 * bn + 1) / 6;
        reduce_options o;
        o.chunk_size = 32;
        o.workers = 4;
        auto out = tree_reduce<bigint>(n, map, combine, o);
        CHECK(out.status == reduce_status::ok);
        CHECK(out.value.has_value() && *out.value == expect);
        CHECK(serial_tree_reduce<bigint>(n, map, combine, 32) == expect);
    }

    // 4. Cancellation: no result, and every buffer is released.
    {
        cancel_token token;
        reduce_stats stats;
        reduce_options o;
        o.chunk_size = 16;
        o.workers = 4;
        o.token = &token;
        o.stats = &stats;
        std::thread canceller([&] {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            token.request();
        });
        auto slow_map = [](std::size_t i) {
            std::this_thread::sleep_for(std::chrono::microseconds(50));
            return static_cast<std::uint64_t>(i);
        };
        auto combine = [](std::uint64_t a, std::uint64_t b) { return a + b; };
        auto out = tree_reduce<std::uint64_t>(200000, slow_map, combine, o);
        canceller.join();
        CHECK(out.status == reduce_status::cancelled);
        CHECK(!out.value.has_value());
        CHECK(!out.error.has_value());
        CHECK(stats.live_buffers == 0);
    }

    // 5. Pre-cancelled token: immediate cancellation, still no leaks.
    {
        cancel_token token;
        token.request();
        reduce_stats stats;
        reduce_options o;
        o.chunk_size = 4;
        o.workers = 2;
        o.token = &token;
        o.stats = &stats;
        auto map = [](std::size_t i) { return static_cast<std::uint64_t>(i); };
        auto combine = [](std::uint64_t a, std::uint64_t b) { return a + b; };
        auto out = tree_reduce<std::uint64_t>(1000, map, combine, o);
        CHECK(out.status == reduce_status::cancelled);
        CHECK(!out.value.has_value());
        CHECK(stats.live_buffers == 0);
    }

    // 6. Chunk failure: the smallest failing chunk index is reported.
    {
        reduce_stats stats;
        reduce_options o;
        o.chunk_size = 10;
        o.workers = 4;
        o.stats = &stats;
        // Failing indices 25, 53, 90 -> chunks 2, 5, 9; minimum is 2.
        auto map = [](std::size_t i) -> std::uint64_t {
            if (i == 25 || i == 53 || i == 90)
                throw std::runtime_error("boom at " + std::to_string(i));
            return static_cast<std::uint64_t>(i);
        };
        auto combine = [](std::uint64_t a, std::uint64_t b) { return a + b; };
        auto out = tree_reduce<std::uint64_t>(1000, map, combine, o);
        CHECK(out.status == reduce_status::failed);
        CHECK(!out.value.has_value());
        CHECK(out.error.has_value());
        if (out.error) {
            CHECK(out.error->chunk == 2);
            CHECK(out.error->message.find("25") != std::string::npos);
        }
        CHECK(stats.live_buffers == 0);
    }

    // 7. Empty input reduces to the default-constructed identity.
    {
        auto map = [](std::size_t) { return rational(1); };
        auto combine = [](const rational& a, const rational& b) { return a + b; };
        auto out = tree_reduce<rational>(0, map, combine);
        CHECK(out.status == reduce_status::ok);
        CHECK(out.value.has_value() && *out.value == rational(0));
    }

    TEST_SUMMARY("test_reduce");
}
