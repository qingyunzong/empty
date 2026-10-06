#pragma once

#include <compare>
#include <cstdint>
#include <iosfwd>
#include <string>
#include <vector>

namespace statlib {

// Arbitrary-precision signed integer.
// Representation: sign + little-endian base-2^32 magnitude, normalized
// (no trailing zero limbs; zero has an empty magnitude and positive sign).
class BigInt {
public:
    BigInt() = default;
    BigInt(int value) : BigInt(static_cast<long long>(value)) {}
    BigInt(unsigned value) : BigInt(static_cast<unsigned long long>(value)) {}
    BigInt(long long value);
    BigInt(unsigned long long value);
    explicit BigInt(const std::string& decimal);  // e.g. "-123456789012345678901234567890"

    static BigInt pow2(unsigned k);  // 2^k

    int sign() const;  // -1, 0, +1
    bool is_zero() const { return mag_.empty(); }

    BigInt operator-() const;
    BigInt operator+() const { return *this; }

    BigInt& operator+=(const BigInt& rhs);
    BigInt& operator-=(const BigInt& rhs);
    BigInt& operator*=(const BigInt& rhs);
    BigInt& operator/=(const BigInt& rhs);  // truncated toward zero
    BigInt& operator%=(const BigInt& rhs);  // remainder takes sign of dividend
    BigInt& operator<<=(unsigned k);
    BigInt& operator>>=(unsigned k);  // floor shift of magnitude (exact for non-negative)

    friend BigInt operator+(BigInt a, const BigInt& b) { return a += b; }
    friend BigInt operator-(BigInt a, const BigInt& b) { return a -= b; }
    friend BigInt operator*(BigInt a, const BigInt& b) { return a *= b; }
    friend BigInt operator/(BigInt a, const BigInt& b) { return a /= b; }
    friend BigInt operator%(BigInt a, const BigInt& b) { return a %= b; }
    friend BigInt operator<<(BigInt a, unsigned k) { return a <<= k; }
    friend BigInt operator>>(BigInt a, unsigned k) { return a >>= k; }

    bool operator==(const BigInt&) const = default;
    std::strong_ordering operator<=>(const BigInt& rhs) const;

    // Quotient/remainder, truncation toward zero. Throws on division by zero.
    friend void divmod(const BigInt& a, const BigInt& b, BigInt& q, BigInt& r);

    static BigInt gcd(BigInt a, BigInt b);  // non-negative, gcd(0,0)=0

    std::string to_string() const;
    static BigInt from_string(const std::string& decimal);

    friend std::ostream& operator<<(std::ostream& os, const BigInt& v);

private:
    std::vector<std::uint32_t> mag_;  // little-endian limbs, normalized
    bool neg_ = false;

    void normalize();
    static int cmp_mag(const std::vector<std::uint32_t>& a,
                       const std::vector<std::uint32_t>& b);
    static std::vector<std::uint32_t> add_mag(const std::vector<std::uint32_t>& a,
                                              const std::vector<std::uint32_t>& b);
    // Requires |a| >= |b|.
    static std::vector<std::uint32_t> sub_mag(const std::vector<std::uint32_t>& a,
                                              const std::vector<std::uint32_t>& b);
    static std::vector<std::uint32_t> mul_mag(const std::vector<std::uint32_t>& a,
                                              const std::vector<std::uint32_t>& b);
};

}  // namespace statlib
