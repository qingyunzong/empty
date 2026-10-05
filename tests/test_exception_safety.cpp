#include "bq/bounded_queue.hpp"

#include "check.hpp"
#include "tracked.hpp"

namespace {

void check_lifetime_clean() {
    CHECK(tracked::stats().constructed == tracked::stats().destructed);
    CHECK(tracked::stats().double_destroys == 0);
    std::lock_guard lock(tracked::live_mutex());
    CHECK(tracked::live_ids().empty());
}

}  // namespace

int main() {
    // 1. Throwing in-place construction: capacity and contents preserved.
    {
        bq::bounded_queue<tracked> q(4);
        for (int i = 0; i < 3; ++i)
            CHECK(q.emplace(i));

        tracked::arm(1);  // next construction throws
        bool threw = false;
        try {
            q.emplace(99);
        } catch (const injected_failure&) {
            threw = true;
        }
        CHECK(threw);
        tracked::disarm();

        CHECK(q.size() == 3);
        CHECK(q.capacity() == 4);
        // The failed push consumed no slot: exactly one more element fits.
        CHECK(q.try_emplace(3));
        CHECK(!q.try_emplace(4));
        CHECK(q.size() == 4);
        // Original elements are intact and in order.
        for (int i = 0; i < 4; ++i) {
            auto v = q.pop();
            CHECK(v && v->value == i);
        }
    }
    check_lifetime_clean();

    // 2. Throwing move into the queue: no slot leaked, capacity preserved.
    {
        bq::bounded_queue<tracked> q(2);
        CHECK(q.emplace(1));

        tracked::throw_on_move() = true;
        bool threw = false;
        try {
            q.try_push(tracked(3));  // temporary constructs, move into slot throws
        } catch (const injected_failure&) {
            threw = true;
        }
        CHECK(threw);
        tracked::disarm();

        CHECK(q.size() == 1);
        CHECK(q.try_emplace(2));    // exactly one slot remained
        CHECK(!q.try_emplace(4));   // now full
        CHECK(q.pop()->value == 1);
        CHECK(q.pop()->value == 2);
        CHECK(q.try_pop() == std::nullopt);
    }
    check_lifetime_clean();

    // 3. Throwing copy push: queue stays empty, full capacity remains usable.
    {
        bq::bounded_queue<tracked> q(2);
        tracked src(7);

        tracked::throw_on_copy() = true;
        bool threw = false;
        try {
            q.push(src);
        } catch (const injected_failure&) {
            threw = true;
        }
        CHECK(threw);
        tracked::disarm();

        CHECK(q.size() == 0);
        CHECK(q.try_emplace(1));
        CHECK(q.try_emplace(2));
        CHECK(!q.try_emplace(3));
        CHECK(q.pop()->value == 1);
        CHECK(q.pop()->value == 2);
    }
    check_lifetime_clean();

    // 4. Throwing move during pop: element stays queued and deliverable.
    {
        bq::bounded_queue<tracked> q(2);
        CHECK(q.emplace(42));

        tracked::throw_on_move() = true;
        bool threw = false;
        try {
            (void)q.pop();
        } catch (const injected_failure&) {
            threw = true;
        }
        CHECK(threw);
        tracked::disarm();

        CHECK(q.size() == 1);  // element preserved
        auto v = q.pop();
        CHECK(v && v->value == 42);
        CHECK(q.try_pop() == std::nullopt);
    }
    check_lifetime_clean();

    PASS("test_exception_safety");
}
