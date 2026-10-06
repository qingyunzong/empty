#pragma once

#include "units/quantity.hpp"

#include <cctype>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace units {

// Symbol table of the 7 SI base units plus common derived units.
inline const std::unordered_map<std::string, Quantity>& unit_table() {
    static const std::unordered_map<std::string, Quantity> table = [] {
        std::unordered_map<std::string, Quantity> t;
        auto dim = [](std::initializer_list<int> v) {
            Dimension d;
            std::copy(v.begin(), v.end(), d.e.begin());
            return d;
        };
        t.emplace("m",   Quantity(Rational(1), dim({1, 0, 0, 0, 0, 0, 0})));
        t.emplace("kg",  Quantity(Rational(1), dim({0, 1, 0, 0, 0, 0, 0})));
        t.emplace("s",   Quantity(Rational(1), dim({0, 0, 1, 0, 0, 0, 0})));
        t.emplace("A",   Quantity(Rational(1), dim({0, 0, 0, 1, 0, 0, 0})));
        t.emplace("K",   Quantity(Rational(1), dim({0, 0, 0, 0, 1, 0, 0})));
        t.emplace("mol", Quantity(Rational(1), dim({0, 0, 0, 0, 0, 1, 0})));
        t.emplace("cd",  Quantity(Rational(1), dim({0, 0, 0, 0, 0, 0, 1})));
        t.emplace("g",   Quantity(Rational(1, 1000), dim({0, 1, 0, 0, 0, 0, 0})));
        t.emplace("Hz",  Quantity(Rational(1), dim({0, 0, -1, 0, 0, 0, 0})));
        t.emplace("N",   Quantity(Rational(1), dim({1, 1, -2, 0, 0, 0, 0})));
        t.emplace("Pa",  Quantity(Rational(1), dim({-1, 1, -2, 0, 0, 0, 0})));
        t.emplace("J",   Quantity(Rational(1), dim({2, 1, -2, 0, 0, 0, 0})));
        t.emplace("W",   Quantity(Rational(1), dim({2, 1, -3, 0, 0, 0, 0})));
        t.emplace("C",   Quantity(Rational(1), dim({0, 0, 1, 1, 0, 0, 0})));
        t.emplace("V",   Quantity(Rational(1), dim({2, 1, -3, -1, 0, 0, 0})));
        return t;
    }();
    return table;
}

// Recursive-descent parser for unit expressions:
//   expr     := term (('*' | '/') term)*
//   term     := factor ('^' exponent)*
//   factor   := '-' factor | '(' expr ')' | integer | identifier
//   exponent := '-'? digits
// Rational literals arise from dividing integers: "3/4" parses as the
// exact rational 3/4 (reduced). Unknown identifiers, malformed input,
// zero divisors and exponent-range violations all throw.
class Parser {
public:
    explicit Parser(std::string input) : input_(std::move(input)) { tokenize(); }

    Quantity parse() {
        Quantity q = parse_expr();
        expect(Token::Kind::End);
        return q;
    }

private:
    struct Token {
        enum class Kind { Number, Ident, Star, Slash, Caret, Minus, LParen, RParen, End } kind;
        std::int64_t number = 0;
        std::string ident;
    };

    std::string input_;
    std::vector<Token> tokens_;
    std::size_t pos_ = 0;

    void tokenize() {
        std::size_t i = 0;
        while (i < input_.size()) {
            char c = input_[i];
            if (std::isspace(static_cast<unsigned char>(c))) { ++i; continue; }
            Token t;
            if (std::isdigit(static_cast<unsigned char>(c))) {
                std::int64_t v = 0;
                while (i < input_.size() &&
                       std::isdigit(static_cast<unsigned char>(input_[i]))) {
                    int digit = input_[i] - '0';
                    if (v > (INT64_MAX - digit) / 10)
                        throw std::overflow_error("integer literal too large");
                    v = v * 10 + digit;
                    ++i;
                }
                t.kind = Token::Kind::Number;
                t.number = v;
            } else if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
                std::size_t start = i;
                while (i < input_.size() &&
                       (std::isalnum(static_cast<unsigned char>(input_[i])) ||
                        input_[i] == '_'))
                    ++i;
                t.kind = Token::Kind::Ident;
                t.ident = input_.substr(start, i - start);
            } else {
                switch (c) {
                    case '*': t.kind = Token::Kind::Star; break;
                    case '/': t.kind = Token::Kind::Slash; break;
                    case '^': t.kind = Token::Kind::Caret; break;
                    case '-': t.kind = Token::Kind::Minus; break;
                    case '(': t.kind = Token::Kind::LParen; break;
                    case ')': t.kind = Token::Kind::RParen; break;
                    default:
                        throw std::invalid_argument(
                            std::string("unexpected character '") + c + "'");
                }
                ++i;
            }
            tokens_.push_back(std::move(t));
        }
        Token end;
        end.kind = Token::Kind::End;
        tokens_.push_back(std::move(end));
    }

    const Token& peek() const { return tokens_[pos_]; }

    const Token& next() { return tokens_[pos_++]; }

    void expect(Token::Kind kind) {
        if (peek().kind != kind)
            throw std::invalid_argument("unexpected token in expression");
        ++pos_;
    }

    Quantity parse_expr() {
        Quantity lhs = parse_term();
        while (peek().kind == Token::Kind::Star ||
               peek().kind == Token::Kind::Slash) {
            Token::Kind op = next().kind;
            Quantity rhs = parse_term();
            lhs = (op == Token::Kind::Star) ? lhs * rhs : lhs / rhs;
        }
        return lhs;
    }

    Quantity parse_term() {
        Quantity base = parse_factor();
        while (peek().kind == Token::Kind::Caret) {
            next();
            bool negative = false;
            if (peek().kind == Token::Kind::Minus) {
                next();
                negative = true;
            }
            if (peek().kind != Token::Kind::Number)
                throw std::invalid_argument("expected integer exponent after '^'");
            std::int64_t e = next().number;
            if (e > static_cast<std::int64_t>(INT32_MAX))
                throw std::overflow_error("exponent literal too large");
            int k = static_cast<int>(e);
            base = base.pow(negative ? -k : k);
        }
        return base;
    }

    Quantity parse_factor() {
        const Token& t = peek();
        switch (t.kind) {
            case Token::Kind::Minus:
                next();
                return -parse_factor();
            case Token::Kind::LParen: {
                next();
                Quantity q = parse_expr();
                expect(Token::Kind::RParen);
                return q;
            }
            case Token::Kind::Number:
                next();
                return Quantity(Rational(t.number));
            case Token::Kind::Ident: {
                next();
                const auto& table = unit_table();
                auto it = table.find(t.ident);
                if (it == table.end())
                    throw std::invalid_argument("unknown unit '" + t.ident + "'");
                return it->second;
            }
            default:
                throw std::invalid_argument("expected number, unit or '('");
        }
    }
};

inline Quantity parse_expression(const std::string& input) {
    return Parser(input).parse();
}

} // namespace units
