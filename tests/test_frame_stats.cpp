// Enumerate frames of the manual loop and verify each coroutine frame is
// released exactly once; report releases per frame.
#include <cassert>
#include <cstdio>

#include "cosched/scheduler.hpp"
#include "cosched/task.hpp"

using namespace cosched;

static int finished = 0;

static Task immediate(Scheduler&) { ++finished; co_return; }

static Task yielding(Scheduler& sched) {
    co_await YieldOp{sched};
    co_await YieldOp{sched};
    ++finished;
}

static Task waiting([[maybe_unused]] Scheduler& sched, WaitOp* op) {
    bool ok = co_await *op;
    assert(ok);
    ++finished;
}

int main() {
    reset_stats();
    Scheduler sched;
    WaitOp op{sched};
    {
        Task t1 = immediate(sched);
        Task t2 = yielding(sched);
        Task t3 = waiting(sched, &op);
        t1.start();
        t2.start();
        t3.start();

        std::size_t frame = 0;
        while (sched.pending_ready() > 0 || sched.pending_waiters() > 0) {
            std::size_t ran = sched.run_frame();
            std::printf("  frame %zu: resumed %zu\n", frame, ran);
            if (frame == 1) sched.complete(op.id()); // finish the waiter mid-loop
            ++frame;
            assert(frame < 16); // loop must terminate
        }
        assert(finished == 3);
        sched.shutdown();
        assert(sched.no_dangling());
    }
    assert(stats().total_allocs() == 3);
    assert(stats().total_releases() == 3);
    assert(stats().all_released_once()); // every frame released exactly once
    for (const auto& [f, n] : stats().per_frame())
        std::printf("  releases in frame %zu: %zu\n", f, n);
    std::puts("test_frame_stats: OK");
}
