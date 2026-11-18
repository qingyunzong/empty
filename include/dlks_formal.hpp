#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <vector>

// Embeddable C++20 quantization components for inference runtimes.
//
// All calibration is deterministic: scales are derived exactly from the
// observed extrema, zero points are rounded half away from zero and clamped
// into the public integer range of the target type, and every encoded value
// is clamped into that same range. For any input x inside the clip window,
// the decode(encode(x)) round-trip error is bounded by scale / 2.
namespace dlks_formal {

enum class quant_mode { symmetric, asymmetric };

template <typename Q>
struct quant_params {
  double scale = 1.0;
  std::int32_t zero_point = 0;

  static constexpr std::int32_t qmin() {
    return static_cast<std::int32_t>(std::numeric_limits<Q>::min());
  }
  static constexpr std::int32_t qmax() {
    return static_cast<std::int32_t>(std::numeric_limits<Q>::max());
  }
};

namespace detail {

// Deterministic round-to-integer (half away from zero), independent of the
// ambient floating-point rounding mode.
inline double round_half_away(double v) { return std::round(v); }

inline std::int32_t clamp_to_i32(double v, std::int32_t lo, std::int32_t hi) {
  double r = round_half_away(v);
  if (r < static_cast<double>(lo)) return lo;
  if (r > static_cast<double>(hi)) return hi;
  return static_cast<std::int32_t>(r);
}

}  // namespace detail

// Calibrate asymmetric parameters. The observed range is first padded to
// include zero (so the zero point always lands inside [qmin, qmax] and the
// representable range always covers the observed extrema), then the scale
// spans the full integer range exactly.
template <typename Q>
constexpr quant_params<Q> calibrate_asymmetric(double min_val, double max_val) {
  using P = quant_params<Q>;
  const double lo = std::min(min_val, 0.0);
  const double hi = std::max(max_val, 0.0);
  const double range = hi - lo;
  const double span = static_cast<double>(P::qmax()) - static_cast<double>(P::qmin());
  const double scale = range > 0.0 ? range / span : 1.0;
  const double zp = static_cast<double>(P::qmin()) - lo / scale;
  P p;
  p.scale = scale;
  p.zero_point = detail::clamp_to_i32(zp, P::qmin(), P::qmax());
  return p;
}

// Calibrate symmetric parameters: scale is set by the largest magnitude
// extremum and the zero point is pinned to zero. Symmetric quantization
// requires a signed integer type so that both polarities are representable.
template <typename Q>
constexpr quant_params<Q> calibrate_symmetric(double min_val, double max_val) {
  static_assert(std::is_signed_v<Q>,
                "symmetric quantization requires a signed integer type");
  using P = quant_params<Q>;
  const double abs_max = std::max(std::fabs(min_val), std::fabs(max_val));
  const double q_abs = static_cast<double>(
      std::min(-static_cast<std::int64_t>(P::qmin()),
               static_cast<std::int64_t>(P::qmax())));
  P p;
  p.scale = abs_max > 0.0 ? abs_max / q_abs : 1.0;
  p.zero_point = 0;
  return p;
}

template <typename Q>
constexpr quant_params<Q> calibrate(quant_mode mode, double min_val, double max_val) {
  if constexpr (std::is_signed_v<Q>) {
    if (mode == quant_mode::symmetric)
      return calibrate_symmetric<Q>(min_val, max_val);
  } else if (mode == quant_mode::symmetric) {
    throw std::invalid_argument(
        "symmetric quantization requires a signed integer type");
  }
  return calibrate_asymmetric<Q>(min_val, max_val);
}

// A quantizer bundles parameters with a clip window. Values are clipped into
// [clip_lo, clip_hi] before encoding; both bounds and the zero point always
// stay within the public integer range of Q.
template <typename Q>
struct quantizer {
  quant_params<Q> params;
  double clip_lo;
  double clip_hi;

  Q encode(double x) const {
    const double clipped = std::clamp(x, clip_lo, clip_hi);
    const double scaled = clipped / params.scale + static_cast<double>(params.zero_point);
    return static_cast<Q>(detail::clamp_to_i32(scaled, quant_params<Q>::qmin(),
                                               quant_params<Q>::qmax()));
  }

  double decode(Q q) const {
    return params.scale * (static_cast<double>(q) - static_cast<double>(params.zero_point));
  }

  // Guaranteed bound on decode(encode(x)) - x for any finite x.
  double error_bound() const { return params.scale / 2.0; }
};

// Build a quantizer from observed extrema. The clip window defaults to the
// observed range; an explicit window is intersected with it so clipping can
// never push an encoded value outside the integer range of Q.
template <typename Q>
quantizer<Q> make_quantizer(quant_mode mode, double min_val, double max_val) {
  return {calibrate<Q>(mode, min_val, max_val), min_val, max_val};
}

template <typename Q>
quantizer<Q> make_quantizer(quant_mode mode, double min_val, double max_val,
                            double clip_lo, double clip_hi) {
  const double lo = std::max(min_val, clip_lo);
  const double hi = std::min(max_val, clip_hi);
  if (lo > hi) throw std::invalid_argument("clip window excludes the observed range");
  return {calibrate<Q>(mode, lo, hi), lo, hi};
}

// Per-channel calibration over a channel-major tensor: `channels` slices of
// `channel_size` consecutive elements each.
template <typename Q>
std::vector<quantizer<Q>> calibrate_per_channel(std::span<const double> data,
                                                std::size_t channels,
                                                std::size_t channel_size,
                                                quant_mode mode) {
  if (data.size() != channels * channel_size)
    throw std::invalid_argument("tensor size does not match channel layout");
  std::vector<quantizer<Q>> out;
  out.reserve(channels);
  for (std::size_t c = 0; c < channels; ++c) {
    const auto slice = data.subspan(c * channel_size, channel_size);
    const auto [it_min, it_max] = std::minmax_element(slice.begin(), slice.end());
    out.push_back(make_quantizer<Q>(mode, *it_min, *it_max));
  }
  return out;
}

// Same, with an explicit clip window applied to every channel.
template <typename Q>
std::vector<quantizer<Q>> calibrate_per_channel(std::span<const double> data,
                                                std::size_t channels,
                                                std::size_t channel_size,
                                                quant_mode mode, double clip_lo,
                                                double clip_hi) {
  if (data.size() != channels * channel_size)
    throw std::invalid_argument("tensor size does not match channel layout");
  std::vector<quantizer<Q>> out;
  out.reserve(channels);
  for (std::size_t c = 0; c < channels; ++c) {
    const auto slice = data.subspan(c * channel_size, channel_size);
    const auto [it_min, it_max] = std::minmax_element(slice.begin(), slice.end());
    out.push_back(make_quantizer<Q>(mode, *it_min, *it_max, clip_lo, clip_hi));
  }
  return out;
}

// Encode a channel-major tensor, switching quantizers at channel boundaries.
template <typename Q>
std::vector<Q> encode_per_channel(std::span<const double> data,
                                  std::span<const quantizer<Q>> quants,
                                  std::size_t channel_size) {
  if (data.size() != quants.size() * channel_size)
    throw std::invalid_argument("tensor size does not match quantizer layout");
  std::vector<Q> out(data.size());
  for (std::size_t c = 0; c < quants.size(); ++c)
    for (std::size_t i = 0; i < channel_size; ++i)
      out[c * channel_size + i] = quants[c].encode(data[c * channel_size + i]);
  return out;
}

}  // namespace dlks_formal
