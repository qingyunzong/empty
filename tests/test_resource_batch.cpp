#include "resource_batch.hpp"

#include <algorithm>
#include <cstdio>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
        }                                                                  \
    } while (0)

using Trace = std::vector<std::size_t>;
using resource_batch::AcquireError;
using resource_batch::Handle;
using resource_batch::acquire_batch;

// Acquire that succeeds for the first `fail_at` calls, then throws.
struct AcquireInjector {
    std::size_t fail_at;
    std::size_t calls = 0;
    std::size_t operator()(std::size_t i) {
        ++calls;
        if (i == fail_at) {
            throw std::runtime_error("injected acquire failure");
        }
        return 100 + i; // deterministic resource id
    }
};

Trace reversed_ids(std::size_t first, std::size_t count) {
    Trace t;
    for (std::size_t n = count; n-- > 0;) {
        t.push_back(100 + n);
    }
    (void)first;
    return t;
}

// 1. Full success: every handle released exactly once at scope exit.
void test_all_success() {
    Trace trace;
    {
        auto handles = acquire_batch(5, AcquireInjector{999},
            [&](std::size_t id) { trace.push_back(id); });
        CHECK(handles.size() == 5);
        CHECK(trace.empty()); // nothing released while alive
        for (std::size_t i = 0; i < 5; ++i) {
            CHECK(handles[i].id() == 100 + i);
        }
    }
    CHECK(trace.size() == 5);
    Trace sorted = trace;
    std::sort(sorted.begin(), sorted.end());
    CHECK((sorted == Trace{100, 101, 102, 103, 104})); // each exactly once
}

// 2. Failure injection at k-th item: reverse-order rollback of 0..k-1.
void test_failure_injection() {
    constexpr std::size_t n = 6;
    for (std::size_t k = 0; k < n; ++k) {
        Trace trace;
        std::size_t err_index = 999;
        bool caught = false;
        try {
            auto handles = acquire_batch(n, AcquireInjector{k},
                [&](std::size_t id) { trace.push_back(id); });
            (void)handles;
        } catch (const AcquireError& e) {
            caught = true;
            err_index = e.index;
            CHECK(e.release_errors == 0);
        }
        CHECK(caught);
        CHECK(err_index == k);
        CHECK((trace == reversed_ids(100, k))); // k-1 ... 0, reverse order
    }
}

// 3. Throwing release callback: rollback still cleans up remaining items.
void test_throwing_release() {
    Trace trace;
    std::size_t release_errors = 0;
    bool caught = false;
    try {
        auto handles = acquire_batch(6, AcquireInjector{5},
            [&](std::size_t id) {
                trace.push_back(id);
                if (id == 102) {
                    throw std::runtime_error("release blew up");
                }
            });
        (void)handles;
    } catch (const AcquireError& e) {
        caught = true;
        release_errors = e.release_errors;
    }
    CHECK(caught);
    CHECK(release_errors == 1);
    // All five acquired resources released in reverse order despite the throw.
    CHECK((trace == Trace{104, 103, 102, 101, 100}));
}

// 4. Move chain: ownership transfers, moved-from handles are inert,
//    exactly one release happens when the final handle dies.
void test_move_chain() {
    Trace trace;
    auto release = [&](std::size_t id) { trace.push_back(id); };
    {
        Handle h1(42, release);
        Handle h2(std::move(h1));          // move-construct
        CHECK(!h1.valid());
        CHECK(h2.valid() && h2.id() == 42);
        Handle h3;
        h3 = std::move(h2);                // move-assign onto empty
        CHECK(!h2.valid());
        CHECK(h3.valid() && h3.id() == 42);
        Handle h4(77, release);
        h4 = std::move(h3);                // move-assign releases old 77 first
        CHECK(!h3.valid());
        CHECK(h4.valid() && h4.id() == 42);
        CHECK((trace == Trace{77}));       // displaced resource released once
        Handle& alias = h4;
        h4 = std::move(alias);             // self move-assign is a no-op
        CHECK(h4.valid() && h4.id() == 42);
    }
    CHECK((trace == Trace{77, 42}));       // 42 released exactly once, at the end
}

// 5. Manual reset is idempotent: destructor must not double-release.
void test_reset_idempotent() {
    Trace trace;
    Handle h(7, [&](std::size_t id) { trace.push_back(id); });
    CHECK(h.reset());
    CHECK(!h.valid());
    CHECK(h.reset()); // empty handle: no callback, nothing thrown
    CHECK((trace == Trace{7}));
} // destructor: still exactly one entry

// 6. Empty batch and no-failure injection boundary.
void test_empty_and_boundary() {
    Trace trace;
    auto empty = acquire_batch(0, AcquireInjector{0},
        [&](std::size_t id) { trace.push_back(id); });
    CHECK(empty.empty());
    CHECK(trace.empty());

    // fail_at == count means "no failure": full batch succeeds.
    auto full = acquire_batch(3, AcquireInjector{3},
        [&](std::size_t id) { trace.push_back(id); });
    CHECK(full.size() == 3);
    CHECK(trace.empty());
}

} // namespace

int main() {
    test_all_success();
    test_failure_injection();
    test_throwing_release();
    test_move_chain();
    test_reset_idempotent();
    test_empty_and_boundary();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
