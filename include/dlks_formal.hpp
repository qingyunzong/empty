#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <ostream>
#include <ranges>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <tuple>
#include <type_traits>
#include <utility>
#include <vector>

namespace dlks_formal {

// ---------------------------------------------------------------------------
// Public configuration and statistics
// ---------------------------------------------------------------------------

struct join_options {
    // Upper bound for operator-owned row buffers, hash tables and
    // per-partition bookkeeping.  I/O stream internals are not included.
    std::size_t memory_budget_bytes = 64ull * 1024ull * 1024ull;

    // Initial number of hash partitions.  Rounded down to a power of two and
    // capped according to the memory budget.
    std::size_t partitions = 16;

    // Fan-out used when a partition still does not fit in memory.
    std::size_t partition_fanout = 16;

    // Recursive repartitioning is attempted at most this many levels deep.
    // When the limit is reached the skewed block-hash strategy is used.
    unsigned max_repartition_depth = 8;

    // Number of space-saving counters used for per-partition skew detection.
    // The effective value is reduced for very small memory budgets.
    std::size_t heavy_hitter_slots = 16;

    // Empty means: $TMPDIR when set, otherwise the current working directory.
    // A unique per-call subdirectory is always created below this directory.
    std::filesystem::path spill_directory{};

    // Useful for debugging; the unique spill directory is otherwise removed
    // when the join finishes.
    bool keep_spill_files = false;
};

struct join_stats {
    std::uint64_t build_rows = 0;       // rows seen, including NULL keys
    std::uint64_t probe_rows = 0;       // rows seen, including NULL keys
    std::uint64_t build_null_keys = 0;  // skipped because the key was NULL
    std::uint64_t probe_null_keys = 0;
    std::uint64_t output_rows = 0;      // emitted build/probe pairs

    std::uint64_t partition_count = 0;
    std::uint64_t partition_files = 0;
    std::uint64_t spill_bytes = 0;
    std::uint64_t repartition_rounds = 0;
    std::uint64_t max_repartition_depth = 0;

    // Partitions for which the run switched from recursive hash
    // repartitioning to the bounded-memory block-hash strategy.
    std::uint64_t skewed_partitions = 0;
    std::uint64_t skew_chunks = 0;

    // Accounted peak, in bytes, for row buffers, hash-table arrays and
    // per-partition skew summaries.  Never exceeds memory_budget_bytes.
    std::uint64_t peak_memory_bytes = 0;

    [[nodiscard]] bool spilled() const noexcept {
        return partition_files != 0;
    }

    [[nodiscard]] bool used_skew_strategy() const noexcept {
        return skewed_partitions != 0;
    }
};

// ---------------------------------------------------------------------------
// Spill codec
// ---------------------------------------------------------------------------

// Default record codec.  A row copied to disk must be a self-contained,
// trivially copyable value.  Rows containing std::string, owning pointers,
// etc. can specialize this template.
template <class Row>
struct spill_codec {
    static_assert(std::is_trivially_copyable_v<Row>,
                  "dlks_formal::spill_codec<Row> must be specialized for "
                  "non-trivially-copyable row types");

    void encode(const Row& row, std::vector<std::byte>& out) const {
        out.resize(sizeof(Row));
        std::memcpy(out.data(), &row, sizeof(Row));
    }

    [[nodiscard]] Row decode(std::span<const std::byte> bytes) const {
        if (bytes.size() != sizeof(Row)) {
            throw std::runtime_error("dlks_formal: corrupt spill record size");
        }
        std::array<std::byte, sizeof(Row)> storage{};
        std::memcpy(storage.data(), bytes.data(), sizeof(Row));
        return std::bit_cast<Row>(storage);
    }
};

namespace detail {

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

template <class>
inline constexpr bool always_false_v = false;

[[nodiscard]] inline std::uint64_t mix64(std::uint64_t x) noexcept {
    x += 0x9e3779b97f4a7c15ull;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
    return x ^ (x >> 31);
}

template <class T>
concept tuple_like = requires { typename std::tuple_size<std::remove_cvref_t<T>>::type; };

template <class T>
[[nodiscard]] std::uint64_t hash_value(const T& value) noexcept;

template <class T>
[[nodiscard]] std::uint64_t hash_tuple_element(const T& value) noexcept {
    return hash_value(value);
}

template <class T, std::size_t... I>
[[nodiscard]] std::uint64_t hash_tuple(const T& value,
                                       std::index_sequence<I...>) noexcept {
    std::uint64_t h = 0x9e3779b97f4a7c15ull;
    const auto combine = [&h](const auto& element) {
        h = mix64(h ^ (hash_tuple_element(element) +
                       0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2)));
    };
    (combine(std::get<I>(value)), ...);
    return h;
}

template <class T>
[[nodiscard]] std::uint64_t hash_value(const T& value) noexcept {
    using U = std::remove_cvref_t<T>;
    if constexpr (tuple_like<U>) {
        return hash_tuple(value, std::make_index_sequence<std::tuple_size_v<U>>{});
    } else if constexpr (requires { std::hash<U>{}(value); }) {
        return mix64(static_cast<std::uint64_t>(std::hash<U>{}(value)));
    } else {
        static_assert(always_false_v<U>,
                      "the join key needs std::hash support or must be tuple-like");
    }
}

template <class T>
struct optional_like : std::false_type {};

template <class T>
struct optional_like<std::optional<T>> : std::true_type {
    using value_type = T;
};

template <class KeyResult>
struct key_access {
    using result_type = std::remove_cvref_t<KeyResult>;
    static constexpr bool nullable = optional_like<result_type>::value;
    using key_type = std::conditional_t<
        nullable, typename optional_like<result_type>::value_type, result_type>;

    [[nodiscard]] static bool present(const KeyResult& result) noexcept {
        if constexpr (nullable) {
            return result.has_value();
        } else {
            return true;
        }
    }

    [[nodiscard]] static const key_type& get(const KeyResult& result) noexcept {
        if constexpr (nullable) {
            return *result;
        } else {
            return result;
        }
    }
};

[[nodiscard]] inline std::size_t next_power_of_two(std::size_t value) {
    std::size_t result = 1;
    while (result < value) {
        if (result > std::numeric_limits<std::size_t>::max() / 2) {
            throw std::overflow_error("dlks_formal: partition count overflow");
        }
        result <<= 1;
    }
    return result;
}

[[nodiscard]] inline std::size_t floor_power_of_two(std::size_t value) noexcept {
    return value == 0 ? 0 : std::bit_floor(value);
}

[[nodiscard]] inline unsigned log2_of_power_of_two(std::size_t value) noexcept {
    return static_cast<unsigned>(std::countr_zero(value));
}

[[nodiscard]] inline std::size_t partition_of(std::uint64_t hash,
                                              unsigned shift,
                                              std::size_t partition_count) noexcept {
    // partition_count is a power of two.  Once all 64 hash bits have been
    // consumed, continue with a shift-dependent remix so deep recursion still
    // separates unrelated keys.
    if (shift >= 64) {
        const std::uint64_t salted =
            mix64(hash ^ (0x9e3779b97f4a7c15ull * static_cast<std::uint64_t>(shift + 1)));
        return static_cast<std::size_t>(salted & (partition_count - 1));
    }
    return static_cast<std::size_t>((hash >> shift) & (partition_count - 1));
}

[[nodiscard]] inline std::size_t bucket_count_for(std::size_t rows) {
    if (rows > std::numeric_limits<std::size_t>::max() / 2) {
        throw std::overflow_error("dlks_formal: hash table row count overflow");
    }
    return next_power_of_two(std::max<std::size_t>(4, rows * 2));
}

[[nodiscard]] inline std::uint64_t estimated_table_bytes(std::size_t rows,
                                                         std::size_t row_size) {
    if (rows > 0xffffffffull - 1ull) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return static_cast<std::uint64_t>(rows) * row_size +
           static_cast<std::uint64_t>(rows) * sizeof(std::uint32_t) +
           static_cast<std::uint64_t>(bucket_count_for(rows)) *
               sizeof(std::uint32_t);
}

[[nodiscard]] inline std::size_t max_rows_for_budget(std::size_t budget,
                                                     std::size_t row_size) {
    if (budget == 0 || estimated_table_bytes(1, row_size) > budget) {
        return 0;
    }
    std::size_t lo = 1;
    std::size_t hi = std::min<std::size_t>(
        budget / (row_size + sizeof(std::uint32_t)) + 1, 0xffffffffull - 1ull);
    while (lo <= hi) {
        const std::size_t mid = lo + (hi - lo) / 2;
        if (estimated_table_bytes(mid, row_size) <= budget) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return hi;
}

// ---------------------------------------------------------------------------
// Framed record I/O
// ---------------------------------------------------------------------------

inline void write_record(std::ostream& out, std::span<const std::byte> bytes) {
    const std::uint64_t size = static_cast<std::uint64_t>(bytes.size());
    out.write(reinterpret_cast<const char*>(&size), sizeof(size));
    if (!bytes.empty()) {
        out.write(reinterpret_cast<const char*>(bytes.data()),
                  static_cast<std::streamsize>(bytes.size()));
    }
    if (!out) {
        throw std::runtime_error("dlks_formal: failed to write spill record");
    }
}

[[nodiscard]] inline bool read_record(std::istream& in,
                                      std::vector<std::byte>& buffer) {
    std::uint64_t size = 0;
    in.read(reinterpret_cast<char*>(&size), sizeof(size));
    if (in.gcount() == 0 && in.eof()) {
        return false;
    }
    if (!in || in.gcount() != static_cast<std::streamsize>(sizeof(size))) {
        throw std::runtime_error("dlks_formal: truncated spill record header");
    }
    if (size > (1ull << 40)) {
        throw std::runtime_error("dlks_formal: implausibly large spill record");
    }
    buffer.resize(static_cast<std::size_t>(size));
    if (size != 0) {
        in.read(reinterpret_cast<char*>(buffer.data()),
                static_cast<std::streamsize>(size));
        if (!in || in.gcount() != static_cast<std::streamsize>(size)) {
            throw std::runtime_error("dlks_formal: truncated spill record body");
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Bounded skew detection
// ---------------------------------------------------------------------------

// Space-saving heavy-hitter summary.  It stores only hashes, never rows, and
// therefore has a fixed, tiny footprint per partition.
class heavy_hitter {
public:
    struct counter {
        std::uint64_t hash = 0;
        std::uint64_t count = 0;
    };

    heavy_hitter() = default;

    explicit heavy_hitter(std::size_t slots) : counters_(slots) {}

    void add(std::uint64_t hash) noexcept {
        if (counters_.empty()) {
            return;
        }
        ++total_;
        for (counter& item : counters_) {
            if (item.count != 0 && item.hash == hash) {
                ++item.count;
                return;
            }
        }
        for (counter& item : counters_) {
            if (item.count == 0) {
                item.hash = hash;
                item.count = 1;
                return;
            }
        }
        counter* victim = &counters_.front();
        for (counter& item : counters_) {
            if (item.count < victim->count) {
                victim = &item;
            }
        }
        victim->hash = hash;
        victim->count += 1;
    }

    // Space-saving overestimates.  Subtract the worst-case additive error
    // (total/slots) to obtain a conservative lower bound for any key group.
    [[nodiscard]] std::uint64_t lower_bound_max() const noexcept {
        if (counters_.empty()) {
            return 0;
        }
        std::uint64_t maximum = 0;
        for (const counter& item : counters_) {
            maximum = std::max(maximum, item.count);
        }
        const std::uint64_t error = total_ / counters_.size();
        return maximum > error ? maximum - error : 0;
    }

private:
    std::vector<counter> counters_;
    std::uint64_t total_ = 0;
};

// ---------------------------------------------------------------------------
// Flat duplicate-preserving hash table
// ---------------------------------------------------------------------------

template <class BuildRow, class BuildKeyFn>
class flat_hash_table {
public:
    using build_key_result = std::invoke_result_t<BuildKeyFn, const BuildRow&>;
    using access = key_access<build_key_result>;
    using key_type = typename access::key_type;

    static constexpr std::uint32_t npos = 0xffffffffu;

    explicit flat_hash_table(BuildKeyFn& key_fn) : key_fn_(&key_fn) {}

    void reserve(std::size_t rows) {
        if (rows > npos - 1u) {
            throw std::runtime_error(
                "dlks_formal: in-memory partition exceeds 32-bit index range");
        }
        rows_.reserve(rows);
        next_.reserve(rows);
        heads_.assign(bucket_count_for(rows), npos);
        rows_.clear();
        next_.clear();
    }

    void clear() noexcept {
        rows_.clear();
        next_.clear();
        std::fill(heads_.begin(), heads_.end(), npos);
    }

    // Returns false only for a NULL key, which SQL join semantics never match.
    bool insert(BuildRow row) {
        if (rows_.size() >= npos) {
            throw std::runtime_error("dlks_formal: too many rows in one hash table");
        }
        auto key_result = std::invoke(*key_fn_, std::as_const(row));
        if (!access::present(key_result)) {
            return false;
        }
        const std::uint64_t hash = hash_value(access::get(key_result));
        const std::uint32_t index = static_cast<std::uint32_t>(rows_.size());
        rows_.push_back(std::move(row));
        next_.push_back(heads_[bucket(hash)]);
        heads_[bucket(hash)] = index;
        return true;
    }

    template <class ProbeRow, class Emit>
    void probe(const key_type& key, const ProbeRow& probe_row, Emit&& emit) const {
        const std::uint64_t hash = hash_value(key);
        for (std::uint32_t index = heads_[bucket(hash)]; index != npos;
             index = next_[index]) {
            auto row_key_result =
                std::invoke(*key_fn_, std::as_const(rows_[index]));
            if (access::present(row_key_result) &&
                access::get(row_key_result) == key) {
                std::invoke(std::forward<Emit>(emit), std::as_const(rows_[index]),
                            probe_row);
            }
        }
    }

    [[nodiscard]] std::size_t size() const noexcept { return rows_.size(); }

    [[nodiscard]] std::uint64_t bytes() const noexcept {
        return static_cast<std::uint64_t>(rows_.capacity()) * sizeof(BuildRow) +
               static_cast<std::uint64_t>(next_.capacity()) * sizeof(std::uint32_t) +
               static_cast<std::uint64_t>(heads_.capacity()) * sizeof(std::uint32_t);
    }

private:
    [[nodiscard]] std::size_t bucket(std::uint64_t hash) const noexcept {
        return static_cast<std::size_t>(hash & (heads_.size() - 1));
    }

    BuildKeyFn* key_fn_;
    std::vector<BuildRow> rows_;
    std::vector<std::uint32_t> next_;
    std::vector<std::uint32_t> heads_;
};

// ---------------------------------------------------------------------------
// Partition source and builder
// ---------------------------------------------------------------------------

template <class Row>
struct partition_source {
    std::string path;
    std::uint64_t row_count = 0;
    heavy_hitter skew_summary;
};

template <class Row>
class partition_builder {
public:
    partition_builder(std::size_t fanout,
                      unsigned shift,
                      std::size_t buffer_budget,
                      std::filesystem::path directory,
                      std::string prefix,
                      std::size_t heavy_hitter_slots,
                      spill_codec<Row> codec,
                      join_stats& stats,
                      std::uint64_t fixed_overhead_bytes)
        : fanout_(fanout),
          shift_(shift),
          buffer_budget_(buffer_budget),
          directory_(std::move(directory)),
          prefix_(std::move(prefix)),
          codec_(std::move(codec)),
          stats_(stats),
          fixed_overhead_bytes_(fixed_overhead_bytes),
          buffers_(fanout),
          sources_(fanout) {
        for (partition_source<Row>& source : sources_) {
            source.skew_summary = heavy_hitter(heavy_hitter_slots);
        }
        update_peak();
    }

    void add(Row row, std::uint64_t hash) {
        const std::size_t partition = partition_of(hash, shift_, fanout_);
        std::vector<Row>& buffer = buffers_[partition];

        if (buffer.size() == buffer.capacity()) {
            std::size_t old_capacity = buffer.capacity();
            const std::size_t max_capacity =
                std::max<std::size_t>(1, buffer_budget_ / sizeof(Row));
            std::size_t new_capacity =
                std::min(std::max<std::size_t>(16, old_capacity * 2), max_capacity);

            // Reaching max_capacity means any further growth is unaffordable.
            // Flush this partition before the vector reallocates behind our
            // accounting.
            if (new_capacity <= old_capacity) {
                flush(partition);
                old_capacity = 0;
                new_capacity =
                    std::min(std::max<std::size_t>(16, old_capacity * 2),
                             max_capacity);
            }

            std::size_t extra = (new_capacity - old_capacity) * sizeof(Row);
            if (buffer_bytes_ + extra > buffer_budget_) {
                flush_all();
                old_capacity = 0;
                new_capacity =
                    std::min(std::max<std::size_t>(16, old_capacity * 2),
                             max_capacity);
                extra = new_capacity * sizeof(Row);
            }
            if (extra > buffer_budget_ && buffer_bytes_ == 0) {
                new_capacity = 1;
                extra = sizeof(Row);
            }

            buffer.reserve(new_capacity);
            buffer_bytes_ += extra;
        }

        buffer.push_back(std::move(row));
        ++sources_[partition].row_count;
        sources_[partition].skew_summary.add(hash);
        update_peak();
    }

    [[nodiscard]] std::vector<partition_source<Row>> finish() {
        flush_all();
        return std::move(sources_);
    }

private:
    void flush(std::size_t partition) {
        std::vector<Row>& buffer = buffers_[partition];
        if (buffer.empty()) {
            return;
        }

        if (sources_[partition].path.empty()) {
            sources_[partition].path =
                (directory_ /
                 (prefix_ + "-" + std::to_string(partition) + ".bin"))
                    .string();
            ++stats_.partition_files;
        }

        std::ofstream out(sources_[partition].path,
                          std::ios::binary | std::ios::app);
        if (!out) {
            throw std::runtime_error(
                "dlks_formal: cannot open spill file for append");
        }
        for (const Row& row : buffer) {
            codec_.encode(row, scratch_);
            write_record(out, scratch_);
            stats_.spill_bytes +=
                static_cast<std::uint64_t>(scratch_.size() + sizeof(std::uint64_t));
        }
        out.close();
        if (!out) {
            throw std::runtime_error(
                "dlks_formal: failed to close spill file");
        }

        const std::size_t capacity = buffer.capacity();
        std::vector<Row>().swap(buffer);
        buffer_bytes_ -= capacity * sizeof(Row);
    }

    void flush_all() {
        for (std::size_t partition = 0; partition < fanout_; ++partition) {
            flush(partition);
        }
    }

    void update_peak() {
        const std::uint64_t current =
            static_cast<std::uint64_t>(buffer_bytes_) + fixed_overhead_bytes_;
        stats_.peak_memory_bytes = std::max(stats_.peak_memory_bytes, current);
    }

    std::size_t fanout_;
    unsigned shift_;
    std::size_t buffer_budget_;
    std::filesystem::path directory_;
    std::string prefix_;
    spill_codec<Row> codec_;
    join_stats& stats_;
    std::uint64_t fixed_overhead_bytes_;
    std::vector<std::vector<Row>> buffers_;
    std::vector<partition_source<Row>> sources_;
    std::vector<std::byte> scratch_;
    std::size_t buffer_bytes_ = 0;
};

template <class Row>
class source_reader {
public:
    source_reader(const std::string& path, spill_codec<Row>& codec)
        : in_(path, std::ios::binary), codec_(&codec) {
        if (!in_) {
            throw std::runtime_error(
                "dlks_formal: cannot open spill file for reading");
        }
    }

    [[nodiscard]] std::optional<Row> next() {
        if (!read_record(in_, buffer_)) {
            return std::nullopt;
        }
        return codec_->decode(buffer_);
    }

private:
    std::ifstream in_;
    spill_codec<Row>* codec_;
    std::vector<std::byte> buffer_;
};

// ---------------------------------------------------------------------------
// Temporary spill directory
// ---------------------------------------------------------------------------

class spill_area {
public:
    spill_area(const join_options& options, std::filesystem::path root)
        : root_(std::move(root)), keep_(options.keep_spill_files) {
        std::filesystem::create_directories(root_);
    }

    spill_area(const spill_area&) = delete;
    spill_area& operator=(const spill_area&) = delete;

    ~spill_area() {
        if (!keep_) {
            std::error_code ignored;
            std::filesystem::remove_all(root_, ignored);
        }
    }

    [[nodiscard]] const std::filesystem::path& path() const noexcept {
        return root_;
    }

    [[nodiscard]] std::string next_prefix(std::string_view kind) {
        return std::string(kind) + "-" + std::to_string(++sequence_);
    }

private:
    std::filesystem::path root_;
    bool keep_;
    std::uint64_t sequence_ = 0;
};

[[nodiscard]] inline std::filesystem::path make_spill_root(
    const join_options& options) {
    std::filesystem::path base;
    if (!options.spill_directory.empty()) {
        base = options.spill_directory;
    } else {
        const char* tmp = std::getenv("TMPDIR");
        base = (tmp != nullptr && *tmp != '\0')
                   ? std::filesystem::path(tmp)
                   : std::filesystem::current_path();
    }

    static std::atomic<std::uint64_t> sequence{0};
    const auto stamp =
        std::chrono::steady_clock::now().time_since_epoch().count();
    const std::uint64_t id = sequence.fetch_add(1, std::memory_order_relaxed);
    return base /
           ("dlks-hash-join-" + std::to_string(stamp) + "-" + std::to_string(id));
}

// ---------------------------------------------------------------------------
// Join engine
// ---------------------------------------------------------------------------

template <class BuildRow, class ProbeRow, class BuildKeyFn, class ProbeKeyFn,
          class EmitFn>
class join_engine {
public:
    using build_key_access =
        key_access<std::invoke_result_t<BuildKeyFn, const BuildRow&>>;
    using probe_key_access =
        key_access<std::invoke_result_t<ProbeKeyFn, const ProbeRow&>>;
    using build_key_type = typename build_key_access::key_type;
    using probe_key_type = typename probe_key_access::key_type;

    static_assert(std::same_as<build_key_type, probe_key_type>,
                  "build and probe key extractors must produce the same key type");

    join_engine(const join_options& options,
                BuildKeyFn build_key,
                ProbeKeyFn probe_key,
                EmitFn emit)
        : options_(options),
          build_key_(std::move(build_key)),
          probe_key_(std::move(probe_key)),
          emit_(std::move(emit)) {
        validate_and_size();
    }

    template <std::ranges::forward_range BuildRange,
              std::ranges::input_range ProbeRange>
    join_stats run(BuildRange&& build, ProbeRange&& probe) {
        const std::uint64_t build_count =
            static_cast<std::uint64_t>(std::ranges::distance(build));
        if (build_count <= max_table_rows_) {
            return run_in_memory(build, probe, build_count);
        }
        return run_partitioned(build, probe);
    }

private:
    using table_type = flat_hash_table<BuildRow, BuildKeyFn>;

    void validate_and_size() {
        const std::size_t row_floor =
            std::max(sizeof(BuildRow), sizeof(ProbeRow)) +
            sizeof(std::uint32_t) * 8 + 32;
        if (options_.memory_budget_bytes < row_floor + 256) {
            throw std::invalid_argument(
                "dlks_formal: memory_budget_bytes is too small for one row");
        }
        if (options_.max_repartition_depth > 32) {
            throw std::invalid_argument(
                "dlks_formal: max_repartition_depth must be <= 32");
        }

        const std::size_t budget = options_.memory_budget_bytes;
        io_reserve_bytes_ =
            std::min(budget / 8, std::max<std::size_t>(512, row_floor));

        // Keep the initial fan-out small enough that even tiny budgets can
        // retain a useful in-memory table.
        const std::size_t partition_cap =
            std::max<std::size_t>(2, budget / 1024);
        partitions_ = std::max<std::size_t>(
            2, floor_power_of_two(std::min(options_.partitions, partition_cap)));
        partitions_ = std::min<std::size_t>(partitions_, 4096);
        fanout_ = std::max<std::size_t>(
            2, floor_power_of_two(std::min(options_.partition_fanout,
                                           partition_cap)));
        fanout_ = std::min<std::size_t>(fanout_, 1024);

        partition_bits_ = log2_of_power_of_two(partitions_);
        fanout_bits_ = log2_of_power_of_two(fanout_);

        // Reserve room for both parent and child build/probe partition
        // metadata.  Reduce the summary width first, then compute the exact
        // reservation.
        const std::size_t max_sources = 2 * partitions_ + 2 * fanout_;
        const std::size_t summary_sources = partitions_ + fanout_;
        std::size_t slots =
            std::clamp<std::size_t>(options_.heavy_hitter_slots, 2, 64);
        const std::size_t metadata_target =
            std::max<std::size_t>(256, budget / 8);
        const std::size_t source_object_bytes =
            std::max(sizeof(partition_source<BuildRow>),
                     sizeof(partition_source<ProbeRow>));
        while (slots > 2 &&
               max_sources * source_object_bytes +
                       summary_sources * slots *
                           sizeof(heavy_hitter::counter) >
                   metadata_target) {
            slots /= 2;
        }
        heavy_hitter_slots_ = slots;
        const std::uint64_t metadata_bytes =
            static_cast<std::uint64_t>(max_sources) * source_object_bytes +
            static_cast<std::uint64_t>(summary_sources) * slots *
                sizeof(heavy_hitter::counter);

        const std::size_t largest_row =
            std::max(sizeof(BuildRow), sizeof(ProbeRow));
        fixed_overhead_bytes_ =
            io_reserve_bytes_ + metadata_bytes + largest_row;
        if (budget <= fixed_overhead_bytes_ + largest_row + 64) {
            throw std::invalid_argument(
                "dlks_formal: memory_budget_bytes cannot hold table metadata");
        }
        table_budget_bytes_ =
            budget - static_cast<std::size_t>(fixed_overhead_bytes_);
        buffer_budget_bytes_ = table_budget_bytes_;

        max_table_rows_ =
            max_rows_for_budget(table_budget_bytes_, sizeof(BuildRow));
        if (max_table_rows_ == 0) {
            throw std::invalid_argument(
                "dlks_formal: memory_budget_bytes cannot hold one hash-table row");
        }
    }

    void ensure_spill_area() {
        if (!spill_area_) {
            spill_area_ =
                std::make_unique<spill_area>(options_, make_spill_root(options_));
        }
    }

    void emit_pair(const BuildRow& build_row, const ProbeRow& probe_row) {
        ++stats_.output_rows;
        std::invoke(emit_, build_row, probe_row);
    }

    template <std::ranges::forward_range BuildRange,
              std::ranges::input_range ProbeRange>
    join_stats run_in_memory(BuildRange& build, ProbeRange& probe,
                             std::uint64_t build_count) {
        table_type table(build_key_);
        table.reserve(static_cast<std::size_t>(build_count));

        for (const auto& row : build) {
            ++stats_.build_rows;
            auto key_result = std::invoke(build_key_, row);
            if (!build_key_access::present(key_result)) {
                ++stats_.build_null_keys;
                continue;
            }
            table.insert(BuildRow(row));
        }
        stats_.peak_memory_bytes =
            std::max(stats_.peak_memory_bytes,
                     table.bytes() + fixed_overhead_bytes_);

        auto emit_wrapper = [this](const BuildRow& build_row,
                                   const ProbeRow& probe_row) {
            emit_pair(build_row, probe_row);
        };

        for (const auto& row : probe) {
            ++stats_.probe_rows;
            auto key_result = std::invoke(probe_key_, row);
            if (!probe_key_access::present(key_result)) {
                ++stats_.probe_null_keys;
                continue;
            }
            table.probe(probe_key_access::get(key_result), row, emit_wrapper);
        }

        stats_.partition_count = 1;
        return std::move(stats_);
    }

    template <std::ranges::forward_range BuildRange,
              std::ranges::input_range ProbeRange>
    join_stats run_partitioned(BuildRange& build, ProbeRange& probe) {
        ensure_spill_area();

        partition_builder<BuildRow> build_builder(
            partitions_, 0, buffer_budget_bytes_, spill_area_->path(),
            spill_area_->next_prefix("build"), heavy_hitter_slots_,
            build_codec_, stats_, fixed_overhead_bytes_);

        for (const auto& row : build) {
            ++stats_.build_rows;
            auto key_result = std::invoke(build_key_, row);
            if (!build_key_access::present(key_result)) {
                ++stats_.build_null_keys;
                continue;
            }
            const std::uint64_t hash =
                hash_value(build_key_access::get(key_result));
            build_builder.add(BuildRow(row), hash);
        }
        auto build_partitions = build_builder.finish();
        stats_.partition_count = partitions_;

        bool have_build_rows = false;
        for (const auto& source : build_partitions) {
            have_build_rows |= source.row_count != 0;
        }
        if (!have_build_rows) {
            for (const auto& row : probe) {
                ++stats_.probe_rows;
                auto key_result = std::invoke(probe_key_, row);
                if (!probe_key_access::present(key_result)) {
                    ++stats_.probe_null_keys;
                }
            }
            return std::move(stats_);
        }

        partition_builder<ProbeRow> probe_builder(
            partitions_, 0, buffer_budget_bytes_, spill_area_->path(),
            spill_area_->next_prefix("probe"), 0,
            probe_codec_, stats_, fixed_overhead_bytes_);

        for (const auto& row : probe) {
            ++stats_.probe_rows;
            auto key_result = std::invoke(probe_key_, row);
            if (!probe_key_access::present(key_result)) {
                ++stats_.probe_null_keys;
                continue;
            }
            const std::uint64_t hash =
                hash_value(probe_key_access::get(key_result));
            probe_builder.add(ProbeRow(row), hash);
        }
        auto probe_partitions = probe_builder.finish();

        for (std::size_t partition = 0; partition < partitions_; ++partition) {
            if (build_partitions[partition].row_count != 0 &&
                probe_partitions[partition].row_count != 0) {
                process_partition(build_partitions[partition],
                                  probe_partitions[partition], 0,
                                  partition_bits_);
            }
        }
        return std::move(stats_);
    }

    void process_partition(const partition_source<BuildRow>& build_source,
                           const partition_source<ProbeRow>& probe_source,
                           unsigned depth,
                           unsigned shift) {
        if (build_source.row_count <= max_table_rows_) {
            join_sources(build_source, probe_source);
            return;
        }

        // A single key group larger than the table capacity can never be
        // split by hash partitioning.  Switch to the bounded block-hash
        // strategy immediately instead of wasting more recursive passes.
        const bool heavy =
            build_source.skew_summary.lower_bound_max() > max_table_rows_;
        if (heavy || depth >= options_.max_repartition_depth) {
            block_join(build_source, probe_source);
            return;
        }

        repartition(build_source, probe_source, depth, shift);
    }

    void join_sources(const partition_source<BuildRow>& build_source,
                      const partition_source<ProbeRow>& probe_source) {
        table_type table(build_key_);
        table.reserve(static_cast<std::size_t>(build_source.row_count));

        source_reader<BuildRow> build_reader(build_source.path, build_codec_);
        while (auto row = build_reader.next()) {
            table.insert(std::move(*row));
        }

        stats_.peak_memory_bytes =
            std::max(stats_.peak_memory_bytes,
                     table.bytes() + fixed_overhead_bytes_);

        auto emit_wrapper = [this](const BuildRow& build_row,
                                   const ProbeRow& probe_row) {
            emit_pair(build_row, probe_row);
        };

        source_reader<ProbeRow> probe_reader(probe_source.path, probe_codec_);
        while (auto row = probe_reader.next()) {
            auto key_result = std::invoke(probe_key_, *row);
            if (probe_key_access::present(key_result)) {
                table.probe(probe_key_access::get(key_result), *row,
                            emit_wrapper);
            }
        }
    }

    void block_join(const partition_source<BuildRow>& build_source,
                    const partition_source<ProbeRow>& probe_source) {
        ++stats_.skewed_partitions;

        table_type table(build_key_);
        table.reserve(max_table_rows_);
        source_reader<BuildRow> build_reader(build_source.path, build_codec_);
        auto emit_wrapper = [this](const BuildRow& build_row,
                                   const ProbeRow& probe_row) {
            emit_pair(build_row, probe_row);
        };

        bool build_exhausted = false;
        while (!build_exhausted) {
            table.clear();
            std::size_t chunk_rows = 0;
            while (chunk_rows < max_table_rows_) {
                auto row = build_reader.next();
                if (!row) {
                    build_exhausted = true;
                    break;
                }
                if (table.insert(std::move(*row))) {
                    ++chunk_rows;
                }
            }
            if (chunk_rows == 0) {
                break;
            }
            ++stats_.skew_chunks;

            source_reader<ProbeRow> probe_reader(probe_source.path,
                                                 probe_codec_);
            stats_.peak_memory_bytes =
                std::max(stats_.peak_memory_bytes,
                         table.bytes() + fixed_overhead_bytes_);
            while (auto row = probe_reader.next()) {
                auto key_result = std::invoke(probe_key_, *row);
                if (probe_key_access::present(key_result)) {
                    table.probe(probe_key_access::get(key_result), *row,
                                emit_wrapper);
                }
            }
        }
    }

    void repartition(const partition_source<BuildRow>& build_source,
                     const partition_source<ProbeRow>& probe_source,
                     unsigned depth,
                     unsigned shift) {
        const std::string build_prefix = spill_area_->next_prefix("build");
        partition_builder<BuildRow> build_builder(
            fanout_, shift, buffer_budget_bytes_, spill_area_->path(),
            build_prefix, heavy_hitter_slots_, build_codec_, stats_,
            fixed_overhead_bytes_);

        {
            source_reader<BuildRow> build_reader(build_source.path,
                                                 build_codec_);
            while (auto row = build_reader.next()) {
                auto key_result = std::invoke(build_key_, *row);
                if (!build_key_access::present(key_result)) {
                    continue;
                }
                const std::uint64_t hash =
                    hash_value(build_key_access::get(key_result));
                build_builder.add(std::move(*row), hash);
            }
        }
        auto child_build = build_builder.finish();

        const std::string probe_prefix = spill_area_->next_prefix("probe");
        partition_builder<ProbeRow> probe_builder(
            fanout_, shift, buffer_budget_bytes_, spill_area_->path(),
            probe_prefix, 0, probe_codec_, stats_,
            fixed_overhead_bytes_);

        {
            source_reader<ProbeRow> probe_reader(probe_source.path,
                                                 probe_codec_);
            while (auto row = probe_reader.next()) {
                auto key_result = std::invoke(probe_key_, *row);
                if (!probe_key_access::present(key_result)) {
                    continue;
                }
                const std::uint64_t hash =
                    hash_value(probe_key_access::get(key_result));
                probe_builder.add(std::move(*row), hash);
            }
        }
        auto child_probe = probe_builder.finish();

        ++stats_.repartition_rounds;
        stats_.max_repartition_depth =
            std::max<std::uint64_t>(stats_.max_repartition_depth, depth + 1);

        std::error_code ignored;
        std::filesystem::remove(build_source.path, ignored);
        std::filesystem::remove(probe_source.path, ignored);

        const unsigned child_shift = shift + fanout_bits_;
        for (std::size_t child = 0; child < fanout_; ++child) {
            if (child_build[child].row_count != 0 &&
                child_probe[child].row_count != 0) {
                process_partition(child_build[child], child_probe[child],
                                  depth + 1, child_shift);
            }
        }
    }

    join_options options_;
    BuildKeyFn build_key_;
    ProbeKeyFn probe_key_;
    EmitFn emit_;

    spill_codec<BuildRow> build_codec_{};
    spill_codec<ProbeRow> probe_codec_{};

    std::size_t partitions_ = 2;
    std::size_t fanout_ = 2;
    unsigned partition_bits_ = 1;
    unsigned fanout_bits_ = 1;
    std::size_t heavy_hitter_slots_ = 2;
    std::uint64_t fixed_overhead_bytes_ = 0;
    std::size_t io_reserve_bytes_ = 0;
    std::size_t table_budget_bytes_ = 0;
    std::size_t buffer_budget_bytes_ = 0;
    std::size_t max_table_rows_ = 0;

    std::unique_ptr<spill_area> spill_area_;
    join_stats stats_;
};

}  // namespace detail

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// JOIN with distinct build/probe key extractors.  A key extractor may return
// std::optional<T> to model SQL NULL; std::nullopt never matches anything.
// Every matching build/probe pair is emitted exactly once (multiset semantics,
// including the full Cartesian product for duplicate keys).
template <std::ranges::forward_range BuildRange,
          std::ranges::input_range ProbeRange,
          class BuildKeyFn,
          class ProbeKeyFn,
          class EmitFn>
join_stats hash_join(BuildRange&& build,
                     ProbeRange&& probe,
                     BuildKeyFn build_key,
                     ProbeKeyFn probe_key,
                     EmitFn emit,
                     const join_options& options = {}) {
    using build_row = std::ranges::range_value_t<BuildRange>;
    using probe_row = std::ranges::range_value_t<ProbeRange>;
    detail::join_engine<build_row, probe_row, BuildKeyFn, ProbeKeyFn, EmitFn>
        engine(options, std::move(build_key), std::move(probe_key),
               std::move(emit));
    return engine.run(build, probe);
}

// Convenience overload when both sides use exactly the same key extractor.
template <std::ranges::forward_range BuildRange,
          std::ranges::input_range ProbeRange,
          class KeyFn,
          class EmitFn>
join_stats hash_join(BuildRange&& build,
                     ProbeRange&& probe,
                     KeyFn key,
                     EmitFn emit,
                     const join_options& options = {}) {
    return hash_join(std::forward<BuildRange>(build),
                     std::forward<ProbeRange>(probe), key, key,
                     std::move(emit), options);
}

}  // namespace dlks_formal
