#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace numimport {

// Exact rational number in canonical form:
//   value = (negative ? -1 : +1) * num / den
// num and den are decimal strings without leading zeros, den >= 1,
// gcd(num, den) == 1, and zero is always represented as non-negative 0/1.
struct ExactNumber {
    bool negative = false;
    std::string num = "0";
    std::string den = "1";

    friend bool operator==(const ExactNumber&, const ExactNumber&) = default;
};

// Renders the canonical form: "num" when den == 1, otherwise "num/den",
// with a leading '-' for negative values.
std::string toString(const ExactNumber& value);

// Parses `token` as a number whose decimal separator is `decimalChar`
// ('.' or ','); the other character acts as thousands separator and must
// group the integer digits in threes (e.g. "1,234,567" or "1.234.567,89").
// Returns nullopt when the token is not a valid number under this
// interpretation.
std::optional<ExactNumber> parseNumber(std::string_view token, char decimalChar);

} // namespace numimport
