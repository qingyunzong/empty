#include <motion/rational.hpp>

#include <stdexcept>

namespace motion {

Rational::Rational(BigInt numerator, BigInt denominator) {
    if (denominator.is_zero()) throw std::invalid_argument("Rational: zero denominator");
    if (denominator.sign() < 0) {
        numerator = -numerator;
        denominator = -denominator;
    }
    BigInt g = BigInt::gcd(numerator, denominator);
    if (g > BigInt(1)) {
        numerator /= g;
        denominator /= g;
    }
    num_ = std::move(numerator);
    den_ = std::move(denominator);
}

Rational operator+(const Rational& lhs, const Rational& rhs) {
    return Rational(lhs.num_ * rhs.den_ + rhs.num_ * lhs.den_, lhs.den_ * rhs.den_);
}

Rational operator-(const Rational& lhs, const Rational& rhs) {
    return Rational(lhs.num_ * rhs.den_ - rhs.num_ * lhs.den_, lhs.den_ * rhs.den_);
}

Rational operator*(const Rational& lhs, const Rational& rhs) {
    // 交叉约分以控制中间量规模。
    BigInt g1 = BigInt::gcd(lhs.num_, rhs.den_);
    BigInt g2 = BigInt::gcd(rhs.num_, lhs.den_);
    return Rational((lhs.num_ / g1) * (rhs.num_ / g2), (lhs.den_ / g2) * (rhs.den_ / g1));
}

Rational operator/(const Rational& lhs, const Rational& rhs) {
    if (rhs.num_.is_zero()) throw std::domain_error("Rational division by zero");
    return lhs * Rational(rhs.den_, rhs.num_);
}

int compare(const Rational& lhs, const Rational& rhs) {
    return compare(lhs.num_ * rhs.den_, rhs.num_ * lhs.den_);
}

std::string Rational::to_string() const {
    if (den_ == BigInt(1)) return num_.to_string();
    return num_.to_string() + "/" + den_.to_string();
}

}  // namespace motion
