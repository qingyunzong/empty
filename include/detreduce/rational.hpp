#pragma once

#include <compare>
#include <cstdint>
#include <stdexcept>
#include <string>

#include "bigint.hpp"

namespace detreduce {

// Exact rational number, kept in canonical form:
// denominator > 0 and gcd(|num|, den) == 1 (zero is 0/1).
class rational {
public:
    rational() = default;
    rational(int v) : num_(v), den_(1) {}
    rational(long long v) : num_(v), den_(1) {}
    rational(bigint v) : num_(std::move(v)), den_(1) {}
    rational(bigint n, bigint d) : num_(std::move(n)), den_(std::move(d)) {
        normalize();
    }

    const bigint& num() const { return num_; }
    const bigint& den() const { return den_; }

    friend rational operator-(const rational& x) { return rational(-x.num_, x.den_); }

    friend rational operator+(const rational& x, const rational& y) {
        return rational(x.num_ * y.den_ + y.num_ * x.den_, x.den_ * y.den_);
    }

    friend rational operator-(const rational& x, const rational& y) {
        return rational(x.num_ * y.den_ - y.num_ * x.den_, x.den_ * y.den_);
    }

    friend rational operator*(const rational& x, const rational& y) {
        return rational(x.num_ * y.num_, x.den_ * y.den_);
    }

    friend rational operator/(const rational& x, const rational& y) {
        if (y.num_.is_zero()) throw std::domain_error("rational: division by zero");
        return rational(x.num_ * y.den_, x.den_ * y.num_);
    }

    rational& operator+=(const rational& o) { return *this = *this + o; }
    rational& operator-=(const rational& o) { return *this = *this - o; }
    rational& operator*=(const rational& o) { return *this = *this * o; }
    rational& operator/=(const rational& o) { return *this = *this / o; }

    friend bool operator==(const rational&, const rational&) = default;

    friend std::strong_ordering operator<=>(const rational& x, const rational& y) {
        return (x.num_ * y.den_) <=> (y.num_ * x.den_);
    }

    std::string to_string() const {
        if (den_ == bigint(1)) return num_.to_string();
        return num_.to_string() + "/" + den_.to_string();
    }

private:
    bigint num_;
    bigint den_ = bigint(1);

    void normalize() {
        if (den_.is_zero()) throw std::invalid_argument("rational: zero denominator");
        if (den_.sign() < 0) {
            num_ = -num_;
            den_ = -den_;
        }
        if (num_.is_zero()) {
            den_ = bigint(1);
            return;
        }
        const bigint g = bigint::gcd(num_.abs(), den_);
        if (g != bigint(1)) {
            num_ /= g;
            den_ /= g;
        }
    }
};

}  // namespace detreduce
