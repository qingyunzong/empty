// Completion vs cancellation race: the waiter is resumed exactly once.
#include <cassert>
#include <cstdio>

#include "cosched/scheduler.hpp"
#include "cosched/task.hpp"

using namespace cosched;

static int resumed_after_wait = 0;
static int outcome = -1; // 1 = completed, 0 = cancelled

static Task worker(Scheduler& sched, WaitOp* op) {
    bool ok = co_await *op;
    ++resumed_after_wait; // must run exactly once
    outcome = ok ? 1 : 0;
}

static void run_scenario(bool complete_first) {
    reset_stats();
    resumed_after_wait = 0;
    outcome = -1;
    {
        Scheduler sched;
        WaitOp op{sched};
        {
            Task t = worker(sched, &op);
            t.start();
            assert(sched.run_frame() == 1); // frame 0: runs to co_await, registers
            assert(sched.pending_waiters() == 1);

            bool first = complete_first ? sched.complete(op.id()) : sched.cancel(op.id());
            bool second = complete_first ? sched.cancel(op.id()) : sched.complete(op.id());
            assert(first && !second); // exactly one claim wins
            assert(sched.pending_waiters() == 0);

            assert(sched.run_frame() == 1); // frame 1: resumes the waiter once
            assert(resumed_after_wait == 1);
            assert(outcome == (complete_first ? 1 : 0));
            assert(sched.run_frame() == 0); // nothing left to resume
            assert(resumed_after_wait == 1);
        }
        sched.shutdown();
        assert(sched.no_dangling());
    }
    assert(stats().all_released_once());
    assert(stats().total_allocs() == stats().total_releases());
    std::printf("  scenario complete_first=%d: resumed=%d outcome=%d releases/frame:",
                complete_first, resumed_after_wait, outcome);
    for (const auto& [f, n] : stats().per_frame()) std::printf(" [f%zu]=%zu", f, n);
    std::printf("\n");
}

int main() {
    run_scenario(true);
    run_scenario(false);
    std::puts("test_completion: OK");
}
