// Exception-safety tests: when element construction or moving throws,
// the queue keeps its capacity and original contents.
#include "blocking_queue.hpp"
#include "counted.hpp"

#include <cstdlib>
#include <iostream>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            ++failures;                                                   \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "   \
                      << #cond << '\n';                                   \
        }                                                                 \
    } while (0)

void failed_push_preserves_queue() {
    Counted::reset();
    {
        bq::BlockingQueue<Counted> q(4);
        for (int i = 1; i <= 3; ++i) {
            CHECK(q.push(Counted(i)));
        }
        CHECK(q.size() == 3);
        CHECK(q.capacity() == 4);
        const auto live_before = Counted::live_count();

        // The 4th construction from here throws inside the queue.
        Counted::fail_on_construction(1);
        bool threw = false;
        try {
            q.push(Counted(99));
        } catch (const Counted::construction_error&) {
            threw = true;
        }
        CHECK(threw);
        Counted::fail_on_construction(-1);

        // Capacity and original contents preserved.
        CHECK(q.capacity() == 4);
        CHECK(q.size() == 3);
        CHECK(Counted::live_count() == live_before);
        for (int i = 1; i <= 3; ++i) {
            auto v = q.pop();
            CHECK(v.has_value());
            CHECK(v->value == i);
        }
        CHECK(q.size() == 0);
    }
    // Everything destroyed exactly once.
    CHECK(Counted::double_destructions == 0);
    CHECK(Counted::live_count() == 0);
    CHECK(Counted::constructions == Counted::destructions);
}

void failed_full_push_keeps_slot() {
    Counted::reset();
    {
        bq::BlockingQueue<Counted> q(2);
        CHECK(q.push(Counted(1)));
        CHECK(q.push(Counted(2)));
        CHECK(q.size() == q.capacity());

        // Full queue: try_push must fail without constructing anything.
        const auto built = Counted::constructions.load();
        CHECK(!q.try_push(Counted(3)));
        CHECK(Counted::constructions == built + 1);  // only the argument temporary

        // Drain one, then a throwing construction must not consume the slot.
        CHECK(q.pop()->value == 1);
        Counted::fail_on_construction(1);
        bool threw = false;
        try {
            q.try_push(Counted(7));
        } catch (const Counted::construction_error&) {
            threw = true;
        }
        CHECK(threw);
        Counted::fail_on_construction(-1);
        CHECK(q.size() == 1);

        // The freed slot is still usable afterwards.
        CHECK(q.try_push(Counted(8)));
        CHECK(q.pop()->value == 2);
        CHECK(q.pop()->value == 8);
    }
    CHECK(Counted::double_destructions == 0);
    CHECK(Counted::live_count() == 0);
    CHECK(Counted::constructions == Counted::destructions);
}

void failed_pop_move_keeps_element() {
    Counted::reset();
    {
        bq::BlockingQueue<Counted> q(3);
        CHECK(q.push(Counted(42)));
        CHECK(q.push(Counted(43)));
        const auto size_before = q.size();

        Counted::set_throw_on_move(true);
        bool threw = false;
        try {
            auto v = q.pop();
            (void)v;
        } catch (const Counted::construction_error&) {
            threw = true;
        }
        CHECK(threw);
        Counted::set_throw_on_move(false);

        // Nothing was removed: size and order are intact.
        CHECK(q.size() == size_before);
        CHECK(q.pop()->value == 42);
        CHECK(q.pop()->value == 43);
        CHECK(q.size() == 0);
    }
    CHECK(Counted::double_destructions == 0);
    CHECK(Counted::live_count() == 0);
    CHECK(Counted::constructions == Counted::destructions);
}

void repeated_failures_then_recovery() {
    Counted::reset();
    {
        bq::BlockingQueue<Counted> q(2);
        // Fail every other construction; queue must stay consistent.
        for (int round = 0; round < 50; ++round) {
            Counted::fail_on_construction(2);  // 2nd construction throws
            bool threw = false;
            try {
                q.push(Counted(round));  // ctor #1 ok (temporary), #2 (in-queue) throws
            } catch (const Counted::construction_error&) {
                threw = true;
            }
            CHECK(threw);
            CHECK(q.size() == 0);
            Counted::fail_on_construction(-1);
            CHECK(q.push(Counted(round)));
            CHECK(q.pop()->value == round);
        }
    }
    CHECK(Counted::double_destructions == 0);
    CHECK(Counted::live_count() == 0);
    CHECK(Counted::constructions == Counted::destructions);
}

}  // namespace

int main() {
    failed_push_preserves_queue();
    failed_full_push_keeps_slot();
    failed_pop_move_keeps_element();
    repeated_failures_then_recovery();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "exception_safety_test: all checks passed "
              << "(constructions=" << Counted::constructions
              << ", destructions=" << Counted::destructions
              << ", double_destructions=" << Counted::double_destructions << ")\n";
    return EXIT_SUCCESS;
}
