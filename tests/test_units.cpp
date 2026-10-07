// Tests for the units library, including a cross-check of the expression
// parser/algebra against a small independent symbolic model.
#include <units/units.hpp>

#include <array>
#include <cstdio>
#include <memory>
#include <numeric>
#include <random>
#include <string>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const char* what) {
    ++g_checks;
    if (!ok) {
        ++g_failures;
        std::printf("FAIL: %s\n", what);
    }
}

template <typename F>
void check_throws(F&& f, const char* what) {
    ++g_checks;
    try {
        f();
    } catch (const std::exception&) {
        return;
    }
    ++g_failures;
    std::printf("FAIL (no throw): %s\n", what);
}

// ---------------------------------------------------------------------------
// Independent reference model ("small symbolic algebra model").
// Deliberately written separately from the library implementation.
// ---------------------------------------------------------------------------
struct MFrac {
    long long n = 0, d = 1;
    MFrac() = default;
    MFrac(long long nn, long long dd) {
        if (dd == 0) throw std::domain_error("model: zero denominator");
        if (dd < 0) { nn = -nn; dd = -dd; }
        long long g = std::gcd(nn, dd);
        if (g < 0) g = -g;
        n = nn / g; d = dd / g;
    }
    static long long narrow(__int128 v) {
        if (v > INT64_MAX || v < INT64_MIN) throw std::overflow_error("model: overflow");
        return static_cast<long long>(v);
    }
    MFrac operator+(const MFrac& o) const {
        return MFrac(narrow((__int128)n * o.d + (__int128)o.n * d),
                     narrow((__int128)d * o.d));
    }
    MFrac operator-(const MFrac& o) const { return *this + MFrac(-o.n, o.d); }
    MFrac operator*(const MFrac& o) const {
        return MFrac(narrow((__int128)n * o.n), narrow((__int128)d * o.d));
    }
    MFrac operator/(const MFrac& o) const {
        if (o.n == 0) throw std::domain_error("model: division by zero");
        return *this * MFrac(o.d, o.n);
    }
    MFrac powi(int k) const {
        MFrac base = k < 0 ? MFrac(d, n) : *this;
        MFrac r(1, 1);
        int e = k < 0 ? -k : k;
        for (int i = 0; i < e; ++i) r = r * base;
        return r;
    }
};

struct MVal {
    MFrac f;
    std::array<int, 7> dims{};
};

MVal madd(const MVal& a, const MVal& b, bool sub) {
    if (a.dims != b.dims) throw std::invalid_argument("model: dims mismatch");
    return {sub ? a.f - b.f : a.f + b.f, a.dims};
}
MVal mmul(const MVal& a, const MVal& b, bool div) {
    MVal r;
    r.f = div ? a.f / b.f : a.f * b.f;
    for (int i = 0; i < 7; ++i) {
        int e = div ? a.dims[i] - b.dims[i] : a.dims[i] + b.dims[i];
        if (e > 16 || e < -16) throw std::overflow_error("model: dims overflow");
        r.dims[i] = e;
    }
    return r;
}
MVal mpow(const MVal& a, int k) {
    if (k > 16 || k < -16) throw std::overflow_error("model: exponent range");
    MVal r;
    r.f = a.f.powi(k);
    for (int i = 0; i < 7; ++i) {
        long long e = static_cast<long long>(a.dims[i]) * k;
        if (e > 16 || e < -16) throw std::overflow_error("model: dims overflow");
        r.dims[i] = static_cast<int>(e);
    }
    return r;
}

// Model-side unit table (independent copy).
MVal model_unit(const std::string& name) {
    MVal v;
    auto axis = [&](int i, long long n, long long d) {
        v.f = MFrac(n, d);
        v.dims[i] = 1;
    };
    if (name == "m")   axis(0, 1, 1);
    else if (name == "km")  axis(0, 1000, 1);
    else if (name == "cm")  axis(0, 1, 100);
    else if (name == "s")   axis(2, 1, 1);
    else if (name == "min") axis(2, 60, 1);
    else if (name == "kg")  axis(1, 1, 1);
    else if (name == "g")   axis(1, 1, 1000);
    else throw std::invalid_argument("model: unknown unit");
    return v;
}

// ---------------------------------------------------------------------------
// Random expression AST: evaluate with the model, render to text, parse with
// the library, and require identical results (or identical failure).
// ---------------------------------------------------------------------------
struct Node {
    enum Kind { Num, Unit, Add, Sub, Mul, Div, Pow } kind;
    long long num = 0;
    std::string unit;
    int exp = 0;
    std::unique_ptr<Node> a, b;
};

class Generator {
public:
    explicit Generator(unsigned seed) : rng_(seed) {}

    std::unique_ptr<Node> make(int depth) {
        static const char* kUnits[] = {"m", "km", "cm", "s", "min", "kg", "g"};
        std::uniform_int_distribution<int> pick;
        if (depth <= 0) {
            auto n = std::make_unique<Node>();
            if (pick(rng_, std::uniform_int_distribution<int>::param_type{0, 1}) == 0) {
                n->kind = Node::Num;
                n->num = std::uniform_int_distribution<long long>(0, 9)(rng_);
            } else {
                n->kind = Node::Unit;
                n->unit = kUnits[std::uniform_int_distribution<int>(0, 6)(rng_)];
            }
            return n;
        }
        auto n = std::make_unique<Node>();
        int op = std::uniform_int_distribution<int>(0, 5)(rng_);
        n->a = make(depth - 1);
        if (op == 5) {
            n->kind = Node::Pow;
            n->exp = std::uniform_int_distribution<int>(-2, 2)(rng_);
        } else {
            n->kind = static_cast<Node::Kind>(Node::Add + op);
            n->b = make(depth - 1);
        }
        return n;
    }

private:
    std::mt19937 rng_;
};

MVal eval_model(const Node& n) {
    switch (n.kind) {
        case Node::Num:  return {MFrac(n.num, 1), {}};
        case Node::Unit: return model_unit(n.unit);
        case Node::Add:  return madd(eval_model(*n.a), eval_model(*n.b), false);
        case Node::Sub:  return madd(eval_model(*n.a), eval_model(*n.b), true);
        case Node::Mul:  return mmul(eval_model(*n.a), eval_model(*n.b), false);
        case Node::Div:  return mmul(eval_model(*n.a), eval_model(*n.b), true);
        case Node::Pow:  return mpow(eval_model(*n.a), n.exp);
    }
    throw std::logic_error("bad node");
}

std::string render(const Node& n) {
    switch (n.kind) {
        case Node::Num:  return std::to_string(n.num);
        case Node::Unit: return n.unit;
        case Node::Add:  return "(" + render(*n.a) + "+" + render(*n.b) + ")";
        case Node::Sub:  return "(" + render(*n.a) + "-" + render(*n.b) + ")";
        case Node::Mul:  return "(" + render(*n.a) + "*" + render(*n.b) + ")";
        case Node::Div:  return "(" + render(*n.a) + "/" + render(*n.b) + ")";
        case Node::Pow:  return "(" + render(*n.a) + ")^" + std::to_string(n.exp);
    }
    return {};
}

void cross_check_random(int count, unsigned seed) {
    Generator gen(seed);
    int compared = 0, both_threw = 0;
    for (int i = 0; i < count; ++i) {
        auto ast = gen.make(3);
        std::string text = render(*ast);

        MVal expected;
        bool model_ok = true;
        try {
            expected = eval_model(*ast);
        } catch (const std::exception&) {
            model_ok = false;
        }

        units::Quantity got;
        bool lib_ok = true;
        try {
            got = units::parse(text);
        } catch (const std::exception&) {
            lib_ok = false;
        }

        ++g_checks;
        if (model_ok != lib_ok) {
            ++g_failures;
            std::printf("FAIL: throw mismatch for %s (model_ok=%d lib_ok=%d)\n",
                        text.c_str(), model_ok, lib_ok);
            continue;
        }
        if (!model_ok) { ++both_threw; continue; }
        bool same = got.mag.num == expected.f.n && got.mag.den == expected.f.d;
        for (int k = 0; k < 7; ++k) same = same && got.dims.e[k] == expected.dims[k];
        if (!same) {
            ++g_failures;
            std::printf("FAIL: value mismatch for %s: got %lld/%lld want %lld/%lld\n",
                        text.c_str(), (long long)got.mag.num, (long long)got.mag.den,
                        (long long)expected.f.n, (long long)expected.f.d);
            continue;
        }
        ++compared;
    }
    std::printf("cross-check: %d compared equal, %d both rejected\n", compared, both_threw);
}

// ---------------------------------------------------------------------------
// Direct unit tests.
// ---------------------------------------------------------------------------
void test_rational() {
    using units::Rational;
    check(Rational(6, 8) == Rational(3, 4), "reduce 6/8");
    check(Rational(-2, -4) == Rational(1, 2), "reduce -2/-4");
    check(Rational(5, -10) == Rational(-1, 2), "sign normalization");
    check(Rational(0, 7) == Rational(0, 1), "zero normalization");
    check_throws([] { Rational(1, 0); }, "zero denominator rejected");
    check(Rational(1, 2) + Rational(1, 3) == Rational(5, 6), "1/2+1/3");
    check(Rational(1, 2) - Rational(3, 4) == Rational(-1, 4), "1/2-3/4");
    check(Rational(2, 3) * Rational(3, 4) == Rational(1, 2), "2/3*3/4");
    check(Rational(1, 2) / Rational(3, 4) == Rational(2, 3), "(1/2)/(3/4)");
    check_throws([] { (void)(Rational(1, 2) / Rational(0, 1)); }, "division by zero");
    check(Rational(2, 3).pow(2) == Rational(4, 9), "(2/3)^2");
    check(Rational(2, 3).pow(-2) == Rational(9, 4), "(2/3)^-2");
    check(Rational(5, 7).pow(0) == Rational(1, 1), "x^0");
    // Large exact reduction: 2^40 / 2^39 = 2.
    check(Rational(1099511627776LL, 549755813888LL) == Rational(2, 1), "big reduce");
}

void test_dims() {
    using units::Dims;
    Dims l = Dims::base(0);
    Dims t = Dims::base(2);
    Dims v = l - t;  // velocity
    check(v.e[0] == 1 && v.e[2] == -1, "L T^-1");
    check_throws([&] { (void)(l.scaled(17)); }, "scaled overflow");
    check(l.scaled(16).e[0] == 16, "scaled at limit ok");
    check_throws([&] { (void)(l.scaled(16) + l); }, "add overflow");
    check_throws([&] { (void)(Dims{} - l.scaled(16) - l); }, "sub overflow");
}

void test_parser_basics() {
    using namespace units;
    Quantity q = parse("2*km + 300*m");
    check(q.mag == Rational(2300, 1) && q.dims == Dims::base(0), "2*km+300*m = 2300 m");
    check(convert(q, "km") == Rational(23, 10), "2300 m = 23/10 km");

    Quantity v = parse("10*m / (2*s)");
    check(v.mag == Rational(5, 1), "10*m/2*s magnitude");
    check(v.dims.e[0] == 1 && v.dims.e[2] == -1, "velocity dims");

    Quantity e = parse("kg*(m/s)^2");
    check(e.dims.e[0] == 2 && e.dims.e[1] == 1 && e.dims.e[2] == -2, "energy dims");
    check(convert(parse("3*kg*(m/s)^2"), "J") == Rational(3, 1), "3 kg m^2/s^2 = 3 J");

    check(convert(parse("90*min"), "h") == Rational(3, 2), "90 min = 3/2 h");
    check(convert(parse("2500*g"), "kg") == Rational(5, 2), "2500 g = 5/2 kg");
    check(convert(parse("2*L"), "cm^3") == Rational(2000, 1), "2 L = 2000 cm^3");
    check(convert(parse("1/m"), "1/cm") == Rational(1, 100), "1/m in 1/cm");

    // Rational arithmetic through division of literals.
    Quantity r = parse("(3/4) / (2/3)");
    check(r.mag == Rational(9, 8), "(3/4)/(2/3) = 9/8");

    // Negative exponent and unary minus.
    check(parse("s^-1").dims.e[2] == -1, "s^-1 dims");
    check(parse("-3*m").mag == Rational(-3, 1), "unary minus");
}

void test_rejections() {
    using namespace units;
    check_throws([] { parse("1/0"); }, "literal zero division");
    check_throws([] { parse("1/(2-2)"); }, "computed zero division");
    check_throws([] { parse("m^17"); }, "exponent 17 rejected");
    check_throws([] { parse("m^-17"); }, "exponent -17 rejected");
    check_throws([] { parse("m^16 * m"); }, "dims overflow via multiply");
    check_throws([] { parse("m^16 / m^-1"); }, "dims overflow via divide");
    check_throws([] { parse("(m^4)^5"); }, "dims overflow via pow");
    check(parse("m^16").dims.e[0] == 16, "m^16 accepted");
    check(parse("m^16 / m").dims.e[0] == 15, "m^16/m accepted");
    check_throws([] { parse("1*m + 1*s"); }, "add incompatible dims");
    check_throws([] { parse("1*kg - 2*m"); }, "sub incompatible dims");
    check_throws([] { parse("m +"); }, "trailing operator");
    check_throws([] { parse("furlong"); }, "unknown unit");
    check_throws([] { parse("(m"); }, "unbalanced paren");
    check_throws([] { parse("m m"); }, "trailing token");
    check_throws([] { convert(parse("3*m"), "s"); }, "convert incompatible");
}

} // namespace

int main() {
    test_rational();
    test_dims();
    test_parser_basics();
    test_rejections();
    cross_check_random(4000, 20261007u);
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
