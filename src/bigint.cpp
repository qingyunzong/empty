#include <motion/bigint.hpp>

#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace motion {
namespace {

using Mag = std::vector<std::uint32_t>;

void trim(Mag& m) {
    while (!m.empty() && m.back() == 0) m.pop_back();
}

int cmp_mag(const Mag& a, const Mag& b) {
    if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
    for (std::size_t i = a.size(); i-- > 0;) {
        if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

Mag add_mag(const Mag& a, const Mag& b) {
    Mag r(std::max(a.size(), b.size()), 0);
    std::uint64_t carry = 0;
    for (std::size_t i = 0; i < r.size(); ++i) {
        std::uint64_t sum = carry;
        if (i < a.size()) sum += a[i];
        if (i < b.size()) sum += b[i];
        r[i] = static_cast<std::uint32_t>(sum);
        carry = sum >> 32;
    }
    if (carry) r.push_back(static_cast<std::uint32_t>(carry));
    return r;
}

// 要求 a >= b。
Mag sub_mag(const Mag& a, const Mag& b) {
    Mag r(a.size(), 0);
    std::int64_t borrow = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        std::int64_t diff = static_cast<std::int64_t>(a[i]) - borrow -
                            (i < b.size() ? static_cast<std::int64_t>(b[i]) : 0);
        if (diff < 0) {
            diff += std::int64_t{1} << 32;
            borrow = 1;
        } else {
            borrow = 0;
        }
        r[i] = static_cast<std::uint32_t>(diff);
    }
    trim(r);
    return r;
}

Mag mul_mag(const Mag& a, const Mag& b) {
    if (a.empty() || b.empty()) return {};
    Mag r(a.size() + b.size(), 0);
    for (std::size_t i = 0; i < a.size(); ++i) {
        std::uint64_t carry = 0;
        for (std::size_t j = 0; j < b.size(); ++j) {
            std::uint64_t cur = r[i + j] + static_cast<std::uint64_t>(a[i]) * b[j] + carry;
            r[i + j] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
        }
        for (std::size_t k = i + b.size(); carry; ++k) {
            std::uint64_t cur = static_cast<std::uint64_t>(r[k]) + carry;
            r[k] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
        }
    }
    trim(r);
    return r;
}

std::size_t bit_length(const Mag& m) {
    if (m.empty()) return 0;
    std::uint32_t top = m.back();
    std::size_t bits = (m.size() - 1) * 32;
    while (top) {
        ++bits;
        top >>= 1;
    }
    return bits;
}

bool test_bit(const Mag& m, std::size_t i) {
    return (m[i / 32] >> (i % 32)) & 1u;
}

void shl1(Mag& m) {
    std::uint32_t carry = 0;
    for (auto& limb : m) {
        std::uint32_t next = limb >> 31;
        limb = (limb << 1) | carry;
        carry = next;
    }
    if (carry) m.push_back(carry);
}

// 二进制长除法，要求 b 非零；返回 {商, 余数}。
std::pair<Mag, Mag> divmod_mag(const Mag& a, const Mag& b) {
    Mag q(a.size(), 0);
    Mag r;
    for (std::size_t i = bit_length(a); i-- > 0;) {
        shl1(r);
        if (test_bit(a, i)) {
            if (r.empty())
                r.push_back(1);
            else
                r[0] |= 1;
        }
        if (cmp_mag(r, b) >= 0) {
            r = sub_mag(r, b);
            q[i / 32] |= 1u << (i % 32);
        }
    }
    trim(q);
    return {q, r};
}

}  // namespace

BigInt::BigInt(long long value) {
    unsigned long long v =
        value < 0 ? ~static_cast<unsigned long long>(value) + 1
                  : static_cast<unsigned long long>(value);
    negative_ = value < 0;
    while (v) {
        magnitude_.push_back(static_cast<std::uint32_t>(v));
        v >>= 32;
    }
    if (magnitude_.empty()) negative_ = false;
}

BigInt BigInt::from_parts(bool negative, std::vector<std::uint32_t> magnitude) {
    trim(magnitude);
    BigInt r;
    r.negative_ = magnitude.empty() ? false : negative;
    r.magnitude_ = std::move(magnitude);
    return r;
}

BigInt operator+(const BigInt& lhs, const BigInt& rhs) {
    if (lhs.negative_ == rhs.negative_)
        return BigInt::from_parts(lhs.negative_, add_mag(lhs.magnitude_, rhs.magnitude_));
    int c = cmp_mag(lhs.magnitude_, rhs.magnitude_);
    if (c == 0) return BigInt();
    if (c > 0) return BigInt::from_parts(lhs.negative_, sub_mag(lhs.magnitude_, rhs.magnitude_));
    return BigInt::from_parts(rhs.negative_, sub_mag(rhs.magnitude_, lhs.magnitude_));
}

BigInt operator-(const BigInt& lhs, const BigInt& rhs) { return lhs + (-rhs); }

BigInt operator*(const BigInt& lhs, const BigInt& rhs) {
    return BigInt::from_parts(lhs.negative_ != rhs.negative_,
                              mul_mag(lhs.magnitude_, rhs.magnitude_));
}

BigInt operator/(const BigInt& lhs, const BigInt& rhs) {
    if (rhs.is_zero()) throw std::domain_error("BigInt division by zero");
    return BigInt::from_parts(lhs.negative_ != rhs.negative_,
                              divmod_mag(lhs.magnitude_, rhs.magnitude_).first);
}

BigInt operator%(const BigInt& lhs, const BigInt& rhs) {
    if (rhs.is_zero()) throw std::domain_error("BigInt modulo by zero");
    return BigInt::from_parts(lhs.negative_, divmod_mag(lhs.magnitude_, rhs.magnitude_).second);
}

int compare(const BigInt& lhs, const BigInt& rhs) {
    int sl = lhs.sign();
    int sr = rhs.sign();
    if (sl != sr) return sl < sr ? -1 : 1;
    if (sl == 0) return 0;
    int c = cmp_mag(lhs.magnitude_, rhs.magnitude_);
    return sl > 0 ? c : -c;
}

BigInt BigInt::gcd(BigInt a, BigInt b) {
    a = a.abs();
    b = b.abs();
    while (!b.is_zero()) {
        BigInt r = a % b;
        a = b;
        b = r;
    }
    return a;
}

std::string BigInt::to_string() const {
    if (is_zero()) return "0";
    const Mag chunk = {1000000000u};
    Mag m = magnitude_;
    std::vector<std::uint32_t> parts;
    while (!m.empty()) {
        auto [q, r] = divmod_mag(m, chunk);
        parts.push_back(r.empty() ? 0 : r[0]);
        m = std::move(q);
    }
    std::string s = negative_ ? "-" : "";
    s += std::to_string(parts.back());
    for (std::size_t i = parts.size() - 1; i-- > 0;) {
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%09u", parts[i]);
        s += buf;
    }
    return s;
}

}  // namespace motion
