#include "ast.hpp"

#include <cctype>

namespace ar {

namespace {

bool is_atom_char(char c) {
  if (std::isalnum(static_cast<unsigned char>(c)))
    return true;
  switch (c) {
  case '_': case '-': case '+': case '*': case '/': case '<': case '>':
  case '=': case '!': case '?': case '$': case '%': case '&': case ':':
  case '.': case '^': case '~': case '@': case '#':
    return true;
  default:
    return false;
  }
}

struct Token {
  enum Kind { LParen, RParen, Atom, End } kind;
  std::string text;
  size_t pos;
};

struct Lexer {
  const std::string& s;
  size_t pos = 0;
  bool has_peek = false;
  Token peeked{};

  Token next_raw() {
    for (;;) {
      while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos])))
        ++pos;
      if (pos < s.size() && s[pos] == ';') { // comment to end of line
        while (pos < s.size() && s[pos] != '\n')
          ++pos;
        continue;
      }
      break;
    }
    if (pos >= s.size())
      return {Token::End, "", pos};
    size_t start = pos;
    char c = s[pos];
    if (c == '(') {
      ++pos;
      return {Token::LParen, "(", start};
    }
    if (c == ')') {
      ++pos;
      return {Token::RParen, ")", start};
    }
    if (!is_atom_char(c))
      throw ParseError("unexpected character at offset " + std::to_string(pos));
    while (pos < s.size() && is_atom_char(s[pos]))
      ++pos;
    return {Token::Atom, s.substr(start, pos - start), start};
  }

  Token next() {
    if (has_peek) {
      has_peek = false;
      return peeked;
    }
    return next_raw();
  }
  Token peek() {
    if (!has_peek) {
      peeked = next_raw();
      has_peek = true;
    }
    return peeked;
  }
};

bool parse_int(const std::string& t, long long& out) {
  size_t i = 0;
  if (t[0] == '-' || t[0] == '+')
    i = 1;
  if (i >= t.size())
    return false;
  for (size_t j = i; j < t.size(); ++j)
    if (!std::isdigit(static_cast<unsigned char>(t[j])))
      return false;
  try {
    out = std::stoll(t);
  } catch (const std::out_of_range&) {
    throw ParseError("integer literal out of range: " + t);
  }
  return true;
}

Node parse_expr(Lexer& lx) {
  Token t = lx.next();
  switch (t.kind) {
  case Token::LParen: {
    std::vector<Node> cs;
    for (;;) {
      Token p = lx.peek();
      if (p.kind == Token::RParen) {
        lx.next();
        return Node::list(std::move(cs));
      }
      if (p.kind == Token::End)
        throw ParseError("unclosed '(' at offset " + std::to_string(t.pos));
      cs.push_back(parse_expr(lx));
    }
  }
  case Token::RParen:
    throw ParseError("unexpected ')' at offset " + std::to_string(t.pos));
  case Token::Atom: {
    long long v;
    if (parse_int(t.text, v))
      return Node::integer(v);
    return Node::symbol(t.text);
  }
  case Token::End:
    throw ParseError("unexpected end of input");
  }
  throw ParseError("internal parser error");
}

void print_into(const Node& n, std::string& out) {
  switch (n.kind) {
  case Node::Kind::Int:
    out += std::to_string(n.value);
    break;
  case Node::Kind::Sym:
    out += n.sym;
    break;
  case Node::Kind::List:
    out += '(';
    for (size_t i = 0; i < n.children.size(); ++i) {
      if (i)
        out += ' ';
      print_into(n.children[i], out);
    }
    out += ')';
    break;
  }
}

} // namespace

Node parse(const std::string& text) {
  Lexer lx{text};
  Node n = parse_expr(lx);
  Token t = lx.next();
  if (t.kind != Token::End)
    throw ParseError("trailing tokens after expression at offset " +
                     std::to_string(t.pos));
  return n;
}

std::string print(const Node& n) {
  std::string out;
  print_into(n, out);
  return out;
}

size_t node_count(const Node& n) {
  size_t c = 1;
  for (const Node& ch : n.children)
    c += node_count(ch);
  return c;
}

} // namespace ar
