// Shutdown cancels pending waiters, drains the loop, and leaves no dangling
// handles; post/register after shutdown are rejected.
#include <cassert>
#include <cstdio>

#include "cosched/scheduler.hpp"
#include "cosched/task.hpp"

using namespace cosched;

static int cancelled = 0;
static int completed = 0;

static Task waiter_task([[maybe_unused]] Scheduler& sched, WaitOp* op) {
    bool ok = co_await *op;
    if (ok) ++completed; else ++cancelled;
}

int main() {
    reset_stats();
    Scheduler sched;
    WaitOp op1{sched}, op2{sched}, op3{sched};
    {
        Task t1 = waiter_task(sched, &op1);
        Task t2 = waiter_task(sched, &op2);
        t1.start();
        t2.start();
        assert(sched.run_frame() == 2); // both register as waiters
        assert(sched.pending_waiters() == 2);

        Task t3 = waiter_task(sched, &op3);
        t3.start(); // queued but not yet run when shutdown hits

        sched.shutdown(); // cancels t1/t2, drains; t3 runs and is cancelled
                          // immediately because registration is closed
        assert(cancelled == 3 && completed == 0);
        assert(sched.no_dangling());

        // After shutdown: nothing can be queued or registered anymore.
        WaitOp op4{sched};
        Task t4 = waiter_task(sched, &op4);
        t4.start(); // rejected
        assert(sched.run_frame() == 0);
        assert(sched.pending_waiters() == 0 && sched.pending_ready() == 0);
        assert(!sched.complete(op1.id()) && !sched.cancel(op2.id()));
        assert(sched.no_dangling());
    }
    assert(stats().all_released_once());
    assert(stats().total_allocs() == 4 && stats().total_releases() == 4);
    for (const auto& [f, n] : stats().per_frame())
        std::printf("  frame %zu: %zu release(s)\n", f, n);
    std::puts("test_shutdown: OK");
}
