#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace xreduce {

// Arbitrary-precision signed integer, little-endian base-2^32 limbs.
// Zero is represented by an empty limb vector and is never negative.
class BigInt {
public:
  BigInt() = default;

  BigInt(long long value) {
    unsigned long long mag =
        value < 0 ? 0ULL - static_cast<unsigned long long>(value)
                  : static_cast<unsigned long long>(value);
    negative_ = value < 0;
    while (mag != 0) {
      limbs_.push_back(static_cast<std::uint32_t>(mag & 0xFFFFFFFFULL));
      mag >>= 32;
    }
  }

  static BigInt pow2(std::size_t k) {
    BigInt r;
    r.set_bit(k);
    return r;
  }

  bool is_zero() const { return limbs_.empty(); }
  bool is_negative() const { return negative_; }

  BigInt abs() const {
    BigInt r = *this;
    r.negative_ = false;
    return r;
  }

  BigInt operator-() const {
    BigInt r = *this;
    if (!r.is_zero())
      r.negative_ = !r.negative_;
    return r;
  }

  friend bool operator==(const BigInt &, const BigInt &) = default;

  friend bool operator<(const BigInt &a, const BigInt &b) {
    return compare(a, b) < 0;
  }
  friend bool operator>(const BigInt &a, const BigInt &b) {
    return compare(a, b) > 0;
  }

  static int compare(const BigInt &a, const BigInt &b) {
    if (a.negative_ != b.negative_)
      return a.negative_ ? -1 : 1;
    int c = cmp_abs(a, b);
    return a.negative_ ? -c : c;
  }

  friend BigInt operator+(const BigInt &a, const BigInt &b) {
    BigInt r;
    if (a.negative_ == b.negative_) {
      r = add_abs(a, b);
      r.negative_ = a.negative_ && !r.is_zero();
    } else {
      int c = cmp_abs(a, b);
      if (c == 0)
        return BigInt{};
      if (c > 0) {
        r = sub_abs(a, b);
        r.negative_ = a.negative_;
      } else {
        r = sub_abs(b, a);
        r.negative_ = b.negative_;
      }
    }
    return r;
  }

  friend BigInt operator-(const BigInt &a, const BigInt &b) {
    return a + (-b);
  }

  friend BigInt operator*(const BigInt &a, const BigInt &b) {
    BigInt r;
    if (a.is_zero() || b.is_zero())
      return r;
    r.limbs_.assign(a.limbs_.size() + b.limbs_.size() + 1, 0);
    for (std::size_t i = 0; i < a.limbs_.size(); ++i) {
      std::uint64_t carry = 0;
      for (std::size_t j = 0; j < b.limbs_.size(); ++j) {
        std::uint64_t t = r.limbs_[i + j] +
                          static_cast<std::uint64_t>(a.limbs_[i]) * b.limbs_[j] +
                          carry;
        r.limbs_[i + j] = static_cast<std::uint32_t>(t);
        carry = t >> 32;
      }
      std::size_t k = i + b.limbs_.size();
      while (carry != 0) {
        std::uint64_t t = static_cast<std::uint64_t>(r.limbs_[k]) + carry;
        r.limbs_[k] = static_cast<std::uint32_t>(t);
        carry = t >> 32;
        ++k;
      }
    }
    r.negative_ = a.negative_ != b.negative_;
    r.normalize();
    return r;
  }

  // Truncating division (quotient rounds toward zero).
  static BigInt div(const BigInt &a, const BigInt &b) {
    auto [q, r] = divmod_abs(a.abs(), b.abs());
    q.negative_ = (a.negative_ != b.negative_) && !q.is_zero();
    return q;
  }

  static BigInt mod(const BigInt &a, const BigInt &b) {
    auto [q, r] = divmod_abs(a.abs(), b.abs());
    r.negative_ = a.negative_ && !r.is_zero();
    return r;
  }

  static BigInt gcd(BigInt a, BigInt b) {
    a = a.abs();
    b = b.abs();
    while (!b.is_zero()) {
      auto [q, r] = divmod_abs(a, b);
      a = b;
      b = r;
    }
    return a; // gcd(0, 0) == 0
  }

  std::string to_string() const {
    if (is_zero())
      return "0";
    BigInt t = abs();
    std::string out;
    while (!t.is_zero()) {
      auto [q, rem] = t.divmod_small(1000000000U);
      std::string chunk = std::to_string(rem);
      // Chunks are produced least-significant first; pad each to 9
      // digits and strip the leading zeros of the final result.
      out = std::string(9 - chunk.size(), '0') + chunk + out;
      t = q;
    }
    out = out.substr(out.find_first_not_of('0'));
    if (negative_)
      out = '-' + out;
    return out;
  }

private:
  std::vector<std::uint32_t> limbs_;
  bool negative_ = false;

  void normalize() {
    while (!limbs_.empty() && limbs_.back() == 0)
      limbs_.pop_back();
    if (limbs_.empty())
      negative_ = false;
  }

  static int cmp_abs(const BigInt &a, const BigInt &b) {
    if (a.limbs_.size() != b.limbs_.size())
      return a.limbs_.size() < b.limbs_.size() ? -1 : 1;
    for (std::size_t i = a.limbs_.size(); i-- > 0;)
      if (a.limbs_[i] != b.limbs_[i])
        return a.limbs_[i] < b.limbs_[i] ? -1 : 1;
    return 0;
  }

  static BigInt add_abs(const BigInt &a, const BigInt &b) {
    BigInt r;
    std::size_t n = a.limbs_.size() > b.limbs_.size() ? a.limbs_.size()
                                                      : b.limbs_.size();
    r.limbs_.assign(n, 0);
    std::uint64_t carry = 0;
    for (std::size_t i = 0; i < n; ++i) {
      std::uint64_t s = carry;
      if (i < a.limbs_.size())
        s += a.limbs_[i];
      if (i < b.limbs_.size())
        s += b.limbs_[i];
      r.limbs_[i] = static_cast<std::uint32_t>(s);
      carry = s >> 32;
    }
    if (carry != 0)
      r.limbs_.push_back(static_cast<std::uint32_t>(carry));
    return r;
  }

  // Requires |a| >= |b|.
  static BigInt sub_abs(const BigInt &a, const BigInt &b) {
    BigInt r = a;
    std::int64_t borrow = 0;
    for (std::size_t i = 0; i < a.limbs_.size(); ++i) {
      std::int64_t d = static_cast<std::int64_t>(a.limbs_[i]) - borrow;
      if (i < b.limbs_.size())
        d -= b.limbs_[i];
      if (d < 0) {
        d += (std::int64_t{1} << 32);
        borrow = 1;
      } else {
        borrow = 0;
      }
      r.limbs_[i] = static_cast<std::uint32_t>(d);
    }
    r.normalize();
    return r;
  }

  std::size_t bit_length() const {
    if (limbs_.empty())
      return 0;
    std::uint32_t top = limbs_.back();
    std::size_t bits = 0;
    while (top != 0) {
      top >>= 1;
      ++bits;
    }
    return (limbs_.size() - 1) * 32 + bits;
  }

  bool test_bit(std::size_t i) const {
    return i / 32 < limbs_.size() &&
           ((limbs_[i / 32] >> (i % 32)) & 1U) != 0;
  }

  void set_bit(std::size_t i) {
    if (i / 32 >= limbs_.size())
      limbs_.resize(i / 32 + 1, 0);
    limbs_[i / 32] |= (1U << (i % 32));
  }

  void shl1() {
    std::uint32_t carry = 0;
    for (auto &limb : limbs_) {
      std::uint32_t next = limb >> 31;
      limb = (limb << 1) | carry;
      carry = next;
    }
    if (carry != 0)
      limbs_.push_back(carry);
  }

  // Unsigned long division by bit-shifting; requires den != 0.
  static std::pair<BigInt, BigInt> divmod_abs(const BigInt &num,
                                              const BigInt &den) {
    BigInt q, r;
    if (cmp_abs(num, den) < 0)
      return {BigInt{}, num};
    std::size_t nbits = num.bit_length();
    for (std::size_t i = nbits; i-- > 0;) {
      r.shl1();
      if (num.test_bit(i)) {
        if (r.limbs_.empty())
          r.limbs_.push_back(1);
        else
          r.limbs_[0] |= 1U;
      }
      if (cmp_abs(r, den) >= 0) {
        r = sub_abs(r, den);
        q.set_bit(i);
      }
    }
    q.normalize();
    r.normalize();
    return {q, r};
  }

  // Divide by a small nonzero value; returns {quotient, remainder}.
  std::pair<BigInt, std::uint32_t> divmod_small(std::uint32_t d) const {
    BigInt q;
    q.limbs_.assign(limbs_.size(), 0);
    std::uint64_t rem = 0;
    for (std::size_t i = limbs_.size(); i-- > 0;) {
      std::uint64_t cur = (rem << 32) | limbs_[i];
      q.limbs_[i] = static_cast<std::uint32_t>(cur / d);
      rem = cur % d;
    }
    q.negative_ = negative_;
    q.normalize();
    return {q, static_cast<std::uint32_t>(rem)};
  }
};

} // namespace xreduce
