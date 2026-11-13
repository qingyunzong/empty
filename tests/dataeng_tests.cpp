#include "dataeng.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using dataeng::Bookmark;
using dataeng::BookmarkCoordinator;
using dataeng::BookmarkStatus;
using dataeng::ChannelBinding;
using dataeng::CoordinatorOptions;
using dataeng::DeliveredRecord;
using dataeng::EventRecord;
using dataeng::RecordId;

#define CHECK(condition)                                                       \
    do {                                                                       \
        if (!(condition)) {                                                    \
            std::cerr << __FILE__ << ':' << __LINE__                           \
                      << ": CHECK failed: " #condition << '\n';                \
            return false;                                                      \
        }                                                                      \
    } while (false)

EventRecord make_record(RecordId record_id,
                        std::string provider = {},
                        std::string query_version = {}) {
    return EventRecord{
        .channel = {},
        .record_id = record_id,
        .provider = std::move(provider),
        .query_version = std::move(query_version),
        .payload = "<Event/>",
    };
}

std::vector<RecordId> ids(const std::vector<DeliveredRecord>& records) {
    std::vector<RecordId> result;
    result.reserve(records.size());
    for (const DeliveredRecord& record : records) {
        result.push_back(record.record.record_id);
    }
    return result;
}

ChannelBinding security_binding() {
    return ChannelBinding{
        .channel = "Security",
        .provider = "Microsoft-Windows-Security-Auditing",
        .query_version = "security-v3",
    };
}

bool test_bookmark_round_trip() {
    BookmarkCoordinator coordinator(security_binding());
    const EventRecord records[] = {make_record(1), make_record(2)};
    auto outcome = coordinator.ingest_backfill(records, std::nullopt, true);
    CHECK(outcome.accepted == 2);
    CHECK((ids(outcome.ready) == std::vector<RecordId>{1, 2}));

    const Bookmark bookmark = coordinator.snapshot_bookmark();
    CHECK(bookmark.channel == "Security");
    CHECK(bookmark.record_id == RecordId{2});
    CHECK(bookmark.provider == "Microsoft-Windows-Security-Auditing");
    CHECK(bookmark.query_version == "security-v3");
    CHECK(bookmark.generation == 1);

    const std::string serialized = bookmark.serialize();
    const auto parsed = Bookmark::deserialize(serialized);
    CHECK(parsed.has_value());
    CHECK(*parsed == bookmark);

    Bookmark unusual{
        .channel = "Application/Test|Channel",
        .record_id = RecordId{18446744073709551615ULL},
        .provider = "Provider % with | separators",
        .query_version = "q\n1",
        .generation = 9,
    };
    const auto parsed_unusual = Bookmark::deserialize(unusual.serialize());
    CHECK(parsed_unusual.has_value());
    CHECK(*parsed_unusual == unusual);

    CHECK(!Bookmark::deserialize("not-a-bookmark").has_value());
    CHECK(!Bookmark::deserialize("dataeng-bookmark/1|Security|1|p|q|0").has_value());
    return true;
}

bool test_bookmark_binding_and_cursor() {
    BookmarkCoordinator coordinator(security_binding());

    Bookmark bookmark{
        .channel = "Security",
        .record_id = RecordId{5},
        .provider = "Microsoft-Windows-Security-Auditing",
        .query_version = "other-query",
        .generation = 1,
    };
    auto restore = coordinator.restore_bookmark(bookmark);
    CHECK(restore.status == BookmarkStatus::query_version_mismatch);
    CHECK(!restore.resume_after.has_value());

    bookmark.query_version = "security-v3";
    bookmark.provider = "Someone-Else";
    restore = coordinator.restore_bookmark(bookmark);
    CHECK(restore.status == BookmarkStatus::provider_mismatch);
    CHECK(!restore.resume_after.has_value());

    bookmark.provider = "Microsoft-Windows-Security-Auditing";
    bookmark.channel = "System";
    restore = coordinator.restore_bookmark(bookmark);
    CHECK(restore.status == BookmarkStatus::channel_mismatch);
    CHECK(!restore.resume_after.has_value());

    bookmark.channel = "Security";
    bookmark.generation = 2;
    restore = coordinator.restore_bookmark(bookmark);
    CHECK(restore.status == BookmarkStatus::generation_mismatch);
    CHECK(!restore.resume_after.has_value());

    bookmark.generation = 1;
    restore = coordinator.restore_bookmark(bookmark);
    CHECK(restore.status == BookmarkStatus::accepted);
    CHECK(restore.resume_after == RecordId{5});

    auto duplicate = coordinator.ingest_subscription(make_record(5));
    CHECK(duplicate.duplicates == 1);
    CHECK(duplicate.ready.empty());

    auto older = coordinator.ingest_subscription(make_record(4));
    CHECK(older.duplicates == 1);
    CHECK(older.ready.empty());

    coordinator.drain_pending();
    auto newer = coordinator.ingest_subscription(make_record(6));
    CHECK(newer.accepted == 1);
    CHECK((ids(newer.ready) == std::vector<RecordId>{6}));
    CHECK(coordinator.last_delivered_record_id() == RecordId{6});
    return true;
}

bool test_clear_starts_new_generation() {
    BookmarkCoordinator coordinator(security_binding());

    coordinator.begin_backfill(0);
    auto live = coordinator.ingest_subscription(make_record(5));
    CHECK(live.accepted == 1);
    CHECK(live.ready.empty());

    const Bookmark before_clear = coordinator.snapshot_bookmark();
    CHECK(!before_clear.record_id.has_value());

    const auto transition = coordinator.on_log_cleared();
    CHECK(transition.previous_generation == 1);
    CHECK(transition.new_generation == 2);
    CHECK((ids(transition.flushed) == std::vector<RecordId>{5}));
    CHECK(transition.flushed.front().generation == 1);

    auto old_restore = coordinator.restore_bookmark(before_clear);
    CHECK(old_restore.status == BookmarkStatus::generation_mismatch);
    CHECK(!old_restore.resume_after.has_value());

    coordinator.complete_backfill();
    auto first_new = coordinator.ingest_subscription(make_record(1));
    CHECK(first_new.accepted == 1);
    CHECK((ids(first_new.ready) == std::vector<RecordId>{1}));
    CHECK(first_new.ready.front().generation == 2);

    const Bookmark after_new = coordinator.snapshot_bookmark();
    CHECK(after_new.generation == 2);
    CHECK(after_new.record_id == RecordId{1});

    auto stale_restore = coordinator.restore_bookmark(before_clear);
    CHECK(stale_restore.status == BookmarkStatus::generation_mismatch);
    CHECK(!stale_restore.resume_after.has_value());
    CHECK(coordinator.last_delivered_record_id() == RecordId{1});
    return true;
}

bool test_interleaved_backfill_and_subscription() {
    BookmarkCoordinator coordinator(security_binding());
    coordinator.begin_backfill(0);

    auto subscription_five = coordinator.ingest_subscription(make_record(5));
    CHECK(subscription_five.accepted == 1);
    CHECK(subscription_five.ready.empty());

    auto subscription_three = coordinator.ingest_subscription(make_record(3));
    CHECK(subscription_three.accepted == 1);
    CHECK(subscription_three.ready.empty());

    const EventRecord first_page[] = {
        make_record(1), make_record(2), make_record(4)};
    auto page_one = coordinator.ingest_backfill(first_page, RecordId{4});
    CHECK(page_one.accepted == 3);
    CHECK((ids(page_one.ready) == std::vector<RecordId>{1, 2, 3, 4}));

    auto duplicate = coordinator.ingest_subscription(make_record(4));
    CHECK(duplicate.duplicates == 1);
    CHECK(duplicate.ready.empty());

    const EventRecord second_page[] = {
        make_record(5), make_record(6)};
    auto page_two = coordinator.ingest_backfill(second_page, RecordId{6});
    CHECK(page_two.duplicates == 1);
    CHECK((ids(page_two.ready) == std::vector<RecordId>{5, 6}));

    auto completed = coordinator.complete_backfill();
    CHECK(completed.empty());

    auto live_eight = coordinator.ingest_subscription(make_record(8));
    CHECK((ids(live_eight.ready) == std::vector<RecordId>{8}));

    auto late_seven = coordinator.ingest_subscription(make_record(7));
    CHECK(late_seven.duplicates == 1);
    CHECK(late_seven.ready.empty());

    const Bookmark bookmark = coordinator.snapshot_bookmark();
    CHECK(bookmark.record_id == RecordId{8});
    return true;
}

bool test_drain_orders_pending_records() {
    BookmarkCoordinator coordinator(security_binding());
    coordinator.begin_backfill(0);

    CHECK(coordinator.ingest_subscription(make_record(9)).accepted == 1);
    CHECK(coordinator.ingest_subscription(make_record(2)).accepted == 1);
    CHECK(coordinator.pending_count() == 2);

    const EventRecord page[] = {make_record(1), make_record(4)};
    auto partial = coordinator.ingest_backfill(page, RecordId{4});
    CHECK((ids(partial.ready) == std::vector<RecordId>{1, 2, 4}));
    CHECK(coordinator.pending_count() == 1);

    auto drained = coordinator.drain_pending();
    CHECK((ids(drained) == std::vector<RecordId>{9}));
    CHECK(coordinator.pending_count() == 0);
    return true;
}

bool test_rebuild_and_provider_binding() {
    BookmarkCoordinator coordinator(security_binding());
    coordinator.complete_backfill();
    CHECK(coordinator.ingest_subscription(make_record(10)).accepted == 1);

    const Bookmark old_bookmark = coordinator.snapshot_bookmark();
    const auto transition =
        coordinator.on_channel_rebuilt("New-Provider", "security-v4");
    CHECK(transition.new_generation == 2);
    CHECK(coordinator.binding_snapshot().provider == "New-Provider");
    CHECK(coordinator.binding_snapshot().query_version == "security-v4");

    auto old_restore = coordinator.restore_bookmark(old_bookmark);
    CHECK(!old_restore.accepted());
    CHECK(!old_restore.resume_after.has_value());

    auto stale = coordinator.ingest_subscription(
        make_record(11, "Microsoft-Windows-Security-Auditing", "security-v4"));
    CHECK(stale.rejected == 1);
    CHECK(stale.first_rejection == dataeng::RejectReason::provider_mismatch);

    auto wrong_query =
        coordinator.ingest_subscription(make_record(11, "New-Provider", "other"));
    CHECK(wrong_query.rejected == 1);
    CHECK(wrong_query.first_rejection ==
          dataeng::RejectReason::query_version_mismatch);

    coordinator.complete_backfill();
    auto fresh = coordinator.ingest_subscription(make_record(1, "New-Provider"));
    CHECK(fresh.accepted == 1);
    CHECK((ids(fresh.ready) == std::vector<RecordId>{1}));
    CHECK(fresh.ready.front().generation == 2);
    return true;
}

bool test_auto_provider_rebuild_does_not_regress() {
    CoordinatorOptions options;
    options.strict_merge = false;
    options.auto_generation_on_provider_change = true;
    BookmarkCoordinator coordinator(security_binding(), options);

    auto first = coordinator.ingest_subscription(
        make_record(1, "Microsoft-Windows-Security-Auditing"));
    CHECK(first.accepted == 1);
    CHECK(first.ready.size() == 1);

    auto rebuilt = coordinator.ingest_subscription(make_record(1, "New-Provider"));
    CHECK(rebuilt.accepted == 1);
    CHECK(rebuilt.ready.size() == 1);
    CHECK(rebuilt.ready[0].generation == 2);
    CHECK(rebuilt.ready[0].record.record_id == RecordId{1});
    CHECK(coordinator.generation() == 2);

    auto delayed_old = coordinator.ingest_subscription(
        make_record(2, "Microsoft-Windows-Security-Auditing"));
    CHECK(delayed_old.rejected == 1);
    CHECK(delayed_old.first_rejection ==
          dataeng::RejectReason::provider_mismatch);
    CHECK(coordinator.generation() == 2);

    auto invalid_rebuild =
        coordinator.ingest_subscription(make_record(1, "Third-Provider", "wrong"));
    CHECK(invalid_rebuild.rejected == 1);
    CHECK(invalid_rebuild.first_rejection ==
          dataeng::RejectReason::query_version_mismatch);
    CHECK(coordinator.generation() == 2);
    return true;
}

bool test_live_mode_and_query_binding() {
    CoordinatorOptions options;
    options.strict_merge = false;
    BookmarkCoordinator coordinator(security_binding(), options);

    auto event = coordinator.ingest_subscription(make_record(11));
    CHECK(event.accepted == 1);
    CHECK((ids(event.ready) == std::vector<RecordId>{11}));

    auto replay = coordinator.ingest_subscription(make_record(11));
    CHECK(replay.duplicates == 1);
    CHECK(replay.ready.empty());

    auto wrong_version =
        coordinator.ingest_subscription(make_record(12, {}, "old-query"));
    CHECK(wrong_version.rejected == 1);
    CHECK(wrong_version.first_rejection ==
          dataeng::RejectReason::query_version_mismatch);

    auto wrong_channel = make_record(13);
    wrong_channel.channel = "System";
    auto rejected_channel = coordinator.ingest_subscription(wrong_channel);
    CHECK(rejected_channel.rejected == 1);
    CHECK(rejected_channel.first_rejection ==
          dataeng::RejectReason::channel_mismatch);
    return true;
}

bool test_initial_generation_restore() {
    CoordinatorOptions options;
    options.initial_generation = 7;
    BookmarkCoordinator coordinator(security_binding(), options);

    Bookmark bookmark{
        .channel = "Security",
        .record_id = RecordId{90},
        .provider = "Microsoft-Windows-Security-Auditing",
        .query_version = "security-v3",
        .generation = 7,
    };
    auto result = coordinator.restore_bookmark(bookmark);
    CHECK(result.accepted());
    CHECK(result.resume_after == RecordId{90});

    bookmark.generation = 6;
    result = coordinator.restore_bookmark(bookmark);
    CHECK(!result.accepted());
    CHECK(!result.resume_after.has_value());
    return true;
}

}  // namespace

int main() {
    const std::vector<std::pair<std::string, bool (*)()>> tests = {
        {"bookmark_round_trip", test_bookmark_round_trip},
        {"bookmark_binding_and_cursor", test_bookmark_binding_and_cursor},
        {"clear_starts_new_generation", test_clear_starts_new_generation},
        {"interleaved_backfill_and_subscription",
         test_interleaved_backfill_and_subscription},
        {"drain_orders_pending_records", test_drain_orders_pending_records},
        {"rebuild_and_provider_binding", test_rebuild_and_provider_binding},
        {"auto_provider_rebuild_does_not_regress",
         test_auto_provider_rebuild_does_not_regress},
        {"live_mode_and_query_binding", test_live_mode_and_query_binding},
        {"initial_generation_restore", test_initial_generation_restore},
    };

    std::size_t failures = 0;
    for (const auto& [name, test] : tests) {
        if (test()) {
            std::cout << "[PASS] " << name << '\n';
        } else {
            std::cout << "[FAIL] " << name << '\n';
            ++failures;
        }
    }
    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return 1;
    }
    std::cout << tests.size() << " test(s) passed\n";
    return 0;
}
