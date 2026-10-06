// Tests for the units library, including a cross-check against an
// independent symbolic reference model: random expression trees are
// rendered to strings, evaluated by the library parser, and compared
// against a naive evaluator that uses 128-bit rationals and unbounded
// dimension exponents.
#include "units/parser.hpp"
#include "units/quantity.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const std::string& what) {
    ++g_checks;
    if (!ok) {
        ++g_failures;
        std::fprintf(stderr, "FAIL: %s\n", what.c_str());
    }
}

template <typename F>
void check_throws(F&& f, const std::string& what) {
    ++g_checks;
    try {
        f();
    } catch (const std::exception&) {
        return;
    }
    ++g_failures;
    std::fprintf(stderr, "FAIL (no throw): %s\n", what.c_str());
}

using units::Dimension;
using units::Quantity;
using units::Rational;

// ---------------------------------------------------------------------------
// Targeted tests
// ---------------------------------------------------------------------------

void test_rational() {
    Rational half(2, 4);
    check(half.num() == 1 && half.den() == 2, "2/4 reduces to 1/2");
    Rational neg(3, -9);
    check(neg.num() == -1 && neg.den() == 3, "3/-9 reduces to -1/3");
    check((Rational(1, 2) + Rational(1, 3)) == Rational(5, 6), "1/2+1/3=5/6");
    check((Rational(2, 3) * Rational(9, 4)) == Rational(3, 2), "2/3*9/4=3/2");
    check((Rational(3, 4) / Rational(9, 8)) == Rational(2, 3), "3/4 / 9/8=2/3");
    check(Rational(2, 3).pow(-2) == Rational(9, 4), "(2/3)^-2=9/4");
    check_throws([] { Rational(1, 0); }, "zero denominator rejected");
    check_throws([] { Rational(1, 2) / Rational(0); }, "division by zero rejected");
    check_throws([] { Rational(0).pow(-1); }, "0^-1 rejected");
    check_throws([] { Rational(INT64_MAX) * Rational(2); }, "value overflow rejected");
}

void test_dimension() {
    Dimension l = Dimension::base(0);
    Dimension t = Dimension::base(2);
    check((l + t) - t == l, "dim add/sub round-trips");
    check(l.scaled(3).e[0] == 3, "dim scaling");
    check_throws([&] { l.scaled(17); }, "exponent +17 rejected");
    check_throws([&] { l.scaled(-17); }, "exponent -17 rejected");
    check_throws([&] { Dimension d; d.e[0] = 16; d + l; }, "16+1 overflows");
    check_throws([&] { Dimension d; d.e[0] = -16; d - l; }, "-16-1 overflows");
}

void test_quantity_addition() {
    Quantity two_m(Rational(2), Dimension::base(0));
    Quantity three_m(Rational(3), Dimension::base(0));
    check((two_m + three_m).value() == Rational(5), "2m+3m=5m");
    check((three_m - two_m).value() == Rational(1), "3m-2m=1m");
    Quantity one_s(Rational(1), Dimension::base(2));
    check_throws([&] { two_m + one_s; }, "m+s rejected");
    check_throws([&] { two_m - one_s; }, "m-s rejected");
    Quantity two(Rational(2));
    Quantity half(Rational(1, 2));
    check((two + half).value() == Rational(5, 2), "dimensionless add");
}

void test_parser() {
    using units::parse_expression;
    // Derived-unit identities.
    check(parse_expression("kg*m/s^2") == parse_expression("N"), "kg*m/s^2 == N");
    check(parse_expression("N/m^2") == parse_expression("Pa"), "N/m^2 == Pa");
    check(parse_expression("N*m") == parse_expression("J"), "N*m == J");
    check(parse_expression("J/s") == parse_expression("W"), "J/s == W");
    check(parse_expression("A*s") == parse_expression("C"), "A*s == C");
    check(parse_expression("W/A") == parse_expression("V"), "W/A == V");
    check(parse_expression("1/s") == parse_expression("Hz"), "1/s == Hz");
    // Exact rational arithmetic.
    Quantity q = parse_expression("3/4*m");
    check(q.value() == Rational(3, 4), "3/4*m keeps exact ratio");
    check(parse_expression("2/4").value() == Rational(1, 2), "2/4 reduces");
    Quantity v = parse_expression("(2/3)*m/(4/9)*s^-1");
    check(v.value() == Rational(3, 2), "(2/3)/(4/9)=3/2 exactly");
    check(v.dim() == Dimension::base(0) - Dimension::base(2), "velocity dims");
    // Powers and parentheses.
    check(parse_expression("(m/s)^2").dim().e[0] == 2, "(m/s)^2 dims L^2");
    check(parse_expression("m^-1").dim().e[0] == -1, "negative exponent");
    check(parse_expression("-(3*m)").value() == Rational(-3), "unary minus");
    check(parse_expression("1000*g") == parse_expression("kg"), "1000 g == 1 kg");
    // Rejections.
    check_throws([] { parse_expression("1/0"); }, "1/0 rejected");
    check_throws([] { parse_expression("m^17"); }, "m^17 exponent overflow");
    check_throws([] { parse_expression("(m^4)^5"); }, "(m^4)^5 exponent overflow");
    check_throws([] { parse_expression("m^-17"); }, "m^-17 exponent overflow");
    check_throws([] { parse_expression("furlong"); }, "unknown unit rejected");
    check_throws([] { parse_expression("m*"); }, "dangling operator rejected");
    check_throws([] { parse_expression("(m"); }, "unbalanced paren rejected");
    check_throws([] { parse_expression("m s"); }, "juxtaposition rejected");
    check_throws([] { parse_expression(""); }, "empty input rejected");
}

// ---------------------------------------------------------------------------
// Independent symbolic reference model
// ---------------------------------------------------------------------------

struct RefQ {
    __int128 num = 0, den = 1;          // unreduced until normalization
    std::array<long long, 7> e{};       // unbounded exponents
};

__int128 ref_gcd(__int128 a, __int128 b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b != 0) { __int128 t = a % b; a = b; b = t; }
    return a;
}

RefQ ref_normalize(RefQ q) {
    if (q.den < 0) { q.num = -q.num; q.den = -q.den; }
    __int128 g = ref_gcd(q.num, q.den);
    if (g != 0) { q.num /= g; q.den /= g; }
    return q;
}

RefQ ref_mul(const RefQ& a, const RefQ& b) {
    RefQ r;
    r.num = a.num * b.num;
    r.den = a.den * b.den;
    for (int i = 0; i < 7; ++i) r.e[i] = a.e[i] + b.e[i];
    return r;
}

RefQ ref_div(const RefQ& a, const RefQ& b) {
    RefQ r;
    r.num = a.num * b.den;
    r.den = a.den * b.num;
    for (int i = 0; i < 7; ++i) r.e[i] = a.e[i] - b.e[i];
    return r;
}

RefQ ref_pow(const RefQ& a, int k) {
    RefQ base = a;
    int n = k;
    if (n < 0) {
        std::swap(base.num, base.den);
        for (auto& v : base.e) v = -v;
        n = -n;
    }
    RefQ r;
    r.num = 1;
    for (int i = 0; i < n; ++i) r = ref_mul(r, base);
    return r;
}

// Random expression tree.
struct Node {
    enum class Kind { Num, Unit, Mul, Div, Pow } kind;
    int num = 1, den = 1;  // Num
    int unit = 0;          // Unit: base dimension index
    int power = 1;         // Pow
    std::vector<Node> kids;
};

class Generator {
public:
    explicit Generator(std::mt19937_64& rng) : rng_(rng) {}

    Node expr(int depth) {
        if (depth == 0) return leaf();
        std::uniform_int_distribution<int> pick(0, 3);
        Node n;
        switch (pick(rng_)) {
            case 0: n.kind = Node::Kind::Mul; break;
            case 1: n.kind = Node::Kind::Div; break;
            case 2: {
                n.kind = Node::Kind::Pow;
                std::uniform_int_distribution<int> p(-4, 4);
                n.power = p(rng_);
                if (n.power == 0) n.power = 2;
                n.kids.push_back(expr(depth - 1));
                return n;
            }
            default: return leaf();
        }
        n.kids.push_back(expr(depth - 1));
        n.kids.push_back(expr(depth - 1));
        return n;
    }

    Node leaf() {
        std::uniform_int_distribution<int> pick(0, 1);
        Node n;
        if (pick(rng_) == 0) {
            n.kind = Node::Kind::Num;
            std::uniform_int_distribution<int> v(1, 9);
            n.num = v(rng_);
            n.den = v(rng_);
        } else {
            n.kind = Node::Kind::Unit;
            std::uniform_int_distribution<int> u(0, 6);
            n.unit = u(rng_);
        }
        return n;
    }

private:
    std::mt19937_64& rng_;
};

std::string render(const Node& n) {
    static const char* names[7] = {"m", "kg", "s", "A", "K", "mol", "cd"};
    switch (n.kind) {
        case Node::Kind::Num:
            if (n.den == 1) return std::to_string(n.num);
            return "(" + std::to_string(n.num) + "/" + std::to_string(n.den) + ")";
        case Node::Kind::Unit:
            return names[n.unit];
        case Node::Kind::Mul:
            return "(" + render(n.kids[0]) + "*" + render(n.kids[1]) + ")";
        case Node::Kind::Div:
            return "(" + render(n.kids[0]) + "/" + render(n.kids[1]) + ")";
        case Node::Kind::Pow:
            return "(" + render(n.kids[0]) + ")^" + std::to_string(n.power);
    }
    return {};
}

// Conservative upper bound on every intermediate numerator/denominator
// magnitude in the tree (root bound dominates all subtree bounds).
__int128 magnitude_bound(const Node& n) {
    const __int128 cap = static_cast<__int128>(1) << 62;
    switch (n.kind) {
        case Node::Kind::Num:
            return n.num > n.den ? n.num : n.den;
        case Node::Kind::Unit:
            return 1;
        case Node::Kind::Mul:
        case Node::Kind::Div: {
            __int128 b = magnitude_bound(n.kids[0]) * magnitude_bound(n.kids[1]);
            return b > cap ? cap : b;
        }
        case Node::Kind::Pow: {
            __int128 base = magnitude_bound(n.kids[0]);
            __int128 b = 1;
            int k = n.power < 0 ? -n.power : n.power;
            for (int i = 0; i < k; ++i) {
                b *= base;
                if (b > cap) return cap;
            }
            return b;
        }
    }
    return 1;
}

// Evaluates the tree and also tracks the largest absolute dimension
// exponent seen at ANY intermediate node, mirroring the library's
// per-operation range check.
RefQ ref_eval(const Node& n, long long& max_abs_exp) {
    RefQ q;
    switch (n.kind) {
        case Node::Kind::Num:
            q.num = n.num;
            q.den = n.den;
            break;
        case Node::Kind::Unit:
            q.num = 1;
            q.e[n.unit] = 1;
            break;
        case Node::Kind::Mul:
            q = ref_mul(ref_eval(n.kids[0], max_abs_exp),
                        ref_eval(n.kids[1], max_abs_exp));
            break;
        case Node::Kind::Div:
            q = ref_div(ref_eval(n.kids[0], max_abs_exp),
                        ref_eval(n.kids[1], max_abs_exp));
            break;
        case Node::Kind::Pow:
            q = ref_pow(ref_eval(n.kids[0], max_abs_exp), n.power);
            break;
    }
    for (long long v : q.e) {
        long long a = v < 0 ? -v : v;
        if (a > max_abs_exp) max_abs_exp = a;
    }
    return q;
}

void test_against_reference_model() {
    std::mt19937_64 rng(20261007);
    Generator gen(rng);
    int overflow_cases = 0, compared = 0;
    const __int128 value_cap = static_cast<__int128>(1) << 62;
    for (int i = 0; i < 4000; ++i) {
        Node tree = gen.expr(4);
        // Skip trees whose values could overflow the library's int64
        // arithmetic; value-overflow rejection is covered by targeted tests.
        if (magnitude_bound(tree) >= value_cap) { --i; continue; }
        std::string text = render(tree);
        long long max_abs_exp = 0;
        RefQ expected = ref_normalize(ref_eval(tree, max_abs_exp));

        bool out_of_range = max_abs_exp > Dimension::kMaxExponent;

        if (out_of_range) {
            ++overflow_cases;
            try {
                units::parse_expression(text);
                check(false, "expected exponent overflow for: " + text);
            } catch (const std::overflow_error&) {
            }
            continue;
        }

        try {
            Quantity got = units::parse_expression(text);
            ++compared;
            bool dims_ok = true;
            for (int d = 0; d < 7; ++d)
                if (got.dim().e[d] != static_cast<int>(expected.e[d])) dims_ok = false;
            check(dims_ok, "dimension mismatch for: " + text);
            check(got.value().num() == static_cast<std::int64_t>(expected.num) &&
                      got.value().den() == static_cast<std::int64_t>(expected.den),
                  "value mismatch for: " + text + " got " + got.value().to_string());
        } catch (const std::exception& ex) {
            check(false, "unexpected throw for: " + text + " (" + ex.what() + ")");
        }
    }
    std::printf("reference-model cross-check: %d compared, %d overflow-rejected\n",
                compared, overflow_cases);
    check(overflow_cases > 0, "generator produced overflow cases");
}

} // namespace

int main() {
    test_rational();
    test_dimension();
    test_quantity_addition();
    test_parser();
    test_against_reference_model();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
