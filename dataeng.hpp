#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace dataeng {

struct Histogram {
    std::vector<double> edges;
    std::vector<double> counts;
    double null_count = 0.0;
    double nan_count = 0.0;
};

enum class MissingPolicy {
    IncludeAsCategories,
    Exclude
};

enum class InfiniteBinPolicy {
    CollapseToBoundary,
    SplitEvenly,
    Reject
};

enum class ZeroMassPolicy {
    FloorAndRenormalize,
    Reject
};

struct Options {
    double zero_floor = 1e-6;
    MissingPolicy missing = MissingPolicy::IncludeAsCategories;
    InfiniteBinPolicy infinite = InfiniteBinPolicy::CollapseToBoundary;
    ZeroMassPolicy zero_mass = ZeroMassPolicy::FloorAndRenormalize;
};

struct ValidationResult {
    bool ok = true;
    std::string message;
};

ValidationResult validate(const Histogram& histogram);

struct IntervalContribution {
    double lower = 0.0;
    double upper = 0.0;
    double p_mass = 0.0;
    double q_mass = 0.0;
    double p_probability = 0.0;
    double q_probability = 0.0;
    double psi = 0.0;
    double js = 0.0;
    double numeric_p_probability = 0.0;
    double numeric_q_probability = 0.0;
    double numeric_psi = 0.0;
    double numeric_js = 0.0;
    double p_mass_error_bound = 0.0;
    double q_mass_error_bound = 0.0;
    bool p_smoothed = false;
    bool q_smoothed = false;
    bool included = false;
};

enum class MissingKind {
    Null,
    NaN
};

struct MissingContribution {
    MissingKind kind = MissingKind::Null;
    double p_count = 0.0;
    double q_count = 0.0;
    double p_probability = 0.0;
    double q_probability = 0.0;
    double psi = 0.0;
    double js = 0.0;
    double missing_p_probability = 0.0;
    double missing_q_probability = 0.0;
    double missing_psi = 0.0;
    double missing_js = 0.0;
    bool p_smoothed = false;
    bool q_smoothed = false;
    bool included = false;
};

struct ComparisonResult {
    bool ok = false;
    std::string error;
    Options options;

    double psi = 0.0;
    double js = 0.0;
    double js_bits = 0.0;
    double numeric_psi = 0.0;
    double numeric_js = 0.0;
    double numeric_js_bits = 0.0;
    double missing_psi = 0.0;
    double missing_js = 0.0;
    double missing_js_bits = 0.0;

    double p_numeric_mass = 0.0;
    double q_numeric_mass = 0.0;
    double p_null_count = 0.0;
    double q_null_count = 0.0;
    double p_nan_count = 0.0;
    double q_nan_count = 0.0;
    double p_total_mass = 0.0;
    double q_total_mass = 0.0;
    double p_primary_mass = 0.0;
    double q_primary_mass = 0.0;
    double p_null_fraction = 0.0;
    double q_null_fraction = 0.0;
    double p_nan_fraction = 0.0;
    double q_nan_fraction = 0.0;

    double p_unresolved_mass = 0.0;
    double q_unresolved_mass = 0.0;
    double psi_error_bound = 0.0;
    double js_error_bound = 0.0;
    double numeric_psi_error_bound = 0.0;
    double numeric_js_error_bound = 0.0;

    bool p_empty = false;
    bool q_empty = false;
    bool primary_defined = false;
    bool numeric_defined = false;
    bool missing_defined = false;

    std::vector<IntervalContribution> intervals;
    MissingContribution null_contribution;
    MissingContribution nan_contribution;
};

ComparisonResult compare(const Histogram& p,
                         const Histogram& q,
                         const Options& options = {});

ComparisonResult try_compare(const Histogram& p,
                             const Histogram& q,
                             const Options& options = {}) noexcept;

class DistributionComparator {
public:
    explicit DistributionComparator(Options options = {});

    ComparisonResult compare(const Histogram& p,
                             const Histogram& q) const;

    ComparisonResult try_compare(const Histogram& p,
                                 const Histogram& q) const noexcept;

    const Options& options() const noexcept;

private:
    Options options_;
};

}  // namespace dataeng
