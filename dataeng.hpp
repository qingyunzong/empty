#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace dataeng {

// Policy controlling how update() treats NaN samples.
enum class NanPolicy : std::uint8_t {
  kReject = 0,  // update() returns false and leaves the sketch unchanged.
};

// Weighted KLL quantile sketch over double samples carrying positive integer
// weights. Levels hold (value, weight) entries; an entry at level h
// represents weight * 2^h units of mass, so the total sample weight is
// conserved exactly through compaction and merging. All randomness derives
// from the caller-supplied seed, and the accumulated rank error bound holds
// for any merge order. Signed zeros sort deterministically (-0.0 < +0.0).
class KllSketch {
 public:
  struct Entry {
    double value;
    std::uint64_t weight;  // multiplicity at the entry's level; always >= 1
  };

  static constexpr std::uint32_t kDefaultK = 200;
  static constexpr std::uint32_t kMinK = 8;

  explicit KllSketch(std::uint32_t k = kDefaultK, std::uint64_t seed = 0,
                     NanPolicy nan_policy = NanPolicy::kReject);

  // Adds one sample. Returns false when the value is rejected by the NaN
  // policy. Throws std::invalid_argument when weight == 0.
  bool update(double value, std::uint64_t weight = 1);

  // Merges another sketch (e.g. one shard) into this one. Both sketches must
  // share k and the NaN policy. Throws std::invalid_argument otherwise.
  void merge(const KllSketch& other);

  bool empty() const { return n_ == 0; }
  std::uint64_t total_weight() const { return n_; }
  std::uint32_t k() const { return k_; }
  std::uint64_t seed() const { return seed_; }
  NanPolicy nan_policy() const { return nan_policy_; }
  std::size_t num_levels() const { return levels_.size(); }

  // Throw std::logic_error when the sketch is empty.
  double min() const;
  double max() const;

  // Estimated value at normalized rank r in [0, 1].
  // Throws std::invalid_argument when r is NaN or outside [0, 1].
  double quantile(double r) const;

  // Estimated normalized rank of value, in [0, 1]. Returns 0 when empty.
  // Throws std::invalid_argument when value is NaN.
  double rank(double value) const;

  // Deterministic upper bound on the normalized rank error of any query,
  // accumulated over all compactions; valid for every merge order.
  double rank_error_bound() const;

  // True when the level entries sum exactly to total_weight().
  bool validate_weight_conservation() const;

  // Serializes to a self-contained little-endian byte string.
  std::vector<std::uint8_t> serialize() const;

  // Rebuilds a sketch from serialize() output. Throws std::runtime_error
  // when the payload is malformed or total weight is not conserved.
  static KllSketch deserialize(const std::uint8_t* data, std::size_t size);
  static KllSketch deserialize(const std::vector<std::uint8_t>& bytes);

 private:
  // Total order on stored values; -0.0 sorts strictly before +0.0.
  static bool value_less(double a, double b);

  void compact_level(std::size_t level);
  void compact_if_needed();
  std::uint64_t next_random();

  std::uint32_t k_;
  std::uint64_t seed_;
  NanPolicy nan_policy_;
  std::uint64_t n_ = 0;
  std::uint64_t rng_state_;
  double error_weight_ = 0.0;  // accumulated rank error, in weight units
  std::vector<std::vector<Entry>> levels_{1};
};

}  // namespace dataeng
