#include "dlks_formal.hpp"
#include "model.hpp"
#include "test_framework.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace {

using Store = dlks_formal::SegmentStore<int, int>;
using Model = dlks_test::NaiveModel<int, int>;
using dlks_formal::CleanMode;
using dlks_formal::CleanStepResult;
using dlks_formal::SegmentState;

bool record_key_present(const dlks_formal::SegmentStore<int, int>::SegmentView&
                            segment,
                        int key) {
  for (const auto& record : segment.records) {
    if (record.key == key) {
      return true;
    }
  }
  return false;
}

}  // namespace

DLKS_TEST(relocation_copies_live_records_and_frees_victim) {
  Store store({8, 3});
  Model model;
  for (int key = 0; key < 4; ++key) {
    CHECK(store.put(key, key + 1, 2));
    model.put(key, key + 1);
  }
  CHECK(store.put(0, 10, 2));
  model.put(0, 10);
  CHECK(store.put(1, 20, 2));
  model.put(1, 20);

  const auto before = store.stats();
  CHECK_EQ(before.used_bytes, 12u);
  CHECK_EQ(before.live_bytes, 8u);
  CHECK_EQ(before.dead_bytes, 4u);
  CHECK_EQ(before.free_bytes, 12u);
  CHECK_EQ(before.segments[0].state, SegmentState::Sealed);

  CHECK(store.begin_clean(0));
  const auto during = store.dump();
  CHECK(during.cleaning.active);
  CHECK_EQ(during.cleaning.mode, CleanMode::Relocate);
  CHECK_EQ(during.cleaning.victim, 0u);
  CHECK_EQ(during.cleaning.destination, 2u);
  CHECK_EQ(during.segments[2].reserved_bytes, 4u);
  CHECK_EQ(during.cleaning.candidate_count, 2u);
  CHECK(store.run_clean());

  const auto after = store.stats();
  CHECK_EQ(after.used_bytes, 8u);
  CHECK_EQ(after.live_bytes, 8u);
  CHECK_EQ(after.dead_bytes, 0u);
  CHECK_EQ(after.free_bytes, 16u);
  CHECK_EQ(after.reclaimed_bytes, 4u);
  CHECK_EQ(after.segments[0].state, SegmentState::Free);
  CHECK_EQ(after.segments[0].used_bytes, 0u);
  CHECK_EQ(after.segments[2].used_bytes, 4u);
  CHECK_EQ(after.segments[2].record_count, 2u);

  const auto dump = store.dump();
  CHECK_EQ(dump.segments[0].used_bytes, 0u);
  CHECK(!record_key_present(dump.segments[2], 0));
  CHECK(!record_key_present(dump.segments[2], 1));
  CHECK(record_key_present(dump.segments[2], 2));
  CHECK(record_key_present(dump.segments[2], 3));
  CHECK_EQ(after.free_bytes - before.free_bytes,
           after.reclaimed_bytes - before.reclaimed_bytes);
  dlks_test::verify_store_against_model(store, model, "relocation");
}

DLKS_TEST(in_place_compaction_when_no_spare_segment) {
  Store store({8, 2});
  Model model;
  for (int key = 0; key < 4; ++key) {
    CHECK(store.put(key, 1, 2));
    model.put(key, 1);
  }
  CHECK(store.put(0, 2, 2));
  model.put(0, 2);
  CHECK(store.put(1, 2, 2));
  model.put(1, 2);
  CHECK(store.put(4, 1, 2));
  model.put(4, 1);
  CHECK(store.put(5, 1, 2));
  model.put(5, 1);

  const auto before = store.stats();
  CHECK_EQ(before.free_bytes, 0u);
  CHECK_EQ(before.dead_bytes, 4u);
  CHECK(store.begin_clean(0));
  const auto during = store.dump();
  CHECK_EQ(during.cleaning.mode, CleanMode::InPlace);
  CHECK_EQ(during.cleaning.destination, Store::no_segment);
  CHECK(store.run_clean());

  const auto after = store.stats();
  CHECK_EQ(after.used_bytes, 12u);
  CHECK_EQ(after.free_bytes, 4u);
  CHECK_EQ(after.live_bytes, 12u);
  CHECK_EQ(after.dead_bytes, 0u);
  CHECK_EQ(after.reclaimed_bytes, 4u);
  CHECK_EQ(after.segments[0].state, SegmentState::Active);
  CHECK_EQ(after.segments[0].used_bytes, 4u);
  CHECK_EQ(after.segments[0].record_count, 2u);
  CHECK_EQ(after.free_bytes - before.free_bytes,
           after.reclaimed_bytes - before.reclaimed_bytes);

  // The reopened segment accepts new appends using the reclaimed tail.
  CHECK(store.put(6, 1, 2));
  model.put(6, 1);
  CHECK_EQ(store.stats().used_bytes, 14u);
  dlks_test::verify_store_against_model(store, model, "in-place");
}

DLKS_TEST(write_between_begin_and_copy_invalidates_candidate) {
  Store store({8, 3});
  Model model;
  for (int key = 0; key < 4; ++key) {
    CHECK(store.put(key, key + 1, 2));
    model.put(key, key + 1);
  }
  CHECK(store.put(0, 10, 2));
  model.put(0, 10);

  const auto reclaimed_before = store.stats().reclaimed_bytes;
  CHECK(store.begin_clean(0));
  CHECK_EQ(store.dump().segments[2].reserved_bytes, 6u);

  // The newest value for key 1 now lives outside the victim. The cleaner must
  // notice this before copying and skip the stale candidate.
  CHECK(store.put(1, 99, 2));
  model.put(1, 99);
  CHECK_EQ(store.clean_step(), CleanStepResult::Skipped);
  CHECK_EQ(store.dump().segments[2].reserved_bytes, 4u);

  // A new key appended while cleaning must survive untouched.
  CHECK(store.put(9, 7, 2));
  model.put(9, 7);
  CHECK(store.run_clean());

  CHECK_EQ(store.get(1).value(), 99);
  CHECK_EQ(store.get(9).value(), 7);
  const auto dump = store.dump();
  CHECK(!record_key_present(dump.segments[2], 1));
  CHECK(record_key_present(dump.segments[2], 2));
  CHECK(record_key_present(dump.segments[2], 3));
  CHECK_EQ(dump.reclaimed_bytes - reclaimed_before, 4u);
  dlks_test::verify_store_against_model(store, model, "skip stale candidate");
}

DLKS_TEST(copy_then_overwrite_leaves_one_dead_copy) {
  Store store({8, 3});
  Model model;
  for (int key = 0; key < 4; ++key) {
    CHECK(store.put(key, key + 1, 2));
    model.put(key, key + 1);
  }
  CHECK(store.put(0, 10, 2));
  model.put(0, 10);

  CHECK(store.begin_clean(0));
  CHECK_EQ(store.clean_step(), CleanStepResult::Copied);  // key 1
  CHECK(store.put(1, 100, 2));
  model.put(1, 100);
  CHECK(store.run_clean());

  CHECK_EQ(store.get(1).value(), 100);
  const auto after = store.stats();
  CHECK_EQ(after.reclaimed_bytes, 2u);
  CHECK_EQ(after.dead_bytes, 2u);
  const auto dump = store.dump();
  CHECK(record_key_present(dump.segments[2], 1));
  CHECK_EQ(dump.segments[2].records.size(), 3u);
  dlks_test::verify_store_against_model(store, model, "stale copied version");
}

DLKS_TEST(writer_can_use_unreserved_space_in_cleaning_destination) {
  Store store({8, 3});
  Model model;
  for (int key = 0; key < 4; ++key) {
    CHECK(store.put(key, key + 1, 2));
    model.put(key, key + 1);
  }
  CHECK(store.put(0, 10, 2));
  model.put(0, 10);
  for (int key = 4; key < 7; ++key) {
    CHECK(store.put(key, key + 1, 2));
    model.put(key, key + 1);
  }

  CHECK(store.begin_clean(0));
  auto dump = store.dump();
  CHECK_EQ(dump.cleaning.mode, CleanMode::Relocate);
  CHECK_EQ(dump.cleaning.destination, 2u);
  CHECK_EQ(dump.segments[2].reserved_bytes, 6u);

  // Only the destination has room. Two unreserved bytes must remain usable by
  // the writer while six bytes stay reserved for live records.
  CHECK(store.put(9, 7, 2));
  model.put(9, 7);
  dump = store.dump();
  CHECK_EQ(dump.segments[2].used_bytes, 2u);
  CHECK_EQ(dump.segments[2].reserved_bytes, 6u);

  CHECK(store.run_clean());
  const auto after = store.stats();
  CHECK_EQ(after.segments[0].state, SegmentState::Free);
  CHECK_EQ(after.segments[2].used_bytes, 8u);
  CHECK_EQ(after.segments[2].reserved_bytes, 0u);
  CHECK_EQ(after.segments[2].state, SegmentState::Sealed);
  CHECK_EQ(after.used_bytes, 16u);
  CHECK_EQ(after.free_bytes, 8u);
  CHECK_EQ(after.dead_bytes, 0u);
  CHECK_EQ(store.get(9).value(), 7);
  CHECK_EQ(store.get(1).value(), 2);
  dlks_test::verify_store_against_model(store, model, "reserved destination");
}

DLKS_TEST(capacity_limit_then_reclaim_and_append) {
  Store store({4, 2});
  Model model;
  CHECK(store.put(0, 1, 2));
  model.put(0, 1);
  CHECK(store.put(1, 1, 2));
  model.put(1, 1);
  CHECK(store.put(2, 1, 2));
  model.put(2, 1);
  CHECK(store.put(0, 2, 2));
  model.put(0, 2);

  const auto full = store.stats();
  CHECK_EQ(full.used_bytes, 8u);
  CHECK_EQ(full.free_bytes, 0u);
  CHECK(!store.put(3, 1, 2));
  CHECK_EQ(store.stats().used_bytes, full.used_bytes);

  CHECK(store.begin_clean(0));
  CHECK(store.run_clean());
  const auto reclaimed = store.stats();
  CHECK_EQ(reclaimed.used_bytes, 6u);
  CHECK_EQ(reclaimed.free_bytes, 2u);
  CHECK_EQ(reclaimed.reclaimed_bytes, 2u);
  CHECK(store.put(3, 1, 2));
  model.put(3, 1);
  CHECK_EQ(store.stats().used_bytes, 8u);
  dlks_test::verify_store_against_model(store, model, "capacity");
}

DLKS_TEST(rejects_records_larger_than_a_segment) {
  Store store({4, 2});
  Model model;
  CHECK(!store.put(0, 1, 0));
  CHECK(!store.put(0, 1, 5));
  CHECK(!store.erase(0, 0));
  CHECK(!store.erase(0, 5));
  CHECK_EQ(store.stats().used_bytes, 0u);
  dlks_test::verify_store_against_model(store, model, "invalid footprint");
}

DLKS_TEST(all_dead_victim_is_freed_without_copying) {
  Store store({4, 2});
  Model model;
  CHECK(store.put(0, 1, 2));
  model.put(0, 1);
  CHECK(store.put(1, 1, 2));
  model.put(1, 1);
  CHECK(store.put(0, 2, 2));
  model.put(0, 2);
  CHECK(store.put(1, 2, 2));
  model.put(1, 2);

  CHECK_EQ(store.stats().dead_bytes, 4u);
  CHECK(store.begin_clean(0));
  const auto after = store.stats();
  CHECK(!after.cleaning_active);
  CHECK_EQ(after.segments[0].state, SegmentState::Free);
  CHECK_EQ(after.reclaimed_bytes, 4u);
  CHECK_EQ(after.used_bytes, 4u);
  CHECK_EQ(after.free_bytes, 4u);
  CHECK_EQ(store.get(0).value(), 2);
  CHECK_EQ(store.get(1).value(), 2);
  dlks_test::verify_store_against_model(store, model, "all dead");
}

DLKS_TEST(tombstones_are_live_during_in_place_compaction) {
  Store store({4, 2});
  Model model;
  CHECK(store.put(0, 1, 2));
  model.put(0, 1);
  CHECK(store.put(1, 2, 1));
  model.put(1, 2);
  CHECK(store.erase(0, 1));
  model.erase(0);
  CHECK_EQ(store.stats().segments[0].state, SegmentState::Sealed);
  CHECK_EQ(store.stats().live_tombstone_bytes, 1u);

  CHECK(store.begin_clean(0));
  CHECK(store.run_clean());
  const auto after = store.stats();
  CHECK_EQ(after.used_bytes, 2u);
  CHECK_EQ(after.reclaimed_bytes, 2u);
  CHECK_EQ(after.live_tombstone_bytes, 1u);
  CHECK_EQ(after.tombstone_record_count, 1u);
  CHECK(!store.get(0).has_value());
  CHECK_EQ(store.get(1).value(), 2);
  dlks_test::verify_store_against_model(store, model, "tombstone");
}

DLKS_TEST(auto_cleaning_picks_most_garbage_and_reclaims) {
  Store store({4, 3});
  Model model;
  CHECK(store.put(0, 1, 2));
  model.put(0, 1);
  CHECK(store.put(1, 1, 2));
  model.put(1, 1);
  CHECK(store.put(0, 2, 2));
  model.put(0, 2);
  CHECK(store.put(1, 2, 2));
  model.put(1, 2);
  CHECK(store.put(0, 3, 2));
  model.put(0, 3);

  const auto before = store.stats();
  CHECK_EQ(before.segments[0].dead_bytes, 4u);
  CHECK(store.begin_clean());
  const auto first = store.stats();
  CHECK(!first.cleaning_active);
  CHECK_EQ(first.segments[0].state, SegmentState::Free);
  CHECK_EQ(first.reclaimed_bytes, 4u);

  CHECK(store.begin_clean());
  CHECK(store.run_clean());
  CHECK_EQ(store.get(0).value(), 3);
  CHECK_EQ(store.get(1).value(), 2);
  dlks_test::verify_store_against_model(store, model, "auto victim");
}

DLKS_TEST(run_clean_without_a_session_is_a_noop) {
  Store store({4, 2});
  Model model;
  CHECK(store.put(0, 1, 1));
  model.put(0, 1);
  const auto before = store.stats();
  CHECK(store.run_clean());
  const auto after = store.stats();
  CHECK_EQ(after.used_bytes, before.used_bytes);
  CHECK_EQ(after.version, before.version);
  dlks_test::verify_store_against_model(store, model, "idle run");
}
