#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>
#include <stdexcept>

namespace dataeng {
namespace {

constexpr std::uint8_t kMagic[4] = {'K', 'L', 'L', '1'};
constexpr std::size_t kMaxLevels = 64;

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i)
    out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_u64(std::vector<std::uint8_t>& out, std::uint64_t v) {
  for (int i = 0; i < 8; ++i)
    out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_f64(std::vector<std::uint8_t>& out, double v) {
  std::uint64_t bits;
  std::memcpy(&bits, &v, sizeof(bits));
  put_u64(out, bits);
}

class Reader {
 public:
  Reader(const std::uint8_t* data, std::size_t size) : data_(data), size_(size) {}

  std::uint8_t u8() {
    need(1);
    return data_[pos_++];
  }
  std::uint32_t u32() {
    need(4);
    std::uint32_t v = 0;
    for (int i = 0; i < 4; ++i) v |= static_cast<std::uint32_t>(data_[pos_++]) << (8 * i);
    return v;
  }
  std::uint64_t u64() {
    need(8);
    std::uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<std::uint64_t>(data_[pos_++]) << (8 * i);
    return v;
  }
  double f64() {
    const std::uint64_t bits = u64();
    double v;
    std::memcpy(&v, &bits, sizeof(v));
    return v;
  }
  bool done() const { return pos_ == size_; }

 private:
  void need(std::size_t n) {
    if (size_ - pos_ < n) throw std::runtime_error("kll: truncated payload");
  }

  const std::uint8_t* data_;
  std::size_t size_;
  std::size_t pos_ = 0;
};

}  // namespace

KllSketch::KllSketch(std::uint32_t k, std::uint64_t seed, NanPolicy nan_policy)
    : k_(k), seed_(seed), nan_policy_(nan_policy), rng_state_(seed) {
  if (k < kMinK) throw std::invalid_argument("kll: k is below the minimum");
}

bool KllSketch::value_less(double a, double b) {
  if (a < b) return true;
  if (b < a) return false;
  return std::signbit(a) && !std::signbit(b);  // -0.0 before +0.0
}

std::uint64_t KllSketch::next_random() {
  // splitmix64: deterministic stream fully controlled by the caller's seed.
  std::uint64_t z = (rng_state_ += 0x9e3779b97f4a7c15ULL);
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}

bool KllSketch::update(double value, std::uint64_t weight) {
  if (std::isnan(value)) return false;  // NanPolicy::kReject
  if (weight == 0)
    throw std::invalid_argument("kll: weight must be a positive integer");
  levels_[0].push_back({value, weight});
  n_ += weight;
  compact_if_needed();
  return true;
}

void KllSketch::compact_if_needed() {
  for (std::size_t h = 0; h < levels_.size(); ++h) {
    if (levels_[h].size() > k_) compact_level(h);
  }
}

void KllSketch::compact_level(std::size_t h) {
  if (h + 1 == levels_.size()) levels_.emplace_back();
  auto& buf = levels_[h];
  std::sort(buf.begin(), buf.end(), [](const Entry& x, const Entry& y) {
    return value_less(x.value, y.value);
  });

  std::vector<Entry> rest;       // entries staying at this level
  std::vector<Entry> promoted;   // entries moving to level h + 1
  rest.reserve(buf.size() / 2 + 1);
  promoted.reserve(buf.size() / 2 + 1);

  std::size_t i = 0;
  if (buf.size() % 2 == 1) rest.push_back(buf[i++]);  // odd leftover stays

  std::uint64_t max_pair_weight = 0;
  for (; i + 1 < buf.size(); i += 2) {
    const Entry& a = buf[i];
    const Entry& b = buf[i + 1];
    Entry survivor = (next_random() & 1) ? b : a;
    const std::uint64_t combined = a.weight + b.weight;
    survivor.weight = combined >> 1;          // mass: 2^(h+1) * (combined / 2)
    if (combined & 1) rest.push_back({survivor.value, 1});  // odd remainder stays
    promoted.push_back(survivor);
    max_pair_weight = std::max(max_pair_weight, std::max(a.weight, b.weight));
  }

  // For any threshold, at most one pair of a sorted compaction straddles it,
  // so this compaction adds at most 2^h * max_pair_weight of rank error.
  error_weight_ += std::ldexp(static_cast<double>(max_pair_weight), static_cast<int>(h));

  auto& up = levels_[h + 1];
  up.insert(up.end(), std::make_move_iterator(promoted.begin()),
            std::make_move_iterator(promoted.end()));
  buf.swap(rest);
}

void KllSketch::merge(const KllSketch& other) {
  if (this == &other) {
    const KllSketch copy(other);
    merge(copy);
    return;
  }
  if (other.empty()) return;
  if (k_ != other.k_) throw std::invalid_argument("kll: k mismatch on merge");
  if (nan_policy_ != other.nan_policy_)
    throw std::invalid_argument("kll: NaN policy mismatch on merge");
  while (levels_.size() < other.levels_.size()) levels_.emplace_back();
  for (std::size_t h = 0; h < other.levels_.size(); ++h) {
    auto& dst = levels_[h];
    dst.insert(dst.end(), other.levels_[h].begin(), other.levels_[h].end());
  }
  n_ += other.n_;
  error_weight_ += other.error_weight_;
  compact_if_needed();
}

double KllSketch::min() const {
  if (empty()) throw std::logic_error("kll: min of empty sketch");
  double best = levels_[0].empty() ? 0.0 : levels_[0][0].value;
  bool seen = !levels_[0].empty();
  for (const auto& level : levels_) {
    for (const Entry& e : level) {
      if (!seen || value_less(e.value, best)) best = e.value;
      seen = true;
    }
  }
  return best;
}

double KllSketch::max() const {
  if (empty()) throw std::logic_error("kll: max of empty sketch");
  double best = levels_[0].empty() ? 0.0 : levels_[0][0].value;
  bool seen = !levels_[0].empty();
  for (const auto& level : levels_) {
    for (const Entry& e : level) {
      if (!seen || value_less(best, e.value)) best = e.value;
      seen = true;
    }
  }
  return best;
}

double KllSketch::quantile(double r) const {
  if (empty()) throw std::logic_error("kll: quantile of empty sketch");
  if (std::isnan(r) || r < 0.0 || r > 1.0)
    throw std::invalid_argument("kll: rank must be in [0, 1]");
  std::vector<std::pair<double, std::uint64_t>> items;  // value, mass
  for (std::size_t h = 0; h < levels_.size(); ++h) {
    for (const Entry& e : levels_[h]) {
      items.push_back(
          {e.value, static_cast<std::uint64_t>(
                        static_cast<unsigned __int128>(e.weight) << h)});
    }
  }
  std::sort(items.begin(), items.end(),
            [](const auto& x, const auto& y) { return value_less(x.first, y.first); });
  const long double target = static_cast<long double>(r) * static_cast<long double>(n_);
  unsigned __int128 cumulative = 0;
  for (const auto& [value, mass] : items) {
    cumulative += mass;
    if (static_cast<long double>(cumulative) >= target) return value;
  }
  return items.back().first;
}

double KllSketch::rank(double value) const {
  if (std::isnan(value)) throw std::invalid_argument("kll: rank of NaN");
  if (empty()) return 0.0;
  unsigned __int128 less = 0;
  for (std::size_t h = 0; h < levels_.size(); ++h) {
    for (const Entry& e : levels_[h]) {
      if (value_less(e.value, value))
        less += static_cast<unsigned __int128>(e.weight) << h;
    }
  }
  return static_cast<double>(static_cast<long double>(less) /
                             static_cast<long double>(n_));
}

double KllSketch::rank_error_bound() const {
  if (n_ == 0) return 0.0;
  return std::min(1.0, error_weight_ / static_cast<double>(n_));
}

bool KllSketch::validate_weight_conservation() const {
  unsigned __int128 sum = 0;
  for (std::size_t h = 0; h < levels_.size(); ++h) {
    for (const Entry& e : levels_[h]) {
      if (e.weight == 0) return false;
      sum += static_cast<unsigned __int128>(e.weight) << h;
    }
  }
  return sum == n_;
}

std::vector<std::uint8_t> KllSketch::serialize() const {
  std::vector<std::uint8_t> out;
  out.insert(out.end(), std::begin(kMagic), std::end(kMagic));
  put_u32(out, k_);
  put_u64(out, seed_);
  out.push_back(static_cast<std::uint8_t>(nan_policy_));
  put_u64(out, n_);
  put_u64(out, rng_state_);
  put_f64(out, error_weight_);
  put_u32(out, static_cast<std::uint32_t>(levels_.size()));
  for (const auto& level : levels_) {
    put_u32(out, static_cast<std::uint32_t>(level.size()));
    for (const Entry& e : level) {
      put_f64(out, e.value);
      put_u64(out, e.weight);
    }
  }
  return out;
}

KllSketch KllSketch::deserialize(const std::uint8_t* data, std::size_t size) {
  Reader r(data, size);
  for (std::uint8_t m : kMagic) {
    if (r.u8() != m) throw std::runtime_error("kll: bad magic");
  }
  const std::uint32_t k = r.u32();
  const std::uint64_t seed = r.u64();
  const std::uint8_t policy = r.u8();
  if (policy > static_cast<std::uint8_t>(NanPolicy::kReject))
    throw std::runtime_error("kll: unknown NaN policy");
  KllSketch sk(k, seed, static_cast<NanPolicy>(policy));
  sk.n_ = r.u64();
  sk.rng_state_ = r.u64();
  sk.error_weight_ = r.f64();
  const std::uint32_t num_levels = r.u32();
  if (num_levels == 0 || num_levels > kMaxLevels)
    throw std::runtime_error("kll: invalid level count");
  sk.levels_.assign(num_levels, {});
  for (auto& level : sk.levels_) {
    const std::uint32_t count = r.u32();
    level.reserve(count);
    for (std::uint32_t i = 0; i < count; ++i) {
      const double value = r.f64();
      const std::uint64_t weight = r.u64();
      level.push_back({value, weight});
    }
  }
  if (!r.done()) throw std::runtime_error("kll: trailing bytes");
  if (!sk.validate_weight_conservation())
    throw std::runtime_error("kll: total weight not conserved");
  return sk;
}

KllSketch KllSketch::deserialize(const std::vector<std::uint8_t>& bytes) {
  return deserialize(bytes.data(), bytes.size());
}

}  // namespace dataeng
