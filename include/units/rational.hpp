#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

namespace units {

// Exact rational number, always kept in lowest terms with a positive
// denominator. All arithmetic is checked: results that do not fit in
// int64_t throw std::overflow_error, and a zero denominator throws
// std::domain_error.
class Rational {
public:
    Rational() : num_(0), den_(1) {}
    explicit Rational(std::int64_t n) : num_(n), den_(1) {}
    Rational(std::int64_t n, std::int64_t d) {
        if (d == 0) throw std::domain_error("rational with zero denominator");
        __int128 rn = n, rd = d;
        *this = reduce(rn, rd);
    }

    std::int64_t num() const { return num_; }
    std::int64_t den() const { return den_; }

    Rational operator+(const Rational& o) const {
        __int128 n = static_cast<__int128>(num_) * o.den_ +
                     static_cast<__int128>(o.num_) * den_;
        __int128 d = static_cast<__int128>(den_) * o.den_;
        return reduce(n, d);
    }

    Rational operator-(const Rational& o) const { return *this + (-o); }

    Rational operator-() const {
        if (num_ == INT64_MIN) throw std::overflow_error("rational negation overflow");
        return Rational(num_ == 0 ? 0 : -num_, den_);
    }

    Rational operator*(const Rational& o) const {
        // Cross-cancel first so the widened product stays small.
        std::int64_t g1 = gcd64(num_, o.den_);
        std::int64_t g2 = gcd64(o.num_, den_);
        __int128 n = static_cast<__int128>(num_ / g1) * (o.num_ / g2);
        __int128 d = static_cast<__int128>(den_ / g2) * (o.den_ / g1);
        return reduce(n, d);
    }

    Rational operator/(const Rational& o) const {
        if (o.num_ == 0) throw std::domain_error("division by zero rational");
        std::int64_t on = o.num_, od = o.den_;
        if (on < 0) { on = -on; od = -od; }
        return *this * Rational(od, on);
    }

    Rational pow(int k) const {
        if (k == 0) return Rational(1);
        Rational base = *this;
        if (k < 0) {
            if (num_ == 0) throw std::domain_error("zero raised to a negative power");
            base = num_ < 0 ? Rational(-den_, -num_) : Rational(den_, num_);
            k = -k;
        }
        Rational result(1);
        while (k > 0) {
            if (k & 1) result = result * base;
            k >>= 1;
            if (k) base = base * base;
        }
        return result;
    }

    bool operator==(const Rational& o) const {
        return num_ == o.num_ && den_ == o.den_;
    }
    bool operator!=(const Rational& o) const { return !(*this == o); }

    std::string to_string() const {
        if (den_ == 1) return std::to_string(num_);
        return std::to_string(num_) + "/" + std::to_string(den_);
    }

private:
    std::int64_t num_, den_; // den_ > 0, gcd(|num_|, den_) == 1

    static std::int64_t gcd64(std::int64_t a, std::int64_t b) {
        if (a < 0) a = -a;
        if (b < 0) b = -b;
        while (b != 0) {
            std::int64_t t = a % b;
            a = b;
            b = t;
        }
        return a == 0 ? 1 : a;
    }

    static Rational reduce(__int128 n, __int128 d) {
        if (d == 0) throw std::domain_error("rational with zero denominator");
        if (d < 0) { n = -n; d = -d; }
        // gcd on the widened values.
        __int128 a = n < 0 ? -n : n, b = d;
        while (b != 0) { __int128 t = a % b; a = b; b = t; }
        if (a != 0) { n /= a; d /= a; }
        if (n < INT64_MIN || n > INT64_MAX || d > INT64_MAX)
            throw std::overflow_error("rational value overflow");
        Rational r;
        r.num_ = static_cast<std::int64_t>(n);
        r.den_ = static_cast<std::int64_t>(d);
        return r;
    }
};

} // namespace units
