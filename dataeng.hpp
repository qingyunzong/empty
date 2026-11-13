#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace dataeng {

// OTLP timestamps are Unix epoch nanoseconds. Zero is accepted as the
// unspecified timestamp and is treated as an ordinary generation marker.
using Timestamp = std::uint64_t;

// A self-describing attribute value. Keeping the value type in the key is
// important: the integer 1, the double 1.0 and the string "1" are distinct
// metric series.
class AttributeValue {
 public:
  using Array = std::vector<AttributeValue>;
  using KeyValueList = std::map<std::string, AttributeValue>;
  using Bytes = std::vector<std::uint8_t>;
  using Storage = std::variant<std::monostate, bool, std::int64_t, double,
                               std::string, Bytes, Array, KeyValueList>;

  AttributeValue() = default;

  AttributeValue(bool value) : value_(value) {}
  AttributeValue(std::string value) : value_(std::move(value)) {}
  AttributeValue(std::string_view value) : value_(std::string(value)) {}
  AttributeValue(const char* value) : value_(std::string(value)) {}
  AttributeValue(Bytes value) : value_(std::move(value)) {}
  AttributeValue(Array value) : value_(std::move(value)) {}
  AttributeValue(KeyValueList value) : value_(std::move(value)) {}

  template <class T>
    requires(std::is_integral_v<T> && !std::is_same_v<T, bool>)
  AttributeValue(T value) : value_(static_cast<std::int64_t>(value)) {}

  template <class T>
    requires(std::is_floating_point_v<T>)
  AttributeValue(T value) : value_(static_cast<double>(value)) {}

  [[nodiscard]] const Storage& storage() const noexcept { return value_; }
  [[nodiscard]] Storage& storage() noexcept { return value_; }

  friend bool operator==(const AttributeValue&, const AttributeValue&) = default;

 private:
  Storage value_;
};

using Attributes = std::map<std::string, AttributeValue>;

struct Resource {
  Attributes attributes;
};

struct InstrumentationScope {
  std::string name;
  std::string version;
  Attributes attributes;
};

using Scope = InstrumentationScope;

enum class MetricType {
  Sum,
  Gauge,
  Histogram,
  ExponentialHistogram,
  Summary,
};

using MetricKind = MetricType;

// `is_monotonic` matters for Sum only. Monotonic sums are reset when a delta
// would make the published cumulative value decrease.
struct MetricDescriptor {
  Resource resource;
  InstrumentationScope scope;
  std::string name;
  std::string unit;
  MetricType type = MetricType::Sum;
  bool is_monotonic = true;
};

using Metric = MetricDescriptor;

struct NumberDataPoint {
  Attributes attributes;
  Timestamp start_time = 0;
  Timestamp time = 0;
  double value = 0.0;
};

struct HistogramDataPoint {
  Attributes attributes;
  Timestamp start_time = 0;
  Timestamp time = 0;
  std::uint64_t count = 0;
  double sum = 0.0;
  // Number of explicit bounds is bucket_counts.size() - 1. Both vectors may
  // be empty when the caller only tracks count and sum.
  std::vector<double> explicit_bounds;
  std::vector<std::uint64_t> bucket_counts;
};

// One contiguous run of exponential-histogram buckets. Bucket i covers the
// range (base^i, base^(i+1)] where base = 2^(2^-scale) for positive values.
struct ExponentialBuckets {
  std::int32_t offset = 0;
  std::vector<std::uint64_t> bucket_counts;
};

struct ExponentialHistogramDataPoint {
  Attributes attributes;
  Timestamp start_time = 0;
  Timestamp time = 0;
  std::uint64_t count = 0;
  double sum = 0.0;
  std::int32_t scale = 0;
  std::uint64_t zero_count = 0;
  ExponentialBuckets positive;
  ExponentialBuckets negative;
};

struct QuantileValue {
  double quantile = 0.0;
  double value = 0.0;
};

struct SummaryDataPoint {
  Attributes attributes;
  Timestamp start_time = 0;
  Timestamp time = 0;
  std::uint64_t count = 0;
  double sum = 0.0;
  std::vector<QuantileValue> quantile_values;
};

using DataPoint =
    std::variant<NumberDataPoint, HistogramDataPoint,
                 ExponentialHistogramDataPoint, SummaryDataPoint>;

struct Options {
  // Deltas older than (newest observed time - reorder_window_ns) are published
  // in observation-time order. Zero means "publish immediately": only deltas
  // that have not already been published can still be reordered.
  Timestamp reorder_window_ns = 0;

  // A safety bound for a single series. If exceeded, the oldest buffered
  // deltas are published early; subsequent deltas older than that publication
  // watermark are dropped. Zero disables the bound.
  std::size_t max_pending_points_per_series = 10000;
};

// Builds the canonical, allocation-stable key used to isolate series state.
// Resource, scope, metric descriptor and every point attribute (including
// the attribute value's type) participate in the key.
[[nodiscard]] std::string make_series_key(const MetricDescriptor& metric,
                                          const Attributes& attributes);

// Streaming delta-to-cumulative state machine.
//
// Each series keeps the start time of its cumulative generation. Normal OTLP
// delta intervals advance their start time to the previous observation time
// without starting a new generation. A start-time discontinuity, clock
// rollback, or a retired generation reappearing resets the accumulator;
// new-generation points are emitted with the new start time.
//
// One instance may hold many series, but is not internally synchronized. Use
// one instance per ingestion thread, or serialize access externally.
class DeltaToCumulative {
 public:
  DeltaToCumulative();
  explicit DeltaToCumulative(Options options);
  explicit DeltaToCumulative(Timestamp reorder_window_ns);
  ~DeltaToCumulative();

  DeltaToCumulative(DeltaToCumulative&&) noexcept;
  DeltaToCumulative& operator=(DeltaToCumulative&&) noexcept;

  DeltaToCumulative(const DeltaToCumulative&) = delete;
  DeltaToCumulative& operator=(const DeltaToCumulative&) = delete;

  // Adds one delta. The returned points are those that became safely
  // publishable as a result of this call; it may contain points from this
  // series that were previously buffered.
  [[nodiscard]] std::vector<DataPoint> ingest(const MetricDescriptor& metric,
                                             const DataPoint& point);

  [[nodiscard]] std::vector<DataPoint> ingest(
      const MetricDescriptor& metric, std::span<const DataPoint> points);

  [[nodiscard]] std::vector<DataPoint> ingest(
      const MetricDescriptor& metric, const std::vector<DataPoint>& points);

  // Emits every buffered delta in timestamp order. After this call, a delta
  // with an already emitted timestamp can no longer change the result.
  [[nodiscard]] std::vector<DataPoint> flush();

  // Clears all generations, accumulators and buffered points.
  void reset();

  // Clears one series (identified by the metric plus point attributes).
  // Returns true if the series existed.
  bool reset_series(const MetricDescriptor& metric,
                    const Attributes& attributes);

  [[nodiscard]] const Options& options() const noexcept;
  [[nodiscard]] std::size_t series_count() const noexcept;
  [[nodiscard]] std::size_t pending_points() const noexcept;

  // Short aliases for integrations that use different naming.
  [[nodiscard]] std::vector<DataPoint> add(const MetricDescriptor& metric,
                                           const DataPoint& point) {
    return ingest(metric, point);
  }
  [[nodiscard]] std::vector<DataPoint> process(
      const MetricDescriptor& metric, const DataPoint& point) {
    return ingest(metric, point);
  }
  [[nodiscard]] std::vector<DataPoint> consume(const MetricDescriptor& metric,
                                               const DataPoint& point) {
    return ingest(metric, point);
  }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

using DeltaToCumulativeState = DeltaToCumulative;
using DeltaToCumulativeConverter = DeltaToCumulative;

// Convenience batch API for a single metric descriptor. Points are ingested in
// the supplied order, then all remaining buffered points are flushed.
[[nodiscard]] std::vector<DataPoint> convert(
    const MetricDescriptor& metric, std::span<const DataPoint> points,
    Options options = {});

[[nodiscard]] std::vector<DataPoint> convert(
    const MetricDescriptor& metric, const std::vector<DataPoint>& points,
    Options options = {});

}  // namespace dataeng
