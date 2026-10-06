#include "statlib/bigint.hpp"

#include <algorithm>
#include <ostream>
#include <stdexcept>

namespace statlib {

BigInt::BigInt(long long value) {
    unsigned long long u;
    if (value < 0) {
        neg_ = true;
        u = 0ULL - static_cast<unsigned long long>(value);  // safe for LLONG_MIN
    } else {
        u = static_cast<unsigned long long>(value);
    }
    while (u != 0) {
        mag_.push_back(static_cast<std::uint32_t>(u & 0xFFFFFFFFULL));
        u >>= 32;
    }
}

BigInt::BigInt(unsigned long long value) {
    while (value != 0) {
        mag_.push_back(static_cast<std::uint32_t>(value & 0xFFFFFFFFULL));
        value >>= 32;
    }
}

BigInt BigInt::from_string(const std::string& decimal) {
    std::size_t pos = 0;
    bool neg = false;
    if (pos < decimal.size() && (decimal[pos] == '-' || decimal[pos] == '+')) {
        neg = decimal[pos] == '-';
        ++pos;
    }
    BigInt result;
    bool any = false;
    for (; pos < decimal.size(); ++pos) {
        char c = decimal[pos];
        if (c < '0' || c > '9') throw std::invalid_argument("BigInt: bad digit");
        any = true;
        result *= BigInt(10);
        result += BigInt(c - '0');
    }
    if (!any) throw std::invalid_argument("BigInt: empty digits");
    if (neg && !result.is_zero()) result.neg_ = true;
    return result;
}

BigInt::BigInt(const std::string& decimal) : BigInt(from_string(decimal)) {}

BigInt BigInt::pow2(unsigned k) {
    BigInt r;
    r.mag_.assign(k / 32 + 1, 0);
    r.mag_[k / 32] = std::uint32_t{1} << (k % 32);
    r.normalize();
    return r;
}

int BigInt::sign() const {
    if (mag_.empty()) return 0;
    return neg_ ? -1 : 1;
}

void BigInt::normalize() {
    while (!mag_.empty() && mag_.back() == 0) mag_.pop_back();
    if (mag_.empty()) neg_ = false;
}

int BigInt::cmp_mag(const std::vector<std::uint32_t>& a,
                    const std::vector<std::uint32_t>& b) {
    if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
    for (std::size_t i = a.size(); i-- > 0;) {
        if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

std::vector<std::uint32_t> BigInt::add_mag(const std::vector<std::uint32_t>& a,
                                           const std::vector<std::uint32_t>& b) {
    std::vector<std::uint32_t> out;
    out.reserve(std::max(a.size(), b.size()) + 1);
    std::uint64_t carry = 0;
    for (std::size_t i = 0; i < std::max(a.size(), b.size()); ++i) {
        std::uint64_t sum = carry;
        if (i < a.size()) sum += a[i];
        if (i < b.size()) sum += b[i];
        out.push_back(static_cast<std::uint32_t>(sum & 0xFFFFFFFFULL));
        carry = sum >> 32;
    }
    if (carry) out.push_back(static_cast<std::uint32_t>(carry));
    return out;
}

std::vector<std::uint32_t> BigInt::sub_mag(const std::vector<std::uint32_t>& a,
                                           const std::vector<std::uint32_t>& b) {
    std::vector<std::uint32_t> out;
    out.reserve(a.size());
    std::int64_t borrow = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        std::int64_t diff = static_cast<std::int64_t>(a[i]) - borrow;
        if (i < b.size()) diff -= b[i];
        if (diff < 0) {
            diff += (std::int64_t{1} << 32);
            borrow = 1;
        } else {
            borrow = 0;
        }
        out.push_back(static_cast<std::uint32_t>(diff));
    }
    while (!out.empty() && out.back() == 0) out.pop_back();
    return out;
}

std::vector<std::uint32_t> BigInt::mul_mag(const std::vector<std::uint32_t>& a,
                                           const std::vector<std::uint32_t>& b) {
    if (a.empty() || b.empty()) return {};
    std::vector<std::uint32_t> out(a.size() + b.size(), 0);
    for (std::size_t i = 0; i < a.size(); ++i) {
        std::uint64_t carry = 0;
        for (std::size_t j = 0; j < b.size(); ++j) {
            std::uint64_t cur = static_cast<std::uint64_t>(a[i]) * b[j] + out[i + j] + carry;
            out[i + j] = static_cast<std::uint32_t>(cur & 0xFFFFFFFFULL);
            carry = cur >> 32;
        }
        std::size_t k = i + b.size();
        while (carry != 0) {
            std::uint64_t cur = static_cast<std::uint64_t>(out[k]) + carry;
            out[k] = static_cast<std::uint32_t>(cur & 0xFFFFFFFFULL);
            carry = cur >> 32;
            ++k;
        }
    }
    while (!out.empty() && out.back() == 0) out.pop_back();
    return out;
}

BigInt BigInt::operator-() const {
    BigInt r = *this;
    if (!r.is_zero()) r.neg_ = !r.neg_;
    return r;
}

BigInt& BigInt::operator+=(const BigInt& rhs) {
    if (rhs.is_zero()) return *this;
    if (is_zero()) return *this = rhs;
    if (neg_ == rhs.neg_) {
        mag_ = add_mag(mag_, rhs.mag_);
    } else {
        int c = cmp_mag(mag_, rhs.mag_);
        if (c == 0) {
            mag_.clear();
            neg_ = false;
        } else if (c > 0) {
            mag_ = sub_mag(mag_, rhs.mag_);
        } else {
            mag_ = sub_mag(rhs.mag_, mag_);
            neg_ = rhs.neg_;
        }
    }
    normalize();
    return *this;
}

BigInt& BigInt::operator-=(const BigInt& rhs) { return *this += (-rhs); }

BigInt& BigInt::operator*=(const BigInt& rhs) {
    if (is_zero() || rhs.is_zero()) {
        mag_.clear();
        neg_ = false;
        return *this;
    }
    mag_ = mul_mag(mag_, rhs.mag_);
    neg_ = neg_ != rhs.neg_;
    normalize();
    return *this;
}

BigInt& BigInt::operator<<=(unsigned k) {
    if (is_zero()) return *this;
    unsigned words = k / 32, bits = k % 32;
    std::vector<std::uint32_t> out(words, 0);
    std::uint32_t carry = 0;
    for (std::uint32_t limb : mag_) {
        if (bits == 0) {
            out.push_back(limb);
        } else {
            out.push_back((limb << bits) | carry);
            carry = limb >> (32 - bits);
        }
    }
    if (bits != 0 && carry != 0) out.push_back(carry);
    mag_ = std::move(out);
    normalize();
    return *this;
}

BigInt& BigInt::operator>>=(unsigned k) {
    unsigned words = k / 32, bits = k % 32;
    if (words >= mag_.size()) {
        mag_.clear();
        neg_ = false;
        return *this;
    }
    std::vector<std::uint32_t> out;
    out.reserve(mag_.size() - words);
    for (std::size_t i = words; i < mag_.size(); ++i) {
        std::uint32_t limb = mag_[i] >> bits;
        if (bits != 0 && i + 1 < mag_.size()) limb |= mag_[i + 1] << (32 - bits);
        out.push_back(limb);
    }
    mag_ = std::move(out);
    normalize();
    return *this;
}

void divmod(const BigInt& a, const BigInt& b, BigInt& q, BigInt& r) {
    if (b.is_zero()) throw std::domain_error("BigInt: division by zero");
    if (BigInt::cmp_mag(a.mag_, b.mag_) < 0) {
        q = BigInt();
        r = a;
        return;
    }
    // Bit-by-bit long division on magnitudes.
    std::size_t total_bits = a.mag_.size() * 32;
    BigInt rem;
    BigInt quotient;
    quotient.mag_.assign(a.mag_.size(), 0);
    BigInt bmag;
    bmag.mag_ = b.mag_;
    for (std::size_t i = total_bits; i-- > 0;) {
        rem <<= 1;
        std::uint32_t bit = (a.mag_[i / 32] >> (i % 32)) & 1u;
        if (bit) {
            if (rem.mag_.empty()) rem.mag_.push_back(1u);
            else rem.mag_[0] |= 1u;
        }
        if (BigInt::cmp_mag(rem.mag_, bmag.mag_) >= 0) {
            rem.mag_ = BigInt::sub_mag(rem.mag_, bmag.mag_);
            quotient.mag_[i / 32] |= std::uint32_t{1} << (i % 32);
        }
    }
    quotient.normalize();
    rem.normalize();
    q = quotient;
    r = rem;
    if (!q.is_zero()) q.neg_ = a.neg_ != b.neg_;
    if (!r.is_zero()) r.neg_ = a.neg_;
}

BigInt& BigInt::operator/=(const BigInt& rhs) {
    BigInt q, r;
    divmod(*this, rhs, q, r);
    return *this = std::move(q);
}

BigInt& BigInt::operator%=(const BigInt& rhs) {
    BigInt q, r;
    divmod(*this, rhs, q, r);
    return *this = std::move(r);
}

std::strong_ordering BigInt::operator<=>(const BigInt& rhs) const {
    int s1 = sign(), s2 = rhs.sign();
    if (s1 != s2) return s1 <=> s2;
    int c = cmp_mag(mag_, rhs.mag_);
    if (s1 < 0) c = -c;
    return c <=> 0;
}

BigInt BigInt::gcd(BigInt a, BigInt b) {
    a.neg_ = false;
    b.neg_ = false;
    while (!b.is_zero()) {
        BigInt q, r;
        divmod(a, b, q, r);
        a = std::move(b);
        b = std::move(r);
    }
    return a;
}

std::string BigInt::to_string() const {
    if (is_zero()) return "0";
    BigInt mag;
    mag.mag_ = mag_;
    std::vector<std::string> chunks;
    const BigInt base(1000000000);
    while (!mag.is_zero()) {
        BigInt q, r;
        divmod(mag, base, q, r);
        std::uint32_t chunk = r.is_zero() ? 0u : r.mag_[0];
        std::string part = std::to_string(chunk);
        if (!q.is_zero()) part.insert(0, 9 - part.size(), '0');
        chunks.push_back(std::move(part));
        mag = std::move(q);
    }
    std::string out;
    if (neg_) out += '-';
    for (auto it = chunks.rbegin(); it != chunks.rend(); ++it) out += *it;
    return out;
}

std::ostream& operator<<(std::ostream& os, const BigInt& v) { return os << v.to_string(); }

}  // namespace statlib
