#include "dataeng.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

void check_near(double actual,
                double expected,
                double tolerance,
                const std::string& message) {
    if (!(std::fabs(actual - expected) <= tolerance)) {
        std::cerr << "FAIL: " << message << " actual=" << actual
                  << " expected=" << expected << '\n';
        ++failures;
    }
}

double probability_sum(const dataeng::ComparisonResult& result) {
    double sum = 0.0;
    for (const auto& interval : result.intervals) {
        sum += interval.p_probability;
    }
    if (result.null_contribution.included) {
        sum += result.null_contribution.p_probability;
    }
    if (result.nan_contribution.included) {
        sum += result.nan_contribution.p_probability;
    }
    return sum;
}

double contribution_sum(const dataeng::ComparisonResult& result, bool numeric) {
    double sum = 0.0;
    for (const auto& interval : result.intervals) {
        sum += numeric ? interval.numeric_psi : interval.psi;
    }
    if (!numeric) {
        if (result.null_contribution.included) {
            sum += result.null_contribution.psi;
        }
        if (result.nan_contribution.included) {
            sum += result.nan_contribution.psi;
        }
    }
    return sum;
}

dataeng::Histogram histogram(std::vector<double> edges,
                             std::vector<double> counts,
                             double null_count = 0.0,
                             double nan_count = 0.0) {
    dataeng::Histogram value;
    value.edges = std::move(edges);
    value.counts = std::move(counts);
    value.null_count = null_count;
    value.nan_count = nan_count;
    return value;
}

void test_validation() {
    check(!dataeng::validate(histogram({0.0}, {1.0})).ok,
          "single edge is rejected");
    check(!dataeng::validate(histogram({0.0, 1.0}, {1.0, 2.0})).ok,
          "count/edge mismatch is rejected");
    check(!dataeng::validate(histogram({0.0, 0.0}, {1.0})).ok,
          "duplicate edges are rejected");
    check(!dataeng::validate(histogram({0.0, 1.0}, {-1.0})).ok,
          "negative count is rejected");
    check(!dataeng::validate(
               histogram({0.0, std::numeric_limits<double>::infinity(), 2.0},
                         {1.0, 1.0}))
               .ok,
          "interior infinity is rejected");
    check(!dataeng::validate(histogram({0.0, 1.0}, {1.0}, -1.0)).ok,
          "negative null count is rejected");
    check(!dataeng::validate(histogram({0.0, 1.0}, {1.0}, 0.0, -1.0)).ok,
          "negative NaN count is rejected");
    check(dataeng::validate(histogram(
              {-std::numeric_limits<double>::infinity(),
               0.0,
               std::numeric_limits<double>::infinity()},
              {1.0, 2.0}))
              .ok,
          "open-ended histogram is valid");
}

void test_identical_and_uniform_rebinning() {
    const auto p = histogram({0.0, 2.0, 4.0}, {10.0, 10.0});
    const auto q = histogram({0.0, 1.0, 3.0, 4.0}, {5.0, 10.0, 5.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "uniform rebin comparison succeeds");
    check(result.intervals.size() == 4, "union has four intervals");
    check_near(result.psi, 0.0, 1e-14, "uniform rebin PSI is zero");
    check_near(result.js, 0.0, 1e-14, "uniform rebin JS is zero");
    for (const auto& interval : result.intervals) {
        check_near(interval.p_mass, 5.0, 1e-12,
                   "coarse histogram mass is split by width");
        check_near(interval.q_mass, 5.0, 1e-12,
                   "fine histogram mass is retained");
    }
}

void test_known_divergence() {
    const auto p = histogram({0.0, 1.0, 2.0}, {50.0, 50.0});
    const auto q = histogram({0.0, 1.0, 2.0}, {25.0, 75.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "known divergence comparison succeeds");
    check_near(result.psi, 0.27465307216702745, 1e-12,
               "PSI matches the analytic value");
    check_near(result.js, 0.033822075568605205, 1e-12,
               "JS matches the analytic value");
    check_near(result.js_bits, 0.0487949406953985, 1e-12,
               "JS bits match the analytic value");
    check_near(contribution_sum(result, false), result.psi, 1e-14,
               "interval PSI contributions sum to the total");
    check_near(probability_sum(result), 1.0, 1e-12,
               "primary probabilities sum to one");
}

void test_infinite_collapse() {
    const auto p = histogram(
        {-std::numeric_limits<double>::infinity(), 0.0}, {10.0});
    const auto q = histogram(
        {-std::numeric_limits<double>::infinity(), -1.0, 0.0}, {4.0, 6.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "collapsed infinite tail comparison succeeds");
    check(result.intervals.size() == 2, "union has two tail intervals");
    check_near(result.intervals[0].p_mass, 0.0, 1e-15,
               "lower tail is collapsed toward the finite boundary");
    check_near(result.intervals[1].p_mass, 10.0, 1e-15,
               "all unbounded mass lands in the adjacent interval");
    check_near(result.intervals[0].p_mass_error_bound, 10.0, 1e-15,
               "unresolved lower-tail mass is exposed");
    check_near(result.intervals[1].p_mass_error_bound, 10.0, 1e-15,
               "adjacent lower-tail interval carries the same bound");
    check_near(result.p_unresolved_mass, 10.0, 1e-15,
               "unresolved mass is aggregated");
    check(result.psi > 0.0, "collapsed tails can produce divergence");
    check(result.psi_error_bound > 0.0,
          "unresolved mass produces a metric error bound");

    dataeng::Options even;
    even.infinite = dataeng::InfiniteBinPolicy::SplitEvenly;
    const auto even_result = dataeng::compare(p, q, even);
    check_near(even_result.intervals[0].p_mass, 5.0, 1e-15,
               "SplitEvenly splits the lower tail equally");
    check_near(even_result.intervals[1].p_mass, 5.0, 1e-15,
               "SplitEvenly splits the lower tail equally");

    dataeng::Options reject;
    reject.infinite = dataeng::InfiniteBinPolicy::Reject;
    const auto rejected = dataeng::try_compare(p, q, reject);
    check(!rejected.ok, "Reject refuses a split unbounded bucket");

    dataeng::Options split_reject_zero;
    split_reject_zero.infinite = dataeng::InfiniteBinPolicy::SplitEvenly;
    split_reject_zero.zero_mass = dataeng::ZeroMassPolicy::Reject;
    const auto unbounded_bound =
        dataeng::compare(p, q, split_reject_zero);
    check(std::isinf(unbounded_bound.psi_error_bound),
          "Reject zero policy makes an unresolved metric bound infinite");
}

void test_fully_unbounded() {
    const auto p = histogram(
        {-std::numeric_limits<double>::infinity(),
         std::numeric_limits<double>::infinity()},
        {3.0});
    const auto q = histogram({0.0, 1.0}, {1.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "fully unbounded comparison succeeds");
    check(result.intervals.size() == 3, "fully unbounded bin is split");
    check_near(result.intervals[0].p_mass, 1.0, 1e-15,
               "fully unbounded mass is split evenly");
    check_near(result.intervals[1].p_mass, 1.0, 1e-15,
               "fully unbounded mass is split evenly");
    check_near(result.intervals[2].p_mass, 1.0, 1e-15,
               "fully unbounded mass is split evenly");
    check_near(result.p_unresolved_mass, 3.0, 1e-15,
               "fully unbounded mass is unresolved");
}

void test_both_tails_and_mass_conservation() {
    const auto p = histogram(
        {-std::numeric_limits<double>::infinity(),
         0.0,
         1.0,
         std::numeric_limits<double>::infinity()},
        {10.0, 20.0, 30.0});
    const auto q = histogram(
        {-std::numeric_limits<double>::infinity(),
         -1.0,
         0.0,
         2.0,
         std::numeric_limits<double>::infinity()},
        {5.0, 10.0, 20.0, 25.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "two-sided tail comparison succeeds");
    check(result.intervals.size() == 5, "tail union has five intervals");
    check_near(result.intervals[0].p_mass, 0.0, 1e-15,
               "lower tail is collapsed inward");
    check_near(result.intervals[1].p_mass, 10.0, 1e-15,
               "lower-tail mass lands at the finite edge");
    check_near(result.intervals[2].p_mass, 20.0, 1e-15,
               "finite bucket mass is preserved");
    check_near(result.intervals[3].p_mass, 30.0, 1e-15,
               "upper-tail mass lands at the finite edge");
    check_near(result.intervals[4].p_mass, 0.0, 1e-15,
               "upper tail is collapsed inward");
    check_near(result.intervals[0].q_mass, 5.0, 1e-15,
               "finite tail bucket is preserved");
    check_near(result.intervals[4].q_mass, 25.0, 1e-15,
               "finite upper bucket is preserved");
    check_near(result.p_numeric_mass, 60.0, 1e-15,
               "P mass is conserved across tails");
    check_near(result.q_numeric_mass, 60.0, 1e-15,
               "Q mass is conserved across tails");
    check_near(result.p_unresolved_mass, 40.0, 1e-15,
               "P tail uncertainty is aggregated");
    check_near(result.q_unresolved_mass, 0.0, 0.0,
               "Q has no split unbounded bucket");
}

void test_missing_categories() {
    const auto p = histogram({0.0, 1.0, 2.0}, {90.0, 10.0}, 5.0, 5.0);
    const auto q = histogram({0.0, 1.0, 2.0}, {80.0, 10.0}, 10.0, 0.0);
    const auto included = dataeng::compare(p, q);

    check(included.ok, "missing-category comparison succeeds");
    check(included.null_contribution.included,
          "null is included in the primary metric by default");
    check(included.nan_contribution.included,
          "NaN is included in the primary metric by default");
    check(included.nan_contribution.q_smoothed,
          "zero NaN mass is floored");
    check_near(included.p_null_fraction, 5.0 / 110.0, 1e-15,
               "null fraction uses numeric and missing mass");
    check_near(included.p_nan_fraction, 5.0 / 110.0, 1e-15,
               "NaN fraction uses numeric and missing mass");
    check_near(included.null_contribution.p_probability, 5.0 / 110.0, 1e-15,
               "null category probability uses the complete denominator");
    check_near(probability_sum(included), 1.0, 1e-12,
               "primary probabilities include missing categories");
    check(included.missing_defined, "missing-only metric is defined");
    check(included.missing_psi > 0.0,
          "missing-only PSI detects the missing-rate drift");

    dataeng::Options exclude;
    exclude.missing = dataeng::MissingPolicy::Exclude;
    const auto numeric = dataeng::compare(p, q, exclude);
    check(numeric.ok, "numeric-only comparison succeeds");
    check(!numeric.null_contribution.included,
          "null is excluded from the primary metric");
    check(!numeric.nan_contribution.included,
          "NaN is excluded from the primary metric");
    check_near(numeric.psi, numeric.numeric_psi, 1e-15,
               "primary metric equals numeric metric when missing is excluded");
    check(numeric.missing_defined,
          "missing-only metric remains available when excluded");
}

void test_zero_mass_rules() {
    const auto p = histogram({0.0, 1.0}, {10.0});
    const auto q = histogram({1.0, 2.0}, {10.0});
    const auto result = dataeng::compare(p, q);

    check(result.ok, "disjoint support comparison succeeds");
    check(result.intervals[0].q_smoothed,
          "zero mass in Q is floored");
    check(result.intervals[0].p_smoothed == false,
          "nonzero mass in P is not floored");
    check(result.intervals[1].p_smoothed,
          "zero mass in P is floored");
    check(result.psi > 20.0, "disjoint support has a large PSI");
    check_near(probability_sum(result), 1.0, 1e-12,
               "floored probabilities are renormalized");

    dataeng::Options reject;
    reject.zero_mass = dataeng::ZeroMassPolicy::Reject;
    const auto rejected = dataeng::try_compare(p, q, reject);
    check(!rejected.ok, "Reject refuses a zero-mass aligned category");

    const auto empty_bin = histogram({0.0, 1.0, 2.0, 3.0}, {10.0, 0.0, 10.0});
    const auto zero_zero = dataeng::compare(empty_bin, empty_bin);
    check(zero_zero.ok, "zero-zero intervals are allowed");
    check(!zero_zero.intervals[1].included,
          "zero-zero interval is excluded from normalization");
    check_near(probability_sum(zero_zero), 1.0, 1e-12,
               "zero-zero interval does not dilute probabilities");
}

void test_empty_distribution_rules() {
    const auto empty = histogram({0.0, 1.0, 2.0}, {0.0, 0.0});
    const auto q = histogram({0.0, 1.0, 2.0}, {10.0, 30.0});
    const auto result = dataeng::compare(empty, q);

    check(result.ok, "empty distribution comparison succeeds");
    check(result.p_empty, "empty side is marked");
    check(result.primary_defined, "empty side is smoothed to a valid distribution");
    check_near(result.intervals[0].p_probability, 0.5, 1e-12,
               "empty side becomes uniform over active categories");
    check_near(result.intervals[1].p_probability, 0.5, 1e-12,
               "empty side becomes uniform over active categories");
    check_near(result.psi, 0.27465307216702745, 1e-12,
               "empty-side PSI uses the uniform convention");

    const auto both_empty = dataeng::compare(empty, empty);
    check(both_empty.ok, "two empty distributions compare");
    check(!both_empty.primary_defined,
          "two empty distributions have no defined metric");
    check_near(both_empty.psi, 0.0, 0.0,
               "two empty distributions have zero PSI");

    dataeng::Options missing_only;
    missing_only.missing = dataeng::MissingPolicy::Exclude;
    const auto p_missing = histogram({0.0, 1.0}, {0.0}, 5.0);
    const auto q_missing = histogram({0.0, 1.0}, {0.0}, 5.0);
    const auto excluded = dataeng::compare(p_missing, q_missing, missing_only);
    check(!excluded.primary_defined,
          "excluded missing mass leaves no primary metric");
    check(excluded.missing_defined,
          "missing-only metric remains defined");
}

void test_errors_and_aliases() {
    const auto invalid = histogram({1.0, 0.0}, {1.0});
    const auto valid = histogram({0.0, 1.0}, {1.0});
    check(!dataeng::try_compare(invalid, valid).ok,
          "try_compare reports invalid input");

    bool threw = false;
    try {
        (void)dataeng::compare(invalid, valid);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    check(threw, "compare throws on invalid input");

    dataeng::DistributionComparator comparator;
    const auto result = comparator.compare(valid, valid);
    check(result.ok, "DistributionComparator delegates correctly");
    check_near(comparator.options().zero_floor, 1e-6, 0.0,
               "DistributionComparator exposes its options");
}

void test_random_properties() {
    std::mt19937 generator(20261115U);
    std::uniform_int_distribution<int> bin_count(1, 8);
    std::uniform_real_distribution<double> width(0.1, 5.0);
    std::uniform_real_distribution<double> count(0.0, 100.0);

    for (int iteration = 0; iteration < 100; ++iteration) {
        const int p_bins = bin_count(generator);
        const int q_bins = bin_count(generator);

        dataeng::Histogram p;
        p.edges.push_back(0.0);
        for (int i = 0; i < p_bins; ++i) {
            p.edges.push_back(p.edges.back() + width(generator));
            p.counts.push_back(count(generator));
        }
        p.null_count = (iteration % 3 == 0) ? 0.0 : count(generator);
        p.nan_count = (iteration % 5 == 0) ? 0.0 : count(generator);

        dataeng::Histogram q;
        q.edges.push_back(0.0);
        for (int i = 0; i < q_bins; ++i) {
            q.edges.push_back(q.edges.back() + width(generator));
            q.counts.push_back(count(generator));
        }
        q.null_count = (iteration % 4 == 0) ? 0.0 : count(generator);
        q.nan_count = (iteration % 6 == 0) ? 0.0 : count(generator);

        const auto result = dataeng::try_compare(p, q);
        check(result.ok, "random finite comparison succeeds");

        double p_mass = 0.0;
        double q_mass = 0.0;
        for (const auto& interval : result.intervals) {
            p_mass += interval.p_mass;
            q_mass += interval.q_mass;
        }
        check_near(p_mass, result.p_numeric_mass, 1e-10,
                   "P numeric mass is conserved");
        check_near(q_mass, result.q_numeric_mass, 1e-10,
                   "Q numeric mass is conserved");
        check_near(result.p_unresolved_mass, 0.0, 0.0,
                   "finite buckets have no unresolved mass");
        check_near(result.psi_error_bound, 0.0, 0.0,
                   "finite buckets have no metric error bound");
        check_near(result.psi, contribution_sum(result, false), 1e-12,
                   "random primary contributions sum to PSI");
        check_near(result.numeric_psi, contribution_sum(result, true), 1e-12,
                   "random numeric contributions sum to numeric PSI");
        check(result.psi >= 0.0, "random PSI is non-negative");
        check(result.js >= 0.0, "random JS is non-negative");
        if (result.primary_defined) {
            check_near(probability_sum(result), 1.0, 1e-10,
                       "random probabilities sum to one");
        }

        const auto reverse = dataeng::try_compare(q, p);
        check_near(result.psi, reverse.psi, 1e-10,
                   "PSI is symmetric");
        check_near(result.js, reverse.js, 1e-10,
                   "JS is symmetric");

        const auto self = dataeng::try_compare(p, p);
        check_near(self.psi, 0.0, 1e-14, "self PSI is zero");
        check_near(self.js, 0.0, 1e-14, "self JS is zero");
    }
}

}  // namespace

int main() {
    test_validation();
    test_identical_and_uniform_rebinning();
    test_known_divergence();
    test_infinite_collapse();
    test_fully_unbounded();
    test_both_tails_and_mass_conservation();
    test_missing_categories();
    test_zero_mass_rules();
    test_empty_distribution_rules();
    test_errors_and_aliases();
    test_random_properties();

    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all dataeng tests passed\n";
    return EXIT_SUCCESS;
}
