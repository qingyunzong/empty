#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace numimport {

enum class DecimalSep { dot, comma };

// Exact rational number: value = (negative ? -1 : 1) * num / den.
// Invariants: den >= 1, gcd(num, den) == 1, num and den are decimal strings
// without leading zeros. Zero is always {false, "0", "1"}.
struct Fraction {
    bool negative = false;
    std::string num = "0";
    std::string den = "1";

    std::string to_string() const;
    friend bool operator==(const Fraction&, const Fraction&) = default;
};

// Parses s as a number using `sep` as the decimal separator. The other of
// '.' and ',' acts as a thousands separator and is only legal between digit
// groups of exactly three (first group 1-3 digits). Returns nullopt if s is
// not a valid number under this interpretation.
std::optional<Fraction> parse_number(std::string_view s, DecimalSep sep);

// Trims ASCII whitespace from both ends.
std::string_view trim(std::string_view s);

} // namespace numimport
