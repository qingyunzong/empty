#pragma once

#include <numeric>
#include <stdexcept>

namespace score {

// 约分有理数：分母恒正，构造时即约分。
class Rational {
public:
    constexpr Rational() : num_(0), den_(1) {}
    constexpr Rational(long long num) : num_(num), den_(1) {}
    Rational(long long num, long long den) {
        if (den == 0) throw std::invalid_argument("Rational: zero denominator");
        if (den < 0) { num = -num; den = -den; }
        long long g = std::gcd(num, den);
        if (g < 0) g = -g;
        num_ = num / g;
        den_ = den / g;
    }

    long long num() const { return num_; }
    long long den() const { return den_; }

    Rational operator+(const Rational& o) const {
        return Rational(num_ * o.den_ + o.num_ * den_, den_ * o.den_);
    }
    Rational operator*(const Rational& o) const {
        return Rational(num_ * o.num_, den_ * o.den_);
    }
    Rational operator/(const Rational& o) const {
        return Rational(num_ * o.den_, den_ * o.num_);
    }
    bool operator==(const Rational&) const = default;
    bool operator<(const Rational& o) const {
        return num_ * o.den_ < o.num_ * den_;
    }

private:
    long long num_;
    long long den_;
};

} // namespace score
