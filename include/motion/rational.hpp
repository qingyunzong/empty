#pragma once

#include <motion/bigint.hpp>

#include <string>

namespace motion {

// 最简有理数：分母恒正，分子分母互素；零表示为 0/1。
class Rational {
public:
    Rational() : num_(0), den_(1) {}
    Rational(long long value) : num_(value), den_(1) {}
    // 自动约分并规范化符号；分母为零时抛 std::invalid_argument。
    Rational(BigInt numerator, BigInt denominator);

    const BigInt& num() const { return num_; }
    const BigInt& den() const { return den_; }
    int sign() const { return num_.sign(); }

    Rational& operator+=(const Rational& rhs) { return *this = *this + rhs; }
    Rational& operator-=(const Rational& rhs) { return *this = *this - rhs; }
    Rational& operator*=(const Rational& rhs) { return *this = *this * rhs; }
    Rational& operator/=(const Rational& rhs) { return *this = *this / rhs; }

    friend Rational operator+(const Rational& lhs, const Rational& rhs);
    friend Rational operator-(const Rational& lhs, const Rational& rhs);
    friend Rational operator*(const Rational& lhs, const Rational& rhs);
    friend Rational operator/(const Rational& lhs, const Rational& rhs);

    friend bool operator==(const Rational&, const Rational&) = default;

    friend int compare(const Rational&, const Rational&);

    // 精确输出：分母为 1 时输出整数，否则输出 "分子/分母"。
    std::string to_string() const;

private:
    BigInt num_;
    BigInt den_;
};

int compare(const Rational& lhs, const Rational& rhs);

inline bool operator!=(const Rational& lhs, const Rational& rhs) { return !(lhs == rhs); }
inline bool operator<(const Rational& lhs, const Rational& rhs) { return compare(lhs, rhs) < 0; }
inline bool operator<=(const Rational& lhs, const Rational& rhs) { return compare(lhs, rhs) <= 0; }
inline bool operator>(const Rational& lhs, const Rational& rhs) { return compare(lhs, rhs) > 0; }
inline bool operator>=(const Rational& lhs, const Rational& rhs) { return compare(lhs, rhs) >= 0; }

}  // namespace motion
