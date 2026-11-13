#include "dataeng.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <limits>
#include <map>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using dataeng::Change;
using dataeng::Duration;
using dataeng::Event;
using dataeng::IntervalJoin;
using dataeng::Output;
using dataeng::RecordKind;
using dataeng::Side;
using dataeng::Timestamp;

int failures = 0;

void check(bool condition, const std::string& message) {
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << message << '\n';
    }
}

std::string event_text(const Event& event) {
    return event.key + "/" + std::to_string(event.time) + "/" + std::to_string(event.id);
}

std::string record_text(const Output& output) {
    switch (output.kind) {
        case RecordKind::Join:
            return "J(" + event_text(*output.left) + "," + event_text(*output.right) + ")";
        case RecordKind::LeftOuter:
            return "LO(" + event_text(*output.left) + ")";
        case RecordKind::RightOuter:
            return "RO(" + event_text(*output.right) + ")";
    }
    return {};
}

std::map<std::string, int> net_multiset(const std::vector<Output>& outputs) {
    std::map<std::string, int> result;
    for (const Output& output : outputs) {
        int& count = result[record_text(output)];
        count += output.change == Change::Insert ? 1 : -1;
        if (count == 0) {
            result.erase(record_text(output));
        }
    }
    return result;
}

void append(std::vector<Output>& destination, const std::vector<Output>& source) {
    destination.insert(destination.end(), source.begin(), source.end());
}

bool is_kind(const std::vector<Output>& outputs, std::size_t index, Change change, RecordKind kind) {
    return index < outputs.size() && outputs[index].change == change && outputs[index].kind == kind;
}

void test_basic_join_and_inclusive_boundaries() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(10));

    check(join.add_left({"k", 100, 1}).empty(), "left alone emits nothing");
    std::vector<Output> out = join.add_right({"k", 110, 2});
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::Join),
          "exact upper boundary joins");

    out = join.add_right({"k", 111, 3});
    check(out.empty(), "outside upper boundary does not join");

    out = join.add_left({"k", 121, 4});
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::Join),
          "exact lower boundary joins");

    out = join.add_left({"other", 100, 5});
    check(out.empty(), "different keys do not join");
}

void test_each_pair_is_emitted_once() {
    {
        IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
        join.add_left({"k", 100, 1});
        std::vector<Output> out = join.add_right({"k", 100, 2});
        check(out.size() == 1, "left then right emits one pair");
        append(out, join.advance_watermark(Side::Right, 1000));
        append(out, join.advance_watermark(Side::Left, 1000));
        append(out, join.finish());
        check(net_multiset(out).size() == 1, "watermarks do not duplicate the pair");
    }
    {
        IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
        join.add_right({"k", 100, 1});
        std::vector<Output> out = join.add_left({"k", 100, 2});
        check(out.size() == 1, "right then left emits one pair");
    }
    {
        IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
        std::vector<Output> out = join.add_left({"k", 100, 1});
        append(out, join.add_left({"k", 102, 2}));
        append(out, join.add_right({"k", 101, 3}));
        append(out, join.add_right({"k", 104, 4}));
        append(out, join.add_left({"k", 103, 5}));
        append(out, join.finish());
        check(net_multiset(out).size() == 6, "many-to-many emits each pair exactly once");
    }
}

void test_left_outer_is_retracted_by_late_match() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);
    std::vector<Output> all = join.add_left({"k", 100, 1});

    check(join.advance_watermark(Side::Right, 105).empty(),
          "outer waits until watermark passes the deadline");
    std::vector<Output> out = join.advance_watermark(Side::Right, 106);
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::LeftOuter),
          "left outer is emitted after right watermark passes");
    append(all, out);

    out = join.add_right({"k", 103, 2});
    check(out.size() == 2, "late match retracts then joins");
    check(is_kind(out, 0, Change::Retract, RecordKind::LeftOuter),
          "late match first retracts the outer record");
    check(is_kind(out, 1, Change::Insert, RecordKind::Join),
          "late match then emits the joined record");
    append(all, out);
    check(net_multiset(all).size() == 1, "retracted outer is absent from the final multiset");
}

void test_right_outer_is_retracted_by_late_match() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);
    join.add_right({"k", 100, 1});

    check(join.advance_watermark(Side::Left, 105).empty(),
          "right outer waits until left watermark passes the deadline");
    std::vector<Output> out = join.advance_watermark(Side::Left, 106);
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::RightOuter),
          "right outer is emitted after left watermark passes");

    out = join.add_left({"k", 97, 2});
    check(out.size() == 2, "late left match retracts then joins");
    check(is_kind(out, 0, Change::Retract, RecordKind::RightOuter),
          "late match retracts the right outer record");
    check(is_kind(out, 1, Change::Insert, RecordKind::Join),
          "late match emits the joined record");
}

void test_outer_is_retracted_at_most_once() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);
    join.add_left({"k", 100, 1});
    std::vector<Output> out = join.advance_watermark(Side::Right, 106);
    check(out.size() == 1, "outer setup");

    append(out, join.add_right({"k", 101, 2}));
    out = join.add_right({"k", 102, 3});
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::Join),
          "a second matching event only adds a join");

    out = join.add_right({"k", 100, 4});
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::Join),
          "a third matching event does not retract again");
}

void test_multiple_outers_are_retracted() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);
    std::vector<Output> all = join.add_left({"k", 100, 1});
    append(all, join.add_left({"k", 101, 2}));
    std::vector<Output> out = join.advance_watermark(Side::Right, 107);
    check(out.size() == 2, "both left events produce outer records");
    append(all, out);

    out = join.add_right({"k", 103, 3});
    check(out.size() == 4, "two retractions and two joins are emitted");
    check(is_kind(out, 0, Change::Retract, RecordKind::LeftOuter), "first retraction");
    check(is_kind(out, 1, Change::Insert, RecordKind::Join), "first join");
    check(is_kind(out, 2, Change::Retract, RecordKind::LeftOuter), "second retraction");
    check(is_kind(out, 3, Change::Insert, RecordKind::Join), "second join");
    append(all, out);
    check(net_multiset(all).size() == 2, "final multiset has only the two joins");
}

void test_matched_event_never_gets_outer() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
    std::vector<Output> out = join.add_left({"k", 100, 1});
    append(out, join.add_right({"k", 101, 2}));
    append(out, join.advance_watermark(Side::Right, 1000));
    append(out, join.advance_watermark(Side::Left, 1000));
    append(out, join.finish());
    check(net_multiset(out).size() == 1, "matched events do not produce outer records");
    check(join.stats().live_left == 0 && join.stats().live_right == 0,
          "finished state is empty");
}

void test_eviction_uses_lateness_window() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);
    join.add_left({"k", 100, 1});

    std::vector<Output> out = join.advance_watermark(Side::Right, 112);
    check(out.size() == 1 && is_kind(out, 0, Change::Insert, RecordKind::LeftOuter),
          "outer is emitted before the lateness window closes");
    check(join.stats().live_left == 1, "state is retained for late matches");

    out = join.add_right({"k", 104, 2});
    check(out.size() == 2, "late match within the window is accepted");
    check(is_kind(out, 0, Change::Retract, RecordKind::LeftOuter), "late match retracts");

    out = join.advance_watermark(Side::Right, 116);
    check(out.empty(), "eviction emits nothing new");
    check(join.stats().live_left == 0, "state is evicted after the lateness window");

    out = join.add_right({"k", 103, 3});
    check(out.empty(), "event beyond the lateness window is dropped");
    check(join.stats().right_dropped_late == 1, "dropped late event is counted");
}

void test_lateness_acceptance_boundary() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 5);
    std::vector<Output> out = join.advance_watermark(Side::Left, 100);
    check(out.empty(), "watermark alone emits nothing");

    out = join.add_left({"k", 94, 1});
    check(out.empty() && join.stats().left_dropped_late == 1,
          "event just before the lateness boundary is dropped");

    out = join.add_left({"k", 95, 2});
    check(out.empty() && join.stats().left_dropped_late == 1,
          "event exactly at the lateness boundary is accepted");
    check(join.stats().live_left == 1, "accepted late event is retained");
}

void test_finish_emits_both_outer_sides() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(2));
    join.add_left({"a", 10, 1});
    join.add_right({"b", 20, 2});
    std::vector<Output> out = join.finish();
    check(out.size() == 2, "finish emits unmatched records from both sides");
    check(is_kind(out, 0, Change::Insert, RecordKind::LeftOuter), "left outer from finish");
    check(is_kind(out, 1, Change::Insert, RecordKind::RightOuter), "right outer from finish");
    check(join.finish().empty(), "finish is idempotent");
}

void test_asymmetric_bounds() {
    IntervalJoin join(IntervalJoin::Bounds{-2, 5});
    join.add_left({"k", 100, 1});

    check(join.add_right({"k", 97, 2}).empty(), "below asymmetric lower bound");
    check(join.add_right({"k", 98, 3}).size() == 1, "at asymmetric lower bound");
    check(join.add_right({"k", 105, 4}).size() == 1, "at asymmetric upper bound");
    check(join.add_right({"k", 106, 5}).empty(), "above asymmetric upper bound");
}

void test_watermark_is_monotonic() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
    join.advance_watermark(Side::Right, 100);
    check(join.watermark(Side::Right) == 100, "watermark records the value");
    check(join.advance_watermark(Side::Right, 90).empty(), "regressing watermark is ignored");
    check(join.watermark(Side::Right) == 100, "watermark does not move backwards");
}

void test_large_timestamps_saturate() {
    const Timestamp max = std::numeric_limits<Timestamp>::max();
    IntervalJoin join(IntervalJoin::Bounds::symmetric(10));
    join.add_left({"k", max, 1});
    std::vector<Output> out = join.add_right({"k", max, 2});
    check(out.size() == 1, "max timestamps can still join");
    out = join.finish();
    check(out.empty(), "joined max timestamps do not produce outer records");
}

void test_invalid_configuration() {
    bool threw = false;
    try {
        IntervalJoin join(IntervalJoin::Bounds{5, -5});
        static_cast<void>(join);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    check(threw, "lower > upper is rejected");

    threw = false;
    try {
        IntervalJoin join(IntervalJoin::Bounds::symmetric(5), -1);
        static_cast<void>(join);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    check(threw, "negative lateness is rejected");

    threw = false;
    try {
        IntervalJoin join(IntervalJoin::Bounds::symmetric(5));
        join.finish();
        join.add_left({"k", 1, 1});
    } catch (const std::logic_error&) {
        threw = true;
    }
    check(threw, "events after finish are rejected");
}

std::map<std::string, int> brute_force(
    const std::vector<std::pair<Side, Event>>& events,
    IntervalJoin::Bounds bounds) {
    std::vector<Event> lefts;
    std::vector<Event> rights;
    for (const auto& item : events) {
        if (item.first == Side::Left) {
            lefts.push_back(item.second);
        } else {
            rights.push_back(item.second);
        }
    }

    std::map<std::string, int> result;
    std::vector<bool> left_matched(lefts.size(), false);
    std::vector<bool> right_matched(rights.size(), false);

    for (std::size_t i = 0; i < lefts.size(); ++i) {
        for (std::size_t j = 0; j < rights.size(); ++j) {
            const Event& left = lefts[i];
            const Event& right = rights[j];
            if (left.key != right.key) {
                continue;
            }
            if (right.time < left.time + bounds.lower || right.time > left.time + bounds.upper) {
                continue;
            }
            left_matched[i] = true;
            right_matched[j] = true;
            ++result["J(" + event_text(left) + "," + event_text(right) + ")"];
        }
    }

    for (std::size_t i = 0; i < lefts.size(); ++i) {
        if (!left_matched[i]) {
            ++result["LO(" + event_text(lefts[i]) + ")"];
        }
    }
    for (std::size_t j = 0; j < rights.size(); ++j) {
        if (!right_matched[j]) {
            ++result["RO(" + event_text(rights[j]) + ")"];
        }
    }
    return result;
}

std::vector<std::pair<Side, Event>> sample_events() {
    return {
        {Side::Left, {"a", 10, 1}},
        {Side::Left, {"a", 12, 2}},
        {Side::Left, {"a", 12, 3}},
        {Side::Left, {"a", 16, 4}},
        {Side::Left, {"b", 11, 5}},
        {Side::Left, {"b", 20, 6}},
        {Side::Left, {"c", 14, 7}},
        {Side::Right, {"a", 8, 8}},
        {Side::Right, {"a", 13, 9}},
        {Side::Right, {"a", 13, 10}},
        {Side::Right, {"a", 20, 11}},
        {Side::Right, {"b", 15, 12}},
        {Side::Right, {"b", 21, 13}},
        {Side::Right, {"c", 30, 14}},
    };
}

void test_batch_matches_brute_force_for_many_permutations() {
    const IntervalJoin::Bounds bounds = IntervalJoin::Bounds::symmetric(4);
    std::vector<std::pair<Side, Event>> events = sample_events();
    const std::map<std::string, int> expected = brute_force(events, bounds);

    std::mt19937_64 random(1234567);
    for (int permutation = 0; permutation < 500; ++permutation) {
        std::shuffle(events.begin(), events.end(), random);
        IntervalJoin join(bounds);
        std::vector<Output> out;
        for (const auto& item : events) {
            if (item.first == Side::Left) {
                append(out, join.add_left(item.second));
            } else {
                append(out, join.add_right(item.second));
            }
        }
        append(out, join.finish());
        check(net_multiset(out) == expected,
              "batch result differs from brute force for permutation " +
                  std::to_string(permutation));
    }
}

void test_retraction_paths_reach_the_same_multiset() {
    const IntervalJoin::Bounds bounds = IntervalJoin::Bounds::symmetric(5);
    const Duration lateness = 20;
    const std::map<std::string, int> expected = {
        {"J(a/100/1,a/103/2)", 1},
    };

    {
        IntervalJoin join(bounds, lateness);
        std::vector<Output> out = join.add_left({"a", 100, 1});
        append(out, join.advance_watermark(Side::Right, 106));
        append(out, join.add_right({"a", 103, 2}));
        append(out, join.finish());
        check(net_multiset(out) == expected, "left outer retraction path");
    }
    {
        IntervalJoin join(bounds, lateness);
        std::vector<Output> out = join.add_right({"a", 103, 2});
        append(out, join.advance_watermark(Side::Left, 109));
        append(out, join.add_left({"a", 100, 1}));
        append(out, join.finish());
        check(net_multiset(out) == expected, "right outer retraction path");
    }
    {
        IntervalJoin join(bounds, lateness);
        std::vector<Output> out = join.add_right({"a", 103, 2});
        append(out, join.add_left({"a", 100, 1}));
        append(out, join.advance_watermark(Side::Right, 200));
        append(out, join.advance_watermark(Side::Left, 200));
        append(out, join.finish());
        check(net_multiset(out) == expected, "in-order path");
    }
}

void test_key_isolation() {
    IntervalJoin join(IntervalJoin::Bounds::symmetric(100));
    join.add_left({"a", 100, 1});
    check(join.add_right({"b", 100, 2}).empty(), "keys isolate state");
    check(join.add_right({"a", 100, 3}).size() == 1, "matching key joins");
}

void test_random_watermark_schedules_match_reference() {
    const IntervalJoin::Bounds bounds = IntervalJoin::Bounds::symmetric(4);
    const Duration lateness = 6;
    std::mt19937_64 random(987654321);

    for (int trial = 0; trial < 1000; ++trial) {
        std::vector<std::pair<Side, Event>> events;
        const std::uint64_t count = 8 + random() % 18;
        const std::uint64_t key_count = 1 + random() % 3;
        for (std::uint64_t i = 0; i < count; ++i) {
            Side side = (random() & 1U) != 0 ? Side::Left : Side::Right;
            std::string key(1, static_cast<char>('a' + random() % key_count));
            Timestamp time = static_cast<Timestamp>(random() % 31);
            events.push_back({side, {key, time, i + 1}});
        }
        std::shuffle(events.begin(), events.end(), random);

        IntervalJoin join(bounds, lateness);
        std::vector<Output> out;
        std::vector<std::pair<Side, Event>> accepted;
        Timestamp watermarks[2] = {
            std::numeric_limits<Timestamp>::min(),
            std::numeric_limits<Timestamp>::min(),
        };
        std::uint64_t dropped[2] = {0, 0};

        for (const auto& item : events) {
            int index = item.first == Side::Left ? 0 : 1;
            Timestamp threshold = watermarks[index] == std::numeric_limits<Timestamp>::min()
                                      ? std::numeric_limits<Timestamp>::min()
                                      : watermarks[index] - lateness;
            if (item.second.time < threshold) {
                if (item.first == Side::Left) {
                    append(out, join.add_left(item.second));
                } else {
                    append(out, join.add_right(item.second));
                }
                ++dropped[index];
            } else {
                accepted.push_back(item);
                if (item.first == Side::Left) {
                    append(out, join.add_left(item.second));
                } else {
                    append(out, join.add_right(item.second));
                }
            }

            if (random() % 100 < 45) {
                int watermark_side = random() & 1U;
                Timestamp target = static_cast<Timestamp>(random() % 46);
                if (watermarks[watermark_side] == std::numeric_limits<Timestamp>::min() ||
                    target > watermarks[watermark_side]) {
                    if (watermark_side == 0) {
                        append(out, join.advance_watermark(Side::Left, target));
                    } else {
                        append(out, join.advance_watermark(Side::Right, target));
                    }
                    watermarks[watermark_side] = target;
                }
            }
        }

        append(out, join.finish());
        check(net_multiset(out) == brute_force(accepted, bounds),
              "random schedule differs from reference in trial " + std::to_string(trial));
        check(join.stats().left_dropped_late == dropped[0], "left drop count matches reference");
        check(join.stats().right_dropped_late == dropped[1], "right drop count matches reference");
        check(join.stats().live_left == 0 && join.stats().live_right == 0,
              "random schedule leaves no live state after finish");
    }
}

}

int main() {
    test_basic_join_and_inclusive_boundaries();
    test_each_pair_is_emitted_once();
    test_left_outer_is_retracted_by_late_match();
    test_right_outer_is_retracted_by_late_match();
    test_outer_is_retracted_at_most_once();
    test_multiple_outers_are_retracted();
    test_matched_event_never_gets_outer();
    test_eviction_uses_lateness_window();
    test_lateness_acceptance_boundary();
    test_finish_emits_both_outer_sides();
    test_asymmetric_bounds();
    test_watermark_is_monotonic();
    test_large_timestamps_saturate();
    test_invalid_configuration();
    test_batch_matches_brute_force_for_many_permutations();
    test_retraction_paths_reach_the_same_multiset();
    test_key_isolation();
    test_random_watermark_schedules_match_reference();

    if (failures != 0) {
        std::cerr << failures << " checks failed\n";
        return 1;
    }
    std::cout << "all interval join checks passed\n";
    return 0;
}
