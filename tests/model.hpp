#pragma once

#include "dlks_formal.hpp"
#include "test_framework.hpp"

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <ostream>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace dlks_formal {

inline std::ostream& operator<<(std::ostream& out, SegmentState state) {
  return out << static_cast<int>(state);
}

inline std::ostream& operator<<(std::ostream& out, CleanMode mode) {
  return out << static_cast<int>(mode);
}

inline std::ostream& operator<<(std::ostream& out, CleanStepResult result) {
  return out << static_cast<int>(result);
}

}  // namespace dlks_formal

namespace dlks_test {

// The reference model deliberately knows nothing about segments. It only
// remembers the last successful operation for each key, which is the
// specification the storage engine must implement.
template <class Key, class Value>
struct NaiveModel {
  std::map<Key, std::optional<Value>> rows;

  void put(const Key& key, const Value& value) { rows[key] = value; }
  void erase(const Key& key) { rows[key] = std::nullopt; }

  std::optional<Value> get(const Key& key) const {
    const auto it = rows.find(key);
    if (it == rows.end()) {
      return std::nullopt;
    }
    return it->second;
  }
};

template <class Store>
void verify_store_against_model(const Store& store,
                                const NaiveModel<typename Store::key_type,
                                                 typename Store::value_type>&
                                    model,
                                const std::string& where) {
  using Key = typename Store::key_type;
  using Value = typename Store::value_type;

  const auto dump = store.dump();
  const std::size_t capacity = dump.capacity_bytes;
  std::size_t used = 0;
  std::size_t reserved = 0;
  std::size_t physical_records = 0;

  std::map<Key, std::uint64_t> max_version;
  std::map<Key, std::optional<Value>> max_value;
  std::vector<std::pair<std::size_t, std::size_t>> per_segment_live;
  per_segment_live.resize(dump.segments.size(), {0, 0});

  for (std::size_t segment_index = 0; segment_index < dump.segments.size();
       ++segment_index) {
    const auto& segment = dump.segments[segment_index];
    CHECK_EQ(segment.id, segment_index);
    CHECK_EQ(segment.capacity_bytes, dump.config.segment_capacity);
    CHECK(segment.used_bytes <= segment.capacity_bytes);
    CHECK(segment.reserved_bytes <=
          segment.capacity_bytes - segment.used_bytes);
    CHECK_EQ(segment.free_bytes,
             segment.capacity_bytes - segment.used_bytes);
    if (segment.state == dlks_formal::SegmentState::Free) {
      CHECK_EQ(segment.used_bytes, 0u);
      CHECK_EQ(segment.reserved_bytes, 0u);
      CHECK(segment.records.empty());
    }
    std::size_t segment_sum = 0;
    for (const auto& record : segment.records) {
      CHECK(record.bytes > 0);
      CHECK(record.bytes <= dump.config.segment_capacity);
      CHECK(record.version > 0);
      segment_sum += record.bytes;
      ++physical_records;
      const auto it = max_version.find(record.key);
      if (it == max_version.end() || record.version > it->second) {
        max_version[record.key] = record.version;
        max_value[record.key] = record.value;
      }
    }
    CHECK_EQ(segment_sum, segment.used_bytes);
    used += segment.used_bytes;
    reserved += segment.reserved_bytes;
  }
  CHECK_EQ(used + dump.free_bytes, capacity);

  std::map<Key, std::pair<std::uint32_t, std::uint32_t>> index;
  std::size_t live_bytes = 0;
  for (const auto& entry : dump.index) {
    CHECK(index.emplace(entry.key, std::make_pair(entry.segment, entry.slot))
              .second);
    CHECK(entry.segment < dump.segments.size());
    const auto& segment = dump.segments[entry.segment];
    CHECK(entry.slot < segment.records.size());
    const auto& record = segment.records[entry.slot];
    CHECK_EQ(record.key, entry.key);
    CHECK_EQ(record.version, entry.version);
    const auto max_it = max_version.find(entry.key);
    CHECK(max_it != max_version.end());
    CHECK_EQ(record.version, max_it->second);
    live_bytes += record.bytes;
    ++per_segment_live[entry.segment].first;
    per_segment_live[entry.segment].second += record.bytes;
  }
  CHECK_EQ(index.size(), max_version.size());

  // Every physical copy of the newest version must agree. Relocation
  // temporarily leaves the old copy in the sealed victim while the index points
  // at the destination copy.
  for (const auto& segment : dump.segments) {
    for (const auto& record : segment.records) {
      const auto max_it = max_version.find(record.key);
      if (max_it != max_version.end() &&
          record.version == max_it->second) {
        const auto& newest = max_value[record.key];
        CHECK_EQ(record.value.has_value(), newest.has_value());
        if (record.value.has_value()) {
          CHECK_EQ(*record.value, *newest);
        }
      }
    }
  }

  for (const auto& row : model.rows) {
    const auto got = store.get(row.first);
    CHECK_EQ(got.has_value(), row.second.has_value());
    if (got.has_value()) {
      CHECK_EQ(*got, *row.second);
    }
    const auto max_it = max_version.find(row.first);
    CHECK(max_it != max_version.end());
    const auto& newest = max_value[row.first];
    CHECK_EQ(newest.has_value(), row.second.has_value());
    if (newest.has_value()) {
      CHECK_EQ(*newest, *row.second);
    }
    CHECK(index.find(row.first) != index.end());
  }
  for (const auto& entry : index) {
    CHECK(model.rows.find(entry.first) != model.rows.end());
  }
  std::size_t live_keys = 0;
  for (const auto& row : model.rows) {
    if (row.second.has_value()) {
      ++live_keys;
    }
  }
  CHECK_EQ(store.size(), live_keys);
  for (const auto& row : model.rows) {
    CHECK_EQ(store.contains(row.first), row.second.has_value());
  }

  const auto stats = store.stats();
  CHECK_EQ(stats.capacity_bytes, capacity);
  CHECK_EQ(stats.used_bytes, used);
  CHECK_EQ(stats.free_bytes, capacity - used);
  CHECK_EQ(stats.reserved_bytes, reserved);
  CHECK_EQ(stats.available_bytes, stats.free_bytes - stats.reserved_bytes);
  CHECK_EQ(stats.live_bytes, live_bytes);
  CHECK_EQ(stats.dead_bytes, used - live_bytes);
  CHECK_EQ(stats.record_count, physical_records);
  CHECK_EQ(stats.live_record_count, index.size());
  CHECK_EQ(stats.version, dump.version);
  CHECK_EQ(stats.reclaimed_bytes, dump.reclaimed_bytes);
  CHECK_EQ(stats.cleaning_active, dump.cleaning.active);
  CHECK_EQ(stats.segments.size(), dump.segments.size());

  for (std::size_t id = 0; id < stats.segments.size(); ++id) {
    const auto& expected = stats.segments[id];
    const auto& physical = dump.segments[id];
    CHECK_EQ(expected.id, id);
    CHECK_EQ(expected.state, physical.state);
    CHECK_EQ(expected.capacity_bytes, physical.capacity_bytes);
    CHECK_EQ(expected.used_bytes, physical.used_bytes);
    CHECK_EQ(expected.reserved_bytes, physical.reserved_bytes);
    CHECK_EQ(expected.free_bytes, physical.free_bytes);
    CHECK_EQ(expected.live_bytes, per_segment_live[id].second);
    CHECK_EQ(expected.live_record_count, per_segment_live[id].first);
    CHECK_EQ(expected.dead_bytes,
             physical.used_bytes - per_segment_live[id].second);
    CHECK_EQ(expected.record_count, physical.records.size());
  }

  std::string why;
  if (!store.check_invariants(&why)) {
    std::ostringstream out;
    out << where << ": store invariant failed: " << why;
    throw Failure(out.str());
  }
}

}  // namespace dlks_test
