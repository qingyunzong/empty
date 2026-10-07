#pragma once

#include <array>
#include <cctype>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>

namespace units {

// ---------------------------------------------------------------------------
// Rational: exact, always-reduced fraction (denominator strictly positive).
// ---------------------------------------------------------------------------
class Rational {
public:
    std::int64_t num = 0;
    std::int64_t den = 1;

    Rational() = default;
    Rational(std::int64_t n, std::int64_t d) {
        if (d == 0) throw std::domain_error("rational: zero denominator");
        if (d < 0) { n = -n; d = -d; }
        std::int64_t g = std::gcd(n, d);
        if (g < 0) g = -g;
        num = n / g;
        den = d / g;
    }

    static std::int64_t checked(std::int64_t v) { return v; }

    friend Rational operator+(const Rational& a, const Rational& b) {
        __int128 n = static_cast<__int128>(a.num) * b.den +
                     static_cast<__int128>(b.num) * a.den;
        __int128 d = static_cast<__int128>(a.den) * b.den;
        return from_wide(n, d);
    }
    friend Rational operator-(const Rational& a, const Rational& b) {
        return a + Rational(-b.num, b.den);
    }
    friend Rational operator*(const Rational& a, const Rational& b) {
        // Cross-cancel before multiplying to keep intermediates small.
        std::int64_t g1 = std::gcd(a.num, b.den); if (g1 < 0) g1 = -g1;
        std::int64_t g2 = std::gcd(b.num, a.den); if (g2 < 0) g2 = -g2;
        __int128 n = static_cast<__int128>(a.num / g1) * (b.num / g2);
        __int128 d = static_cast<__int128>(a.den / g2) * (b.den / g1);
        return from_wide(n, d);
    }
    friend Rational operator/(const Rational& a, const Rational& b) {
        if (b.num == 0) throw std::domain_error("rational: division by zero");
        return a * Rational(b.den, b.num);
    }
    friend bool operator==(const Rational& a, const Rational& b) {
        return a.num == b.num && a.den == b.den;
    }

    Rational pow(int k) const {
        Rational base = (k < 0) ? Rational(den, num) : *this;
        unsigned e = (k < 0) ? static_cast<unsigned>(-k) : static_cast<unsigned>(k);
        Rational result(1, 1);
        while (e) {
            if (e & 1u) result = result * base;
            e >>= 1u;
            if (e) base = base * base;
        }
        return result;
    }

private:
    static Rational from_wide(__int128 n, __int128 d) {
        if (d == 0) throw std::domain_error("rational: zero denominator");
        if (d < 0) { n = -n; d = -d; }
        // Reduce in wide arithmetic before narrowing.
        __int128 a = n < 0 ? -n : n;
        __int128 b = d;
        while (b) { __int128 t = a % b; a = b; b = t; }
        __int128 g = a == 0 ? static_cast<__int128>(1) : a;
        n /= g; d /= g;
        if (n > INT64_MAX || n < INT64_MIN || d > INT64_MAX)
            throw std::overflow_error("rational: value out of range");
        Rational r;
        r.num = static_cast<std::int64_t>(n);
        r.den = static_cast<std::int64_t>(d);
        return r;
    }
};

// ---------------------------------------------------------------------------
// Dims: 7-dimensional SI exponent vector (L, M, T, I, Theta, N, J).
// Each exponent must stay within [-kMaxExponent, +kMaxExponent].
// ---------------------------------------------------------------------------
inline constexpr int kDimCount = 7;
inline constexpr int kMaxExponent = 16;

struct Dims {
    std::array<int, kDimCount> e{};

    static Dims base(int axis) {
        Dims d;
        d.e.at(axis) = 1;
        return d;
    }

    friend Dims operator+(const Dims& a, const Dims& b) {
        Dims r;
        for (int i = 0; i < kDimCount; ++i) {
            int s = a.e[i] + b.e[i];
            if (s > kMaxExponent || s < -kMaxExponent)
                throw std::overflow_error("dims: exponent overflow");
            r.e[i] = s;
        }
        return r;
    }
    friend Dims operator-(const Dims& a, const Dims& b) {
        Dims r;
        for (int i = 0; i < kDimCount; ++i) {
            int s = a.e[i] - b.e[i];
            if (s > kMaxExponent || s < -kMaxExponent)
                throw std::overflow_error("dims: exponent overflow");
            r.e[i] = s;
        }
        return r;
    }
    Dims scaled(int k) const {
        Dims r;
        for (int i = 0; i < kDimCount; ++i) {
            long long s = static_cast<long long>(e[i]) * k;
            if (s > kMaxExponent || s < -kMaxExponent)
                throw std::overflow_error("dims: exponent overflow");
            r.e[i] = static_cast<int>(s);
        }
        return r;
    }
    friend bool operator==(const Dims& a, const Dims& b) { return a.e == b.e; }
};

// ---------------------------------------------------------------------------
// Quantity: magnitude (exact rational, in coherent base units) + dimensions.
// ---------------------------------------------------------------------------
struct Quantity {
    Rational mag;
    Dims dims;

    friend Quantity operator*(const Quantity& a, const Quantity& b) {
        return {a.mag * b.mag, a.dims + b.dims};
    }
    friend Quantity operator/(const Quantity& a, const Quantity& b) {
        return {a.mag / b.mag, a.dims - b.dims};
    }
    friend Quantity operator+(const Quantity& a, const Quantity& b) {
        if (!(a.dims == b.dims))
            throw std::invalid_argument("quantity: addition of incompatible dimensions");
        return {a.mag + b.mag, a.dims};
    }
    friend Quantity operator-(const Quantity& a, const Quantity& b) {
        if (!(a.dims == b.dims))
            throw std::invalid_argument("quantity: subtraction of incompatible dimensions");
        return {a.mag - b.mag, a.dims};
    }
    Quantity pow(int k) const {
        if (k > kMaxExponent || k < -kMaxExponent)
            throw std::overflow_error("quantity: exponent out of range");
        return {mag.pow(k), dims.scaled(k)};
    }
};

// ---------------------------------------------------------------------------
// Built-in unit table. Axis order: L, M, T, I, Theta, N, J.
// ---------------------------------------------------------------------------
inline const std::unordered_map<std::string, Quantity>& builtin_units() {
    static const std::unordered_map<std::string, Quantity> table = [] {
        std::unordered_map<std::string, Quantity> t;
        auto put = [&](std::string name, Rational f, Dims d) {
            t.emplace(std::move(name), Quantity{f, d});
        };
        put("m",   {1, 1},    Dims::base(0));
        put("km",  {1000, 1}, Dims::base(0));
        put("cm",  {1, 100},  Dims::base(0));
        put("mm",  {1, 1000}, Dims::base(0));
        put("kg",  {1, 1},    Dims::base(1));
        put("g",   {1, 1000}, Dims::base(1));
        put("s",   {1, 1},    Dims::base(2));
        put("min", {60, 1},   Dims::base(2));
        put("h",   {3600, 1}, Dims::base(2));
        put("A",   {1, 1},    Dims::base(3));
        put("K",   {1, 1},    Dims::base(4));
        put("mol", {1, 1},    Dims::base(5));
        put("cd",  {1, 1},    Dims::base(6));
        // Derived units.
        Dims dimHz;  dimHz.e[2] = -1;
        put("Hz", {1, 1}, dimHz);
        Dims dimN;   dimN.e[0] = 1;  dimN.e[1] = 1;  dimN.e[2] = -2;
        put("N", {1, 1}, dimN);
        Dims dimPa;  dimPa.e[0] = -1; dimPa.e[1] = 1; dimPa.e[2] = -2;
        put("Pa", {1, 1}, dimPa);
        Dims dimJ;   dimJ.e[0] = 2;  dimJ.e[1] = 1;  dimJ.e[2] = -2;
        put("J", {1, 1}, dimJ);
        Dims dimW;   dimW.e[0] = 2;  dimW.e[1] = 1;  dimW.e[2] = -3;
        put("W", {1, 1}, dimW);
        Dims dimL;   dimL.e[0] = 3;
        put("L", {1, 1000}, dimL);  // litre = 1/1000 m^3
        return t;
    }();
    return table;
}

// ---------------------------------------------------------------------------
// Expression parser.
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := primary ('^' signed-integer)?
//   primary := '(' expr ')' | '-' primary | integer | unit-identifier
// ---------------------------------------------------------------------------
class Parser {
public:
    explicit Parser(std::string_view src,
                    const std::unordered_map<std::string, Quantity>& table = builtin_units())
        : src_(src), table_(table) {}

    Quantity parse() {
        Quantity q = parse_expr();
        skip_ws();
        if (pos_ != src_.size())
            throw std::invalid_argument("parse: unexpected trailing input");
        return q;
    }

private:
    std::string_view src_;
    const std::unordered_map<std::string, Quantity>& table_;
    std::size_t pos_ = 0;

    void skip_ws() {
        while (pos_ < src_.size() && std::isspace(static_cast<unsigned char>(src_[pos_])))
            ++pos_;
    }
    bool eat(char c) {
        skip_ws();
        if (pos_ < src_.size() && src_[pos_] == c) { ++pos_; return true; }
        return false;
    }
    char peek() {
        skip_ws();
        return pos_ < src_.size() ? src_[pos_] : '\0';
    }

    Quantity parse_expr() {
        Quantity v = parse_term();
        while (true) {
            char c = peek();
            if (c == '+') { ++pos_; v = v + parse_term(); }
            else if (c == '-') { ++pos_; v = v - parse_term(); }
            else break;
        }
        return v;
    }

    Quantity parse_term() {
        Quantity v = parse_factor();
        while (true) {
            char c = peek();
            if (c == '*') { ++pos_; v = v * parse_factor(); }
            else if (c == '/') { ++pos_; v = v / parse_factor(); }
            else break;
        }
        return v;
    }

    Quantity parse_factor() {
        Quantity base = parse_primary();
        if (eat('^')) {
            int k = parse_signed_int();
            base = base.pow(k);
        }
        return base;
    }

    Quantity parse_primary() {
        skip_ws();
        char c = peek();
        if (c == '(') {
            ++pos_;
            Quantity q = parse_expr();
            if (!eat(')')) throw std::invalid_argument("parse: expected ')'");
            return q;
        }
        if (c == '-') {
            ++pos_;
            Quantity q = parse_primary();
            return {Rational(0, 1) - q.mag, q.dims};
        }
        if (c == '+') {
            ++pos_;
            return parse_primary();
        }
        if (std::isdigit(static_cast<unsigned char>(c)))
            return parse_number();
        if (std::isalpha(static_cast<unsigned char>(c)) || c == '_')
            return parse_unit();
        throw std::invalid_argument("parse: unexpected character");
    }

    Quantity parse_number() {
        std::size_t start = pos_;
        while (pos_ < src_.size() && std::isdigit(static_cast<unsigned char>(src_[pos_])))
            ++pos_;
        std::string text(src_.substr(start, pos_ - start));
        long long v = 0;
        try {
            v = std::stoll(text);
        } catch (const std::out_of_range&) {
            throw std::overflow_error("parse: integer literal out of range");
        }
        return {Rational(v, 1), Dims{}};
    }

    Quantity parse_unit() {
        std::size_t start = pos_;
        while (pos_ < src_.size() &&
               (std::isalnum(static_cast<unsigned char>(src_[pos_])) || src_[pos_] == '_'))
            ++pos_;
        std::string name(src_.substr(start, pos_ - start));
        auto it = table_.find(name);
        if (it == table_.end())
            throw std::invalid_argument("parse: unknown unit '" + name + "'");
        return it->second;
    }

    int parse_signed_int() {
        skip_ws();
        bool neg = false;
        if (peek() == '-') { neg = true; ++pos_; }
        else if (peek() == '+') { ++pos_; }
        skip_ws();
        std::size_t start = pos_;
        while (pos_ < src_.size() && std::isdigit(static_cast<unsigned char>(src_[pos_])))
            ++pos_;
        if (start == pos_)
            throw std::invalid_argument("parse: expected integer exponent");
        long long v = std::stoll(std::string(src_.substr(start, pos_ - start)));
        if (neg) v = -v;
        if (v > kMaxExponent || v < -kMaxExponent)
            throw std::overflow_error("parse: exponent out of range");
        return static_cast<int>(v);
    }
};

inline Quantity parse(std::string_view src) { return Parser(src).parse(); }

// Convert a quantity into the scale of a target unit expression.
// Returns the exact rational magnitude in target units.
inline Rational convert(const Quantity& q, std::string_view target_expr) {
    Quantity target = parse(target_expr);
    if (!(q.dims == target.dims))
        throw std::invalid_argument("convert: incompatible dimensions");
    if (target.mag.num == 0)
        throw std::invalid_argument("convert: zero target unit");
    return q.mag / target.mag;
}

} // namespace units
