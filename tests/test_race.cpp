// Scenario: completion and destruction race. complete() posts a resume, but
// the task is destroyed before the frame runs; the posted resume must no-op
// and the coroutine frame must be freed exactly once.
#include "check.hpp"

using namespace cosched;

static task waiter(scheduler&, std::shared_ptr<operation> op, int& resumed) {
    co_await op->wait();
    ++resumed;
}

int main() {
    scheduler s;
    int resumed = 0;
    auto op = s.make_operation();
    {
        auto t = waiter(s, op, resumed);
        t.start();
        s.run_frame();            // suspends on op
        CHECK(op->complete());    // resume posted, not yet executed
        t.reset();                // destruction claims the waiter first
        CHECK(s.pending_operations() == 0);
    }
    auto f = s.run_frame();       // posted resume must no-op here
    CHECK(f.posted == 1);
    CHECK(f.resumed == 0);
    CHECK(f.freed == 1);
    CHECK(resumed == 0);

    s.run_until_idle();
    CHECK(resumed == 0);

    print_history(s, "complete-vs-destroy race");
    CHECK(s.total_resumed() == 1);  // only the initial start
    CHECK(s.total_freed() == 1);    // frame freed exactly once
    std::puts("test_race: OK");
    return 0;
}
