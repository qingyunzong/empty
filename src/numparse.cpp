#include "numparse.hpp"

#include <algorithm>

namespace numimport {

namespace {

bool all_digits(std::string_view s) {
    return !s.empty() &&
           std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}

std::string strip_leading_zeros(std::string_view s) {
    const auto pos = s.find_first_not_of('0');
    if (pos == std::string_view::npos)
        return "0";
    return std::string(s.substr(pos));
}

// Exact division of a decimal string by a small number.
std::string div_small(std::string_view num, unsigned divisor) {
    std::string out;
    out.reserve(num.size());
    unsigned rem = 0;
    for (char c : num) {
        const unsigned cur = rem * 10 + static_cast<unsigned>(c - '0');
        const unsigned q = cur / divisor;
        rem = cur % divisor;
        if (!out.empty() || q != 0)
            out.push_back(static_cast<char>('0' + q));
    }
    return out.empty() ? "0" : out;
}

std::string mul_small(std::string_view num, unsigned factor) {
    std::string out(num.size() + 2, '0');
    unsigned carry = 0;
    std::size_t w = out.size();
    for (auto it = num.rbegin(); it != num.rend(); ++it) {
        const unsigned cur = static_cast<unsigned>(*it - '0') * factor + carry;
        out[--w] = static_cast<char>('0' + cur % 10);
        carry = cur / 10;
    }
    while (carry != 0) {
        out[--w] = static_cast<char>('0' + carry % 10);
        carry /= 10;
    }
    return out.substr(w);
}

} // namespace

std::string Fraction::to_string() const {
    if (num == "0")
        return "0";
    std::string out = negative ? "-" : "";
    out += num;
    if (den != "1") {
        out += '/';
        out += den;
    }
    return out;
}

std::optional<Fraction> parse_number(std::string_view s, DecimalSep sep) {
    if (s.empty())
        return std::nullopt;

    bool negative = false;
    if (s.front() == '+' || s.front() == '-') {
        negative = s.front() == '-';
        s.remove_prefix(1);
    }
    if (s.empty())
        return std::nullopt;

    const char dec = sep == DecimalSep::dot ? '.' : ',';
    const char tho = dec == '.' ? ',' : '.';

    std::string_view int_part = s;
    std::string_view frac_part;
    if (const auto pos = s.find(dec); pos != std::string_view::npos) {
        int_part = s.substr(0, pos);
        frac_part = s.substr(pos + 1);
        if (frac_part.find(dec) != std::string_view::npos)
            return std::nullopt;
        if (!all_digits(frac_part))
            return std::nullopt;
    }

    std::string int_digits;
    if (int_part.find(tho) == std::string_view::npos) {
        if (!all_digits(int_part))
            return std::nullopt;
        int_digits = int_part;
    } else {
        std::size_t start = 0;
        std::size_t group = 0;
        while (true) {
            const auto pos = int_part.find(tho, start);
            const std::string_view g =
                pos == std::string_view::npos ? int_part.substr(start)
                                              : int_part.substr(start, pos - start);
            const bool ok = group == 0 ? (g.size() >= 1 && g.size() <= 3 && all_digits(g))
                                       : (g.size() == 3 && all_digits(g));
            if (!ok)
                return std::nullopt;
            int_digits += g;
            if (pos == std::string_view::npos)
                break;
            start = pos + 1;
            ++group;
        }
    }

    std::string num = int_digits;
    num += frac_part;
    num = strip_leading_zeros(num);
    if (num == "0")
        return Fraction{};

    // Denominator is 10^k; reduce by cancelling factors of 2 and 5.
    const std::size_t k = frac_part.size();
    std::size_t twos = 0, fives = 0;
    while (twos < k && (num.back() - '0') % 2 == 0) {
        num = div_small(num, 2);
        ++twos;
    }
    while (fives < k && (num.back() == '0' || num.back() == '5')) {
        num = div_small(num, 5);
        ++fives;
    }
    std::string den = "1";
    for (std::size_t i = 0; i < k - twos; ++i)
        den = mul_small(den, 2);
    for (std::size_t i = 0; i < k - fives; ++i)
        den = mul_small(den, 5);

    return Fraction{negative, std::move(num), std::move(den)};
}

std::string_view trim(std::string_view s) {
    const auto is_space = [](char c) {
        return c == ' ' || c == '\t' || c == '\r' || c == '\n';
    };
    while (!s.empty() && is_space(s.front()))
        s.remove_prefix(1);
    while (!s.empty() && is_space(s.back()))
        s.remove_suffix(1);
    return s;
}

} // namespace numimport
