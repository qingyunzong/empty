#include "dataeng.hpp"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace {

using dataeng::Attributes;
using dataeng::AttributeValue;
using dataeng::DataPoint;
using dataeng::DeltaToCumulative;
using dataeng::HistogramDataPoint;
using dataeng::MetricDescriptor;
using dataeng::MetricType;
using dataeng::NumberDataPoint;
using dataeng::Options;
using dataeng::SummaryDataPoint;
using dataeng::Timestamp;

int failures = 0;

void check(bool condition, const char* expression, const char* file, int line) {
  if (!condition) {
    ++failures;
    std::cerr << file << ':' << line << ": check failed: " << expression
              << '\n';
  }
}

#define CHECK(expression) check((expression), #expression, __FILE__, __LINE__)

const NumberDataPoint& as_number(const DataPoint& point) {
  return std::get<NumberDataPoint>(point);
}

const HistogramDataPoint& as_histogram(const DataPoint& point) {
  return std::get<HistogramDataPoint>(point);
}

const dataeng::ExponentialHistogramDataPoint& as_exponential(
    const DataPoint& point) {
  return std::get<dataeng::ExponentialHistogramDataPoint>(point);
}

MetricDescriptor sum_metric(std::string name = "requests") {
  MetricDescriptor metric;
  metric.resource.attributes = {{"service.name", "checkout"}};
  metric.scope.name = "example.instrumentation";
  metric.scope.version = "1.0.0";
  metric.name = std::move(name);
  metric.unit = "{request}";
  metric.type = MetricType::Sum;
  metric.is_monotonic = true;
  return metric;
}

NumberDataPoint number(Timestamp start, Timestamp time, double value,
                       Attributes attributes = {}) {
  return NumberDataPoint{std::move(attributes), start, time, value};
}

void test_basic_sum() {
  MetricDescriptor metric = sum_metric();
  DeltaToCumulative converter;

  auto first = converter.ingest(
      metric, DataPoint{number(100, 110, 5, {{"route", "/a"}})});
  CHECK(first.size() == 1);
  CHECK(as_number(first[0]).start_time == 100);
  CHECK(as_number(first[0]).time == 110);
  CHECK(as_number(first[0]).value == 5);

  auto second = converter.ingest(
      metric, DataPoint{number(100, 120, 7, {{"route", "/a"}})});
  CHECK(second.size() == 1);
  CHECK(as_number(second[0]).value == 12);
  CHECK(as_number(second[0]).start_time == 100);
  CHECK(as_number(second[0]).time == 120);
  CHECK(as_number(second[0]).attributes.at("route") == AttributeValue("/a"));
}

void test_series_key_isolation() {
  DeltaToCumulative converter;
  MetricDescriptor metric = sum_metric();

  const Attributes a = {{"route", "/a"}};
  const Attributes b = {{"route", "/b"}};
  const Attributes typed_int = {{"route", std::int64_t{1}}};
  const Attributes typed_double = {{"route", 1.0}};
  const Attributes typed_string = {{"route", "1"}};

  CHECK(converter.ingest(metric, DataPoint{number(1, 10, 3, a)}).size() == 1);
  CHECK(converter.ingest(metric, DataPoint{number(1, 10, 5, b)}).size() == 1);

  auto other_resource = metric;
  other_resource.resource.attributes["host.name"] = "host-2";
  CHECK(converter.ingest(other_resource, DataPoint{number(1, 10, 11, a)})
            .size() == 1);

  auto other_scope = metric;
  other_scope.scope.attributes["library"] = "generated";
  CHECK(converter.ingest(other_scope, DataPoint{number(1, 10, 13, a)})
            .size() == 1);

  auto other_metric = sum_metric("bytes");
  CHECK(converter.ingest(other_metric, DataPoint{number(1, 10, 17, a)})
            .size() == 1);

  CHECK(converter.ingest(metric, DataPoint{number(1, 20, 7, a)}).size() == 1);
  CHECK(converter.ingest(metric, DataPoint{number(1, 20, 9, b)}).size() == 1);

  CHECK(converter.ingest(metric, DataPoint{number(1, 20, 19, typed_int)})
            .size() == 1);
  CHECK(converter.ingest(metric, DataPoint{number(1, 20, 23, typed_double)})
            .size() == 1);
  CHECK(converter.ingest(metric, DataPoint{number(1, 20, 29, typed_string)})
            .size() == 1);

  CHECK(converter.series_count() == 8);
  CHECK(dataeng::make_series_key(metric, typed_int) !=
        dataeng::make_series_key(metric, typed_double));
  CHECK(dataeng::make_series_key(metric, typed_int) !=
        dataeng::make_series_key(metric, typed_string));
}

void test_generation_resets_and_stale_generation() {
  MetricDescriptor metric = sum_metric();
  DeltaToCumulative converter;
  const Attributes attrs = {{"route", "/a"}};

  auto first =
      converter.ingest(metric, DataPoint{number(100, 110, 5, attrs)});
  CHECK(first.size() == 1);
  CHECK(as_number(first[0]).value == 5);

  // A new start time is a new generation and resets the accumulator.
  auto restarted =
      converter.ingest(metric, DataPoint{number(200, 210, 7, attrs)});
  CHECK(restarted.size() == 1);
  CHECK(as_number(restarted[0]).start_time == 200);
  CHECK(as_number(restarted[0]).value == 7);

  // An event from the retired generation must not reset the new generation.
  auto stale =
      converter.ingest(metric, DataPoint{number(100, 220, 1000, attrs)});
  CHECK(stale.empty());

  auto after_stale =
      converter.ingest(metric, DataPoint{number(200, 230, 3, attrs)});
  CHECK(after_stale.size() == 1);
  CHECK(as_number(after_stale[0]).value == 10);

  // A previously unseen, lower start time models a clock rollback. It resets.
  auto rolled_back =
      converter.ingest(metric, DataPoint{number(150, 240, 2, attrs)});
  CHECK(rolled_back.size() == 1);
  CHECK(as_number(rolled_back[0]).start_time == 150);
  CHECK(as_number(rolled_back[0]).value == 2);

  // And the superseded generation cannot bounce the state back.
  auto stale_again =
      converter.ingest(metric, DataPoint{number(200, 250, 500, attrs)});
  CHECK(stale_again.empty());

  auto final_point =
      converter.ingest(metric, DataPoint{number(150, 260, 4, attrs)});
  CHECK(final_point.size() == 1);
  CHECK(as_number(final_point[0]).value == 6);
}

void test_advancing_delta_interval_start_time() {
  MetricDescriptor metric = sum_metric();
  DeltaToCumulative converter;
  const Attributes attrs = {{"route", "/a"}};

  auto first =
      converter.ingest(metric, DataPoint{number(100, 110, 5, attrs)});
  CHECK(first.size() == 1);
  CHECK(as_number(first[0]).start_time == 100);

  // Normal delta progression: the next interval starts where the previous
  // observation ended. The cumulative generation start stays at 100.
  auto second =
      converter.ingest(metric, DataPoint{number(110, 120, 7, attrs)});
  CHECK(second.size() == 1);
  CHECK(as_number(second[0]).start_time == 100);
  CHECK(as_number(second[0]).value == 12);

  auto third =
      converter.ingest(metric, DataPoint{number(120, 130, 3, attrs)});
  CHECK(third.size() == 1);
  CHECK(as_number(third[0]).start_time == 100);
  CHECK(as_number(third[0]).value == 15);

  // A start time beyond the observed timeline is a discontinuity / restart.
  auto restarted =
      converter.ingest(metric, DataPoint{number(200, 210, 2, attrs)});
  CHECK(restarted.size() == 1);
  CHECK(as_number(restarted[0]).start_time == 200);
  CHECK(as_number(restarted[0]).value == 2);

  // A start-time change that does not tile the previous interval is also a
  // new generation, even when it is numerically inside the old timeline.
  auto non_tiling = converter.ingest(
      metric, DataPoint{number(300, 1200, 11, attrs)});
  CHECK(non_tiling.size() == 1);
  CHECK(as_number(non_tiling[0]).start_time == 300);
  CHECK(as_number(non_tiling[0]).value == 11);
}

void test_monotonic_and_non_monotonic_sum_reset() {
  MetricDescriptor monotonic = sum_metric("monotonic");
  DeltaToCumulative converter;
  const Attributes attrs = {{"route", "/a"}};

  CHECK(converter.ingest(monotonic, DataPoint{number(1, 10, 10, attrs)})
            .size() == 1);
  auto reset =
      converter.ingest(monotonic, DataPoint{number(1, 20, -3, attrs)});
  CHECK(reset.size() == 1);
  CHECK(as_number(reset[0]).value == -3);

  MetricDescriptor non_monotonic = sum_metric("non-monotonic");
  non_monotonic.is_monotonic = false;
  CHECK(converter.ingest(non_monotonic, DataPoint{number(1, 10, 10, attrs)})
            .size() == 1);
  auto negative =
      converter.ingest(non_monotonic, DataPoint{number(1, 20, -3, attrs)});
  CHECK(negative.size() == 1);
  CHECK(as_number(negative[0]).value == 7);

  MetricDescriptor gauge = sum_metric("temperature");
  gauge.type = MetricType::Gauge;
  CHECK(converter.ingest(gauge, DataPoint{number(1, 10, 10, attrs)}).size() ==
        1);
  auto gauge_update = converter.ingest(gauge, DataPoint{number(1, 20, 4, attrs)});
  CHECK(gauge_update.size() == 1);
  CHECK(as_number(gauge_update[0]).value == 4);
}

void test_reorder_window_and_late_drop() {
  MetricDescriptor metric = sum_metric();
  const Attributes attrs = {{"route", "/a"}};
  Options options;
  options.reorder_window_ns = 120;
  DeltaToCumulative converter(options);

  CHECK(converter.ingest(metric, DataPoint{number(1, 100, 5, attrs)}).empty());

  auto after_300 =
      converter.ingest(metric, DataPoint{number(1, 300, 7, attrs)});
  CHECK(after_300.size() == 1);
  CHECK(as_number(after_300[0]).time == 100);
  CHECK(as_number(after_300[0]).value == 5);

  auto after_200 =
      converter.ingest(metric, DataPoint{number(1, 200, 3, attrs)});
  CHECK(after_200.empty());

  auto flushed = converter.flush();
  CHECK(flushed.size() == 2);
  CHECK(as_number(flushed[0]).time == 200);
  CHECK(as_number(flushed[0]).value == 8);
  CHECK(as_number(flushed[1]).time == 300);
  CHECK(as_number(flushed[1]).value == 15);

  // Published history is immutable: both points are outside the window now.
  CHECK(converter.ingest(metric, DataPoint{number(1, 250, 100, attrs)}).empty());
  CHECK(converter.ingest(metric, DataPoint{number(1, 101, 100, attrs)}).empty());
  CHECK(converter.flush().empty());
  CHECK(converter.pending_points() == 0);
}

void test_in_window_reorder_before_publication() {
  MetricDescriptor metric = sum_metric();
  const Attributes attrs = {{"route", "/a"}};
  Options options;
  options.reorder_window_ns = 50;
  DeltaToCumulative converter(options);

  CHECK(converter.ingest(metric, DataPoint{number(1, 100, 1, attrs)}).empty());
  auto at_200 =
      converter.ingest(metric, DataPoint{number(1, 200, 2, attrs)});
  CHECK(at_200.size() == 1);
  CHECK(as_number(at_200[0]).time == 100);
  CHECK(as_number(at_200[0]).value == 1);

  // This is exactly on the publication horizon and can still be inserted.
  auto at_150 =
      converter.ingest(metric, DataPoint{number(1, 150, 4, attrs)});
  CHECK(at_150.size() == 1);
  CHECK(as_number(at_150[0]).time == 150);
  CHECK(as_number(at_150[0]).value == 5);

  auto flushed = converter.flush();
  CHECK(flushed.size() == 1);
  CHECK(as_number(flushed[0]).time == 200);
  CHECK(as_number(flushed[0]).value == 7);
}

void test_out_of_window_before_any_publication() {
  MetricDescriptor metric = sum_metric();
  const Attributes attrs = {{"route", "/a"}};
  Options options;
  options.reorder_window_ns = 100;
  DeltaToCumulative converter(options);

  CHECK(converter.ingest(metric, DataPoint{number(1, 1000, 5, attrs)}).empty());
  // This is far beyond the window even though nothing has been published yet.
  CHECK(converter.ingest(metric, DataPoint{number(1, 100, 100, attrs)}).empty());

  auto flushed = converter.flush();
  CHECK(flushed.size() == 1);
  CHECK(as_number(flushed[0]).time == 1000);
  CHECK(as_number(flushed[0]).value == 5);
}

void test_histogram_accumulation_and_reset() {
  MetricDescriptor metric = sum_metric("latency");
  metric.type = MetricType::Histogram;
  metric.unit = "ms";
  DeltaToCumulative converter;
  const Attributes attrs = {{"route", "/a"}};

  HistogramDataPoint first;
  first.attributes = attrs;
  first.start_time = 1;
  first.time = 10;
  first.count = 2;
  first.sum = 3;
  first.explicit_bounds = {1, 2};
  first.bucket_counts = {1, 1, 0};

  auto first_out = converter.ingest(metric, DataPoint{first});
  CHECK(first_out.size() == 1);
  CHECK(as_histogram(first_out[0]).count == 2);
  CHECK(as_histogram(first_out[0]).sum == 3);

  HistogramDataPoint second = first;
  second.time = 20;
  second.count = 3;
  second.sum = 7;
  second.bucket_counts = {1, 2, 0};
  auto second_out = converter.ingest(metric, DataPoint{second});
  CHECK(second_out.size() == 1);
  CHECK(as_histogram(second_out[0]).count == 5);
  CHECK(as_histogram(second_out[0]).sum == 10);
  CHECK((as_histogram(second_out[0]).bucket_counts ==
         std::vector<std::uint64_t>{2, 3, 0}));

  // A shape change is a type-level reset even when start time is unchanged.
  HistogramDataPoint reshaped = second;
  reshaped.time = 30;
  reshaped.explicit_bounds = {1, 3};
  reshaped.bucket_counts = {4, 5, 6};
  reshaped.count = 15;
  reshaped.sum = 20;
  auto reshaped_out = converter.ingest(metric, DataPoint{reshaped});
  CHECK(reshaped_out.size() == 1);
  CHECK(as_histogram(reshaped_out[0]).count == 15);
  CHECK(as_histogram(reshaped_out[0]).sum == 20);
  CHECK((as_histogram(reshaped_out[0]).explicit_bounds ==
         std::vector<double>{1, 3}));
}

void test_exponential_histogram_scale_merge() {
  MetricDescriptor metric = sum_metric("request.size");
  metric.type = MetricType::ExponentialHistogram;
  metric.unit = "By";
  DeltaToCumulative converter;
  const Attributes attrs = {{"route", "/a"}};

  dataeng::ExponentialHistogramDataPoint first;
  first.attributes = attrs;
  first.start_time = 1;
  first.time = 10;
  first.scale = 0;
  first.count = 4;
  first.sum = 10;
  first.zero_count = 1;
  first.positive.offset = 0;
  first.positive.bucket_counts = {1, 2};

  CHECK(converter.ingest(metric, DataPoint{first}).size() == 1);

  dataeng::ExponentialHistogramDataPoint second = first;
  second.time = 20;
  second.count = 7;
  second.sum = 25;
  second.zero_count = 2;
  second.positive.offset = 1;
  second.positive.bucket_counts = {3, 4};
  auto out = converter.ingest(metric, DataPoint{second});
  CHECK(out.size() == 1);
  CHECK(as_exponential(out[0]).scale == 0);
  CHECK(as_exponential(out[0]).count == 11);
  CHECK(as_exponential(out[0]).sum == 35);
  CHECK(as_exponential(out[0]).zero_count == 3);
  CHECK(as_exponential(out[0]).positive.offset == 0);
  CHECK((as_exponential(out[0]).positive.bucket_counts ==
         std::vector<std::uint64_t>{1, 5, 4}));

  // Scale 1 is finer than scale 0; the cumulative side is downsampled.
  dataeng::ExponentialHistogramDataPoint finer = first;
  finer.time = 30;
  finer.scale = 1;
  finer.count = 2;
  finer.sum = 7;
  finer.zero_count = 0;
  finer.positive.offset = 1;
  finer.positive.bucket_counts = {6};
  finer.negative.offset = -1;
  finer.negative.bucket_counts = {2};

  auto merged = converter.ingest(metric, DataPoint{finer});
  CHECK(merged.size() == 1);
  CHECK(as_exponential(merged[0]).scale == 0);
  CHECK(as_exponential(merged[0]).count == 13);
  CHECK(as_exponential(merged[0]).sum == 42);
  CHECK(as_exponential(merged[0]).zero_count == 3);
  CHECK(as_exponential(merged[0]).positive.offset == 0);
  CHECK((as_exponential(merged[0]).positive.bucket_counts ==
         std::vector<std::uint64_t>{7, 5, 4}));
  CHECK(as_exponential(merged[0]).negative.offset == -1);
  CHECK((as_exponential(merged[0]).negative.bucket_counts ==
         std::vector<std::uint64_t>{2}));
}

void test_summary_and_reset_series() {
  MetricDescriptor metric = sum_metric("duration");
  metric.type = MetricType::Summary;
  DeltaToCumulative converter;
  const Attributes a = {{"route", "/a"}};
  const Attributes b = {{"route", "/b"}};

  auto make_summary = [](const Attributes& attrs, Timestamp time,
                         std::uint64_t count, double sum, double p50) {
    SummaryDataPoint point;
    point.attributes = attrs;
    point.start_time = 1;
    point.time = time;
    point.count = count;
    point.sum = sum;
    point.quantile_values = {{0.5, p50}};
    return DataPoint{point};
  };

  CHECK(converter.ingest(metric, make_summary(a, 10, 2, 3, 1.5)).size() == 1);
  CHECK(converter.ingest(metric, make_summary(b, 10, 2, 3, 1.5)).size() == 1);
  CHECK(converter.series_count() == 2);

  CHECK(converter.reset_series(metric, a));
  CHECK(!converter.reset_series(metric, a));
  CHECK(converter.series_count() == 1);

  auto after_reset = converter.ingest(metric, make_summary(a, 20, 4, 9, 3));
  CHECK(after_reset.size() == 1);
  CHECK(std::get<SummaryDataPoint>(after_reset[0]).count == 4);

  // Summary snapshots replace each other instead of accumulating quantiles.
  auto replaced = converter.ingest(metric, make_summary(a, 30, 5, 12, 4));
  CHECK(replaced.size() == 1);
  CHECK(std::get<SummaryDataPoint>(replaced[0]).count == 5);
  CHECK(std::get<SummaryDataPoint>(replaced[0]).sum == 12);
}

void test_batch_and_max_pending() {
  MetricDescriptor metric = sum_metric();
  const Attributes attrs = {{"route", "/a"}};
  Options options;
  options.reorder_window_ns = 100;
  options.max_pending_points_per_series = 2;
  DeltaToCumulative converter(options);

  std::vector<DataPoint> points{
      DataPoint{number(1, 100, 1, attrs)},
      DataPoint{number(1, 200, 2, attrs)},
      DataPoint{number(1, 300, 3, attrs)},
  };
  auto output = converter.ingest(metric, points);
  CHECK(!output.empty());
  CHECK(converter.pending_points() <= 2);

  auto flushed = converter.flush();
  output.insert(output.end(), flushed.begin(), flushed.end());
  CHECK(output.size() == 3);
  CHECK(as_number(output.back()).value == 6);

  auto batch = dataeng::convert(metric, points, options);
  CHECK(batch.size() == 3);
  CHECK(as_number(batch.back()).value == 6);
}

void test_invalid_point_type() {
  MetricDescriptor metric = sum_metric();
  DeltaToCumulative converter;
  bool threw = false;
  try {
    (void)converter.ingest(metric, DataPoint{HistogramDataPoint{}});
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  CHECK(threw);
}

}  // namespace

int main() {
  test_basic_sum();
  test_series_key_isolation();
  test_generation_resets_and_stale_generation();
  test_advancing_delta_interval_start_time();
  test_monotonic_and_non_monotonic_sum_reset();
  test_reorder_window_and_late_drop();
  test_in_window_reorder_before_publication();
  test_out_of_window_before_any_publication();
  test_histogram_accumulation_and_reset();
  test_exponential_histogram_scale_merge();
  test_summary_and_reset_series();
  test_batch_and_max_pending();
  test_invalid_point_type();

  if (failures != 0) {
    std::cerr << failures << " test check(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "all dataeng tests passed\n";
  return EXIT_SUCCESS;
}
