// Exhaustive cross-check: every short string over a number-ish alphabet is
// parsed by the production parser and by an independent reference
// implementation (regex-based validation + separate value construction).
// Both must agree on validity and on the exact rational value.

#include "number_parser.hpp"

#include <algorithm>
#include <iostream>
#include <optional>
#include <regex>
#include <string>
#include <vector>

namespace {

using numimport::ExactNumber;

// --- Independent reference implementation -------------------------------

std::string stripZeros(const std::string& digits) {
    const auto pos = digits.find_first_not_of('0');
    return pos == std::string::npos ? "0" : digits.substr(pos);
}

std::string divBy(const std::string& digits, int divisor) {
    std::string out;
    int rem = 0;
    for (char c : digits) {
        const int cur = rem * 10 + (c - '0');
        rem = cur % divisor;
        if (!out.empty() || cur / divisor != 0)
            out.push_back(static_cast<char>('0' + cur / divisor));
    }
    return out.empty() ? "0" : out;
}

std::optional<ExactNumber> referenceParse(const std::string& token, char decimal) {
    static const std::regex dotDecimal{
        R"(^[+-]?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)(\.[0-9]+)?$)"};
    static const std::regex commaDecimal{
        R"(^[+-]?([0-9]+|[0-9]{1,3}(\.[0-9]{3})+)(,[0-9]+)?$)"};
    if (!std::regex_match(token, decimal == '.' ? dotDecimal : commaDecimal))
        return std::nullopt;

    const char group = decimal == '.' ? ',' : '.';
    std::string s = token;
    bool negative = false;
    if (s.front() == '+' || s.front() == '-') {
        negative = s.front() == '-';
        s.erase(s.begin());
    }
    s.erase(std::remove(s.begin(), s.end(), group), s.end());
    const auto dot = s.find(decimal);
    const std::string intPart = dot == std::string::npos ? s : s.substr(0, dot);
    const std::string fracPart = dot == std::string::npos ? "" : s.substr(dot + 1);

    std::string num = stripZeros(intPart + fracPart);
    if (num == "0") return ExactNumber{};
    std::string den = "1" + std::string(fracPart.size(), '0');
    auto divisibleBy = [](const std::string& v, int d) {
        const int last = v.back() - '0';
        return d == 2 ? last % 2 == 0 : last == 0 || last == 5;
    };
    while (divisibleBy(num, 2) && divisibleBy(den, 2)) {
        num = divBy(num, 2);
        den = divBy(den, 2);
    }
    while (divisibleBy(num, 5) && divisibleBy(den, 5)) {
        num = divBy(num, 5);
        den = divBy(den, 5);
    }
    return ExactNumber{negative, num, den};
}

// --- Exhaustive enumeration ----------------------------------------------

const char kAlphabet[] = {'0', '1', '9', '.', ',', '+', '-'};
constexpr size_t kMaxLength = 7;

size_t checked = 0;
size_t mismatches = 0;

void check(const std::string& token) {
    for (char decimal : {'.', ','}) {
        const auto production = numimport::parseNumber(token, decimal);
        const auto reference = referenceParse(token, decimal);
        ++checked;
        const bool sameValidity = production.has_value() == reference.has_value();
        const bool sameValue = !sameValidity || !production || *production == *reference;
        if (!sameValidity || !sameValue) {
            if (mismatches < 20) {
                std::cerr << "MISMATCH token=\"" << token << "\" decimal='" << decimal
                          << "': production="
                          << (production ? numimport::toString(*production) : "<invalid>")
                          << " reference="
                          << (reference ? numimport::toString(*reference) : "<invalid>")
                          << '\n';
            }
            ++mismatches;
        }
    }
}

void enumerate(std::string& current, size_t remaining) {
    if (remaining == 0) {
        check(current);
        return;
    }
    for (char c : kAlphabet) {
        current.push_back(c);
        enumerate(current, remaining - 1);
        current.pop_back();
    }
}

} // namespace

int main() {
    std::string current;
    check(""); // empty token
    for (size_t length = 1; length <= kMaxLength; ++length) enumerate(current, length);

    std::cout << "exhaustively checked " << checked << " (token, interpretation) pairs\n";
    if (mismatches > 0) {
        std::cerr << mismatches << " mismatch(es) against the reference\n";
        return 1;
    }
    return 0;
}
