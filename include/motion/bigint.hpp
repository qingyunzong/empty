#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace motion {

// 任意精度有符号整数。
// 表示：符号位 + 2^32 进制小端幅度；零的幅度为空且符号非负（唯一规范形）。
class BigInt {
public:
    BigInt() = default;
    BigInt(long long value);

    // 由符号与幅度构造（自动去除前导零并规范化零的符号）。
    static BigInt from_parts(bool negative, std::vector<std::uint32_t> magnitude);

    bool is_zero() const { return magnitude_.empty(); }
    int sign() const { return magnitude_.empty() ? 0 : (negative_ ? -1 : 1); }
    BigInt abs() const { return from_parts(false, magnitude_); }

    BigInt operator-() const { return from_parts(!negative_, magnitude_); }

    BigInt& operator+=(const BigInt& rhs) { return *this = *this + rhs; }
    BigInt& operator-=(const BigInt& rhs) { return *this = *this - rhs; }
    BigInt& operator*=(const BigInt& rhs) { return *this = *this * rhs; }
    BigInt& operator/=(const BigInt& rhs) { return *this = *this / rhs; }
    BigInt& operator%=(const BigInt& rhs) { return *this = *this % rhs; }

    friend BigInt operator+(const BigInt& lhs, const BigInt& rhs);
    friend BigInt operator-(const BigInt& lhs, const BigInt& rhs);
    friend BigInt operator*(const BigInt& lhs, const BigInt& rhs);
    friend BigInt operator/(const BigInt& lhs, const BigInt& rhs);  // 向零截断
    friend BigInt operator%(const BigInt& lhs, const BigInt& rhs);  // 余数符号同被除数

    friend bool operator==(const BigInt&, const BigInt&) = default;

    friend int compare(const BigInt&, const BigInt&);

    // 最大公约数，结果非负；gcd(0, 0) == 0。
    static BigInt gcd(BigInt a, BigInt b);

    std::string to_string() const;

private:
    bool negative_ = false;
    std::vector<std::uint32_t> magnitude_;
};

int compare(const BigInt& lhs, const BigInt& rhs);

inline bool operator!=(const BigInt& lhs, const BigInt& rhs) { return !(lhs == rhs); }
inline bool operator<(const BigInt& lhs, const BigInt& rhs) { return compare(lhs, rhs) < 0; }
inline bool operator<=(const BigInt& lhs, const BigInt& rhs) { return compare(lhs, rhs) <= 0; }
inline bool operator>(const BigInt& lhs, const BigInt& rhs) { return compare(lhs, rhs) > 0; }
inline bool operator>=(const BigInt& lhs, const BigInt& rhs) { return compare(lhs, rhs) >= 0; }

}  // namespace motion
