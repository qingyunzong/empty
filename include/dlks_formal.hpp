#pragma once

// dlks_formal: a small, embeddable, bounded-cardinality metric aggregator.
//
// The component is header-only and depends only on the C++20 standard library.
// It is intentionally single-threaded: callers synchronise access if a shard is
// shared between threads.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace dlks_formal {

using Nanos = std::uint64_t;

struct Label {
    std::string key;
    std::string value;

    friend bool operator==(const Label&, const Label&) = default;
};

enum class RetentionPolicy : std::uint8_t {
    // Protect residents whose count is strictly above the incoming increment.
    // On a tie the newcomer is admitted, so a table full of one-off labels can
    // still let a new key accumulate.  This is the default: an established
    // heavy set survives a flood of one-off labels, while ties keep the table
    // adaptable.
    ProtectResidents = 0,

    // Admit every new key.  When the table is full the least-frequent resident
    // series is folded into overflow, even if the newcomer starts below it.
    // This adapts quickly to a new heavy key at the cost of possibly displacing
    // one established resident per burst.
    EvictLeastFrequent = 1,
};

struct MetricConfig {
    // Upper bound for the retained-series table.  The fixed O(1) shard
    // metadata is outside this charge; see the README for the exact model.
    std::size_t memory_budget_bytes = 64 * 1024;

    // Idle time after which a retained label set is expired.  Zero disables
    // expiry.  Expiry folds the series count into overflow and releases the
    // series' table charge.
    Nanos label_ttl_ns = 0;

    RetentionPolicy retention = RetentionPolicy::ProtectResidents;
};

enum class ObserveStatus : std::uint8_t {
    Retained,
    MergedIntoOverflow,
    KeyTooLong,
    UnknownMetric,
    NoCapacity,
    Ignored,
};

struct SeriesPoint {
    std::vector<Label> labels;  // Empty for the overflow control series.
    std::uint64_t count = 0;
    Nanos last_seen = 0;
    bool overflow = false;
};

namespace detail {

inline std::uint64_t saturating_add(std::uint64_t a,
                                    std::uint64_t b) noexcept {
    const std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
    return a > max - b ? max : a + b;
}

inline bool label_less(const Label& a, const Label& b) noexcept {
    if (a.key != b.key) {
        return a.key < b.key;
    }
    return a.value < b.value;
}

struct StringLess {
    using is_transparent = void;

    bool operator()(std::string_view a, std::string_view b) const noexcept {
        return a < b;
    }
};

}  // namespace detail

struct MetricSnapshot {
    std::string metric;
    MetricConfig config{};
    std::vector<SeriesPoint> series;  // Retained series, canonical order.
    SeriesPoint overflow{};           // Always present, always overflow == true.
    std::size_t live_series = 0;
    std::size_t max_series = 0;
    std::size_t series_slot_bytes = 0;
    std::size_t accounted_bytes = 0;
    std::size_t reserved_bytes = 0;
    std::uint64_t evictions = 0;
    std::uint64_t expirations = 0;

    std::uint64_t total_count() const noexcept {
        std::uint64_t total = overflow.count;
        for (const SeriesPoint& point : series) {
            total = detail::saturating_add(total, point.count);
        }
        return total;
    }
};

struct Snapshot {
    std::vector<MetricSnapshot> metrics;

    std::uint64_t total_count() const noexcept {
        std::uint64_t total = 0;
        for (const MetricSnapshot& metric : metrics) {
            total = detail::saturating_add(total, metric.total_count());
        }
        return total;
    }

    const MetricSnapshot* find(std::string_view name) const noexcept {
        for (const MetricSnapshot& metric : metrics) {
            if (metric.metric == name) {
                return &metric;
            }
        }
        return nullptr;
    }
};

struct Fnv1aHasher {
    std::uint64_t operator()(std::string_view bytes) const noexcept {
        std::uint64_t hash = 14695981039346656037ULL;
        for (const unsigned char byte : bytes) {
            hash ^= byte;
            hash *= 1099511628211ULL;
        }
        return hash;
    }
};

// A bounded, exact series table for one metric.
//
// Keys are encoded canonically (labels sorted by key then value, with explicit
// length prefixes) into a fixed KeyBytes slot.  The table is an open-addressing
// linear-probing hash table.  The stored bytes, not just the hash, are compared
// on lookup, so two distinct keys that collide in the hash function can never
// be merged.
template <std::size_t KeyBytes = 128, class Hasher = Fnv1aHasher>
class BasicMetricShard {
    static_assert(KeyBytes >= 8, "KeyBytes must leave room for a label set");
    static_assert(KeyBytes <= std::numeric_limits<std::uint32_t>::max(),
                  "KeyBytes must fit the slot length field");

private:
    struct Slot {
        std::uint64_t hash = 0;
        std::uint64_t count = 0;
        Nanos last_seen = 0;
        std::uint32_t key_len = 0;
        bool occupied = false;
        std::array<char, KeyBytes> key{};
    };

public:
    explicit BasicMetricShard(MetricConfig config = {}, Hasher hasher = {})
        : config_(config), hasher_(std::move(hasher)) {
        // One slot is kept empty so linear-probing deletion always terminates.
        const std::size_t physical_slots =
            config_.memory_budget_bytes / sizeof(Slot);
        if (physical_slots != 0) {
            slots_ = std::make_unique<Slot[]>(physical_slots);
            slot_count_ = physical_slots;
            max_live_ = physical_slots - 1;
        }
    }

    BasicMetricShard(BasicMetricShard&&) noexcept = default;
    BasicMetricShard& operator=(BasicMetricShard&&) noexcept = default;
    BasicMetricShard(const BasicMetricShard&) = delete;
    BasicMetricShard& operator=(const BasicMetricShard&) = delete;

    static constexpr std::size_t slot_bytes() noexcept { return sizeof(Slot); }

    // Maximum number of retained series that a budget can hold.
    static constexpr std::size_t max_series_for(
        std::size_t budget_bytes) noexcept {
        const std::size_t physical_slots = budget_bytes / sizeof(Slot);
        return physical_slots == 0 ? 0 : physical_slots - 1;
    }

    ObserveStatus observe(std::span<const Label> labels,
                          std::uint64_t delta,
                          Nanos now) {
        if (max_live_ == 0) {
            if (delta != 0) {
                add_overflow(delta, now);
                return ObserveStatus::NoCapacity;
            }
            return ObserveStatus::Ignored;
        }

        std::array<char, KeyBytes> encoded{};
        std::size_t encoded_len = 0;
        if (!encode(labels, encoded.data(), encoded.size(), encoded_len)) {
            if (delta != 0) {
                add_overflow(delta, now);
                return ObserveStatus::KeyTooLong;
            }
            return ObserveStatus::Ignored;
        }

        const std::uint64_t hash =
            hasher_(std::string_view(encoded.data(), encoded_len));
        std::size_t index = 0;
        if (find_key(encoded.data(), encoded_len, hash, index)) {
            Slot& slot = slots_[index];
            if (delta != 0 && is_expired(slot, now)) {
                // A sample after the idle TTL starts a fresh series.  The old
                // count is preserved in overflow, so totals stay conserved.
                add_overflow(slot.count, slot.last_seen);
                ++expirations_;
                slot.count = 0;
            }
            slot.count = detail::saturating_add(slot.count, delta);
            slot.last_seen = std::max(slot.last_seen, now);
            return ObserveStatus::Retained;
        }

        if (delta == 0) {
            return ObserveStatus::Ignored;
        }

        if (live_ < max_live_) {
            insert_free(encoded.data(), encoded_len, hash, delta, now);
            return ObserveStatus::Retained;
        }

        const std::size_t victim = find_victim();
        if (config_.retention == RetentionPolicy::ProtectResidents &&
            slots_[victim].count > delta) {
            add_overflow(delta, now);
            return ObserveStatus::MergedIntoOverflow;
        }

        add_overflow(slots_[victim].count, slots_[victim].last_seen);
        erase_at(victim);
        ++evictions_;
        insert_free(encoded.data(), encoded_len, hash, delta, now);
        return ObserveStatus::Retained;
    }

    // Remove every series idle for at least config().label_ttl_ns.  Expired
    // counts are folded into overflow and their slots are released.
    std::size_t expire(Nanos now) {
        if (config_.label_ttl_ns == 0 || slot_count_ == 0) {
            return 0;
        }

        std::size_t removed = 0;
        bool progress = true;
        while (progress) {
            progress = false;
            for (std::size_t i = 0; i < slot_count_; ++i) {
                if (!slots_[i].occupied || !is_expired(slots_[i], now)) {
                    continue;
                }
                add_overflow(slots_[i].count, slots_[i].last_seen);
                erase_at(i);
                ++expirations_;
                ++removed;
                progress = true;
                break;  // erase_at may move a later slot into an earlier index
            }
        }
        return removed;
    }

    void reset() {
        if (slots_) {
            std::fill_n(slots_.get(), slot_count_, Slot{});
        }
        live_ = 0;
        overflow_ = 0;
        overflow_last_seen_ = 0;
        evictions_ = 0;
        expirations_ = 0;
    }

    MetricSnapshot snapshot(std::string_view metric) const {
        MetricSnapshot out;
        out.metric.assign(metric);
        out.config = config_;
        out.series.reserve(live_);

        for (std::size_t i = 0; i < slot_count_; ++i) {
            const Slot& slot = slots_[i];
            if (!slot.occupied) {
                continue;
            }
            SeriesPoint point;
            point.labels = decode_key(slot.key.data(), slot.key_len);
            point.count = slot.count;
            point.last_seen = slot.last_seen;
            point.overflow = false;
            out.series.push_back(std::move(point));
        }

        std::sort(out.series.begin(), out.series.end(),
                  [](const SeriesPoint& a, const SeriesPoint& b) {
                      return labels_less(a.labels, b.labels);
                  });

        out.overflow.labels.clear();
        out.overflow.count = overflow_;
        out.overflow.last_seen = overflow_last_seen_;
        out.overflow.overflow = true;
        out.live_series = live_;
        out.max_series = max_live_;
        out.series_slot_bytes = sizeof(Slot);
        out.accounted_bytes = live_ * sizeof(Slot);
        out.reserved_bytes = slot_count_ * sizeof(Slot);
        out.evictions = evictions_;
        out.expirations = expirations_;
        return out;
    }

    const MetricConfig& config() const noexcept { return config_; }
    std::size_t max_series() const noexcept { return max_live_; }
    std::size_t live_series() const noexcept { return live_; }
    std::size_t reserved_table_bytes() const noexcept {
        return slot_count_ * sizeof(Slot);
    }
    std::size_t accounted_table_bytes() const noexcept {
        return live_ * sizeof(Slot);
    }
    std::uint64_t overflow_count() const noexcept { return overflow_; }

private:
    static bool labels_less(const std::vector<Label>& a,
                            const std::vector<Label>& b) {
        return std::lexicographical_compare(
            a.begin(), a.end(), b.begin(), b.end(),
            [](const Label& lhs, const Label& rhs) {
                return detail::label_less(lhs, rhs);
            });
    }

    static void put_u32(char* out, std::uint32_t value) noexcept {
        out[0] = static_cast<char>(value & 0xFFu);
        out[1] = static_cast<char>((value >> 8) & 0xFFu);
        out[2] = static_cast<char>((value >> 16) & 0xFFu);
        out[3] = static_cast<char>((value >> 24) & 0xFFu);
    }

    static std::uint32_t get_u32(const char* in) noexcept {
        return static_cast<std::uint32_t>(
                   static_cast<unsigned char>(in[0])) |
               (static_cast<std::uint32_t>(
                    static_cast<unsigned char>(in[1]))
                << 8) |
               (static_cast<std::uint32_t>(
                    static_cast<unsigned char>(in[2]))
                << 16) |
               (static_cast<std::uint32_t>(
                    static_cast<unsigned char>(in[3]))
                << 24);
    }

    bool encode(std::span<const Label> labels,
                char* out,
                std::size_t capacity,
                std::size_t& encoded_len) const {
        // Avoid a heap allocation for the common case of a small, already
        // canonical label set.
        std::array<const Label*, 16> local{};
        std::vector<const Label*> heap;
        std::span<const Label*> ordered;
        if (labels.size() <= local.size()) {
            for (std::size_t i = 0; i < labels.size(); ++i) {
                local[i] = &labels[i];
            }
            ordered = std::span<const Label*>(local.data(), labels.size());
        } else {
            heap.reserve(labels.size());
            for (const Label& label : labels) {
                heap.push_back(&label);
            }
            ordered = std::span<const Label*>(heap.data(), heap.size());
        }

        const auto less = [](const Label* a, const Label* b) {
            return detail::label_less(*a, *b);
        };
        if (!std::is_sorted(ordered.begin(), ordered.end(), less)) {
            std::sort(ordered.begin(), ordered.end(), less);
        }

        std::size_t remaining = capacity;
        for (const Label* label : ordered) {
            const std::size_t key_size = label->key.size();
            const std::size_t value_size = label->value.size();
            if (key_size > std::numeric_limits<std::uint32_t>::max() ||
                value_size > std::numeric_limits<std::uint32_t>::max()) {
                return false;
            }
            const std::size_t need = 8 + key_size + value_size;
            if (need < 8 || need > remaining) {
                return false;
            }
            remaining -= need;
        }

        char* cursor = out;
        for (const Label* label : ordered) {
            put_u32(cursor, static_cast<std::uint32_t>(label->key.size()));
            cursor += 4;
            std::memcpy(cursor, label->key.data(), label->key.size());
            cursor += label->key.size();
            put_u32(cursor, static_cast<std::uint32_t>(label->value.size()));
            cursor += 4;
            std::memcpy(cursor, label->value.data(), label->value.size());
            cursor += label->value.size();
        }
        encoded_len = static_cast<std::size_t>(cursor - out);
        return true;
    }

    static std::vector<Label> decode_key(const char* data, std::size_t len) {
        std::vector<Label> labels;
        std::size_t offset = 0;
        while (offset + 4 <= len) {
            const std::uint32_t key_len = get_u32(data + offset);
            offset += 4;
            if (key_len > len - offset) {
                break;
            }
            std::string key(data + offset, key_len);
            offset += key_len;
            if (offset + 4 > len) {
                break;
            }
            const std::uint32_t value_len = get_u32(data + offset);
            offset += 4;
            if (value_len > len - offset) {
                break;
            }
            std::string value(data + offset, value_len);
            offset += value_len;
            labels.push_back(Label{std::move(key), std::move(value)});
        }
        return labels;
    }

    bool find_key(const char* key,
                  std::size_t key_len,
                  std::uint64_t hash,
                  std::size_t& index) const {
        std::size_t cursor = static_cast<std::size_t>(hash % slot_count_);
        for (std::size_t probes = 0; probes < slot_count_; ++probes) {
            const Slot& slot = slots_[cursor];
            if (!slot.occupied) {
                return false;
            }
            if (slot.hash == hash && slot.key_len == key_len &&
                std::memcmp(slot.key.data(), key, key_len) == 0) {
                index = cursor;
                return true;
            }
            cursor = (cursor + 1) % slot_count_;
        }
        return false;
    }

    void insert_free(const char* key,
                     std::size_t key_len,
                     std::uint64_t hash,
                     std::uint64_t delta,
                     Nanos now) {
        std::size_t cursor = static_cast<std::size_t>(hash % slot_count_);
        while (slots_[cursor].occupied) {
            cursor = (cursor + 1) % slot_count_;
        }
        Slot& slot = slots_[cursor];
        slot.hash = hash;
        slot.count = delta;
        slot.last_seen = now;
        slot.key_len = static_cast<std::uint32_t>(key_len);
        slot.occupied = true;
        std::memcpy(slot.key.data(), key, key_len);
        ++live_;
    }

    // Backward-shift deletion for linear probing.  A slot is only moved when
    // doing so cannot break another key's probe path.
    void erase_at(std::size_t hole) {
        const std::size_t n = slot_count_;
        std::size_t cursor = hole;
        for (;;) {
            cursor = (cursor + 1) % n;
            if (!slots_[cursor].occupied) {
                break;
            }
            const std::size_t home =
                static_cast<std::size_t>(slots_[cursor].hash % n);
            const bool movable =
                cursor > hole
                    ? (home <= hole || home > cursor)
                    : (home <= hole && home > cursor);
            if (movable) {
                slots_[hole] = slots_[cursor];
                hole = cursor;
            }
        }
        slots_[hole].occupied = false;
        slots_[hole].hash = 0;
        slots_[hole].count = 0;
        slots_[hole].last_seen = 0;
        slots_[hole].key_len = 0;
        --live_;
    }

    std::size_t find_victim() const {
        std::size_t best = slot_count_;
        for (std::size_t i = 0; i < slot_count_; ++i) {
            if (!slots_[i].occupied) {
                continue;
            }
            if (best == slot_count_) {
                best = i;
                continue;
            }
            const Slot& candidate = slots_[i];
            const Slot& current = slots_[best];
            if (candidate.count < current.count) {
                best = i;
            } else if (candidate.count == current.count) {
                if (candidate.last_seen < current.last_seen) {
                    best = i;
                } else if (candidate.last_seen == current.last_seen &&
                           std::string_view(candidate.key.data(),
                                            candidate.key_len) <
                               std::string_view(current.key.data(),
                                                current.key_len)) {
                    best = i;
                }
            }
        }
        return best;
    }

    bool is_expired(const Slot& slot, Nanos now) const noexcept {
        if (config_.label_ttl_ns == 0 || now <= slot.last_seen) {
            return false;
        }
        return now - slot.last_seen >= config_.label_ttl_ns;
    }

    void add_overflow(std::uint64_t delta, Nanos now) noexcept {
        overflow_ = detail::saturating_add(overflow_, delta);
        overflow_last_seen_ = std::max(overflow_last_seen_, now);
    }

    MetricConfig config_{};
    Hasher hasher_{};
    std::unique_ptr<Slot[]> slots_{};
    std::size_t slot_count_ = 0;
    std::size_t max_live_ = 0;
    std::size_t live_ = 0;
    std::uint64_t overflow_ = 0;
    Nanos overflow_last_seen_ = 0;
    std::uint64_t evictions_ = 0;
    std::uint64_t expirations_ = 0;
};

// A registry of independent per-metric shards.  Each metric has its own
// budget, TTL and retention policy; overflow is never shared across metrics.
template <std::size_t KeyBytes = 128, class Hasher = Fnv1aHasher>
class BasicAggregator {
public:
    using shard_type = BasicMetricShard<KeyBytes, Hasher>;

    explicit BasicAggregator(Hasher hasher = {}) : hasher_(std::move(hasher)) {}

    BasicAggregator(BasicAggregator&&) noexcept = default;
    BasicAggregator& operator=(BasicAggregator&&) noexcept = default;
    BasicAggregator(const BasicAggregator&) = delete;
    BasicAggregator& operator=(const BasicAggregator&) = delete;

    static constexpr std::size_t slot_bytes() noexcept {
        return shard_type::slot_bytes();
    }

    static constexpr std::size_t max_series_for(
        std::size_t budget_bytes) noexcept {
        return shard_type::max_series_for(budget_bytes);
    }

    bool define_metric(std::string name, MetricConfig config = {}) {
        if (index_.find(name) != index_.end()) {
            return false;
        }
        const std::size_t index = metrics_.size();
        metrics_.push_back(Entry{std::move(name), shard_type(config, hasher_)});
        index_.emplace(metrics_.back().name, index);
        return true;
    }

    bool has_metric(std::string_view name) const noexcept {
        return index_.find(name) != index_.end();
    }

    bool erase_metric(std::string_view name) {
        const auto it = index_.find(name);
        if (it == index_.end()) {
            return false;
        }
        const std::size_t index = it->second;
        index_.erase(it);
        metrics_.erase(metrics_.begin() + static_cast<std::ptrdiff_t>(index));
        for (auto& [key, value] : index_) {
            (void)key;
            if (value > index) {
                --value;
            }
        }
        return true;
    }

    ObserveStatus observe(std::string_view metric,
                          std::span<const Label> labels,
                          std::uint64_t delta,
                          Nanos now) {
        const auto it = index_.find(metric);
        if (it == index_.end()) {
            return ObserveStatus::UnknownMetric;
        }
        return metrics_[it->second].shard.observe(labels, delta, now);
    }

    std::size_t expire(Nanos now) {
        std::size_t removed = 0;
        for (Entry& entry : metrics_) {
            removed += entry.shard.expire(now);
        }
        return removed;
    }

    std::size_t expire_metric(std::string_view metric, Nanos now) {
        const auto it = index_.find(metric);
        if (it == index_.end()) {
            return 0;
        }
        return metrics_[it->second].shard.expire(now);
    }

    bool reset_metric(std::string_view metric) {
        const auto it = index_.find(metric);
        if (it == index_.end()) {
            return false;
        }
        metrics_[it->second].shard.reset();
        return true;
    }

    Snapshot snapshot() const {
        Snapshot out;
        out.metrics.reserve(metrics_.size());
        for (const Entry& entry : metrics_) {
            out.metrics.push_back(entry.shard.snapshot(entry.name));
        }
        std::sort(out.metrics.begin(), out.metrics.end(),
                  [](const MetricSnapshot& a, const MetricSnapshot& b) {
                      return a.metric < b.metric;
                  });
        return out;
    }

    std::optional<MetricSnapshot> metric_snapshot(
        std::string_view metric) const {
        const auto it = index_.find(metric);
        if (it == index_.end()) {
            return std::nullopt;
        }
        return metrics_[it->second].shard.snapshot(metric);
    }

    const MetricConfig* metric_config(std::string_view metric) const noexcept {
        const auto it = index_.find(metric);
        return it == index_.end() ? nullptr
                                  : &metrics_[it->second].shard.config();
    }

    void clear() {
        index_.clear();
        metrics_.clear();
    }

    std::size_t metric_count() const noexcept { return metrics_.size(); }

private:
    struct Entry {
        std::string name;
        shard_type shard;
    };

    std::map<std::string, std::size_t, detail::StringLess> index_;
    std::vector<Entry> metrics_;
    Hasher hasher_{};
};

template <std::size_t KeyBytes = 128, class Hasher = Fnv1aHasher>
using Aggregator = BasicAggregator<KeyBytes, Hasher>;

}  // namespace dlks_formal

// Convenience short namespace; both names refer to the same component.
namespace dlks = dlks_formal;
