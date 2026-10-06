#include "number_parser.hpp"

namespace numimport {
namespace {

bool isDigit(char c) { return c >= '0' && c <= '9'; }

std::string stripLeadingZeros(const std::string& digits) {
    const auto pos = digits.find_first_not_of('0');
    if (pos == std::string::npos) return "0";
    return digits.substr(pos);
}

// Exact decimal-string division by a small integer (caller guarantees the
// division is exact).
std::string divBySmall(const std::string& digits, int divisor) {
    std::string out;
    out.reserve(digits.size());
    int rem = 0;
    for (char c : digits) {
        const int cur = rem * 10 + (c - '0');
        const int q = cur / divisor;
        rem = cur % divisor;
        if (!out.empty() || q != 0) out.push_back(static_cast<char>('0' + q));
    }
    return out.empty() ? "0" : out;
}

std::string mulBySmall(const std::string& digits, int factor) {
    if (digits == "0") return "0";
    std::string out(digits.size() + 2, '0');
    int carry = 0;
    size_t oi = out.size();
    for (size_t i = digits.size(); i-- > 0;) {
        const int cur = (digits[i] - '0') * factor + carry;
        out[--oi] = static_cast<char>('0' + (cur % 10));
        carry = cur / 10;
    }
    while (carry > 0) {
        out[--oi] = static_cast<char>('0' + (carry % 10));
        carry /= 10;
    }
    return out.substr(oi);
}

// Divides `num` by `divisor` (2 or 5) as long as it stays divisible, at most
// `limit` times. Returns how many divisions were performed.
int divideOut(std::string& num, int divisor, int limit) {
    int count = 0;
    while (count < limit && num != "0") {
        const int last = num.back() - '0';
        const bool divisible = divisor == 2 ? (last % 2 == 0) : (last == 0 || last == 5);
        if (!divisible) break;
        num = divBySmall(num, divisor);
        ++count;
    }
    return count;
}

} // namespace

std::optional<ExactNumber> parseNumber(std::string_view token, char decimalChar) {
    if (decimalChar != '.' && decimalChar != ',') return std::nullopt;
    const char groupChar = decimalChar == '.' ? ',' : '.';
    const size_t n = token.size();
    size_t i = 0;

    bool negative = false;
    if (i < n && (token[i] == '+' || token[i] == '-')) {
        negative = token[i] == '-';
        ++i;
    }

    // Integer part: either plain digits, or 1-3 digits followed by one or
    // more (groupChar + exactly 3 digits) groups.
    if (i >= n || !isDigit(token[i])) return std::nullopt;
    const size_t firstBegin = i;
    while (i < n && isDigit(token[i])) ++i;
    const size_t firstLen = i - firstBegin;
    std::string intDigits(token.substr(firstBegin, firstLen));
    bool grouped = false;
    while (i < n && token[i] == groupChar) {
        grouped = true;
        ++i;
        const size_t groupBegin = i;
        while (i < n && isDigit(token[i])) ++i;
        if (i - groupBegin != 3) return std::nullopt;
        intDigits.append(token.substr(groupBegin, 3));
    }
    if (grouped && firstLen > 3) return std::nullopt;

    // Fraction part: decimalChar followed by at least one digit. No further
    // separators are allowed after it.
    std::string fracDigits;
    if (i < n && token[i] == decimalChar) {
        ++i;
        const size_t fracBegin = i;
        while (i < n && isDigit(token[i])) ++i;
        if (i == fracBegin) return std::nullopt;
        fracDigits.assign(token.substr(fracBegin, i - fracBegin));
    }
    if (i != n) return std::nullopt;

    // Exact value: intDigits.fracDigits = (intDigits ++ fracDigits) / 10^k.
    std::string num = stripLeadingZeros(intDigits + fracDigits);
    if (num == "0") return ExactNumber{}; // canonical zero, sign dropped
    const size_t k = fracDigits.size();

    // den = 10^k = 2^k * 5^k, so reduction only needs factors 2 and 5.
    const int twos = divideOut(num, 2, static_cast<int>(k));
    const int fives = divideOut(num, 5, static_cast<int>(k));
    std::string den = "1";
    for (size_t j = 0; j < k - static_cast<size_t>(twos); ++j) den = mulBySmall(den, 2);
    for (size_t j = 0; j < k - static_cast<size_t>(fives); ++j) den = mulBySmall(den, 5);

    ExactNumber value;
    value.negative = negative;
    value.num = std::move(num);
    value.den = std::move(den);
    return value;
}

std::string toString(const ExactNumber& value) {
    std::string out = value.negative ? "-" : "";
    out += value.num;
    if (value.den != "1") {
        out += '/';
        out += value.den;
    }
    return out;
}

} // namespace numimport
