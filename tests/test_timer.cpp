// Scenario: frame-based delay. async_delay(3) completes three frames after
// registration; the waiter is resumed exactly once, in the firing frame.
#include "check.hpp"

using namespace cosched;

static task delayed(scheduler& s, std::uint64_t frames, int& resumed,
                    std::uint64_t& done_frame) {
    co_await s.async_delay(frames)->wait();
    ++resumed;
    done_frame = s.frame_index();
}

int main() {
    scheduler s;
    int resumed = 0;
    std::uint64_t done_frame = 0;
    {
        auto t = delayed(s, 3, resumed, done_frame);
        t.start();

        s.run_frame();  // frame 1: starts, suspends; timer due at frame 4
        CHECK(resumed == 0);
        CHECK(s.pending_operations() == 1);

        auto f2 = s.run_frame();
        auto f3 = s.run_frame();
        CHECK(f2.timers_fired == 0 && f3.timers_fired == 0);
        CHECK(resumed == 0);

        auto f4 = s.run_frame();  // timer fires; posted resume runs in this frame
        CHECK(f4.timers_fired == 1);
        CHECK(f4.resumed == 1);
        CHECK(resumed == 1);
        CHECK(done_frame == 4);
        CHECK(t.done());

        auto f5 = s.run_frame();  // nothing left to run
        CHECK(f5.posted == 0);
        CHECK(f5.resumed == 0);

        s.run_until_idle();
        CHECK(resumed == 1);  // resumed exactly once
    }
    auto f6 = s.run_frame();
    CHECK(f6.freed == 1);

    print_history(s, "timer");
    CHECK(s.total_resumed() == 2);
    CHECK(s.total_freed() == 1);
    CHECK(s.pending_operations() == 0);
    std::puts("test_timer: OK");
    return 0;
}
