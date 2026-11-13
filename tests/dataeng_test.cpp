#include "dataeng.hpp"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(condition)                                                     \
    do {                                                                     \
        if (!(condition)) {                                                  \
            std::cerr << __FILE__ << ':' << __LINE__                         \
                      << ": check failed: " #condition << '\n';              \
            ++failures;                                                      \
        }                                                                    \
    } while (false)

using namespace dataeng;

RingRecord make_record(CpuId cpu, Sequence sequence, std::uint64_t lost,
                       Timestamp timestamp, SchemaVersion schema = 1,
                       std::string payload = {}) {
    return RingRecord(cpu, sequence, lost, timestamp, schema, 0, 0, 0,
                      std::move(payload));
}

void test_global_time_order() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 0, 100));
    merger.push(make_record(1, 0, 0, 300));
    merger.push(make_record(2, 0, 0, 200));
    merger.push(make_record(0, 1, 0, 400));

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 4);
    CHECK(events[0].cpu == 0 && events[0].timestamp == 100);
    CHECK(events[1].cpu == 2 && events[1].timestamp == 200);
    CHECK(events[2].cpu == 1 && events[2].timestamp == 300);
    CHECK(events[3].cpu == 0 && events[3].sequence == 1);
    for (const MergedEvent& event : events) {
        CHECK(event.is_record());
    }
}

void test_gap_is_explicit_and_never_backfilled() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 0, 100));
    merger.push(make_record(0, 2, 0, 200));

    std::vector<MergedEvent> events = merger.events();
    CHECK(events.size() == 3);
    CHECK(events[1].is_loss());
    CHECK(events[1].first_sequence == 1);
    CHECK(events[1].last_sequence == 1);
    CHECK(events[1].missing_count == 1);
    CHECK(events[2].is_record() && events[2].sequence == 2);

    const std::vector<MergedEvent> late = merger.push(make_record(0, 1, 0, 250));
    CHECK(late.empty());
    CHECK(merger.stats().rejected_backfill == 1);

    events = merger.finish();
    CHECK(events.size() == 3);
    CHECK(events[1].is_loss());
    CHECK(merger.stats().missing_sequences == 1);
}

void test_same_timestamp_stable_order() {
    RingBufferMerger merger;
    merger.push(make_record(2, 0, 0, 100));
    merger.push(make_record(1, 2, 0, 100));
    merger.push(make_record(0, 0, 0, 100));
    merger.push(make_record(0, 2, 0, 100));

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 5);
    CHECK(events[0].cpu == 0 && events[0].is_record() &&
          events[0].sequence == 0);
    CHECK(events[1].cpu == 0 && events[1].is_loss() &&
          events[1].sequence == 1);
    CHECK(events[2].cpu == 0 && events[2].is_record() &&
          events[2].sequence == 2);
    CHECK(events[3].cpu == 1 && events[3].sequence == 2);
    CHECK(events[4].cpu == 2 && events[4].sequence == 0);
}

void test_explicit_hotplug_generation() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 2, 100, 3));
    merger.push(make_record(0, 1, 2, 110, 3));
    merger.cpu_offline(0);
    merger.cpu_online(0);

    const std::vector<MergedEvent> first = merger.push(
        make_record(0, 0, 0, 200, 4));
    CHECK(first.size() == 1);
    CHECK(first[0].is_record());
    CHECK(first[0].generation == 1);
    CHECK(first[0].sequence == 0);
    CHECK(first[0].schema_version == 4);
    CHECK(merger.stats().loss_events == 0);

    const std::optional<CpuState> state = merger.cpu_state(0);
    CHECK(state.has_value());
    CHECK(state->generation == 1);
    CHECK(state->online);
    CHECK(state->last_sequence == 0);
    CHECK(state->last_lost == 0);
}

void test_implicit_generation_reset() {
    RingBufferMerger merger;
    merger.push(make_record(3, 9, 0, 100));
    merger.push(make_record(3, 1, 0, 200));

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 2);
    CHECK(events[0].generation == 0 && events[0].sequence == 9);
    CHECK(events[1].generation == 1 && events[1].sequence == 1);
    CHECK(merger.stats().loss_events == 0);
}

void test_lost_counter_delta() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 4, 100));
    merger.push(make_record(0, 1, 7, 200));

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 3);
    CHECK(events[0].is_record());
    CHECK(events[1].is_loss());
    CHECK(events[1].missing_count == 0);
    CHECK(events[1].lost_before == 4);
    CHECK(events[1].lost == 3);
    CHECK(events[1].lost_counter == 7);
    CHECK(events[1].cumulative_lost == 7);
    CHECK(events[1].lost_delta == 3);
    CHECK(events[2].is_record());
    CHECK(events[2].lost_delta == 3);
    CHECK(merger.stats().lost_counter_delta == 3);
}

void test_initial_baseline_and_opt_in() {
    {
        RingBufferMerger merger;
        merger.push(make_record(0, 5, 9, 100));
        const std::vector<MergedEvent> events = merger.finish();
        CHECK(events.size() == 1);
        CHECK(events[0].is_record());
        CHECK(merger.stats().loss_events == 0);
    }
    {
        MergeOptions options;
        options.report_initial_gap = true;
        options.report_initial_lost = true;
        RingBufferMerger merger(options);
        merger.push(make_record(0, 5, 9, 100));
        const std::vector<MergedEvent> events = merger.finish();
        CHECK(events.size() == 2);
        CHECK(events[0].is_loss());
        CHECK(events[0].first_sequence == 0);
        CHECK(events[0].last_sequence == 4);
        CHECK(events[0].missing_count == 5);
        CHECK(events[0].lost_delta == 9);
        CHECK(events[1].sequence == 5);
    }
}

void test_metadata_and_payload_preserved() {
    RingBufferMerger merger;
    RingRecord record = make_record(4, 0, 0, 42, 11, "hello");
    record.payload_id = 99;
    merger.push(record);

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 1);
    CHECK(events[0].is_record());
    CHECK(events[0].cpu == 4);
    CHECK(events[0].timestamp == 42);
    CHECK(events[0].timestamp_ns == 42);
    CHECK(events[0].schema_version == 11);
    CHECK(events[0].schema == 11);
    CHECK(events[0].payload == "hello");
    CHECK(events[0].payload_id == 99);
    CHECK(events[0].record == record);
}

void test_batch_helpers() {
    const std::vector<RingRecord> records{
        make_record(0, 0, 0, 10),
        make_record(1, 0, 0, 20),
        make_record(0, 1, 0, 30),
    };
    const std::vector<MergedEvent> events = merge_records(records);
    CHECK(events.size() == 3);
    CHECK(events[0].cpu == 0 && events[0].timestamp == 10);
    CHECK(events[1].cpu == 1 && events[1].timestamp == 20);
    CHECK(events[2].cpu == 0 && events[2].sequence == 1);

    const std::vector<std::vector<RingRecord>> per_cpu{
        {make_record(0, 0, 0, 10), make_record(0, 1, 0, 30)},
        {make_record(1, 0, 0, 20)},
    };
    const std::vector<MergedEvent> streams = merge_cpu_streams(per_cpu);
    CHECK(streams.size() == 3);
    CHECK(streams[1].cpu == 1);
}

void test_watermark_and_duplicates() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 0, 10));
    merger.push(make_record(1, 0, 0, 20));
    merger.push(make_record(0, 1, 0, 30));

    const std::vector<MergedEvent> ready = merger.pop_ready(20);
    CHECK(ready.size() == 2);
    CHECK(ready[0].timestamp == 10);
    CHECK(ready[1].timestamp == 20);

    const std::vector<MergedEvent> rest = merger.finish();
    CHECK(rest.size() == 1);
    CHECK(rest[0].timestamp == 30);

    const std::vector<MergedEvent> duplicate =
        merger.push(make_record(0, 1, 0, 31));
    CHECK(duplicate.empty());
    CHECK(merger.stats().duplicates == 1);
}

void test_loss_schema_and_tie_break() {
    RingBufferMerger merger;
    merger.push(make_record(0, 0, 0, 100, 2));
    merger.push(make_record(0, 2, 0, 100, 3));

    const std::vector<MergedEvent> events = merger.finish();
    CHECK(events.size() == 3);
    CHECK(events[1].is_loss());
    CHECK(events[1].schema_version == 3);
    CHECK(events[1].previous_schema_version == 2);
    CHECK(events[2].is_record());
    CHECK(events[2].sequence == 2);
}

}  // namespace

int main() {
    test_global_time_order();
    test_gap_is_explicit_and_never_backfilled();
    test_same_timestamp_stable_order();
    test_explicit_hotplug_generation();
    test_implicit_generation_reset();
    test_lost_counter_delta();
    test_initial_baseline_and_opt_in();
    test_metadata_and_payload_preserved();
    test_batch_helpers();
    test_watermark_and_duplicates();
    test_loss_schema_and_tie_break();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "dataeng tests passed\n";
    return 0;
}
