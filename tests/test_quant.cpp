#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <span>
#include <type_traits>
#include <vector>

#include "dlks_formal.hpp"

namespace {

int g_failures = 0;
int g_checks = 0;

// Symmetric quantization is only defined for signed integer types.
template <typename Q>
std::vector<dlks_formal::quant_mode> modes_for() {
  if constexpr (std::is_signed_v<Q>)
    return {dlks_formal::quant_mode::symmetric,
            dlks_formal::quant_mode::asymmetric};
  else
    return {dlks_formal::quant_mode::asymmetric};
}

#define CHECK(cond)                                                  \
  do {                                                               \
    ++g_checks;                                                      \
    if (!(cond)) {                                                   \
      ++g_failures;                                                  \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,   \
                   #cond);                                           \
    }                                                                \
  } while (0)

// Naive per-value reference implementation, written independently of the
// library: clip, scale, shift, round half away from zero, clamp to the
// public integer range. Uses the same double arithmetic so encodings must
// match bit for bit.
template <typename Q>
Q ref_encode(double x, double scale, std::int32_t zp, double lo, double hi) {
  const double qmin = static_cast<double>(std::numeric_limits<Q>::min());
  const double qmax = static_cast<double>(std::numeric_limits<Q>::max());
  double v = x;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  double s = std::round(v / scale + static_cast<double>(zp));
  if (s < qmin) s = qmin;
  if (s > qmax) s = qmax;
  return static_cast<Q>(s);
}

// High-precision (long double) round-trip error of the library pipeline.
template <typename Q>
long double ref_error(const dlks_formal::quantizer<Q>& qz, double x) {
  const long double lo = qz.clip_lo;
  const long double hi = qz.clip_hi;
  long double v = x;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  const Q q = qz.encode(x);
  const long double dec =
      static_cast<long double>(qz.params.scale) *
      (static_cast<long double>(q) - static_cast<long double>(qz.params.zero_point));
  return fabsl(dec - v);
}

template <typename Q>
void check_quantizer(const dlks_formal::quantizer<Q>& qz,
                     const std::vector<double>& probe) {
  using P = dlks_formal::quant_params<Q>;
  // Zero point inside the public integer bounds.
  CHECK(qz.params.zero_point >= P::qmin());
  CHECK(qz.params.zero_point <= P::qmax());
  CHECK(qz.params.scale > 0.0);
  for (double x : probe) {
    const Q got = qz.encode(x);
    // Encoded value inside the public integer bounds.
    CHECK(static_cast<std::int32_t>(got) >= P::qmin());
    CHECK(static_cast<std::int32_t>(got) <= P::qmax());
    // Exact match against the naive reference encoding.
    const Q want = ref_encode<Q>(x, qz.params.scale, qz.params.zero_point,
                                 qz.clip_lo, qz.clip_hi);
    CHECK(got == want);
    // Bounded, deterministic round-trip error in high precision.
    const long double err = ref_error(qz, x);
    const long double bound =
        static_cast<long double>(qz.error_bound()) + 1e-12L;
    CHECK(err <= bound);
  }
}

// Exact scale derivation from the actual extrema.
template <typename Q>
void check_scale_exact(dlks_formal::quant_mode mode, double lo, double hi,
                       const dlks_formal::quantizer<Q>& qz) {
  using P = dlks_formal::quant_params<Q>;
  if (mode == dlks_formal::quant_mode::asymmetric) {
    const double span =
        static_cast<double>(P::qmax()) - static_cast<double>(P::qmin());
    const double eff_lo = std::min(lo, 0.0);
    const double eff_hi = std::max(hi, 0.0);
    const double want = (eff_hi - eff_lo) > 0.0 ? (eff_hi - eff_lo) / span : 1.0;
    CHECK(qz.params.scale == want);
  } else {
    const double abs_max = std::max(std::fabs(lo), std::fabs(hi));
    const double q_abs = static_cast<double>(std::min(
        -static_cast<std::int64_t>(P::qmin()), static_cast<std::int64_t>(P::qmax())));
    const double want = abs_max > 0.0 ? abs_max / q_abs : 1.0;
    CHECK(qz.params.scale == want);
    CHECK(qz.params.zero_point == 0);
  }
}

template <typename Q>
void exhaustive_per_tensor() {
  const std::vector<double> pool = {-3.5, -1.25, -0.5, 0.0, 0.5, 1.75, 4.0};
  const std::vector<double> probe = {-5.0, -3.5, -1.25, -0.75, -0.5, -0.25,
                                     0.0,  0.25, 0.5,   1.0,  1.75, 4.0, 9.0};
  for (dlks_formal::quant_mode mode : modes_for<Q>()) {
    // Exhaustive 3-element tensors over the pool: extrema are the actual
    // min/max of each tensor.
    for (double a : pool)
      for (double b : pool)
        for (double c : pool) {
          const double mn = std::min({a, b, c});
          const double mx = std::max({a, b, c});
          // No clipping.
          auto qz = dlks_formal::make_quantizer<Q>(mode, mn, mx);
          CHECK(qz.clip_lo == mn && qz.clip_hi == mx);
          check_scale_exact<Q>(mode, mn, mx, qz);
          check_quantizer<Q>(qz, probe);
          // Exhaustive clip windows from the pool, intersected with [mn, mx].
          for (double clo : pool)
            for (double chi : pool) {
              if (clo > chi) continue;
              if (std::max(mn, clo) > std::min(mx, chi)) continue;
              auto qc = dlks_formal::make_quantizer<Q>(mode, mn, mx, clo, chi);
              const double lo = std::max(mn, clo);
              const double hi = std::min(mx, chi);
              CHECK(qc.clip_lo == lo && qc.clip_hi == hi);
              check_scale_exact<Q>(mode, lo, hi, qc);
              check_quantizer<Q>(qc, probe);
            }
        }
  }
}

// Interleave channel switches and clipping: every element is encoded with
// its own channel's clipped quantizer and must stay in bounds.
template <typename Q>
void exhaustive_per_channel() {
  const std::vector<double> pool = {-2.0, -0.5, 0.0, 0.5, 3.0};
  const std::vector<double> clips = {-2.0, -0.5, 0.0, 0.5, 3.0};
  constexpr std::size_t kChannels = 2;
  constexpr std::size_t kSize = 2;
  for (dlks_formal::quant_mode mode : modes_for<Q>()) {
    for (double a : pool)
      for (double b : pool)
        for (double c : pool)
          for (double d : pool)
            for (double clo : clips)
              for (double chi : clips) {
                if (clo > chi) continue;
                const std::vector<double> tensor = {a, b, c, d};
                const double mn0 = std::min(a, b), mx0 = std::max(a, b);
                const double mn1 = std::min(c, d), mx1 = std::max(c, d);
                if (std::max(mn0, clo) > std::min(mx0, chi)) continue;
                if (std::max(mn1, clo) > std::min(mx1, chi)) continue;
                auto quants = dlks_formal::calibrate_per_channel<Q>(
                    std::span<const double>(tensor), kChannels, kSize, mode,
                    clo, chi);
                CHECK(quants.size() == kChannels);
                auto enc = dlks_formal::encode_per_channel<Q>(
                    std::span<const double>(tensor),
                    std::span<const dlks_formal::quantizer<Q>>(quants), kSize);
                CHECK(enc.size() == tensor.size());
                using P = dlks_formal::quant_params<Q>;
                for (std::size_t ch = 0; ch < kChannels; ++ch) {
                  for (std::size_t i = 0; i < kSize; ++i) {
                    const std::size_t idx = ch * kSize + i;
                    // Channel switching picks the right quantizer.
                    CHECK(enc[idx] == quants[ch].encode(tensor[idx]));
                    CHECK(static_cast<std::int32_t>(enc[idx]) >= P::qmin());
                    CHECK(static_cast<std::int32_t>(enc[idx]) <= P::qmax());
                    const long double err = ref_error(quants[ch], tensor[idx]);
                    CHECK(err <= static_cast<long double>(
                                     quants[ch].error_bound()) +
                                     1e-12L);
                  }
                }
              }
  }
}

template <typename Q>
void edge_cases() {
  // Constant tensor: degenerate range must still encode safely.
  check_quantizer<Q>(dlks_formal::make_quantizer<Q>(
                         dlks_formal::quant_mode::asymmetric, 2.5, 2.5),
                     {2.5, 2.5, 2.5});
  if constexpr (std::is_signed_v<Q>) {
    check_quantizer<Q>(dlks_formal::make_quantizer<Q>(
                           dlks_formal::quant_mode::symmetric, 0.0, 0.0),
                       {0.0, 1.0, -1.0});
  }
  // Values far outside the clip window clamp instead of overflowing.
  auto narrow = dlks_formal::make_quantizer<Q>(
      dlks_formal::quant_mode::asymmetric, -1.0, 1.0);
  check_quantizer<Q>(narrow, {-1e30, 1e30, -0.0});
}

}  // namespace

int main() {
  exhaustive_per_tensor<std::int8_t>();
  exhaustive_per_tensor<std::uint8_t>();
  exhaustive_per_tensor<std::int16_t>();
  exhaustive_per_channel<std::int8_t>();
  exhaustive_per_channel<std::uint8_t>();
  exhaustive_per_channel<std::int16_t>();
  edge_cases<std::int8_t>();
  edge_cases<std::uint8_t>();
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
