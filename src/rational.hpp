#pragma once
// Exact rational numbers over BigInt, kept in lowest terms.

#include "bigint.hpp"

class Rational {
public:
    BigInt num;    // any integer
    BigUInt den;   // always >= 1
    // invariant: gcd(|num|, den) == 1, and num == 0  =>  den == 1

    Rational() : num(0), den(1) {}
    Rational(int64_t v) : num(v), den(1) {}
    Rational(BigInt n, BigUInt d) : num(std::move(n)), den(std::move(d)) {
        if (den.isZero()) throw std::domain_error("zero denominator");
        normalize();
    }

    static Rational fromInts(int64_t n, int64_t d) {
        if (d == 0) throw std::domain_error("zero denominator");
        BigInt nn(n);
        BigUInt dd;
        if (d < 0) {
            nn = -nn;
            dd = BigUInt(static_cast<uint64_t>(-(d + 1)) + 1);
        } else {
            dd = BigUInt(static_cast<uint64_t>(d));
        }
        return Rational(nn, dd);
    }

    bool isZero() const { return num.isZero(); }

    friend Rational operator+(const Rational& a, const Rational& b) {
        // gcd-aware addition keeps intermediates small
        BigUInt g = gcd(a.den, b.den);
        BigUInt d1 = a.den / g;  // a.den = d1 * g
        BigUInt d2 = b.den / g;  // b.den = d2 * g
        BigInt n = a.num * BigInt(d2) + b.num * BigInt(d1);
        BigUInt d = a.den * d2;
        if (n.isZero()) return Rational();
        BigUInt h = gcd(n.mag, g);
        if (!h.isOne()) {
            n = BigInt(n.mag / h, n.neg);
            d = d / h;
        }
        return Rational(std::move(n), std::move(d));
    }

    friend Rational operator-(const Rational& a, const Rational& b) {
        return a + Rational(-b.num, b.den);
    }

    friend Rational operator*(const Rational& a, const Rational& b) {
        if (a.isZero() || b.isZero()) return Rational();
        BigUInt g1 = gcd(a.num.mag, b.den);
        BigUInt g2 = gcd(b.num.mag, a.den);
        BigInt n = BigInt(a.num.mag / g1, a.neg()) * BigInt(b.num.mag / g2, b.neg());
        BigUInt d = (a.den / g2) * (b.den / g1);
        return Rational(std::move(n), std::move(d));
    }

    friend bool operator==(const Rational& a, const Rational& b) {
        return a.num == b.num && a.den == b.den;
    }
    friend bool operator!=(const Rational& a, const Rational& b) { return !(a == b); }

    // a < b  (both denominators positive)
    friend bool operator<(const Rational& a, const Rational& b) {
        return a.num * BigInt(b.den) < b.num * BigInt(a.den);
    }
    friend bool operator<=(const Rational& a, const Rational& b) {
        return a.num * BigInt(b.den) <= b.num * BigInt(a.den);
    }

    std::string str() const {
        if (den.isOne()) return num.toString();
        return num.toString() + "/" + den.toString();
    }

    // decimal expansion with `digits` fractional digits (truncated)
    std::string decimal(int digits) const {
        std::string out;
        BigUInt mag = num.mag;
        auto [q, r] = divmod(mag, den);
        out = q.toString();
        if (digits > 0) {
            out += '.';
            for (int i = 0; i < digits; ++i) {
                BigUInt scaled = BigUInt::mulSmall(r, 10);
                auto [dq, dr] = divmod(scaled, den);
                out += static_cast<char>('0' + (dq.isZero() ? 0 : dq.limbs[0]));
                r = dr;
            }
        }
        return (num.neg ? "-" : "") + out;
    }

private:
    bool neg() const { return num.neg; }

    void normalize() {
        if (num.isZero()) {
            den = BigUInt(1);
            return;
        }
        BigUInt g = gcd(num.mag, den);
        if (!g.isOne()) {
            num = BigInt(num.mag / g, num.neg);
            den = den / g;
        }
    }
};
