#include "dlks_formal.hpp"
#include "naive_session_model.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using dlks_formal::session_window_state;
using dlks_formal::step_result;
using dlks_formal::timestamp_t;
using dlks_formal::window_result;

void require(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void require_equal(std::size_t actual, std::size_t expected, const std::string& context) {
    if (actual != expected) {
        throw std::runtime_error(context + ": expected " + std::to_string(expected) +
                                 ", got " + std::to_string(actual));
    }
}

void require_equal(timestamp_t actual, timestamp_t expected, const std::string& context) {
    if (actual != expected) {
        throw std::runtime_error(context + ": expected " + std::to_string(expected) +
                                 ", got " + std::to_string(actual));
    }
}

void require_event(const dlks_formal::event<>& actual, const naive::event& expected,
                   const std::string& context) {
    require(actual.key == expected.key, context + ": key differs");
    require_equal(actual.timestamp, expected.time, context + ": timestamp");
    require(actual.value == expected.value, context + ": value differs");
    require(actual.sequence == expected.seq, context + ": sequence differs");
}

void require_matches(const step_result<>& actual, const naive::result& expected,
                     const std::string& context) {
    require_equal(actual.closed.size(), expected.closed.size(), context + ": closed count");
    require_equal(actual.late.size(), expected.late.size(), context + ": late count");

    for (std::size_t i = 0; i < actual.closed.size(); ++i) {
        const auto& got = actual.closed[i];
        const auto& want = expected.closed[i];
        const std::string prefix = context + ": closed[" + std::to_string(i) + "]";
        require(got.key == want.key, prefix + ": key differs");
        require_equal(got.start, want.start, prefix + ": start");
        require_equal(got.end, want.end, prefix + ": end");
        require(got.aggregate == want.aggregate, prefix + ": aggregate differs");
        require_equal(got.members.size(), want.members.size(), prefix + ": member count");
        for (std::size_t j = 0; j < got.members.size(); ++j) {
            require_event(got.members[j], want.members[j],
                          prefix + ".members[" + std::to_string(j) + "]");
        }
    }

    for (std::size_t i = 0; i < actual.late.size(); ++i) {
        require_event(actual.late[i], expected.late[i],
                      context + ": late[" + std::to_string(i) + "]");
    }
}

void require_window(const window_result<>& window, const std::string& key,
                    timestamp_t start, timestamp_t end,
                    const std::vector<std::pair<timestamp_t, std::int64_t>>& members,
                    std::int64_t aggregate, const std::string& context) {
    require(window.key == key, context + ": key differs");
    require_equal(window.start, start, context + ": start");
    require_equal(window.end, end, context + ": end");
    require(window.aggregate == aggregate, context + ": aggregate differs");
    require_equal(window.members.size(), members.size(), context + ": member count");

    std::vector<std::pair<timestamp_t, std::int64_t>> actual_members;
    for (const auto& member : window.members) {
        actual_members.emplace_back(member.timestamp, member.value);
    }
    require(actual_members == members, context + ": member order or values differ");
}

void test_gap_boundary_merges_exactly() {
    session_window_state<> state(5);
    static_cast<void>(state.process("a", 10, 1));
    static_cast<void>(state.process("a", 15, 2));

    auto at_boundary = state.advance_watermark(20);
    require(at_boundary.closed.empty(), "watermark at end + gap must keep the session open");
    require(at_boundary.late.empty(), "boundary watermark must not create side output");

    static_cast<void>(state.process("a", 20, 3));
    auto before_close = state.advance_watermark(25);
    require(before_close.closed.empty(),
            "watermark equal to end + gap must not close the session");

    auto closed = state.advance_watermark(26);
    require_equal(closed.closed.size(), 1, "exactly-at-gap merged window count");
    require_window(closed.closed[0], "a", 10, 20, {{10, 1}, {15, 2}, {20, 3}}, 6,
                   "exactly-at-gap merged window");
}

void test_gap_plus_one_stays_separate() {
    session_window_state<> state(5);
    static_cast<void>(state.process("a", 10, 4));
    static_cast<void>(state.process("a", 16, 7));

    auto closed = state.advance_watermark(100);
    require_equal(closed.closed.size(), 2, "gap + 1 window count");
    require_window(closed.closed[0], "a", 10, 10, {{10, 4}}, 4, "left singleton");
    require_window(closed.closed[1], "a", 16, 16, {{16, 7}}, 7, "right singleton");
}

void test_all_input_orders() {
    {
        std::vector<timestamp_t> order{0, 3, 6};
        do {
            session_window_state<> state(3);
            for (const auto timestamp : order) {
                static_cast<void>(state.process("a", timestamp, timestamp));
            }
            auto closed = state.advance_watermark(100);
            require_equal(closed.closed.size(), 1, "all exact-gap permutations merge");
            require_window(closed.closed[0], "a", 0, 6, {{0, 0}, {3, 3}, {6, 6}}, 9,
                           "exact-gap permutation");
        } while (std::next_permutation(order.begin(), order.end()));
    }

    {
        std::vector<timestamp_t> order{0, 4, 8};
        do {
            session_window_state<> state(3);
            for (const auto timestamp : order) {
                static_cast<void>(state.process("a", timestamp, timestamp));
            }
            auto closed = state.advance_watermark(100);
            require_equal(closed.closed.size(), 3, "all gap+1 permutations stay split");
            require_window(closed.closed[0], "a", 0, 0, {{0, 0}}, 0,
                           "split permutation left");
            require_window(closed.closed[1], "a", 4, 4, {{4, 4}}, 4,
                           "split permutation middle");
            require_window(closed.closed[2], "a", 8, 8, {{8, 8}}, 8,
                           "split permutation right");
        } while (std::next_permutation(order.begin(), order.end()));
    }
}

void test_cascading_multi_window_merge() {
    session_window_state<> state(3);
    static_cast<void>(state.process("a", 0, 0));
    static_cast<void>(state.process("a", 6, 6));
    static_cast<void>(state.process("a", 9, 9));
    static_cast<void>(state.process("a", 3, 3));
    static_cast<void>(state.process("a", 12, 12));

    auto boundary = state.advance_watermark(15);
    require(boundary.closed.empty(), "cascade window must survive exact gap watermark");

    auto closed = state.advance_watermark(16);
    require_equal(closed.closed.size(), 1, "cascade merged window count");
    require_window(closed.closed[0], "a", 0, 12,
                   {{0, 0}, {3, 3}, {6, 6}, {9, 9}, {12, 12}}, 30,
                   "cascade merged window");
}

void test_watermark_boundary_and_lateness() {
    session_window_state<> state(5);
    static_cast<void>(state.process("a", 10, 1));

    auto first = state.advance_watermark(10);
    require(first.closed.empty() && first.late.empty(), "watermark at event time is a no-op");

    auto too_early = state.process("a", 9, 100);
    require(too_early.closed.empty(), "late event must not close windows");
    require_equal(too_early.late.size(), 1, "late event count");
    require(too_early.late[0].timestamp == 9, "late timestamp");
    require(too_early.late[0].value == 100, "late value");
    require(too_early.late[0].sequence == 1, "late event consumes an input sequence");

    auto equal_time = state.process("a", 10, 2);
    require(equal_time.late.empty(), "timestamp equal to watermark is accepted");

    auto exact_gap = state.advance_watermark(15);
    require(exact_gap.closed.empty(), "event exactly gap from end keeps window open");

    static_cast<void>(state.process("a", 15, 3));
    auto close = state.advance_watermark(21);
    require_equal(close.closed.size(), 1, "closed window count");
    require_window(close.closed[0], "a", 10, 15, {{10, 1}, {10, 2}, {15, 3}}, 6,
                   "window after watermark boundary");

    auto late_after_close = state.process("a", 20, 200);
    require(late_after_close.closed.empty(), "late event cannot modify closed window");
    require_equal(late_after_close.late.size(), 1, "post-close late count");
    require(late_after_close.late[0].sequence == 4, "post-close late sequence");

    auto next = state.process("a", 21, 21);
    require(next.late.empty(), "event on watermark starts a new open session");
    auto next_boundary = state.advance_watermark(26);
    require(next_boundary.closed.empty(), "new window survives exact gap watermark");
    auto next_close = state.advance_watermark(27);
    require_equal(next_close.closed.size(), 1, "new window count");
    require_window(next_close.closed[0], "a", 21, 21, {{21, 21}}, 21,
                   "new window after prior closure");
}

void test_empty_input() {
    session_window_state<> state;
    auto advanced = state.advance_watermark(0);
    require(advanced.closed.empty() && advanced.late.empty(), "empty state emits nothing");

    auto repeated = state.advance_watermark(0);
    require(repeated.closed.empty() && repeated.late.empty(), "repeated watermark emits nothing");
    require_equal(state.open_window_count(), 0, "empty state open count");
}

void test_stable_order_and_separate_keys() {
    session_window_state<> state(0);
    static_cast<void>(state.process("b", 5, 1));
    static_cast<void>(state.process("a", 5, 9));
    static_cast<void>(state.process("b", 5, 2));
    static_cast<void>(state.process("a", 5, 8));

    auto closed = state.advance_watermark(6);
    require_equal(closed.closed.size(), 2, "two keys produce two windows");
    require_window(closed.closed[0], "a", 5, 5, {{5, 9}, {5, 8}}, 17, "key a stable order");
    require_window(closed.closed[1], "b", 5, 5, {{5, 1}, {5, 2}}, 3, "key b stable order");
    require(closed.closed[0].members[0].sequence == 1, "a first member input sequence");
    require(closed.closed[0].members[1].sequence == 3, "a second member input sequence");
}

void test_gap_repartition_of_open_windows() {
    session_window_state<> state(10);
    static_cast<void>(state.process("a", 0, 1));
    static_cast<void>(state.process("a", 10, 2));
    require_equal(state.open_window_count(), 1, "broad gap merges open events");

    state.set_gap(3);
    require_equal(state.open_window_count(), 2, "narrow gap splits open events");

    auto closed = state.advance_watermark(4);
    require_equal(closed.closed.size(), 1, "only the left split window expires");
    require_window(closed.closed[0], "a", 0, 0, {{0, 1}}, 1, "left split window");

    state.set_gap(7);
    require_equal(state.open_window_count(), 1, "open windows survive gap widening");
    auto final = state.advance_watermark(18);
    require_equal(final.closed.size(), 1, "widened window closes");
    require_window(final.closed[0], "a", 10, 10, {{10, 2}}, 2, "widened window contents");
}

void test_signed_extreme_distances() {
    session_window_state<> state(std::numeric_limits<timestamp_t>::max());
    static_cast<void>(state.process("a", std::numeric_limits<timestamp_t>::min(), 1));
    static_cast<void>(state.process("a", 10, 2));
    require_equal(state.open_window_count(), 2,
                  "full-range distance exceeds INT64_MAX gap without overflow");

    static_cast<void>(state.process("a", std::numeric_limits<timestamp_t>::min() + 1, 3));
    require_equal(state.open_window_count(), 2,
                  "event near INT64_MIN merges locally but not across the full range");
    static_cast<void>(state.process("b", 0, 0));

    auto closed = state.advance_watermark(std::numeric_limits<timestamp_t>::max());
    require_equal(closed.closed.size(), 1, "full-range closure without overflow");
    require_window(closed.closed[0], "a", std::numeric_limits<timestamp_t>::min(),
                   std::numeric_limits<timestamp_t>::min() + 1,
                   {{std::numeric_limits<timestamp_t>::min(), 1},
                    {std::numeric_limits<timestamp_t>::min() + 1, 3}},
                   4, "INT64_MIN session");
}

std::uint64_t next_random(std::uint64_t& state) {
    state ^= state >> 12;
    state ^= state << 25;
    state ^= state >> 27;
    return state * 0x2545f4914f6cdd1dULL;
}

void test_randomized_event_by_event_differential() {
    const std::vector<std::string> keys{"a", "b", "c"};

    for (std::uint64_t seed = 1; seed <= 32; ++seed) {
        std::uint64_t random = 0x9e3779b97f4a7c15ULL ^ (seed * 0x100000001b3ULL);
        timestamp_t gap = static_cast<timestamp_t>(next_random(random) % 7);
        session_window_state<> state(gap);
        naive::session_model reference(gap);
        timestamp_t watermark = -60;

        for (std::size_t operation = 0; operation < 500; ++operation) {
            const auto choice = next_random(random) % 100;
            const std::string context =
                "seed " + std::to_string(seed) + " operation " + std::to_string(operation);

            if (choice < 18) {
                watermark += static_cast<timestamp_t>(1 + next_random(random) % 14);
                require_matches(state.advance_watermark(watermark),
                                reference.advance(watermark), context + " watermark");
            } else if (choice < 22) {
                gap = static_cast<timestamp_t>(next_random(random) % 8);
                state.set_gap(gap);
                reference.set_gap(gap);
                require_equal(state.gap(), reference.gap(), context + " gap");
            } else {
                const auto timestamp = static_cast<timestamp_t>(next_random(random) % 100) - 30;
                const auto value = static_cast<std::int64_t>(next_random(random) % 41) - 20;
                const auto& key = keys[next_random(random) % keys.size()];
                require_matches(state.process(key, timestamp, value),
                                reference.process(key, timestamp, value), context + " event");
            }
        }

        watermark += static_cast<timestamp_t>(gap + 10);
        require_matches(state.advance_watermark(watermark), reference.advance(watermark),
                        "seed " + std::to_string(seed) + " final watermark");
    }
}

void test_invalid_configuration() {
    bool negative_gap_thrown = false;
    try {
        session_window_state<> invalid(-1);
        static_cast<void>(invalid);
    } catch (const std::invalid_argument&) {
        negative_gap_thrown = true;
    }
    require(negative_gap_thrown, "constructor must reject negative gap");

    session_window_state<> state(1);
    static_cast<void>(state.advance_watermark(10));
    bool backwards_thrown = false;
    try {
        static_cast<void>(state.advance_watermark(9));
    } catch (const std::invalid_argument&) {
        backwards_thrown = true;
    }
    require(backwards_thrown, "backwards watermark must be rejected");

    bool set_gap_thrown = false;
    try {
        state.set_gap(-2);
    } catch (const std::invalid_argument&) {
        set_gap_thrown = true;
    }
    require(set_gap_thrown, "set_gap must reject negative gap");
}

template <class Function>
void run_test(const std::string& name, Function&& test) {
    try {
        test();
        std::cout << "[PASS] " << name << '\n';
    } catch (const std::exception& error) {
        std::cerr << "[FAIL] " << name << ": " << error.what() << '\n';
        throw;
    }
}

}  // namespace

int main() {
    try {
        run_test("gap boundary merges exactly", test_gap_boundary_merges_exactly);
        run_test("gap plus one stays separate", test_gap_plus_one_stays_separate);
        run_test("all input orders", test_all_input_orders);
        run_test("cascading multi-window merge", test_cascading_multi_window_merge);
        run_test("watermark boundary and lateness", test_watermark_boundary_and_lateness);
        run_test("empty input", test_empty_input);
        run_test("stable order and separate keys", test_stable_order_and_separate_keys);
        run_test("gap repartition of open windows", test_gap_repartition_of_open_windows);
        run_test("signed extreme distances", test_signed_extreme_distances);
        run_test("randomized event-by-event differential",
                 test_randomized_event_by_event_differential);
        run_test("invalid configuration", test_invalid_configuration);
    } catch (const std::exception&) {
        return 1;
    }
    return 0;
}
