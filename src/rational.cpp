#include "statlib/rational.hpp"

#include <ostream>
#include <stdexcept>

namespace statlib {

Rational::Rational(BigInt num, BigInt den) : num_(std::move(num)), den_(std::move(den)) {
    if (den_.is_zero()) throw std::domain_error("Rational: zero denominator");
    if (den_.sign() < 0) {
        num_ = -num_;
        den_ = -den_;
    }
    BigInt g = BigInt::gcd(num_, den_);
    if (g.sign() > 0 && g != BigInt(1)) {
        num_ /= g;
        den_ /= g;
    }
    if (num_.is_zero()) den_ = BigInt(1);
}

Rational& Rational::operator+=(const Rational& rhs) {
    num_ = num_ * rhs.den_ + rhs.num_ * den_;
    den_ = den_ * rhs.den_;
    *this = Rational(std::move(num_), std::move(den_));
    return *this;
}

Rational& Rational::operator-=(const Rational& rhs) {
    num_ = num_ * rhs.den_ - rhs.num_ * den_;
    den_ = den_ * rhs.den_;
    *this = Rational(std::move(num_), std::move(den_));
    return *this;
}

Rational& Rational::operator*=(const Rational& rhs) {
    num_ *= rhs.num_;
    den_ *= rhs.den_;
    *this = Rational(std::move(num_), std::move(den_));
    return *this;
}

Rational& Rational::operator/=(const Rational& rhs) {
    if (rhs.num_.is_zero()) throw std::domain_error("Rational: division by zero");
    num_ *= rhs.den_;
    den_ *= rhs.num_;
    *this = Rational(std::move(num_), std::move(den_));
    return *this;
}

std::string Rational::to_string() const {
    if (den_ == BigInt(1)) return num_.to_string();
    return num_.to_string() + "/" + den_.to_string();
}

std::ostream& operator<<(std::ostream& os, const Rational& v) { return os << v.to_string(); }

}  // namespace statlib
