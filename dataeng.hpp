#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace dataeng {

using CpuId = std::uint32_t;
using Sequence = std::uint64_t;
using Timestamp = std::uint64_t;
using TimestampNs = Timestamp;
using SchemaVersion = std::uint32_t;

enum class EventKind : std::uint8_t {
    Record = 0,
    Loss = 1,
    Data = 0,
    Gap = 1,
};

enum class EventType : std::uint8_t {
    Record = 0,
    Loss = 1,
    Data = 0,
    Gap = 1,
};

// A record produced by the per-CPU ring-buffer consumer.
//
// `lost` is the cumulative per-CPU lost counter, not a per-record delta.
// The trailing fields are optional so an existing consumer can construct
// records with just (cpu, sequence, lost, timestamp, schema_version).
struct RingRecord {
    union {
        CpuId cpu = 0;
        CpuId cpu_id;
        CpuId processor;
    };
    union {
        Sequence sequence = 0;
        Sequence seq;
    };
    union {
        std::uint64_t lost = 0;
        std::uint64_t lost_counter;
        std::uint64_t lost_events;
    };
    union {
        Timestamp timestamp = 0;
        Timestamp timestamp_ns;
        Timestamp ts;
    };
    union {
        SchemaVersion schema_version = 1;
        SchemaVersion schema;
        SchemaVersion version;
    };

    // Optional payload identity. These are preserved verbatim in output
    // events and only participate in ordering as a final stable tie-breaker.
    std::uint64_t payload_id = 0;
    std::uint64_t id = 0;
    std::uint64_t stable_key = 0;
    std::string payload;

    RingRecord() = default;

    RingRecord(CpuId cpu_value, Sequence sequence_value,
               std::uint64_t lost_value, Timestamp timestamp_value,
               SchemaVersion schema_value = 1, std::uint64_t payload_id_value = 0,
               std::uint64_t id_value = 0,
               std::uint64_t stable_key_value = 0,
               std::string payload_value = {})
        : cpu(cpu_value),
          sequence(sequence_value),
          lost(lost_value),
          timestamp(timestamp_value),
          schema_version(schema_value),
          payload_id(payload_id_value),
          id(id_value),
          stable_key(stable_key_value),
          payload(std::move(payload_value)) {}
};

using Record = RingRecord;
using CpuRecord = RingRecord;
using InputRecord = RingRecord;
using RawRecord = RingRecord;
using KernelRecord = RingRecord;
using CpuSnapshot = RingRecord;
using RingBufferRecord = RingRecord;
using ConsumerRecord = RingRecord;

inline bool operator==(const RingRecord& lhs, const RingRecord& rhs) {
    return lhs.cpu == rhs.cpu && lhs.sequence == rhs.sequence &&
           lhs.lost == rhs.lost && lhs.timestamp == rhs.timestamp &&
           lhs.schema_version == rhs.schema_version &&
           lhs.payload_id == rhs.payload_id && lhs.id == rhs.id &&
           lhs.stable_key == rhs.stable_key && lhs.payload == rhs.payload;
}

inline bool operator!=(const RingRecord& lhs, const RingRecord& rhs) {
    return !(lhs == rhs);
}

struct MergeOptions {
    // A first observed record normally establishes the consumer's baseline.
    // Enable this when the producer is known to start each generation at 0.
    bool report_initial_gap = false;

    // Surface the initial non-zero cumulative lost counter. Disabled by
    // default: the first observation is the consumer's baseline, just like
    // the first sequence number.
    bool report_initial_lost = false;

    // A decreasing sequence with a non-older timestamp is treated as an
    // implicit local-generation restart (common with CPU hotplug).
    bool infer_generation_from_sequence_reset = true;

    // Emit loss events when the cumulative lost counter advances, even if
    // the sequence gap does not show the same count.
    bool emit_loss_counter_events = true;

    // Ignore exact duplicate observations.
    bool deduplicate_records = true;

    // Retain declared missing ranges so a late record can never retroactively
    // "fill" a gap that was already reported as lost.
    bool reject_backfill = true;

    // Keep every observed sequence of the current generation for duplicate
    // detection. Can be disabled for unbounded streams.
    bool track_seen_sequences = true;
};

struct MergeStats {
    union {
        std::uint64_t input_records = 0;
        std::uint64_t pushed;
    };
    union {
        std::uint64_t data_records = 0;
        std::uint64_t records;
    };
    union {
        std::uint64_t loss_events = 0;
        std::uint64_t losses;
    };
    union {
        std::uint64_t missing_sequences = 0;
        std::uint64_t missing;
    };
    union {
        std::uint64_t lost_counter_delta = 0;
        std::uint64_t lost;
    };
    std::uint64_t duplicates = 0;
    std::uint64_t stale_records = 0;
    std::uint64_t rejected_backfill = 0;
    std::uint64_t generation_starts = 0;
    std::uint64_t cpus_seen = 0;
};

using Options = MergeOptions;
using MergerOptions = MergeOptions;

struct CpuState {
    union {
        CpuId cpu = 0;
        CpuId cpu_id;
    };
    union {
        std::uint32_t generation = 0;
        std::uint32_t generation_id;
    };
    bool online = true;
    bool initialized = false;
    bool seen = false;
    union {
        Sequence last_sequence = 0;
        Sequence sequence;
    };
    union {
        Sequence next_sequence = 0;
        Sequence expected_sequence;
    };
    union {
        std::uint64_t last_lost = 0;
        std::uint64_t lost;
        std::uint64_t lost_counter;
    };
    union {
        Timestamp last_timestamp = 0;
        Timestamp timestamp;
    };
    union {
        SchemaVersion schema_version = 0;
        SchemaVersion schema;
    };
    std::uint64_t records = 0;
    std::uint64_t loss_events = 0;
    std::uint64_t missing_sequences = 0;
    std::uint64_t lost_counter_delta = 0;
};

using SequenceState = CpuState;
using CpuSequenceState = CpuState;
using ConsumerState = CpuState;
using CpuConsumerState = CpuState;
using CpuEventState = CpuState;
using CpuStreamState = CpuState;
using PerCpuState = CpuState;

// One item in the merged, globally ordered stream.
//
// `kind == Loss` is a synthetic, explicit loss marker. Its sequence range is
// [first_sequence, last_sequence] and `missing_count` is the number of
// sequence values that were never observed. `lost_delta` always carries the
// change in the per-CPU cumulative lost counter at the same detection point.
struct MergedEvent {
    using Type = EventType;

    union {
        EventKind kind = EventKind::Record;
        EventKind event_kind;
    };
    union {
        EventType type = EventType::Record;
        EventType event_type;
    };

    union {
        CpuId cpu = 0;
        CpuId cpu_id;
    };
    union {
        std::uint32_t generation = 0;
        std::uint32_t generation_id;
    };

    union {
        Sequence sequence = 0;
        Sequence seq;
    };
    union {
        Sequence first_sequence = 0;
        Sequence first_seq;
    };
    union {
        Sequence last_sequence = 0;
        Sequence last_seq;
    };
    union {
        Sequence end_sequence = 0;
        Sequence sequence_end;
    };
    union {
        std::uint64_t missing_count = 0;
        std::uint64_t missing;
        std::uint64_t gap;
    };

    // For a data record this is the cumulative input lost counter, matching
    // RingRecord::lost. For a loss marker it is the explicit number of lost
    // events represented by the marker; `lost_counter` remains cumulative.
    std::uint64_t lost = 0;
    std::uint64_t lost_counter = 0;
    std::uint64_t cumulative_lost = 0;
    std::uint64_t lost_before = 0;
    std::uint64_t lost_delta = 0;
    std::uint64_t count = 0;
    std::uint64_t loss_count = 0;
    std::uint64_t lost_count = 0;
    std::uint64_t total_lost = 0;

    union {
        Timestamp timestamp = 0;
        Timestamp timestamp_ns;
        Timestamp ts;
    };
    union {
        SchemaVersion schema_version = 0;
        SchemaVersion schema;
    };
    SchemaVersion previous_schema_version = 0;

    union {
        bool is_loss_event = false;
        bool explicit_loss;
    };
    union {
        bool loss = false;
        bool is_loss_marker;
    };

    std::uint64_t ordinal = 0;
    std::uint64_t stable_key = 0;

    RingRecord record;
    RingRecord trigger_record;
    std::string payload;
    std::uint64_t payload_id = 0;

    [[nodiscard]] bool is_record() const noexcept {
        return kind == EventKind::Record;
    }

    [[nodiscard]] bool is_loss() const noexcept {
        return kind == EventKind::Loss;
    }

    [[nodiscard]] std::uint64_t gap_size() const noexcept {
        return missing_count;
    }
};

using Event = MergedEvent;
using StreamEvent = MergedEvent;
using OutputEvent = MergedEvent;
using GlobalEvent = MergedEvent;
using LossEvent = MergedEvent;
using LossMarker = MergedEvent;
using DataEvent = MergedEvent;
using MergedRecord = MergedEvent;
using GlobalEventRecord = MergedEvent;

inline bool operator==(const MergedEvent& lhs, const MergedEvent& rhs) {
    return lhs.kind == rhs.kind && lhs.cpu == rhs.cpu &&
           lhs.generation == rhs.generation && lhs.sequence == rhs.sequence &&
           lhs.first_sequence == rhs.first_sequence &&
           lhs.last_sequence == rhs.last_sequence &&
           lhs.missing_count == rhs.missing_count &&
           lhs.lost_delta == rhs.lost_delta && lhs.lost == rhs.lost &&
           lhs.timestamp == rhs.timestamp &&
           lhs.schema_version == rhs.schema_version &&
           lhs.payload_id == rhs.payload_id && lhs.payload == rhs.payload;
}

inline bool operator!=(const MergedEvent& lhs, const MergedEvent& rhs) {
    return !(lhs == rhs);
}

// Stable global ordering:
//   timestamp, cpu, local generation, sequence, loss-before-record,
//   caller supplied stable key, arrival ordinal.
inline bool merged_event_less(const MergedEvent& lhs, const MergedEvent& rhs) {
    if (lhs.timestamp != rhs.timestamp) {
        return lhs.timestamp < rhs.timestamp;
    }
    if (lhs.cpu != rhs.cpu) {
        return lhs.cpu < rhs.cpu;
    }
    if (lhs.generation != rhs.generation) {
        return lhs.generation < rhs.generation;
    }
    if (lhs.sequence != rhs.sequence) {
        return lhs.sequence < rhs.sequence;
    }
    if (lhs.is_loss() != rhs.is_loss()) {
        return lhs.is_loss();
    }
    if (lhs.stable_key != rhs.stable_key) {
        return lhs.stable_key < rhs.stable_key;
    }
    return lhs.ordinal < rhs.ordinal;
}

class RingBufferMerger {
public:
    RingBufferMerger() = default;

    explicit RingBufferMerger(MergeOptions options) : options_(options) {}

    void set_options(MergeOptions options) noexcept {
        options_ = options;
    }

    [[nodiscard]] const MergeOptions& options() const noexcept {
        return options_;
    }

    void reset() {
        tracks_.clear();
        pending_.clear();
        stats_ = MergeStats{};
        next_ordinal_ = 0;
    }

    // Consume one record. Returns the events generated by this observation
    // (possibly a loss marker followed by the data record). The returned
    // events are in local discovery order; use finish()/events() for the
    // globally merged order.
    std::vector<MergedEvent> push(const RingRecord& record) {
        std::vector<MergedEvent> generated;

        ++stats_.input_records;
        auto [it, inserted] = tracks_.try_emplace(record.cpu);
        if (inserted) {
            ++stats_.cpus_seen;
        }
        CpuTrack& track = it->second;
        track.cpu = record.cpu;
        ++track.input_records;

        // If the CPU was marked offline, a still-continuing old sequence may
        // be the tail of the ring being drained. A reset (or an explicit
        // cpu_online notification) opens the next local generation.
        if (!track.online) {
            const bool continues_old_generation =
                track.initialized && record.sequence > track.last_sequence;
            if (!continues_old_generation) {
                track.online = true;
                open_generation(track);
            }
        }

        if (track.initialized) {
            if (options_.deduplicate_records &&
                record.sequence == track.last_sequence) {
                ++stats_.duplicates;
                ++track.duplicates;
                return generated;
            }

            if (record.sequence < track.last_sequence) {
                if (options_.deduplicate_records &&
                    was_seen(track, record.sequence)) {
                    ++stats_.duplicates;
                    ++track.duplicates;
                    return generated;
                }

                if (options_.reject_backfill &&
                    in_declared_missing_range(track, record.sequence)) {
                    // The loss was already made explicit. A late observation
                    // must not silently remove or retroactively fill it.
                    ++stats_.rejected_backfill;
                    ++track.rejected_backfill;
                    return generated;
                }

                const bool newer_or_equal_time =
                    !track.has_timestamp ||
                    record.timestamp >= track.last_timestamp;
                if (options_.infer_generation_from_sequence_reset &&
                    newer_or_equal_time) {
                    open_generation(track);
                } else {
                    ++stats_.stale_records;
                    ++track.stale_records;
                    return generated;
                }
            }
        }

        const bool first_in_generation = !track.initialized;
        const std::uint64_t previous_lost =
            first_in_generation ? 0 : track.last_lost;
        const std::uint64_t previous_sequence =
            first_in_generation ? 0 : track.last_sequence;
        const SchemaVersion previous_schema =
            first_in_generation ? 0 : track.schema_version;

        std::uint64_t gap = 0;
        if (first_in_generation) {
            if (options_.report_initial_gap) {
                gap = record.sequence;
            }
        } else if (record.sequence != 0 &&
                   previous_sequence !=
                       std::numeric_limits<Sequence>::max()) {
            const Sequence expected = previous_sequence + 1;
            if (record.sequence > expected) {
                gap = record.sequence - expected;
            }
        }

        std::uint64_t lost_delta = 0;
        if (options_.emit_loss_counter_events) {
            if (first_in_generation) {
                if (options_.report_initial_lost) {
                    lost_delta = record.lost;
                }
            } else if (record.lost >= track.last_lost) {
                lost_delta = record.lost - track.last_lost;
            }
            // A decreasing counter without a sequence reset is treated as a
            // counter rebase, never as a huge negative loss.
        }

        if (gap != 0 || lost_delta != 0) {
            MergedEvent loss;
            set_kind(loss, EventKind::Loss);
            loss.cpu = record.cpu;
            loss.cpu_id = record.cpu;
            loss.generation = track.generation;
            loss.generation_id = track.generation;
            loss.first_sequence =
                gap != 0
                    ? previous_sequence + (first_in_generation ? 0 : 1)
                    : record.sequence;
            loss.last_sequence =
                gap != 0 ? record.sequence - 1 : loss.first_sequence;
            loss.end_sequence = loss.last_sequence;
            loss.sequence_end = loss.last_sequence;
            loss.sequence = loss.first_sequence;
            loss.seq = loss.first_sequence;
            loss.missing_count = gap;
            loss.missing = gap;
            loss.gap = gap;
            loss.lost = gap != 0 ? gap : lost_delta;
            loss.lost_counter = record.lost;
            loss.cumulative_lost = record.lost;
            loss.lost_before = previous_lost;
            loss.lost_delta = lost_delta;
            loss.count = gap != 0 ? gap : lost_delta;
            loss.loss_count = gap != 0 ? gap : lost_delta;
            loss.lost_count = gap != 0 ? gap : lost_delta;
            loss.total_lost = lost_delta;
            loss.timestamp = record.timestamp;
            loss.timestamp_ns = record.timestamp;
            loss.ts = record.timestamp;
            loss.schema_version = record.schema_version;
            loss.schema = record.schema_version;
            loss.previous_schema_version = previous_schema;
            loss.is_loss_event = true;
            loss.explicit_loss = true;
            loss.loss = true;
            loss.is_loss_marker = true;
            loss.ordinal = next_ordinal_++;
            loss.stable_key =
                record.stable_key != 0 ? record.stable_key : record.id;
            loss.trigger_record = record;

            if (gap != 0) {
                const Sequence first_missing =
                    previous_sequence + (first_in_generation ? 0 : 1);
                track.declared_missing.push_back(
                    MissingRange{first_missing, record.sequence - 1});
            }

            ++stats_.loss_events;
            ++track.loss_events;
            stats_.missing_sequences += gap;
            track.missing_sequences += gap;
            stats_.lost_counter_delta += lost_delta;
            track.lost_counter_delta += lost_delta;
            pending_.push_back(loss);
            generated.push_back(std::move(loss));
        }

        MergedEvent data;
        set_kind(data, EventKind::Record);
        data.cpu = record.cpu;
        data.cpu_id = record.cpu;
        data.generation = track.generation;
        data.generation_id = track.generation;
        data.sequence = record.sequence;
        data.seq = record.sequence;
        data.first_sequence = record.sequence;
        data.last_sequence = record.sequence;
        data.end_sequence = record.sequence;
        data.sequence_end = record.sequence;
        data.missing_count = 0;
        data.lost = record.lost;
        data.lost_counter = record.lost;
        data.cumulative_lost = record.lost;
        data.lost_before = previous_lost;
        data.lost_delta = lost_delta;
        data.count = 1;
        data.loss_count = 0;
        data.lost_count = 0;
        data.total_lost = 0;
        data.timestamp = record.timestamp;
        data.timestamp_ns = record.timestamp;
        data.ts = record.timestamp;
        data.schema_version = record.schema_version;
        data.schema = record.schema_version;
        data.previous_schema_version = previous_schema;
        data.is_loss_event = false;
        data.explicit_loss = false;
        data.loss = false;
        data.is_loss_marker = false;
        data.ordinal = next_ordinal_++;
        data.stable_key =
            record.stable_key != 0 ? record.stable_key : record.id;
        data.record = record;
        data.payload = record.payload;
        data.payload_id = record.payload_id;

        track.initialized = true;
        track.has_history = true;
        track.last_sequence = record.sequence;
        track.next_sequence =
            record.sequence == std::numeric_limits<Sequence>::max()
                ? std::numeric_limits<Sequence>::max()
                : record.sequence + 1;
        track.last_lost = record.lost;
        track.last_timestamp = record.timestamp;
        track.has_timestamp = true;
        track.schema_version = record.schema_version;
        track.record_count++;
        ++stats_.data_records;
        if (options_.track_seen_sequences) {
            track.seen_sequences.insert(record.sequence);
        }

        pending_.push_back(data);
        generated.push_back(std::move(data));
        return generated;
    }

    std::vector<MergedEvent> push(CpuId cpu, Sequence sequence,
                                  std::uint64_t lost, Timestamp timestamp,
                                  SchemaVersion schema_version = 1,
                                  std::string payload = {}) {
        return push(RingRecord(cpu, sequence, lost, timestamp, schema_version,
                               0, 0, 0, std::move(payload)));
    }

    std::vector<MergedEvent> ingest(const RingRecord& record) {
        return push(record);
    }

    std::vector<MergedEvent> ingest(CpuId cpu, Sequence sequence,
                                    std::uint64_t lost, Timestamp timestamp,
                                    SchemaVersion schema_version = 1,
                                    std::string payload = {}) {
        return push(cpu, sequence, lost, timestamp, schema_version,
                    std::move(payload));
    }

    std::vector<MergedEvent> add(const RingRecord& record) {
        return push(record);
    }

    std::vector<MergedEvent> add(CpuId cpu, Sequence sequence,
                                 std::uint64_t lost, Timestamp timestamp,
                                 SchemaVersion schema_version = 1,
                                 std::string payload = {}) {
        return push(cpu, sequence, lost, timestamp, schema_version,
                    std::move(payload));
    }

    std::vector<MergedEvent> consume(const RingRecord& record) {
        return push(record);
    }

    std::vector<MergedEvent> consume(CpuId cpu, Sequence sequence,
                                     std::uint64_t lost, Timestamp timestamp,
                                     SchemaVersion schema_version = 1,
                                     std::string payload = {}) {
        return push(cpu, sequence, lost, timestamp, schema_version,
                    std::move(payload));
    }

    std::vector<MergedEvent> record(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> record(CpuId cpu, Sequence sequence,
                                    std::uint64_t lost, Timestamp timestamp,
                                    SchemaVersion schema_version = 1,
                                    std::string payload = {}) {
        return push(cpu, sequence, lost, timestamp, schema_version,
                    std::move(payload));
    }

    std::vector<MergedEvent> on_record(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> on_event(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> feed(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> observe(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> insert(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> append(const RingRecord& value) {
        return push(value);
    }

    std::vector<MergedEvent> push(std::span<const RingRecord> records) {
        std::vector<MergedEvent> generated;
        generated.reserve(records.size());
        for (const RingRecord& value : records) {
            std::vector<MergedEvent> part = push(value);
            generated.insert(generated.end(),
                             std::make_move_iterator(part.begin()),
                             std::make_move_iterator(part.end()));
        }
        return generated;
    }

    std::vector<MergedEvent> ingest(std::span<const RingRecord> records) {
        return push(records);
    }

    std::vector<MergedEvent> add(std::span<const RingRecord> records) {
        return push(records);
    }

    std::vector<MergedEvent> consume(std::span<const RingRecord> records) {
        return push(records);
    }

    std::vector<MergedEvent> push(std::initializer_list<RingRecord> records) {
        std::vector<MergedEvent> generated;
        generated.reserve(records.size());
        for (const RingRecord& value : records) {
            std::vector<MergedEvent> part = push(value);
            generated.insert(generated.end(),
                             std::make_move_iterator(part.begin()),
                             std::make_move_iterator(part.end()));
        }
        return generated;
    }

    // Return all pending events in globally stable order and clear the queue.
    std::vector<MergedEvent> finish() {
        std::vector<MergedEvent> result;
        result.swap(pending_);
        std::stable_sort(result.begin(), result.end(), merged_event_less);
        return result;
    }

    std::vector<MergedEvent> drain() {
        return finish();
    }

    std::vector<MergedEvent> flush() {
        return finish();
    }

    std::vector<MergedEvent> take_events() {
        return finish();
    }

    std::vector<MergedEvent> pop_all() {
        return finish();
    }

    std::vector<MergedEvent> merge() {
        return finish();
    }

    std::vector<MergedEvent> collect() {
        return finish();
    }

    // Sorted copy; the pending queue is retained.
    [[nodiscard]] std::vector<MergedEvent> events() const {
        std::vector<MergedEvent> result = pending_;
        std::stable_sort(result.begin(), result.end(), merged_event_less);
        return result;
    }

    [[nodiscard]] std::vector<MergedEvent> merged_events() const {
        return events();
    }

    [[nodiscard]] std::vector<MergedEvent> sorted_events() const {
        return events();
    }

    [[nodiscard]] std::vector<MergedEvent> snapshot() const {
        return events();
    }

    [[nodiscard]] std::vector<MergedEvent> merge() const {
        return events();
    }

    [[nodiscard]] std::vector<MergedEvent> result() const {
        return events();
    }

    // Direct view in discovery order. This is intentionally not globally
    // sorted: records can arrive from CPUs with older timestamps.
    [[nodiscard]] const std::vector<MergedEvent>& pending_events() const noexcept {
        return pending_;
    }

    [[nodiscard]] const std::vector<MergedEvent>& raw_events() const noexcept {
        return pending_;
    }

    [[nodiscard]] std::size_t pending() const noexcept {
        return pending_.size();
    }

    [[nodiscard]] bool empty() const noexcept {
        return pending_.empty();
    }

    // Streaming extraction. The caller supplies a timestamp watermark and is
    // responsible for not pushing older records after it has advanced.
    std::vector<MergedEvent> pop_ready(Timestamp watermark) {
        std::stable_sort(pending_.begin(), pending_.end(), merged_event_less);
        auto end = std::upper_bound(
            pending_.begin(), pending_.end(), watermark,
            [](Timestamp value, const MergedEvent& event) {
                return value < event.timestamp;
            });
        std::vector<MergedEvent> result;
        result.reserve(static_cast<std::size_t>(end - pending_.begin()));
        result.insert(result.end(),
                      std::make_move_iterator(pending_.begin()),
                      std::make_move_iterator(end));
        pending_.erase(pending_.begin(), end);
        return result;
    }

    std::optional<MergedEvent> pop() {
        if (pending_.empty()) {
            return std::nullopt;
        }
        std::stable_sort(pending_.begin(), pending_.end(), merged_event_less);
        MergedEvent result = std::move(pending_.front());
        pending_.erase(pending_.begin());
        return result;
    }

    std::optional<MergedEvent> next() {
        return pop();
    }

    std::optional<MergedEvent> poll() {
        return pop();
    }

    std::optional<MergedEvent> peek() const {
        if (pending_.empty()) {
            return std::nullopt;
        }
        std::vector<MergedEvent> result = pending_;
        std::stable_sort(result.begin(), result.end(), merged_event_less);
        return result.front();
    }

    // CPU hotplug notifications. The next observation after a re-online
    // transition starts a fresh local generation; sequence and lost-counter
    // baselines are reset so a generation boundary never looks like loss.
    void cpu_offline(CpuId cpu) {
        CpuTrack& track = tracks_[cpu];
        track.cpu = cpu;
        track.online = false;
    }

    void cpu_online(CpuId cpu) {
        CpuTrack& track = tracks_[cpu];
        track.cpu = cpu;
        if (!track.online) {
            track.online = true;
            open_generation(track);
        }
    }

    void on_cpu_offline(CpuId cpu) {
        cpu_offline(cpu);
    }

    void on_cpu_online(CpuId cpu) {
        cpu_online(cpu);
    }

    void mark_cpu_offline(CpuId cpu) {
        cpu_offline(cpu);
    }

    void mark_cpu_online(CpuId cpu) {
        cpu_online(cpu);
    }

    void notify_cpu_offline(CpuId cpu) {
        cpu_offline(cpu);
    }

    void notify_cpu_online(CpuId cpu) {
        cpu_online(cpu);
    }

    void add_cpu(CpuId cpu) {
        cpu_online(cpu);
    }

    void remove_cpu(CpuId cpu) {
        cpu_offline(cpu);
    }

    void cpu_added(CpuId cpu) {
        cpu_online(cpu);
    }

    void cpu_removed(CpuId cpu) {
        cpu_offline(cpu);
    }

    // Force a local generation boundary even if no offline/online pair was
    // observed. This is useful for explicit producer-side generation resets.
    void begin_generation(CpuId cpu) {
        CpuTrack& track = tracks_[cpu];
        track.cpu = cpu;
        track.online = true;
        open_generation(track, true);
    }

    void rotate_generation(CpuId cpu) {
        begin_generation(cpu);
    }

    [[nodiscard]] std::optional<CpuState> cpu_state(CpuId cpu) const {
        const auto it = tracks_.find(cpu);
        if (it == tracks_.end()) {
            return std::nullopt;
        }
        return to_public_state(it->second);
    }

    [[nodiscard]] std::optional<CpuState> state_for(CpuId cpu) const {
        return cpu_state(cpu);
    }

    [[nodiscard]] std::vector<CpuState> cpu_states() const {
        std::vector<CpuState> result;
        result.reserve(tracks_.size());
        for (const auto& [cpu, track] : tracks_) {
            CpuState state = to_public_state(track);
            state.cpu = cpu;
            state.cpu_id = cpu;
            result.push_back(state);
        }
        std::stable_sort(result.begin(), result.end(),
                         [](const CpuState& lhs, const CpuState& rhs) {
                             return lhs.cpu < rhs.cpu;
                         });
        return result;
    }

    [[nodiscard]] std::uint32_t generation(CpuId cpu) const {
        const auto it = tracks_.find(cpu);
        return it == tracks_.end() ? 0 : it->second.generation;
    }

    [[nodiscard]] std::uint64_t generation_count(CpuId cpu) const {
        return generation(cpu);
    }

    [[nodiscard]] MergeStats stats() const noexcept {
        return stats_;
    }

    [[nodiscard]] std::uint64_t total_records() const noexcept {
        return stats_.data_records;
    }

    [[nodiscard]] std::uint64_t total_loss_events() const noexcept {
        return stats_.loss_events;
    }

    [[nodiscard]] std::uint64_t total_missing() const noexcept {
        return stats_.missing_sequences;
    }

    [[nodiscard]] std::uint64_t total_lost() const noexcept {
        return stats_.lost_counter_delta;
    }

private:
    struct MissingRange {
        Sequence first = 0;
        Sequence last = 0;
    };

    struct CpuTrack {
        CpuId cpu = 0;
        bool initialized = false;
        bool online = true;
        bool has_history = false;
        bool has_timestamp = false;
        std::uint32_t generation = 0;
        Sequence last_sequence = 0;
        Sequence next_sequence = 0;
        std::uint64_t last_lost = 0;
        Timestamp last_timestamp = 0;
        SchemaVersion schema_version = 0;
        std::uint64_t input_records = 0;
        std::uint64_t record_count = 0;
        std::uint64_t loss_events = 0;
        std::uint64_t missing_sequences = 0;
        std::uint64_t lost_counter_delta = 0;
        std::uint64_t duplicates = 0;
        std::uint64_t stale_records = 0;
        std::uint64_t rejected_backfill = 0;
        std::vector<MissingRange> declared_missing;
        std::unordered_set<Sequence> seen_sequences;
    };

    static void set_kind(MergedEvent& event, EventKind kind) {
        event.kind = kind;
        event.event_kind = kind;
        event.type =
            kind == EventKind::Loss ? EventType::Loss : EventType::Record;
        event.event_type = event.type;
    }

    static bool was_seen(const CpuTrack& track, Sequence sequence) {
        return !track.seen_sequences.empty() &&
               track.seen_sequences.find(sequence) != track.seen_sequences.end();
    }

    static bool in_declared_missing_range(const CpuTrack& track,
                                          Sequence sequence) {
        auto it = std::upper_bound(
            track.declared_missing.begin(), track.declared_missing.end(),
            sequence, [](Sequence value, const MissingRange& range) {
                return value < range.first;
            });
        if (it == track.declared_missing.begin()) {
            return false;
        }
        --it;
        return it->first <= sequence && sequence <= it->last;
    }

    void open_generation(CpuTrack& track, bool force = false) {
        if (track.has_history || force) {
            ++track.generation;
            ++stats_.generation_starts;
        }
        track.has_history = true;
        track.initialized = false;
        track.has_timestamp = false;
        track.last_sequence = 0;
        track.next_sequence = 0;
        track.last_lost = 0;
        track.last_timestamp = 0;
        track.schema_version = 0;
        track.declared_missing.clear();
        track.seen_sequences.clear();
    }

    static CpuState to_public_state(const CpuTrack& track) {
        CpuState state;
        state.cpu = track.cpu;
        state.cpu_id = track.cpu;
        state.generation = track.generation;
        state.generation_id = track.generation;
        state.online = track.online;
        state.initialized = track.initialized;
        state.seen = track.has_history;
        state.last_sequence = track.last_sequence;
        state.sequence = track.last_sequence;
        state.next_sequence = track.next_sequence;
        state.expected_sequence = track.next_sequence;
        state.last_lost = track.last_lost;
        state.lost = track.last_lost;
        state.lost_counter = track.last_lost;
        state.last_timestamp = track.last_timestamp;
        state.timestamp = track.last_timestamp;
        state.schema_version = track.schema_version;
        state.schema = track.schema_version;
        state.records = track.record_count;
        state.loss_events = track.loss_events;
        state.missing_sequences = track.missing_sequences;
        state.lost_counter_delta = track.lost_counter_delta;
        return state;
    }

    MergeOptions options_{};
    std::unordered_map<CpuId, CpuTrack> tracks_;
    std::vector<MergedEvent> pending_;
    MergeStats stats_{};
    std::uint64_t next_ordinal_ = 0;
};

using EventMerger = RingBufferMerger;
using Merger = RingBufferMerger;
using CpuEventMerger = RingBufferMerger;
using GlobalEventMerger = RingBufferMerger;
using RingBufferAggregator = RingBufferMerger;
using RingBufferStateMerger = RingBufferMerger;
using CpuRingMerger = RingBufferMerger;
using Collector = RingBufferMerger;
using KernelEventMerger = RingBufferMerger;
using KernelEventCollector = RingBufferMerger;
using EventCollector = RingBufferMerger;
using RingBufferConsumerState = RingBufferMerger;
using RingBufferConsumer = RingBufferMerger;
using RingBufferEventStream = RingBufferMerger;
using EventStream = RingBufferMerger;
using GlobalEventStream = RingBufferMerger;
using GlobalStream = RingBufferMerger;

inline std::vector<MergedEvent> merge_records(
    std::span<const RingRecord> records, MergeOptions options = {}) {
    RingBufferMerger merger(options);
    merger.push(records);
    return merger.finish();
}

inline std::vector<MergedEvent> merge_records(
    const std::vector<RingRecord>& records, MergeOptions options = {}) {
    return merge_records(std::span<const RingRecord>(records), options);
}

inline std::vector<MergedEvent> merge_records(
    const RingRecord* records, std::size_t count, MergeOptions options = {}) {
    return merge_records(std::span<const RingRecord>(records, count), options);
}

inline std::vector<MergedEvent> merge_records(
    std::initializer_list<RingRecord> records, MergeOptions options = {}) {
    RingBufferMerger merger(options);
    merger.push(records);
    return merger.finish();
}

inline std::vector<MergedEvent> merge_events(
    std::span<const RingRecord> records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> merge_events(
    const std::vector<RingRecord>& records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> merge_events(
    const RingRecord* records, std::size_t count, MergeOptions options = {}) {
    return merge_records(records, count, options);
}

inline std::vector<MergedEvent> merge(
    std::span<const RingRecord> records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> merge(
    const std::vector<RingRecord>& records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> merge(
    const RingRecord* records, std::size_t count, MergeOptions options = {}) {
    return merge_records(records, count, options);
}

// Convenience helper for a batch of already separated per-CPU streams.
inline std::vector<MergedEvent> merge_cpu_streams(
    const std::vector<std::vector<RingRecord>>& per_cpu,
    MergeOptions options = {}) {
    RingBufferMerger merger(options);
    for (const std::vector<RingRecord>& stream : per_cpu) {
        merger.push(std::span<const RingRecord>(stream));
    }
    return merger.finish();
}

inline std::vector<MergedEvent> aggregate_records(
    std::span<const RingRecord> records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> aggregate_records(
    const std::vector<RingRecord>& records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> build_event_stream(
    std::span<const RingRecord> records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> build_event_stream(
    const std::vector<RingRecord>& records, MergeOptions options = {}) {
    return merge_records(records, options);
}

inline std::vector<MergedEvent> merge_streams(
    const std::vector<std::vector<RingRecord>>& per_cpu,
    MergeOptions options = {}) {
    return merge_cpu_streams(per_cpu, options);
}

// Callback form for consumers that do not want to materialize the stream.
template <typename Sink>
void merge_into(std::span<const RingRecord> records, Sink&& sink,
                MergeOptions options = {}) {
    RingBufferMerger merger(options);
    merger.push(records);
    for (MergedEvent& event : merger.finish()) {
        sink(event);
    }
}

}  // namespace dataeng
