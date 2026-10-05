// Scenario: scheduler shutdown. Every registered waiter is resumed exactly
// once with operation_cancelled; afterwards no work is accepted and no
// dangling handles remain.
#include "check.hpp"

using namespace cosched;

static task waiter(scheduler&, std::shared_ptr<operation> op, int& resumed,
                   int& cancelled) {
    try {
        co_await op->wait();
        ++resumed;
    } catch (const operation_cancelled&) {
        ++cancelled;
    }
}

int main() {
    scheduler s;
    int resumed = 0, cancelled = 0;
    auto op1 = s.make_operation();
    auto op2 = s.make_operation();
    {
        auto t1 = waiter(s, op1, resumed, cancelled);
        auto t2 = waiter(s, op2, resumed, cancelled);
        auto op3 = s.async_delay(100);  // far-future timer, must be cancelled
        auto t3 = waiter(s, op3, resumed, cancelled);
        t1.start();
        t2.start();
        t3.start();
        s.run_frame();
        CHECK(s.pending_operations() == 3);

        s.shutdown();
        CHECK(s.is_shutdown());
        CHECK(s.pending_operations() == 0);  // no dangling registrations
        CHECK(cancelled == 3);               // each waiter resumed exactly once
        CHECK(resumed == 0);

        CHECK(!s.post([] {}));      // new work rejected after shutdown
        CHECK(!op1->complete());    // completions after shutdown lose

        auto f = s.run_frame();     // nothing left to run
        CHECK(f.posted == 0);
        CHECK(f.resumed == 0);
    }  // tasks destruct: 3 coroutine frames freed
    auto f = s.run_frame();
    CHECK(f.freed == 3);

    print_history(s, "shutdown");
    CHECK(s.total_resumed() == 6);  // 3 starts + 3 cancellation resumes
    CHECK(s.total_freed() == 3);
    std::puts("test_shutdown: OK");
    return 0;
}
