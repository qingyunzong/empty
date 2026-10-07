#pragma once

#include "ast.hpp"
#include "regs.hpp"

#include <bit>
#include <cctype>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace rex {

// Parse/compile error carrying the byte offset into the source.
struct ParseError : std::runtime_error {
  size_t pos;
  ParseError(size_t p, const std::string& msg)
      : std::runtime_error(msg), pos(p) {}
};

// Recursive-descent parser for the register expression language.
//
// Grammar (loosest to tightest binding):
//   cond    := or_expr ('?' cond ':' cond)?
//   or_expr := and_expr ('||' and_expr)*
//   and_expr:= eq_expr ('&&' eq_expr)*
//   eq_expr := add_expr (('=='|'!=') add_expr)*
//   add_expr:= shift_expr ('+' shift_expr)*
//   shift   := postfix (('<<'|'>>') postfix)*
//   postfix := primary ('[' NUM (':' NUM)? ']')*
//   primary := NUM | NUM '\'' ('b'|'d'|'h') DIGITS | IDENT
//            | '(' cond ')' | '{' cond (',' cond)* '}'
class Parser {
public:
  Parser(std::string_view src, const std::vector<RegDecl>& regs)
      : src_(src), regs_(regs) {
    for (uint32_t i = 0; i < regs.size(); ++i) {
      if (regs[i].width < 8 || regs[i].width > 64)
        throw std::invalid_argument("register width out of range [8,64]: " +
                                    regs[i].name);
      if (!reg_index_.emplace(regs[i].name, i).second)
        throw std::invalid_argument("duplicate register: " + regs[i].name);
    }
  }

  Expr parse() {
    advance();
    Expr e = parse_cond();
    if (tok_.kind != Tok::End)
      fail(tok_.pos, "unexpected trailing input");
    return e;
  }

private:
  enum class Tok {
    Num,   // unsized decimal literal, value in num
    Lit,   // sized literal, value in num, width in width
    Ident, // text
    Plus, Shl, Shr, EqEq, Ne, AndAnd, OrOr,
    Question, Colon, LParen, RParen, LBrace, RBrace, LBracket, RBracket,
    Comma, End
  };

  struct Token {
    Tok kind;
    size_t pos;
    uint64_t num = 0;
    uint8_t width = 0;
    std::string_view text{};
  };

  std::string_view src_;
  const std::vector<RegDecl>& regs_;
  std::unordered_map<std::string_view, uint32_t> reg_index_;
  size_t pos_ = 0;
  Token tok_{Tok::End, 0};

  [[noreturn]] void fail(size_t pos, const std::string& msg) const {
    throw ParseError(pos, msg);
  }

  static bool is_space(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
  }
  static bool is_digit(char c) { return c >= '0' && c <= '9'; }
  static bool is_alpha(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  bool match(char c) {
    if (pos_ < src_.size() && src_[pos_] == c) {
      ++pos_;
      return true;
    }
    return false;
  }

  void advance() { tok_ = lex(); }

  Token lex() {
    while (pos_ < src_.size() && is_space(src_[pos_]))
      ++pos_;
    const size_t start = pos_;
    if (pos_ >= src_.size())
      return Token{Tok::End, start};
    const char c = src_[pos_];

    if (is_digit(c)) {
      uint64_t v = 0;
      while (pos_ < src_.size() && is_digit(src_[pos_])) {
        const unsigned d = static_cast<unsigned>(src_[pos_] - '0');
        if (v > (UINT64_MAX - d) / 10)
          fail(start, "integer literal too large");
        v = v * 10 + d;
        ++pos_;
      }
      if (pos_ < src_.size() && src_[pos_] == '\'') {
        ++pos_;
        if (pos_ >= src_.size())
          fail(pos_, "expected base specifier after '\\''");
        const char b = src_[pos_];
        ++pos_;
        unsigned base;
        switch (b) {
        case 'b': case 'B': base = 2; break;
        case 'd': case 'D': base = 10; break;
        case 'h': case 'H': base = 16; break;
        default: fail(pos_ - 1, "unknown base specifier");
        }
        if (v < 8 || v > 64)
          fail(start, "literal width out of range [8,64]");
        const uint64_t width = v;
        uint64_t val = 0;
        bool any = false;
        while (pos_ < src_.size()) {
          const char d = src_[pos_];
          unsigned dv;
          if (d >= '0' && d <= '9')
            dv = static_cast<unsigned>(d - '0');
          else if (d >= 'a' && d <= 'f')
            dv = static_cast<unsigned>(d - 'a') + 10;
          else if (d >= 'A' && d <= 'F')
            dv = static_cast<unsigned>(d - 'A') + 10;
          else
            break;
          if (dv >= base)
            fail(pos_, "invalid digit for base");
          if (val > (UINT64_MAX - dv) / base)
            fail(start, "literal too large");
          val = val * base + dv;
          any = true;
          ++pos_;
        }
        if (!any)
          fail(pos_, "expected digits after base specifier");
        if (width < 64 && val >= (uint64_t{1} << width))
          fail(start, "literal does not fit in " + std::to_string(width) +
                          " bits");
        return Token{Tok::Lit, start, val, static_cast<uint8_t>(width)};
      }
      return Token{Tok::Num, start, v};
    }

    if (is_alpha(c) || c == '_') {
      while (pos_ < src_.size() &&
             (is_alpha(src_[pos_]) || is_digit(src_[pos_]) ||
              src_[pos_] == '_'))
        ++pos_;
      return Token{Tok::Ident, start, 0, 0, src_.substr(start, pos_ - start)};
    }

    ++pos_;
    switch (c) {
    case '+': return Token{Tok::Plus, start};
    case '<':
      if (match('<')) return Token{Tok::Shl, start};
      fail(start, "unexpected character '<'");
    case '>':
      if (match('>')) return Token{Tok::Shr, start};
      fail(start, "unexpected character '>'");
    case '=':
      if (match('=')) return Token{Tok::EqEq, start};
      fail(start, "unexpected character '='");
    case '!':
      if (match('=')) return Token{Tok::Ne, start};
      fail(start, "unexpected character '!'");
    case '&':
      if (match('&')) return Token{Tok::AndAnd, start};
      fail(start, "unexpected character '&'");
    case '|':
      if (match('|')) return Token{Tok::OrOr, start};
      fail(start, "unexpected character '|'");
    case '?': return Token{Tok::Question, start};
    case ':': return Token{Tok::Colon, start};
    case '(': return Token{Tok::LParen, start};
    case ')': return Token{Tok::RParen, start};
    case '{': return Token{Tok::LBrace, start};
    case '}': return Token{Tok::RBrace, start};
    case '[': return Token{Tok::LBracket, start};
    case ']': return Token{Tok::RBracket, start};
    case ',': return Token{Tok::Comma, start};
    default:
      fail(start, std::string("unexpected character '") + c + "'");
    }
  }

  void expect(Tok kind, const char* what) {
    if (tok_.kind != kind)
      fail(tok_.pos, std::string("expected ") + what);
    advance();
  }

  Expr parse_cond() {
    Expr cond = parse_or();
    if (tok_.kind != Tok::Question)
      return cond;
    const size_t qpos = tok_.pos;
    advance();
    Expr then = parse_cond();
    expect(Tok::Colon, "':' in conditional expression");
    Expr els = parse_cond();
    if (then.width != els.width)
      fail(qpos, "conditional branches have different bit widths");
    Expr e;
    e.kind = Expr::Kind::Cond;
    e.width = then.width;
    e.pos = cond.pos;
    e.kids = {std::move(cond), std::move(then), std::move(els)};
    return e;
  }

  Expr parse_or() {
    Expr lhs = parse_and();
    while (tok_.kind == Tok::OrOr) {
      advance();
      Expr rhs = parse_and();
      lhs = make_logic(Expr::Kind::Or, std::move(lhs), std::move(rhs));
    }
    return lhs;
  }

  Expr parse_and() {
    Expr lhs = parse_eq();
    while (tok_.kind == Tok::AndAnd) {
      advance();
      Expr rhs = parse_eq();
      lhs = make_logic(Expr::Kind::And, std::move(lhs), std::move(rhs));
    }
    return lhs;
  }

  Expr make_logic(Expr::Kind kind, Expr lhs, Expr rhs) {
    Expr e;
    e.kind = kind;
    e.width = 1;
    e.pos = lhs.pos;
    e.kids = {std::move(lhs), std::move(rhs)};
    return e;
  }

  Expr parse_eq() {
    Expr lhs = parse_add();
    while (tok_.kind == Tok::EqEq || tok_.kind == Tok::Ne) {
      const bool is_eq = tok_.kind == Tok::EqEq;
      const size_t opos = tok_.pos;
      advance();
      Expr rhs = parse_add();
      if (lhs.width != rhs.width)
        fail(opos, "comparison operands have different bit widths");
      Expr e;
      e.kind = is_eq ? Expr::Kind::Eq : Expr::Kind::Ne;
      e.width = 1;
      e.pos = lhs.pos;
      e.kids = {std::move(lhs), std::move(rhs)};
      lhs = std::move(e);
    }
    return lhs;
  }

  Expr parse_add() {
    Expr lhs = parse_shift();
    while (tok_.kind == Tok::Plus) {
      const size_t opos = tok_.pos;
      advance();
      Expr rhs = parse_shift();
      if (lhs.width != rhs.width)
        fail(opos, "operands of '+' have different bit widths");
      Expr e;
      e.kind = Expr::Kind::Add;
      e.width = lhs.width;
      e.pos = lhs.pos;
      e.kids = {std::move(lhs), std::move(rhs)};
      lhs = std::move(e);
    }
    return lhs;
  }

  Expr parse_shift() {
    Expr lhs = parse_postfix();
    while (tok_.kind == Tok::Shl || tok_.kind == Tok::Shr) {
      const bool is_shl = tok_.kind == Tok::Shl;
      advance();
      Expr rhs = parse_postfix();
      Expr e;
      e.kind = is_shl ? Expr::Kind::Shl : Expr::Kind::Shr;
      e.width = lhs.width; // result width is the shifted value's width
      e.pos = lhs.pos;
      e.kids = {std::move(lhs), std::move(rhs)};
      lhs = std::move(e);
    }
    return lhs;
  }

  Expr parse_postfix() {
    Expr e = parse_primary();
    while (tok_.kind == Tok::LBracket) {
      const size_t bpos = tok_.pos;
      advance();
      if (tok_.kind != Tok::Num)
        fail(tok_.pos, "expected slice index");
      const uint64_t hi = tok_.num;
      advance();
      uint64_t lo = hi;
      if (tok_.kind == Tok::Colon) {
        advance();
        if (tok_.kind != Tok::Num)
          fail(tok_.pos, "expected slice index");
        lo = tok_.num;
        advance();
      }
      if (hi < lo)
        fail(bpos, "slice high index is below low index");
      if (hi >= e.width)
        fail(bpos, "slice index out of range for " +
                       std::to_string(e.width) + "-bit value");
      expect(Tok::RBracket, "']'");
      Expr s;
      s.kind = Expr::Kind::Slice;
      s.width = static_cast<uint8_t>(hi - lo + 1);
      s.pos = e.pos;
      s.slice_hi = static_cast<uint8_t>(hi);
      s.slice_lo = static_cast<uint8_t>(lo);
      s.kids = {std::move(e)};
      e = std::move(s);
    }
    return e;
  }

  Expr parse_primary() {
    const Token t = tok_;
    switch (t.kind) {
    case Tok::Num: {
      advance();
      const int bits =
          t.num == 0 ? 0 : 64 - std::countl_zero(t.num);
      Expr e;
      e.kind = Expr::Kind::Literal;
      e.width = static_cast<uint8_t>(bits < 8 ? 8 : bits);
      e.pos = t.pos;
      e.lit = t.num;
      return e;
    }
    case Tok::Lit: {
      advance();
      Expr e;
      e.kind = Expr::Kind::Literal;
      e.width = t.width;
      e.pos = t.pos;
      e.lit = t.num;
      return e;
    }
    case Tok::Ident: {
      advance();
      const auto it = reg_index_.find(t.text);
      if (it == reg_index_.end())
        fail(t.pos, "unknown register '" + std::string(t.text) + "'");
      Expr e;
      e.kind = Expr::Kind::Reg;
      e.width = regs_[it->second].width;
      e.pos = t.pos;
      e.reg = it->second;
      return e;
    }
    case Tok::LParen: {
      advance();
      Expr e = parse_cond();
      expect(Tok::RParen, "')'");
      return e; // grouping is transparent: it never changes semantics
    }
    case Tok::LBrace: {
      advance();
      std::vector<Expr> kids;
      uint32_t total = 0;
      kids.push_back(parse_cond());
      while (tok_.kind == Tok::Comma) {
        advance();
        kids.push_back(parse_cond());
      }
      expect(Tok::RBrace, "'}'");
      for (const auto& k : kids)
        total += k.width;
      if (total > 64)
        fail(t.pos, "concatenation exceeds 64 bits");
      Expr e;
      e.kind = Expr::Kind::Concat;
      e.width = static_cast<uint8_t>(total);
      e.pos = t.pos;
      e.kids = std::move(kids);
      return e;
    }
    default:
      fail(t.pos, "expected expression");
    }
  }
};

} // namespace rex
