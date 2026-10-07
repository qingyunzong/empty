#include "column.hpp"
#include "csv.hpp"
#include "numparse.hpp"

#include <cstring>
#include <iostream>
#include <numeric>
#include <optional>
#include <regex>
#include <string>
#include <tuple>
#include <vector>

namespace {

int checks = 0;
int failures = 0;

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        ++checks;                                                                              \
        if (!(cond)) {                                                                         \
            ++failures;                                                                        \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " #cond "\n";            \
        }                                                                                      \
    } while (0)

using numimport::DecimalSep;
using numimport::Fraction;

std::optional<Fraction> parse(const std::string& s, char dec) {
    return numimport::parse_number(s, dec == '.' ? DecimalSep::dot : DecimalSep::comma);
}

// ---------------------------------------------------------------------------
// Independent reference implementation (regex grammar + 64-bit value math).
// Only valid for short strings; used by the exhaustive cross-check below.
// ---------------------------------------------------------------------------

struct RefValue {
    bool negative;
    unsigned long long num;
    unsigned long long den;
};

std::optional<RefValue> ref_parse(const std::string& s, char dec) {
    const char tho = dec == '.' ? ',' : '.';
    const auto esc = [](char c) { return c == '.' ? std::string("\\.") : std::string(1, c); };
    const std::string pattern = "^[+-]?([0-9]+|[0-9]{1,3}(" + esc(tho) + "[0-9]{3})+)(" +
                                esc(dec) + "[0-9]+)?$";
    if (!std::regex_match(s, std::regex(pattern)))
        return std::nullopt;

    std::string body = (s[0] == '+' || s[0] == '-') ? s.substr(1) : s;
    const bool negative = s[0] == '-';
    std::erase(body, tho);
    std::string int_digits, frac_digits;
    if (const auto pos = body.find(dec); pos != std::string::npos) {
        int_digits = body.substr(0, pos);
        frac_digits = body.substr(pos + 1);
    } else {
        int_digits = body;
    }
    unsigned long long num = std::stoull(int_digits + frac_digits);
    unsigned long long den = 1;
    for (std::size_t i = 0; i < frac_digits.size(); ++i)
        den *= 10;
    const unsigned long long g = std::gcd(num, den);
    num /= g;
    den /= g;
    return RefValue{negative && num != 0, num, den};
}

void check_against_reference(const std::string& s) {
    for (char dec : {'.', ','}) {
        const auto got = parse(s, dec);
        const auto ref = ref_parse(s, dec);
        CHECK(got.has_value() == ref.has_value());
        if (got && ref) {
            CHECK(got->negative == ref->negative);
            CHECK(got->num == std::to_string(ref->num));
            CHECK(got->den == std::to_string(ref->den));
        }
    }
}

void enumerate(const std::string& prefix, int depth, int max_depth) {
    if (depth == max_depth) {
        check_against_reference(prefix);
        return;
    }
    for (char c : {'0', '1', '.', ','})
        enumerate(prefix + c, depth + 1, max_depth);
}

// ---------------------------------------------------------------------------

int test_parser() {
    auto expect = [](const std::string& s, char dec, const char* want) {
        const auto got = parse(s, dec);
        CHECK(got.has_value());
        if (got)
            CHECK(got->to_string() == want);
    };
    auto reject = [](const std::string& s, char dec) { CHECK(!parse(s, dec).has_value()); };

    expect("0", '.', "0");
    expect("-0.0", '.', "0");
    expect("42", '.', "42");
    expect("-17", '.', "-17");
    expect("+8", '.', "8");
    expect("1.5", '.', "3/2");
    expect("0.2", '.', "1/5");
    expect("1.25", '.', "5/4");
    expect("1,234,567", '.', "1234567");
    expect("1,234.5", '.', "2469/2");
    expect("1.234.567,89", ',', "123456789/100");
    expect("12,34", ',', "617/50"); // comma as decimal separator
    expect("1,234", ',', "617/500");
    expect("007", '.', "7");
    expect("1.000", '.', "1");

    reject("", '.');
    reject("abc", '.');
    reject("1.2.3", '.');
    reject("1,2,3", '.');
    reject("12,34", '.');  // thousands group must be exactly three digits
    reject("1,23", '.');
    reject("1234,567", '.'); // first group too long
    reject("1,,234", '.');
    reject("1.", '.');
    reject(".5", '.');
    reject("-", '.');
    reject("1.2,3", '.');
    reject("1,234.5", ','); // '.' is not a digit in the fraction
    reject("1.5", ',');     // "1.5" as thousands groups: "5" is not 3 digits

    return failures;
}

int test_exhaustive() {
    // Every string over {'0','1','.',','} up to length 7, plus every string
    // up to length 6 behind a '-' sign, cross-checked against the reference.
    for (int len = 1; len <= 7; ++len)
        enumerate("", 0, len);
    for (int len = 1; len <= 6; ++len)
        enumerate("-", 1, len + 1);
    std::cerr << "exhaustive: " << checks << " checks\n";
    return failures;
}

int test_column() {
    using numimport::ColumnError;
    using numimport::ColumnKind;
    using numimport::decide_column;

    { // dot column, empty cells impose no constraint
        auto d = decide_column({"1.5", "", "2.25", "   "});
        CHECK(d.kind == ColumnKind::numeric && d.error == ColumnError::none);
        CHECK(d.sep == DecimalSep::dot);
    }
    { // comma column
        auto d = decide_column({"1,5", "2,25"});
        CHECK(d.kind == ColumnKind::numeric && d.sep == DecimalSep::comma);
    }
    { // both separators legal, same values -> not ambiguous
        auto d = decide_column({"123", "456", ""});
        CHECK(d.kind == ColumnKind::numeric && d.error == ColumnError::none);
    }
    { // both separators legal, different values -> ambiguous
        auto d = decide_column({"1,234"});
        CHECK(d.error == ColumnError::ambiguous && d.error_row == 1);
        CHECK(d.error_cell == "1,234");
    }
    { // ambiguity detected on a later row, not the first
        auto d = decide_column({"100", "1.234"});
        CHECK(d.error == ColumnError::ambiguous && d.error_row == 2);
    }
    { // no separator fits every row -> inconsistent
        auto d = decide_column({"1.5", "2,5"});
        CHECK(d.error == ColumnError::inconsistent && d.error_row == 2);
    }
    { // non-numeric cell -> column passes through untouched
        auto d = decide_column({"abc", "1.5"});
        CHECK(d.kind == ColumnKind::non_numeric && d.error == ColumnError::none);
    }
    { // empty column
        auto d = decide_column({"", "  "});
        CHECK(d.kind == ColumnKind::empty_only);
    }
    { // european style with thousands and decimal comma
        auto d = decide_column({"1.234,56", "2.345,67"});
        CHECK(d.kind == ColumnKind::numeric && d.sep == DecimalSep::comma);
    }
    { // us style with thousands and decimal dot
        auto d = decide_column({"1,234.56", "2,345.67"});
        CHECK(d.kind == ColumnKind::numeric && d.sep == DecimalSep::dot);
    }
    return failures;
}

int test_csv() {
    using numimport::parse_csv;
    using numimport::serialize_csv;

    CHECK(parse_csv("").empty());
    CHECK((parse_csv("a\n") == numimport::Table{{"a"}}));
    CHECK((parse_csv("a,b\r\nc,d\n") == numimport::Table{{"a", "b"}, {"c", "d"}}));
    CHECK((parse_csv("\"x,y\",\"q\"\"r\"") == numimport::Table{{"x,y", "q\"r"}}));
    CHECK((parse_csv("\"a\nb\",c") == numimport::Table{{"a\nb", "c"}}));
    CHECK((parse_csv("a,,c") == numimport::Table{{"a", "", "c"}}));

    const numimport::Table t{{"plain", "has,comma", "has\"quote", "has\nnewline", ""}};
    const std::string s = serialize_csv(t);
    CHECK(parse_csv(s) == t);
    CHECK(s == "plain,\"has,comma\",\"has\"\"quote\",\"has\nnewline\",\n");
    return failures;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: numimport_tests <parser|exhaustive|column|csv>\n";
        return 2;
    }
    const std::string what = argv[1];
    int rc = 2;
    if (what == "parser")
        rc = test_parser();
    else if (what == "exhaustive")
        rc = test_exhaustive();
    else if (what == "column")
        rc = test_column();
    else if (what == "csv")
        rc = test_csv();
    else
        std::cerr << "unknown test suite: " << what << "\n";
    if (rc == 2)
        return 2;
    std::cerr << (failures == 0 ? "OK" : "FAILED") << " (" << checks << " checks, "
              << failures << " failures)\n";
    return failures == 0 ? 0 : 1;
}
