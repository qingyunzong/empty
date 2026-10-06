#include "regx/parser.hpp"

#include <cctype>

namespace regx {
namespace {

enum class Tk {
  Num, Ident,
  Plus, Shl, Shr, EqEq, NotEq, AndAnd, OrOr,
  Question, Colon, LParen, RParen, LBracket, RBracket, LBrace, RBrace, Comma,
  End
};

struct Token {
  Tk kind;
  std::string text;
  size_t pos;
};

std::vector<Token> lex(const std::string& s) {
  std::vector<Token> out;
  size_t i = 0;
  while (i < s.size()) {
    char c = s[i];
    if (std::isspace(static_cast<unsigned char>(c))) { ++i; continue; }
    size_t start = i;
    if (std::isdigit(static_cast<unsigned char>(c))) {
      if (c == '0' && i + 1 < s.size() && (s[i + 1] == 'x' || s[i + 1] == 'X')) {
        i += 2;
        size_t digits = i;
        while (i < s.size() && std::isxdigit(static_cast<unsigned char>(s[i]))) ++i;
        if (i == digits) throw ParseError(start, "expected hexadecimal digits after 0x");
      } else if (c == '0' && i + 1 < s.size() && (s[i + 1] == 'b' || s[i + 1] == 'B')) {
        i += 2;
        size_t digits = i;
        while (i < s.size() && (s[i] == '0' || s[i] == '1')) ++i;
        if (i == digits) throw ParseError(start, "expected binary digits after 0b");
      } else {
        while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
      }
      out.push_back({Tk::Num, s.substr(start, i - start), start});
      continue;
    }
    if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
      while (i < s.size() &&
             (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '_'))
        ++i;
      out.push_back({Tk::Ident, s.substr(start, i - start), start});
      continue;
    }
    auto two = [&](Tk k) { out.push_back({k, s.substr(start, 2), start}); i += 2; };
    auto one = [&](Tk k) { out.push_back({k, s.substr(start, 1), start}); i += 1; };
    bool pair = i + 1 < s.size();
    switch (c) {
      case '+': one(Tk::Plus); break;
      case '<': if (pair && s[i + 1] == '<') two(Tk::Shl); else throw ParseError(start, "unexpected character '<'"); break;
      case '>': if (pair && s[i + 1] == '>') two(Tk::Shr); else throw ParseError(start, "unexpected character '>'"); break;
      case '=': if (pair && s[i + 1] == '=') two(Tk::EqEq); else throw ParseError(start, "unexpected character '='"); break;
      case '!': if (pair && s[i + 1] == '=') two(Tk::NotEq); else throw ParseError(start, "unexpected character '!'"); break;
      case '&': if (pair && s[i + 1] == '&') two(Tk::AndAnd); else throw ParseError(start, "unexpected character '&'"); break;
      case '|': if (pair && s[i + 1] == '|') two(Tk::OrOr); else throw ParseError(start, "unexpected character '|'"); break;
      case '?': one(Tk::Question); break;
      case ':': one(Tk::Colon); break;
      case '(': one(Tk::LParen); break;
      case ')': one(Tk::RParen); break;
      case '[': one(Tk::LBracket); break;
      case ']': one(Tk::RBracket); break;
      case '{': one(Tk::LBrace); break;
      case '}': one(Tk::RBrace); break;
      case ',': one(Tk::Comma); break;
      default:
        throw ParseError(start, std::string("unexpected character '") + c + "'");
    }
  }
  out.push_back({Tk::End, "", s.size()});
  return out;
}

uint64_t numValue(const Token& t) {
  const std::string& text = t.text;
  uint64_t v = 0;
  auto acc = [&](unsigned base, unsigned digit) {
    if (v > (UINT64_MAX - digit) / base)
      throw ParseError(t.pos, "integer literal too large");
    v = v * base + digit;
  };
  if (text.size() > 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
    for (size_t k = 2; k < text.size(); ++k) {
      char c = text[k];
      unsigned d = c <= '9' ? c - '0' : (c <= 'F' ? c - 'A' + 10 : c - 'a' + 10);
      acc(16, d);
    }
  } else if (text.size() > 2 && text[0] == '0' && (text[1] == 'b' || text[1] == 'B')) {
    for (size_t k = 2; k < text.size(); ++k) acc(2, text[k] - '0');
  } else {
    for (char c : text) acc(10, c - '0');
  }
  return v;
}

unsigned bitLength(uint64_t v) {
  unsigned n = 0;
  while (v) { ++n; v >>= 1; }
  return n;
}

struct Parser {
  const std::vector<Token>& toks;
  const Schema& schema;
  size_t i = 0;

  const Token& peek() const { return toks[i]; }
  bool eat(Tk k) { if (peek().kind == k) { ++i; return true; } return false; }
  const Token& expect(Tk k, const char* what) {
    if (peek().kind != k)
      throw ParseError(peek().pos, std::string("expected ") + what);
    return toks[i++];
  }

  ExprPtr mk(Node n, unsigned width, size_t pos) {
    return std::make_unique<Expr>(Expr{std::move(n), static_cast<uint8_t>(width), pos});
  }

  // ternary := orExpr ('?' ternary ':' ternary)?
  ExprPtr ternary() {
    auto cond = orExpr();
    if (!eat(Tk::Question)) return cond;
    size_t qpos = toks[i - 1].pos;
    auto ifTrue = ternary();
    expect(Tk::Colon, "':' in conditional expression");
    auto ifFalse = ternary();
    if (ifTrue->width != ifFalse->width)
      throw ParseError(qpos, "conditional branches have different bit widths");
    unsigned w = ifTrue->width;
    return mk(Ternary{std::move(cond), std::move(ifTrue), std::move(ifFalse)}, w, qpos);
  }

  ExprPtr orExpr() {
    auto e = andExpr();
    while (peek().kind == Tk::OrOr) {
      size_t pos = toks[i++].pos;
      e = mk(LOr{std::move(e), andExpr()}, kMinWidth, pos);
    }
    return e;
  }

  ExprPtr andExpr() {
    auto e = cmp();
    while (peek().kind == Tk::AndAnd) {
      size_t pos = toks[i++].pos;
      e = mk(LAnd{std::move(e), cmp()}, kMinWidth, pos);
    }
    return e;
  }

  ExprPtr cmp() {
    auto e = shift();
    while (peek().kind == Tk::EqEq || peek().kind == Tk::NotEq) {
      Tk k = peek().kind;
      size_t pos = toks[i++].pos;
      auto r = shift();
      if (k == Tk::EqEq) e = mk(Eq{std::move(e), std::move(r)}, kMinWidth, pos);
      else e = mk(Ne{std::move(e), std::move(r)}, kMinWidth, pos);
    }
    return e;
  }

  ExprPtr shift() {
    auto e = add();
    while (peek().kind == Tk::Shl || peek().kind == Tk::Shr) {
      Tk k = peek().kind;
      size_t pos = toks[i++].pos;
      auto r = add();
      unsigned w = e->width;
      if (k == Tk::Shl) e = mk(Shl{std::move(e), std::move(r)}, w, pos);
      else e = mk(Shr{std::move(e), std::move(r)}, w, pos);
    }
    return e;
  }

  ExprPtr add() {
    auto e = postfix();
    while (peek().kind == Tk::Plus) {
      size_t pos = toks[i++].pos;
      auto r = postfix();
      unsigned w = std::max<unsigned>(e->width, r->width);
      e = mk(Add{std::move(e), std::move(r)}, w, pos);
    }
    return e;
  }

  ExprPtr postfix() {
    auto e = primary();
    while (peek().kind == Tk::LBracket) {
      size_t bpos = toks[i++].pos;
      const Token& ht = expect(Tk::Num, "slice high index");
      uint64_t hi = numValue(ht);
      expect(Tk::Colon, "':' in slice");
      const Token& lt = expect(Tk::Num, "slice low index");
      uint64_t lo = numValue(lt);
      expect(Tk::RBracket, "']'");
      if (lo > hi)
        throw ParseError(bpos, "illegal slice: low index exceeds high index");
      if (hi >= e->width)
        throw ParseError(bpos, "illegal slice: high index out of range");
      uint64_t w = hi - lo + 1;
      if (w < kMinWidth)
        throw ParseError(bpos, "illegal slice: result narrower than 8 bits");
      e = mk(Slice{std::move(e), static_cast<uint8_t>(hi), static_cast<uint8_t>(lo)},
             w, bpos);
    }
    return e;
  }

  ExprPtr primary() {
    const Token& t = peek();
    if (t.kind == Tk::Num) {
      ++i;
      uint64_t v = numValue(t);
      unsigned w;
      if (eat(Tk::Colon)) {
        const Token& wt = expect(Tk::Num, "bit width after ':'");
        uint64_t wv = numValue(wt);
        if (wv < kMinWidth || wv > kMaxWidth)
          throw ParseError(wt.pos, "bit width must be in 8..64");
        w = static_cast<unsigned>(wv);
        if (w < 64 && (v >> w) != 0)
          throw ParseError(t.pos, "literal does not fit in declared width");
      } else {
        w = std::max<unsigned>(kMinWidth, bitLength(v));
      }
      return mk(Literal{v, static_cast<uint8_t>(w)}, w, t.pos);
    }
    if (t.kind == Tk::Ident) {
      ++i;
      const uint8_t* w = schema.find(t.text);
      if (!w) throw ParseError(t.pos, "unknown register '" + t.text + "'");
      return mk(RegRef{t.text}, *w, t.pos);
    }
    if (eat(Tk::LParen)) {
      auto e = ternary(); // grouping is transparent: no node is created
      expect(Tk::RParen, "')'");
      return e;
    }
    if (eat(Tk::LBrace)) {
      std::vector<ExprPtr> parts;
      parts.push_back(ternary());
      while (eat(Tk::Comma)) parts.push_back(ternary());
      expect(Tk::RBrace, "'}'");
      unsigned w = 0;
      for (const auto& p : parts) w += p->width;
      if (w > kMaxWidth)
        throw ParseError(t.pos, "concatenation wider than 64 bits");
      return mk(Concat{std::move(parts)}, w, t.pos);
    }
    throw ParseError(t.pos, "expected expression");
  }
};

} // namespace

ExprPtr parse(const std::string& src, const Schema& schema) {
  std::vector<Token> toks = lex(src);
  Parser p{toks, schema};
  auto e = p.ternary();
  p.expect(Tk::End, "end of input");
  return e;
}

} // namespace regx
