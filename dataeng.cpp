#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace dataeng {
namespace {

using Real = long double;

constexpr Real kLogTwo = 0.693147180559945309417232121458176568L;

[[noreturn]] void fail(const std::string& message) {
    throw std::invalid_argument(message);
}

bool is_negative_infinity(double value) {
    return std::isinf(value) && std::signbit(value);
}

bool is_positive_infinity(double value) {
    return std::isinf(value) && !std::signbit(value);
}

std::string bin_label(std::size_t index) {
    return "bin " + std::to_string(index);
}

void validate_options(const Options& options) {
    if (!std::isfinite(options.zero_floor) || options.zero_floor <= 0.0 ||
        options.zero_floor >= 1.0) {
        fail("zero_floor must be finite and strictly between 0 and 1");
    }
    if (options.missing != MissingPolicy::IncludeAsCategories &&
        options.missing != MissingPolicy::Exclude) {
        fail("unknown missing-value policy");
    }
    if (options.infinite != InfiniteBinPolicy::CollapseToBoundary &&
        options.infinite != InfiniteBinPolicy::SplitEvenly &&
        options.infinite != InfiniteBinPolicy::Reject) {
        fail("unknown infinite-bin policy");
    }
    if (options.zero_mass != ZeroMassPolicy::FloorAndRenormalize &&
        options.zero_mass != ZeroMassPolicy::Reject) {
        fail("unknown zero-mass policy");
    }
}

struct Segment {
    double lower = 0.0;
    double upper = 0.0;
};

struct HistogramAllocation {
    std::vector<Real> mass;
    std::vector<Real> error_bound;
    Real unresolved_mass = 0.0;
};

std::vector<double> build_breakpoints(const Histogram& p, const Histogram& q) {
    std::vector<double> points;
    points.reserve(p.edges.size() + q.edges.size());
    points.insert(points.end(), p.edges.begin(), p.edges.end());
    points.insert(points.end(), q.edges.begin(), q.edges.end());
    std::sort(points.begin(), points.end());
    points.erase(std::unique(points.begin(), points.end()), points.end());
    return points;
}

std::vector<Segment> build_segments(const std::vector<double>& points) {
    std::vector<Segment> segments;
    segments.reserve(points.size() - 1);
    for (std::size_t i = 0; i + 1 < points.size(); ++i) {
        segments.push_back(Segment{points[i], points[i + 1]});
    }
    return segments;
}

int containing_bin(const Histogram& histogram,
                   const Segment& segment,
                   std::size_t& bin_index) {
    const auto first_greater =
        std::upper_bound(histogram.edges.begin(), histogram.edges.end(), segment.lower);
    if (first_greater == histogram.edges.begin()) {
        return -1;
    }

    const std::size_t candidate =
        static_cast<std::size_t>(first_greater - histogram.edges.begin() - 1);
    if (candidate >= histogram.counts.size()) {
        return -1;
    }

    if (segment.lower < histogram.edges[candidate] ||
        segment.upper > histogram.edges[candidate + 1]) {
        return -1;
    }

    bin_index = candidate;
    return 0;
}

Real finite_fraction(const Histogram& histogram,
                     std::size_t bin,
                     const Segment& segment) {
    const Real bin_lower = static_cast<Real>(histogram.edges[bin]);
    const Real bin_upper = static_cast<Real>(histogram.edges[bin + 1]);
    const Real lower = std::max(static_cast<Real>(segment.lower), bin_lower);
    const Real upper = std::min(static_cast<Real>(segment.upper), bin_upper);
    const Real width = bin_upper - bin_lower;
    if (!(width > 0.0L)) {
        return 0.0L;
    }
    const Real fraction = (upper - lower) / width;
    return std::clamp(fraction, 0.0L, 1.0L);
}

HistogramAllocation allocate_histogram(const Histogram& histogram,
                                       const std::vector<Segment>& segments,
                                       const Options& options) {
    HistogramAllocation allocation;
    allocation.mass.assign(segments.size(), 0.0L);
    allocation.error_bound.assign(segments.size(), 0.0L);

    std::vector<int> segment_bin(segments.size(), -1);
    std::vector<std::size_t> segments_per_bin(histogram.counts.size(), 0);

    for (std::size_t i = 0; i < segments.size(); ++i) {
        std::size_t bin = 0;
        if (containing_bin(histogram, segments[i], bin) == 0) {
            segment_bin[i] = static_cast<int>(bin);
            ++segments_per_bin[bin];
        }
    }

    std::vector<Real> allocated(histogram.counts.size(), 0.0L);
    std::vector<std::size_t> last_segment(histogram.counts.size(), segments.size());

    for (std::size_t i = 0; i < segments.size(); ++i) {
        const int bin_value = segment_bin[i];
        if (bin_value < 0) {
            continue;
        }

        const std::size_t bin = static_cast<std::size_t>(bin_value);
        const Real count = static_cast<Real>(histogram.counts[bin]);
        if (!(count > 0.0L)) {
            continue;
        }

        const double bin_lower = histogram.edges[bin];
        const double bin_upper = histogram.edges[bin + 1];
        const bool lower_unbounded = is_negative_infinity(bin_lower);
        const bool upper_unbounded = is_positive_infinity(bin_upper);
        const std::size_t pieces = segments_per_bin[bin];
        Real mass = 0.0L;

        if (!lower_unbounded && !upper_unbounded) {
            mass = count * finite_fraction(histogram, bin, segments[i]);
        } else if (pieces <= 1) {
            mass = count;
        } else {
            if (options.infinite == InfiniteBinPolicy::Reject) {
                fail("unbounded " + bin_label(bin) +
                     " is split by the other histogram; set "
                     "InfiniteBinPolicy::CollapseToBoundary or SplitEvenly");
            }

            allocation.error_bound[i] = count;

            if (options.infinite == InfiniteBinPolicy::SplitEvenly ||
                (lower_unbounded && upper_unbounded)) {
                mass = count / static_cast<Real>(pieces);
            } else if (lower_unbounded) {
                if (segments[i].upper == bin_upper) {
                    mass = count;
                }
            } else if (segments[i].lower == bin_lower) {
                mass = count;
            }
        }

        allocation.mass[i] += mass;
        allocated[bin] += mass;
        last_segment[bin] = i;
    }

    for (std::size_t bin = 0; bin < histogram.counts.size(); ++bin) {
        const Real count = static_cast<Real>(histogram.counts[bin]);
        const Real difference = count - allocated[bin];
        if (difference != 0.0L && last_segment[bin] < segments.size()) {
            allocation.mass[last_segment[bin]] += difference;
        }

        const bool lower_unbounded = is_negative_infinity(histogram.edges[bin]);
        const bool upper_unbounded = is_positive_infinity(histogram.edges[bin + 1]);
        if ((lower_unbounded || upper_unbounded) && segments_per_bin[bin] > 1) {
            allocation.unresolved_mass += count;
        }
    }

    return allocation;
}

struct CategoryMass {
    Real p = 0.0L;
    Real q = 0.0L;
};

struct MetricSample {
    bool defined = false;
    std::vector<Real> p;
    std::vector<Real> q;
    std::vector<bool> p_smoothed;
    std::vector<bool> q_smoothed;
    Real p_total = 0.0L;
    Real q_total = 0.0L;
};

MetricSample evaluate_categories(const std::vector<CategoryMass>& categories,
                                 const Options& options,
                                 const char* metric_name) {
    MetricSample sample;
    if (categories.empty()) {
        return sample;
    }

    sample.defined = true;
    sample.p.resize(categories.size(), 0.0L);
    sample.q.resize(categories.size(), 0.0L);
    sample.p_smoothed.assign(categories.size(), false);
    sample.q_smoothed.assign(categories.size(), false);

    for (const CategoryMass& category : categories) {
        sample.p_total += category.p;
        sample.q_total += category.q;
    }

    for (std::size_t i = 0; i < categories.size(); ++i) {
        if (sample.p_total > 0.0L) {
            sample.p[i] = categories[i].p / sample.p_total;
        }
        if (sample.q_total > 0.0L) {
            sample.q[i] = categories[i].q / sample.q_total;
        }
    }

    if (options.zero_mass == ZeroMassPolicy::Reject) {
        for (std::size_t i = 0; i < categories.size(); ++i) {
            if (sample.p[i] == 0.0L || sample.q[i] == 0.0L) {
                fail(std::string(metric_name) +
                     " has an aligned interval with zero mass; set "
                     "ZeroMassPolicy::FloorAndRenormalize or remove the empty "
                     "category");
            }
        }
        return sample;
    }

    const Real floor = static_cast<Real>(options.zero_floor);
    Real p_sum = 0.0L;
    Real q_sum = 0.0L;
    for (std::size_t i = 0; i < categories.size(); ++i) {
        if (sample.p[i] < floor) {
            sample.p[i] = floor;
            sample.p_smoothed[i] = true;
        }
        if (sample.q[i] < floor) {
            sample.q[i] = floor;
            sample.q_smoothed[i] = true;
        }
        p_sum += sample.p[i];
        q_sum += sample.q[i];
    }

    if (!(p_sum > 0.0L) || !(q_sum > 0.0L)) {
        fail(std::string(metric_name) + " cannot be normalized");
    }

    for (std::size_t i = 0; i < categories.size(); ++i) {
        sample.p[i] /= p_sum;
        sample.q[i] /= q_sum;
    }

    return sample;
}

struct MetricValue {
    Real psi = 0.0L;
    Real js = 0.0L;
    std::vector<Real> psi_cells;
    std::vector<Real> js_cells;
};

MetricValue evaluate_metric(const MetricSample& sample) {
    MetricValue value;
    if (!sample.defined) {
        return value;
    }

    value.psi_cells.assign(sample.p.size(), 0.0L);
    value.js_cells.assign(sample.p.size(), 0.0L);

    for (std::size_t i = 0; i < sample.p.size(); ++i) {
        const Real p = sample.p[i];
        const Real q = sample.q[i];
        if (p <= 0.0L || q <= 0.0L) {
            continue;
        }

        Real psi = (p - q) * (std::log(p) - std::log(q));
        if (psi < 0.0L && psi > -1e-24L) {
            psi = 0.0L;
        }

        const Real sum = p + q;
        const Real js =
            0.5L * (p * std::log(2.0L * p / sum) +
                    q * std::log(2.0L * q / sum));

        value.psi_cells[i] = psi;
        value.js_cells[i] = (js < 0.0L && js > -1e-24L) ? 0.0L : js;
        value.psi += psi;
        value.js += value.js_cells[i];
    }

    if (value.psi < 0.0L && value.psi > -1e-24L) {
        value.psi = 0.0L;
    }
    if (value.js < 0.0L && value.js > -1e-24L) {
        value.js = 0.0L;
    }
    return value;
}

struct MetricBounds {
    double psi = 0.0;
    double js = 0.0;
};

MetricBounds metric_error_bounds(const MetricSample& sample,
                                 Real unresolved_p,
                                 Real unresolved_q,
                                 std::size_t category_count,
                                 double zero_floor,
                                 ZeroMassPolicy zero_mass_policy) {
    MetricBounds bounds;
    if (!sample.defined || category_count == 0 ||
        (unresolved_p == 0.0L && unresolved_q == 0.0L)) {
        return bounds;
    }
    if (zero_mass_policy == ZeroMassPolicy::Reject) {
        bounds.psi = std::numeric_limits<double>::infinity();
        bounds.js = std::numeric_limits<double>::infinity();
        return bounds;
    }

    const Real floor = static_cast<Real>(zero_floor);
    const Real effective_floor =
        floor / (1.0L + static_cast<Real>(category_count) * floor);
    if (!(effective_floor > 0.0L)) {
        bounds.psi = std::numeric_limits<double>::infinity();
        bounds.js = std::numeric_limits<double>::infinity();
        return bounds;
    }

    const Real inverse_floor = 1.0L / effective_floor;
    const Real psi_gradient = inverse_floor + std::log(inverse_floor) + 1.0L;
    const Real js_gradient =
        0.5L * std::log(std::max(inverse_floor, 2.0L));

    const Real p_error =
        sample.p_total > 0.0L
            ? std::min(2.0L, 4.0L * unresolved_p / sample.p_total)
            : 0.0L;
    const Real q_error =
        sample.q_total > 0.0L
            ? std::min(2.0L, 4.0L * unresolved_q / sample.q_total)
            : 0.0L;

    const Real psi_bound = psi_gradient * (p_error + q_error);
    const Real js_bound = js_gradient * (p_error + q_error);
    bounds.psi = std::isfinite(static_cast<double>(psi_bound))
                     ? static_cast<double>(psi_bound)
                     : std::numeric_limits<double>::infinity();
    bounds.js = std::isfinite(static_cast<double>(js_bound))
                    ? static_cast<double>(js_bound)
                    : std::numeric_limits<double>::infinity();
    return bounds;
}

}  // namespace

ValidationResult validate(const Histogram& histogram) {
    if (histogram.edges.size() < 2) {
        return {false, "histogram must contain at least one bin"};
    }
    if (histogram.counts.size() + 1 != histogram.edges.size()) {
        return {false, "edges must contain exactly counts.size() + 1 entries"};
    }

    for (std::size_t i = 0; i < histogram.edges.size(); ++i) {
        const double edge = histogram.edges[i];
        if (std::isnan(edge)) {
            return {false, "edge " + std::to_string(i) + " is NaN"};
        }
        if (is_negative_infinity(edge) && i != 0) {
            return {false, "-infinity is only allowed as the first edge"};
        }
        if (is_positive_infinity(edge) &&
            i + 1 != histogram.edges.size()) {
            return {false, "+infinity is only allowed as the last edge"};
        }
        if (i > 0) {
            const double previous = histogram.edges[i - 1];
            if (!(previous < edge)) {
                return {false, "edges must be strictly increasing"};
            }
        }
    }

    for (std::size_t i = 0; i < histogram.counts.size(); ++i) {
        const double count = histogram.counts[i];
        if (!std::isfinite(count) || count < 0.0) {
            return {false, "count in bin " + std::to_string(i) +
                               " must be finite and non-negative"};
        }
    }

    if (!std::isfinite(histogram.null_count) || histogram.null_count < 0.0) {
        return {false, "null_count must be finite and non-negative"};
    }
    if (!std::isfinite(histogram.nan_count) || histogram.nan_count < 0.0) {
        return {false, "nan_count must be finite and non-negative"};
    }

    return {};
}

ComparisonResult compare(const Histogram& p,
                         const Histogram& q,
                         const Options& options) {
    const ValidationResult p_validation = validate(p);
    if (!p_validation.ok) {
        fail("p: " + p_validation.message);
    }
    const ValidationResult q_validation = validate(q);
    if (!q_validation.ok) {
        fail("q: " + q_validation.message);
    }
    validate_options(options);

    const std::vector<double> breakpoints = build_breakpoints(p, q);
    const std::vector<Segment> segments = build_segments(breakpoints);
    const HistogramAllocation p_allocation =
        allocate_histogram(p, segments, options);
    const HistogramAllocation q_allocation =
        allocate_histogram(q, segments, options);

    ComparisonResult result;
    result.ok = true;
    result.options = options;
    result.intervals.reserve(segments.size());

    Real p_numeric_mass = 0.0L;
    Real q_numeric_mass = 0.0L;
    for (std::size_t i = 0; i < segments.size(); ++i) {
        IntervalContribution interval;
        interval.lower = segments[i].lower;
        interval.upper = segments[i].upper;
        interval.p_mass = static_cast<double>(p_allocation.mass[i]);
        interval.q_mass = static_cast<double>(q_allocation.mass[i]);
        interval.p_mass_error_bound =
            static_cast<double>(p_allocation.error_bound[i]);
        interval.q_mass_error_bound =
            static_cast<double>(q_allocation.error_bound[i]);
        p_numeric_mass += p_allocation.mass[i];
        q_numeric_mass += q_allocation.mass[i];
        result.intervals.push_back(interval);
    }

    const Real p_null = static_cast<Real>(p.null_count);
    const Real q_null = static_cast<Real>(q.null_count);
    const Real p_nan = static_cast<Real>(p.nan_count);
    const Real q_nan = static_cast<Real>(q.nan_count);
    const Real p_total = p_numeric_mass + p_null + p_nan;
    const Real q_total = q_numeric_mass + q_null + q_nan;
    const bool include_missing =
        options.missing == MissingPolicy::IncludeAsCategories;
    const Real p_primary =
        include_missing ? p_total : p_numeric_mass;
    const Real q_primary =
        include_missing ? q_total : q_numeric_mass;

    result.p_numeric_mass = static_cast<double>(p_numeric_mass);
    result.q_numeric_mass = static_cast<double>(q_numeric_mass);
    result.p_null_count = p.null_count;
    result.q_null_count = q.null_count;
    result.p_nan_count = p.nan_count;
    result.q_nan_count = q.nan_count;
    result.p_total_mass = static_cast<double>(p_total);
    result.q_total_mass = static_cast<double>(q_total);
    result.p_primary_mass = static_cast<double>(p_primary);
    result.q_primary_mass = static_cast<double>(q_primary);
    result.p_empty = p_total == 0.0L;
    result.q_empty = q_total == 0.0L;
    result.p_unresolved_mass =
        static_cast<double>(p_allocation.unresolved_mass);
    result.q_unresolved_mass =
        static_cast<double>(q_allocation.unresolved_mass);

    if (p_total > 0.0L) {
        result.p_null_fraction = p.null_count / static_cast<double>(p_total);
        result.p_nan_fraction = p.nan_count / static_cast<double>(p_total);
    }
    if (q_total > 0.0L) {
        result.q_null_fraction = q.null_count / static_cast<double>(q_total);
        result.q_nan_fraction = q.nan_count / static_cast<double>(q_total);
    }

    result.null_contribution.kind = MissingKind::Null;
    result.null_contribution.p_count = p.null_count;
    result.null_contribution.q_count = q.null_count;
    result.nan_contribution.kind = MissingKind::NaN;
    result.nan_contribution.p_count = p.nan_count;
    result.nan_contribution.q_count = q.nan_count;

    std::vector<std::size_t> numeric_category_intervals;
    std::vector<CategoryMass> numeric_categories;
    for (std::size_t i = 0; i < segments.size(); ++i) {
        if (p_allocation.mass[i] > 0.0L ||
            q_allocation.mass[i] > 0.0L) {
            numeric_category_intervals.push_back(i);
            numeric_categories.push_back(
                CategoryMass{p_allocation.mass[i], q_allocation.mass[i]});
        }
    }

    const MetricSample numeric_sample =
        evaluate_categories(numeric_categories, options, "numeric PSI/JS");
    const MetricValue numeric_value = evaluate_metric(numeric_sample);
    result.numeric_defined = numeric_sample.defined;
    result.numeric_psi = static_cast<double>(numeric_value.psi);
    result.numeric_js = static_cast<double>(numeric_value.js);
    result.numeric_js_bits =
        static_cast<double>(numeric_value.js / kLogTwo);
    const MetricBounds numeric_bounds =
        metric_error_bounds(numeric_sample,
                            p_allocation.unresolved_mass,
                            q_allocation.unresolved_mass,
                            numeric_categories.size(),
                            options.zero_floor,
                            options.zero_mass);
    result.numeric_psi_error_bound = numeric_bounds.psi;
    result.numeric_js_error_bound = numeric_bounds.js;

    for (std::size_t i = 0; i < numeric_categories.size(); ++i) {
        IntervalContribution& interval =
            result.intervals[numeric_category_intervals[i]];
        interval.numeric_p_probability =
            static_cast<double>(numeric_sample.p[i]);
        interval.numeric_q_probability =
            static_cast<double>(numeric_sample.q[i]);
        interval.numeric_psi =
            static_cast<double>(numeric_value.psi_cells[i]);
        interval.numeric_js =
            static_cast<double>(numeric_value.js_cells[i]);
    }

    std::vector<CategoryMass> missing_categories;
    std::vector<int> missing_slots;
    if (p_null + q_null > 0.0L) {
        missing_categories.push_back(CategoryMass{p_null, q_null});
        missing_slots.push_back(0);
    }
    if (p_nan + q_nan > 0.0L) {
        missing_categories.push_back(CategoryMass{p_nan, q_nan});
        missing_slots.push_back(1);
    }

    const MetricSample missing_sample =
        evaluate_categories(missing_categories, options, "missing PSI/JS");
    const MetricValue missing_value = evaluate_metric(missing_sample);
    result.missing_defined = missing_sample.defined;
    result.missing_psi = static_cast<double>(missing_value.psi);
    result.missing_js = static_cast<double>(missing_value.js);
    result.missing_js_bits =
        static_cast<double>(missing_value.js / kLogTwo);

    for (std::size_t i = 0; i < missing_categories.size(); ++i) {
        MissingContribution& contribution =
            missing_slots[i] == 0 ? result.null_contribution
                                  : result.nan_contribution;
        contribution.missing_p_probability =
            static_cast<double>(missing_sample.p[i]);
        contribution.missing_q_probability =
            static_cast<double>(missing_sample.q[i]);
        contribution.missing_psi =
            static_cast<double>(missing_value.psi_cells[i]);
        contribution.missing_js =
            static_cast<double>(missing_value.js_cells[i]);
    }

    std::vector<std::size_t> primary_category_intervals;
    std::vector<int> primary_missing_slots;
    std::vector<CategoryMass> primary_categories;
    for (std::size_t i = 0; i < segments.size(); ++i) {
        if (p_allocation.mass[i] > 0.0L ||
            q_allocation.mass[i] > 0.0L) {
            primary_category_intervals.push_back(i);
            primary_missing_slots.push_back(-1);
            primary_categories.push_back(
                CategoryMass{p_allocation.mass[i], q_allocation.mass[i]});
        }
    }
    if (include_missing) {
        if (p_null + q_null > 0.0L) {
            primary_category_intervals.push_back(
                std::numeric_limits<std::size_t>::max());
            primary_missing_slots.push_back(0);
            primary_categories.push_back(CategoryMass{p_null, q_null});
        }
        if (p_nan + q_nan > 0.0L) {
            primary_category_intervals.push_back(
                std::numeric_limits<std::size_t>::max());
            primary_missing_slots.push_back(1);
            primary_categories.push_back(CategoryMass{p_nan, q_nan});
        }
    }

    const MetricSample primary_sample =
        evaluate_categories(primary_categories, options, "PSI/JS");
    const MetricValue primary_value = evaluate_metric(primary_sample);
    result.primary_defined = primary_sample.defined;
    result.psi = static_cast<double>(primary_value.psi);
    result.js = static_cast<double>(primary_value.js);
    result.js_bits = static_cast<double>(primary_value.js / kLogTwo);
    const MetricBounds primary_bounds =
        metric_error_bounds(primary_sample,
                            p_allocation.unresolved_mass,
                            q_allocation.unresolved_mass,
                            primary_categories.size(),
                            options.zero_floor,
                            options.zero_mass);
    result.psi_error_bound = primary_bounds.psi;
    result.js_error_bound = primary_bounds.js;

    for (std::size_t i = 0; i < primary_categories.size(); ++i) {
        if (primary_missing_slots[i] < 0) {
            IntervalContribution& interval =
                result.intervals[primary_category_intervals[i]];
            interval.p_probability =
                static_cast<double>(primary_sample.p[i]);
            interval.q_probability =
                static_cast<double>(primary_sample.q[i]);
            interval.psi = static_cast<double>(primary_value.psi_cells[i]);
            interval.js = static_cast<double>(primary_value.js_cells[i]);
            interval.p_smoothed = primary_sample.p_smoothed[i];
            interval.q_smoothed = primary_sample.q_smoothed[i];
            interval.included = true;
            continue;
        }

        MissingContribution& contribution =
            primary_missing_slots[i] == 0 ? result.null_contribution
                                          : result.nan_contribution;
        contribution.p_probability =
            static_cast<double>(primary_sample.p[i]);
        contribution.q_probability =
            static_cast<double>(primary_sample.q[i]);
        contribution.psi = static_cast<double>(primary_value.psi_cells[i]);
        contribution.js = static_cast<double>(primary_value.js_cells[i]);
        contribution.p_smoothed = primary_sample.p_smoothed[i];
        contribution.q_smoothed = primary_sample.q_smoothed[i];
        contribution.included = true;
    }

    return result;
}

ComparisonResult try_compare(const Histogram& p,
                             const Histogram& q,
                             const Options& options) noexcept {
    try {
        return compare(p, q, options);
    } catch (const std::exception& error) {
        ComparisonResult result;
        result.ok = false;
        result.error = error.what();
        result.options = options;
        return result;
    } catch (...) {
        ComparisonResult result;
        result.ok = false;
        result.error = "unknown comparison failure";
        result.options = options;
        return result;
    }
}

DistributionComparator::DistributionComparator(Options options)
    : options_(options) {}

ComparisonResult DistributionComparator::compare(const Histogram& p,
                                                 const Histogram& q) const {
    return dataeng::compare(p, q, options_);
}

ComparisonResult DistributionComparator::try_compare(
    const Histogram& p,
    const Histogram& q) const noexcept {
    return dataeng::try_compare(p, q, options_);
}

const Options& DistributionComparator::options() const noexcept {
    return options_;
}

}  // namespace dataeng
