#include "dataeng.hpp"

#include <algorithm>
#include <bit>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <utility>

namespace dataeng {
namespace {

void append_size(std::string& out, std::size_t size) {
  out += std::to_string(size);
  out += ':';
}

void append_field(std::string& out, std::string_view field) {
  append_size(out, field.size());
  out.append(field);
}

void append_hex64(std::string& out, std::uint64_t value) {
  static constexpr char kHex[] = "0123456789abcdef";
  char buffer[16];
  for (int index = 15; index >= 0; --index) {
    buffer[index] = kHex[value & 0x0fU];
    value >>= 4U;
  }
  out.append(buffer, sizeof(buffer));
}

void encode_attributes(const Attributes& attributes, std::string& out);

void encode_value(const AttributeValue& attribute, std::string& out) {
  std::visit(
      [&](const auto& value) {
        using T = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          out += 'n';
        } else if constexpr (std::is_same_v<T, bool>) {
          out += value ? 't' : 'f';
        } else if constexpr (std::is_same_v<T, std::int64_t>) {
          out += 'i';
          const std::string encoded = std::to_string(value);
          append_field(out, encoded);
        } else if constexpr (std::is_same_v<T, double>) {
          out += 'd';
          append_hex64(out, std::bit_cast<std::uint64_t>(value));
        } else if constexpr (std::is_same_v<T, std::string>) {
          out += 's';
          append_field(out, value);
        } else if constexpr (std::is_same_v<T, AttributeValue::Bytes>) {
          out += 'y';
          append_size(out, value.size());
          if (!value.empty()) {
            out.append(reinterpret_cast<const char*>(value.data()),
                       value.size());
          }
        } else if constexpr (std::is_same_v<T, AttributeValue::Array>) {
          out += 'a';
          append_size(out, value.size());
          for (const auto& element : value) {
            encode_value(element, out);
          }
        } else if constexpr (std::is_same_v<T, AttributeValue::KeyValueList>) {
          encode_attributes(value, out);
        }
      },
      attribute.storage());
}

void encode_attributes(const Attributes& attributes, std::string& out) {
  out += 'A';
  append_size(out, attributes.size());
  for (const auto& [key, value] : attributes) {
    append_field(out, key);
    encode_value(value, out);
  }
}

Timestamp point_start_time(const DataPoint& point) {
  return std::visit([](const auto& value) { return value.start_time; }, point);
}

Timestamp point_time(const DataPoint& point) {
  return std::visit([](const auto& value) { return value.time; }, point);
}

const Attributes& point_attributes(const DataPoint& point) {
  return std::visit(
      [](const auto& value) -> const Attributes& { return value.attributes; },
      point);
}

void set_start_time(DataPoint& point, Timestamp start_time) {
  std::visit([&](auto& value) { value.start_time = start_time; }, point);
}

void validate_exponential_buckets(const ExponentialBuckets& buckets) {
  if (buckets.bucket_counts.empty()) {
    return;
  }
  const std::int64_t last_index =
      static_cast<std::int64_t>(buckets.offset) +
      static_cast<std::int64_t>(buckets.bucket_counts.size()) - 1;
  if (last_index > std::numeric_limits<std::int32_t>::max()) {
    throw std::invalid_argument(
        "exponential histogram bucket offset overflows int32");
  }
}

void validate_point(const MetricDescriptor& metric, const DataPoint& point) {
  switch (metric.type) {
    case MetricType::Sum:
    case MetricType::Gauge:
      if (!std::holds_alternative<NumberDataPoint>(point)) {
        throw std::invalid_argument(
            "sum and gauge metrics require NumberDataPoint");
      }
      return;
    case MetricType::Histogram:
      if (const auto* histogram = std::get_if<HistogramDataPoint>(&point)) {
        const bool has_no_buckets =
            histogram->bucket_counts.empty() &&
            histogram->explicit_bounds.empty();
        if (!has_no_buckets &&
            histogram->bucket_counts.size() !=
                histogram->explicit_bounds.size() + 1) {
          throw std::invalid_argument(
              "histogram bucket_counts must have bounds.size() + 1 entries");
        }
        return;
      }
      throw std::invalid_argument(
          "histogram metric requires HistogramDataPoint");
    case MetricType::ExponentialHistogram:
      if (const auto* histogram =
              std::get_if<ExponentialHistogramDataPoint>(&point)) {
        validate_exponential_buckets(histogram->positive);
        validate_exponential_buckets(histogram->negative);
        return;
      }
      throw std::invalid_argument(
          "exponential histogram metric requires "
          "ExponentialHistogramDataPoint");
    case MetricType::Summary:
      if (!std::holds_alternative<SummaryDataPoint>(point)) {
        throw std::invalid_argument(
            "summary metric requires SummaryDataPoint");
      }
      return;
  }
  throw std::invalid_argument("unknown metric type");
}

std::uint64_t saturating_add(std::uint64_t left, std::uint64_t right) {
  if (std::numeric_limits<std::uint64_t>::max() - left < right) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return left + right;
}

bool addition_overflows(std::uint64_t left, std::uint64_t right) {
  return std::numeric_limits<std::uint64_t>::max() - left < right;
}

using BucketMap = std::map<std::int32_t, std::uint64_t>;

BucketMap to_bucket_map(const ExponentialBuckets& buckets) {
  BucketMap result;
  for (std::size_t index = 0; index < buckets.bucket_counts.size(); ++index) {
    const auto bucket_index =
        static_cast<std::int64_t>(buckets.offset) +
        static_cast<std::int64_t>(index);
    if (bucket_index < std::numeric_limits<std::int32_t>::min() ||
        bucket_index > std::numeric_limits<std::int32_t>::max()) {
      throw std::invalid_argument(
          "exponential histogram bucket index overflows int32");
    }
    result[static_cast<std::int32_t>(bucket_index)] +=
        buckets.bucket_counts[index];
  }
  return result;
}

ExponentialBuckets to_exponential_buckets(const BucketMap& buckets) {
  ExponentialBuckets result;
  if (buckets.empty()) {
    return result;
  }

  const auto first = buckets.begin()->first;
  const auto last = buckets.rbegin()->first;
  const std::int64_t span =
      static_cast<std::int64_t>(last) - static_cast<std::int64_t>(first) + 1;
  constexpr std::int64_t kMaxRepresentableBuckets = 1'000'000;
  if (span > kMaxRepresentableBuckets) {
    throw std::length_error(
        "exponential histogram bucket span is too large to represent");
  }

  result.offset = first;
  result.bucket_counts.assign(static_cast<std::size_t>(span), 0);
  for (const auto& [index, count] : buckets) {
    result.bucket_counts[static_cast<std::size_t>(index - first)] = count;
  }
  return result;
}

std::int32_t rebase_index(std::int32_t index, std::uint32_t scale_delta) {
  if (scale_delta >= 31U) {
    return index < 0 ? -1 : 0;
  }

  const std::int64_t divisor =
      static_cast<std::int64_t>(1) << scale_delta;
  std::int64_t quotient = static_cast<std::int64_t>(index) / divisor;
  const std::int64_t remainder = static_cast<std::int64_t>(index) % divisor;
  if (remainder != 0 && index < 0) {
    --quotient;
  }
  return static_cast<std::int32_t>(quotient);
}

BucketMap rebase_buckets(const BucketMap& buckets, std::int32_t from_scale,
                         std::int32_t to_scale) {
  if (buckets.empty() || from_scale == to_scale) {
    return buckets;
  }
  if (to_scale > from_scale) {
    throw std::invalid_argument("cannot refine exponential histogram scale");
  }

  const auto scale_delta =
      static_cast<std::uint32_t>(static_cast<std::int64_t>(from_scale) -
                                 static_cast<std::int64_t>(to_scale));
  BucketMap result;
  for (const auto& [index, count] : buckets) {
    const std::int32_t rebased = rebase_index(index, scale_delta);
    result[rebased] = saturating_add(result[rebased], count);
  }
  return result;
}

void merge_bucket_map(BucketMap& destination, const BucketMap& source) {
  for (const auto& [index, count] : source) {
    destination[index] = saturating_add(destination[index], count);
  }
}

struct Series {
  MetricDescriptor metric;
  bool has_current = false;
  Timestamp generation_start = 0;

  bool has_processed = false;
  Timestamp last_processed_time = 0;

  bool has_seen = false;
  Timestamp max_seen_time = 0;
  std::map<Timestamp, DataPoint> pending;
  std::set<Timestamp> retired_generations;

  DataPoint current{NumberDataPoint{}};
};

struct ApplyResult {
  std::optional<DataPoint> output;
  bool consumed = false;
};

DataPoint normalized_copy(const DataPoint& point, Timestamp start_time) {
  DataPoint result = point;
  set_start_time(result, start_time);
  return result;
}

ApplyResult apply_point(Series& series, const DataPoint& point) {
  const Timestamp start_time = point_start_time(point);
  const Timestamp event_time = point_time(point);

  if (series.has_current && start_time != series.generation_start) {
    // A point from a generation that has already been superseded must not
    // reset the current generation, even if it is far outside the reorder
    // window. An unknown lower start time is treated as a clock rollback and
    // starts a fresh generation.
    if (series.retired_generations.contains(start_time)) {
      return {};
    }

    // Delta points normally advance their interval start time, for example
    // (T0,T1], (T1,T2]. Such a start time is still inside the already
    // observed timeline and belongs to the same cumulative generation.
    const bool interval_advance =
        start_time > series.generation_start && series.has_processed &&
        start_time == series.last_processed_time;
    if (!interval_advance) {
      series.retired_generations.insert(series.generation_start);
      if (series.retired_generations.size() > 4096) {
        series.retired_generations.erase(series.retired_generations.begin());
      }
      series.generation_start = start_time;
      series.current = normalized_copy(point, series.generation_start);
      series.has_current = true;
      return {series.current, true};
    }
  }

  if (!series.has_current) {
    series.generation_start = start_time;
    series.current = normalized_copy(point, series.generation_start);
    series.has_current = true;
    return {series.current, true};
  }

  const auto reset_current = [&]() {
    series.current = normalized_copy(point, series.generation_start);
    return ApplyResult{series.current, true};
  };

  switch (series.metric.type) {
    case MetricType::Sum: {
      auto& current = std::get<NumberDataPoint>(series.current);
      const auto& incoming = std::get<NumberDataPoint>(point);
      if (series.metric.is_monotonic && incoming.value < 0.0) {
        return reset_current();
      }
      current.value += incoming.value;
      current.time = event_time;
      current.start_time = series.generation_start;
      current.attributes = incoming.attributes;
      return {current, true};
    }
    case MetricType::Gauge: {
      series.current = normalized_copy(point, series.generation_start);
      return {series.current, true};
    }
    case MetricType::Histogram: {
      auto& current = std::get<HistogramDataPoint>(series.current);
      const auto& incoming = std::get<HistogramDataPoint>(point);
      if (current.explicit_bounds != incoming.explicit_bounds) {
        return reset_current();
      }

      bool overflow = addition_overflows(current.count, incoming.count);
      for (std::size_t index = 0;
           index < current.bucket_counts.size() && !overflow; ++index) {
        overflow = addition_overflows(current.bucket_counts[index],
                                      incoming.bucket_counts[index]);
      }
      if (overflow) {
        return reset_current();
      }

      current.count += incoming.count;
      current.sum += incoming.sum;
      for (std::size_t index = 0; index < current.bucket_counts.size();
           ++index) {
        current.bucket_counts[index] += incoming.bucket_counts[index];
      }
      current.time = event_time;
      current.start_time = series.generation_start;
      current.attributes = incoming.attributes;
      return {current, true};
    }
    case MetricType::ExponentialHistogram: {
      auto& current =
          std::get<ExponentialHistogramDataPoint>(series.current);
      const auto& incoming =
          std::get<ExponentialHistogramDataPoint>(point);

      const bool overflow =
          addition_overflows(current.count, incoming.count) ||
          addition_overflows(current.zero_count, incoming.zero_count);
      const std::int32_t target_scale =
          std::min(current.scale, incoming.scale);
      BucketMap positive =
          rebase_buckets(to_bucket_map(current.positive), current.scale,
                         target_scale);
      BucketMap negative =
          rebase_buckets(to_bucket_map(current.negative), current.scale,
                         target_scale);
      const BucketMap incoming_positive =
          rebase_buckets(to_bucket_map(incoming.positive), incoming.scale,
                         target_scale);
      const BucketMap incoming_negative =
          rebase_buckets(to_bucket_map(incoming.negative), incoming.scale,
                         target_scale);
      merge_bucket_map(positive, incoming_positive);
      merge_bucket_map(negative, incoming_negative);
      if (overflow) {
        return reset_current();
      }

      current.count += incoming.count;
      current.sum += incoming.sum;
      current.zero_count += incoming.zero_count;
      current.scale = target_scale;
      current.positive = to_exponential_buckets(positive);
      current.negative = to_exponential_buckets(negative);
      current.time = event_time;
      current.start_time = series.generation_start;
      current.attributes = incoming.attributes;
      return {current, true};
    }
    case MetricType::Summary: {
      // Quantiles cannot be combined. Keep the newest complete snapshot while
      // still applying generation and ordering semantics.
      series.current = normalized_copy(point, series.generation_start);
      return {series.current, true};
    }
  }
  return {};
}

std::vector<DataPoint> publish_ready(Series& series, Timestamp horizon,
                                     bool publish_all) {
  std::vector<DataPoint> output;
  while (!series.pending.empty()) {
    auto iterator = series.pending.begin();
    if (!publish_all && iterator->first > horizon) {
      break;
    }

    const Timestamp event_time = iterator->first;
    DataPoint point = std::move(iterator->second);
    series.pending.erase(iterator);

    ApplyResult result = apply_point(series, point);
    if (!result.consumed) {
      continue;
    }

    series.has_processed = true;
    series.last_processed_time = event_time;
    if (result.output.has_value()) {
      output.push_back(std::move(*result.output));
    }
  }
  return output;
}

}  // namespace

std::string make_series_key(const MetricDescriptor& metric,
                            const Attributes& attributes) {
  std::string key;
  key.reserve(256);
  key += "otlp-delta-v1";

  std::string encoded;
  append_field(key, "resource");
  encode_attributes(metric.resource.attributes, encoded);
  append_field(key, encoded);

  encoded.clear();
  append_field(key, "scope-name");
  append_field(key, metric.scope.name);
  append_field(key, "scope-version");
  append_field(key, metric.scope.version);
  encode_attributes(metric.scope.attributes, encoded);
  append_field(key, encoded);

  append_field(key, "metric-name");
  append_field(key, metric.name);
  append_field(key, "metric-unit");
  append_field(key, metric.unit);

  key += "type";
  key += static_cast<char>('0' + static_cast<int>(metric.type));
  key += metric.is_monotonic ? 'm' : 'n';

  encoded.clear();
  append_field(key, "attributes");
  encode_attributes(attributes, encoded);
  append_field(key, encoded);
  return key;
}

struct DeltaToCumulative::Impl {
  explicit Impl(Options value) : options(value) {}

  Options options;
  std::map<std::string, Series> series;
};

DeltaToCumulative::DeltaToCumulative() : DeltaToCumulative(Options{}) {}

DeltaToCumulative::DeltaToCumulative(Options options)
    : impl_(std::make_unique<Impl>(options)) {}

DeltaToCumulative::DeltaToCumulative(Timestamp reorder_window_ns)
    : DeltaToCumulative(Options{.reorder_window_ns = reorder_window_ns}) {}

DeltaToCumulative::~DeltaToCumulative() = default;

DeltaToCumulative::DeltaToCumulative(DeltaToCumulative&&) noexcept = default;

DeltaToCumulative& DeltaToCumulative::operator=(DeltaToCumulative&&) noexcept =
    default;

std::vector<DataPoint> DeltaToCumulative::ingest(
    const MetricDescriptor& metric, const DataPoint& point) {
  validate_point(metric, point);

  const Timestamp event_time = point_time(point);
  const Timestamp start_time = point_start_time(point);
  const std::string key = make_series_key(metric, point_attributes(point));

  auto [iterator, inserted] = impl_->series.try_emplace(key);
  Series& series = iterator->second;
  if (inserted) {
    series.metric = metric;
  }

  if (series.has_processed && event_time <= series.last_processed_time) {
    return {};
  }
  if (series.pending.contains(event_time)) {
    return {};
  }

  // A known retired generation can never become current again. Drop it at
  // admission rather than allowing it to occupy reorder-window capacity.
  if (series.has_current && start_time != series.generation_start &&
      series.retired_generations.contains(start_time)) {
    return {};
  }

  if (!series.has_seen || event_time > series.max_seen_time) {
    series.max_seen_time = event_time;
    series.has_seen = true;
  }

  const Timestamp horizon =
      series.has_seen && series.max_seen_time >=
                              impl_->options.reorder_window_ns
          ? series.max_seen_time - impl_->options.reorder_window_ns
          : 0;
  if (series.has_seen && event_time < horizon) {
    return {};
  }

  series.pending.emplace(event_time, point);

  std::vector<DataPoint> output;
  const std::size_t limit = impl_->options.max_pending_points_per_series;
  if (limit != 0 && series.pending.size() > limit) {
    while (series.pending.size() > limit) {
      auto published = publish_ready(series, series.pending.begin()->first,
                                     false);
      output.insert(output.end(),
                    std::make_move_iterator(published.begin()),
                    std::make_move_iterator(published.end()));
    }
  }

  auto published = publish_ready(series, horizon, false);
  output.insert(output.end(), std::make_move_iterator(published.begin()),
                std::make_move_iterator(published.end()));
  return output;
}

std::vector<DataPoint> DeltaToCumulative::ingest(
    const MetricDescriptor& metric, std::span<const DataPoint> points) {
  std::vector<DataPoint> output;
  for (const DataPoint& point : points) {
    auto published = ingest(metric, point);
    output.insert(output.end(), std::make_move_iterator(published.begin()),
                  std::make_move_iterator(published.end()));
  }
  return output;
}

std::vector<DataPoint> DeltaToCumulative::ingest(
    const MetricDescriptor& metric, const std::vector<DataPoint>& points) {
  return ingest(metric, std::span<const DataPoint>(points));
}

std::vector<DataPoint> DeltaToCumulative::flush() {
  std::vector<DataPoint> output;
  for (auto& [key, series] : impl_->series) {
    auto published = publish_ready(series, 0, true);
    output.insert(output.end(), std::make_move_iterator(published.begin()),
                  std::make_move_iterator(published.end()));
  }
  return output;
}

void DeltaToCumulative::reset() { impl_->series.clear(); }

bool DeltaToCumulative::reset_series(const MetricDescriptor& metric,
                                     const Attributes& attributes) {
  return impl_->series.erase(make_series_key(metric, attributes)) != 0;
}

const Options& DeltaToCumulative::options() const noexcept {
  return impl_->options;
}

std::size_t DeltaToCumulative::series_count() const noexcept {
  return impl_->series.size();
}

std::size_t DeltaToCumulative::pending_points() const noexcept {
  std::size_t count = 0;
  for (const auto& [key, series] : impl_->series) {
    count += series.pending.size();
  }
  return count;
}

std::vector<DataPoint> convert(const MetricDescriptor& metric,
                               std::span<const DataPoint> points,
                               Options options) {
  DeltaToCumulative converter(std::move(options));
  auto output = converter.ingest(metric, points);
  auto flushed = converter.flush();
  output.insert(output.end(), std::make_move_iterator(flushed.begin()),
                std::make_move_iterator(flushed.end()));
  return output;
}

std::vector<DataPoint> convert(const MetricDescriptor& metric,
                               const std::vector<DataPoint>& points,
                               Options options) {
  return convert(metric, std::span<const DataPoint>(points),
                 std::move(options));
}

}  // namespace dataeng
