// Scenario: manual completion. A waiter suspends on an operation; the
// completer wins the race, the waiter is resumed exactly once.
#include "check.hpp"

using namespace cosched;

static task waiter(scheduler&, std::shared_ptr<operation> op, int& resumed) {
    co_await op->wait();
    ++resumed;
}

int main() {
    scheduler s;
    int resumed = 0;
    {
        auto op = s.make_operation();
        auto t = waiter(s, op, resumed);
        t.start();

        auto f1 = s.run_frame();  // coroutine starts and suspends on op
        CHECK(f1.resumed == 1);
        CHECK(resumed == 0);
        CHECK(s.pending_operations() == 1);

        CHECK(op->complete());    // posts the resume
        CHECK(!op->complete());   // second completion loses the race

        auto f2 = s.run_frame();  // posted resume runs here
        CHECK(f2.resumed == 1);
        CHECK(resumed == 1);
        CHECK(t.done());

        s.run_until_idle();
        CHECK(resumed == 1);  // resumed exactly once
    }  // task destructs -> coroutine frame freed (deferred to next frame)

    auto f3 = s.run_frame();
    CHECK(f3.freed == 1);

    print_history(s, "completion");
    CHECK(s.total_resumed() == 2);  // initial start + completion resume
    CHECK(s.total_freed() == 1);
    CHECK(s.pending_operations() == 0);
    std::puts("test_completion: OK");
    return 0;
}
