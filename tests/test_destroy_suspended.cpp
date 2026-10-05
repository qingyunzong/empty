// Scenario: destroying a suspended task must revoke its registration, so a
// later completion finds no waiter and touches no dead handle.
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
        s.run_frame();  // suspends on op
        CHECK(s.pending_operations() == 1);

        t.reset();  // destroy while suspended: unregisters + frees the frame
        CHECK(s.pending_operations() == 0);
        CHECK(!op->complete());  // completion after cancel loses the race
    }
    auto f = s.run_frame();  // deferred free is attributed to this frame
    CHECK(f.freed == 1);
    CHECK(f.resumed == 0);
    CHECK(f.posted == 0);

    s.run_until_idle();
    CHECK(resumed == 0);  // waiter was never resumed

    print_history(s, "destroy-suspended");
    CHECK(s.total_freed() == 1);
    CHECK(s.pending_operations() == 0);
    std::puts("test_destroy_suspended: OK");
    return 0;
}
