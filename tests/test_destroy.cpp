// Destroying a suspended task revokes its waiter registration.
#include <cassert>
#include <cstdio>

#include "cosched/scheduler.hpp"
#include "cosched/task.hpp"

using namespace cosched;

static int resumed = 0;

static Task worker(Scheduler& sched, WaitOp* op) {
    co_await *op;
    ++resumed; // must never run: the task is destroyed while suspended
}

int main() {
    reset_stats();
    Scheduler sched;
    WaitOp op{sched};
    {
        Task t = worker(sched, &op);
        t.start();
        assert(sched.run_frame() == 1);
        assert(sched.pending_waiters() == 1);
    } // t destroyed here while suspended -> unregisters itself

    assert(sched.pending_waiters() == 0);
    assert(!sched.complete(op.id())); // late completion finds nothing
    assert(!sched.cancel(op.id()));   // late cancellation finds nothing
    assert(sched.run_frame() == 0);
    assert(resumed == 0);

    sched.shutdown();
    assert(sched.no_dangling());
    assert(stats().all_released_once());
    assert(stats().total_allocs() == 1 && stats().total_releases() == 1);
    for (const auto& [f, n] : stats().per_frame())
        std::printf("  frame %zu: %zu release(s)\n", f, n);
    std::puts("test_destroy: OK");
}
