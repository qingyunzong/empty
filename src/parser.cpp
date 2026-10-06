#include "score.hpp"

#include <cctype>
#include <sstream>

namespace score {

namespace {

enum class TokKind { LBrace, RBrace, Eq, Word, End };

struct Token {
    TokKind kind;
    std::string text;  // Word only
    std::size_t pos;
};

std::vector<Token> tokenize(const std::string& text) {
    std::vector<Token> out;
    std::size_t i = 0;
    while (i < text.size()) {
        char c = text[i];
        if (std::isspace(static_cast<unsigned char>(c))) { ++i; continue; }
        if (c == '#') {  // '#' at token start: comment to end of line
            while (i < text.size() && text[i] != '\n') ++i;
            continue;
        }
        if (c == '{') { out.push_back({TokKind::LBrace, "", i}); ++i; continue; }
        if (c == '}') { out.push_back({TokKind::RBrace, "", i}); ++i; continue; }
        if (c == '=') { out.push_back({TokKind::Eq, "", i}); ++i; continue; }
        if (c == ',' || c == '|') { ++i; continue; }  // cosmetic separators
        std::size_t start = i;
        while (i < text.size() &&
               !std::isspace(static_cast<unsigned char>(text[i])) &&
               text[i] != '{' && text[i] != '}' && text[i] != '=' &&
               text[i] != ',' && text[i] != '|') {
            ++i;
        }
        out.push_back({TokKind::Word, text.substr(start, i - start), start});
    }
    out.push_back({TokKind::End, "", text.size()});
    return out;
}

[[noreturn]] void fail(std::size_t pos, const std::string& msg) {
    std::ostringstream oss;
    oss << "parse error at offset " << pos << ": " << msg;
    throw ParseError(oss.str());
}

bool is_pitch_start(char c) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return c >= 'a' && c <= 'g';
}

// Parses "c#4/8.." style words; returns written duration in beats.
Item parse_note_word(const Token& tok) {
    const std::string& w = tok.text;
    std::size_t i = 0;

    Item item;
    if (w[i] == 'r' && i + 1 < w.size() && w[i + 1] == '/') {
        item.kind = Item::Kind::Rest;
        i += 1;
    } else {
        if (!is_pitch_start(w[i])) fail(tok.pos, "expected note pitch or rest, got '" + w + "'");
        item.kind = Item::Kind::Note;
        item.pitch.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(w[i]))));
        ++i;
        if (i < w.size() && (w[i] == '#' || w[i] == 'b')) {
            item.pitch.push_back(w[i]);
            ++i;
        }
        if (i < w.size() && std::isdigit(static_cast<unsigned char>(w[i])) &&
            (i + 1 >= w.size() || w[i + 1] == '/')) {
            item.pitch.push_back(w[i]);
            ++i;
        }
    }

    if (i >= w.size() || w[i] != '/')
        fail(tok.pos, "expected '/' after note/rest in '" + w + "'");
    ++i;

    std::size_t dstart = i;
    while (i < w.size() && std::isdigit(static_cast<unsigned char>(w[i]))) ++i;
    if (i == dstart) fail(tok.pos, "missing duration denominator in '" + w + "'");
    std::int64_t denom = 0;
    try {
        denom = std::stoll(w.substr(dstart, i - dstart));
    } catch (const std::out_of_range&) {
        fail(tok.pos, "duration denominator out of range in '" + w + "'");
    }
    if (denom <= 0) fail(tok.pos, "duration denominator must be positive in '" + w + "'");

    int dots = 0;
    while (i < w.size() && w[i] == '.') { ++dots; ++i; }
    if (i != w.size()) fail(tok.pos, "unexpected trailing characters in '" + w + "'");

    // base = whole-note beats / denom; each dot adds half of the previous piece.
    Rational base(4, denom);
    Rational total = base;
    Rational piece = base;
    for (int d = 0; d < dots; ++d) {
        piece = piece * Rational(1, 2);
        total = total + piece;
    }
    item.duration = total;
    return item;
}

Rational parse_beats(const Token& tok) {
    const std::string& w = tok.text;
    std::size_t slash = w.find('/');
    try {
        if (slash == std::string::npos) {
            std::size_t used = 0;
            std::int64_t n = std::stoll(w, &used);
            if (used != w.size()) fail(tok.pos, "invalid beat count '" + w + "'");
            if (n <= 0) fail(tok.pos, "tuplet target must be positive");
            return Rational(n, 1);
        }
        std::size_t un = 0, ud = 0;
        std::int64_t n = std::stoll(w.substr(0, slash), &un);
        std::int64_t d = std::stoll(w.substr(slash + 1), &ud);
        if (un != slash || ud != w.size() - slash - 1)
            fail(tok.pos, "invalid beat count '" + w + "'");
        if (n <= 0 || d <= 0) fail(tok.pos, "tuplet target must be positive");
        return Rational(n, d);
    } catch (const std::invalid_argument&) {
        fail(tok.pos, "invalid beat count '" + w + "'");
    } catch (const std::out_of_range&) {
        fail(tok.pos, "beat count out of range '" + w + "'");
    }
}

class Parser {
public:
    explicit Parser(const std::string& text) : toks_(tokenize(text)) {}

    std::vector<Item> run() {
        std::vector<Item> items = parse_sequence(0);
        if (peek().kind != TokKind::End)
            fail(peek().pos, "unexpected '}'");
        return items;
    }

private:
    const Token& peek() const { return toks_[idx_]; }
    const Token& next() { return toks_[idx_++]; }

    // Parses items until RBrace (nested) or End (top level).
    std::vector<Item> parse_sequence(int depth) {
        std::vector<Item> items;
        for (;;) {
            const Token& t = peek();
            if (t.kind == TokKind::End || t.kind == TokKind::RBrace) return items;
            items.push_back(parse_item(depth));
        }
    }

    Item parse_item(int depth) {
        const Token& t = next();
        if (t.kind == TokKind::Word) return parse_note_word(t);
        if (t.kind == TokKind::LBrace) {
            if (depth >= kMaxTupletDepth)
                fail(t.pos, "tuplet nesting exceeds maximum depth of " +
                                std::to_string(kMaxTupletDepth));
            Item group;
            group.kind = Item::Kind::Group;
            group.children = parse_sequence(depth + 1);
            if (peek().kind != TokKind::RBrace)
                fail(peek().pos, "expected '}' to close tuplet");
            next();
            if (group.children.empty())
                fail(t.pos, "tuplet group must contain at least one item");
            if (peek().kind != TokKind::Eq)
                fail(peek().pos, "expected '=' and target beats after tuplet '}'");
            next();
            const Token& beats = next();
            if (beats.kind != TokKind::Word)
                fail(beats.pos, "expected target beat count after '='");
            group.group_target = parse_beats(beats);
            group.duration = group.group_target;
            return group;
        }
        fail(t.pos, t.kind == TokKind::RBrace ? "unexpected '}'"
                                              : "unexpected token");
    }

    std::vector<Token> toks_;
    std::size_t idx_ = 0;
};

Rational written_duration_sum(const std::vector<Item>& items) {
    Rational sum;
    for (const Item& it : items) sum = sum + it.duration;
    return sum;
}

void flatten(const std::vector<Item>& items, const Rational& scale,
             Rational& cursor, std::vector<Event>& out) {
    for (const Item& it : items) {
        if (it.kind == Item::Kind::Group) {
            Rational inner_sum = written_duration_sum(it.children);
            if (inner_sum.is_zero())
                throw ParseError("tuplet group has zero total written duration");
            Rational inner_scale = scale * it.group_target / inner_sum;
            flatten(it.children, inner_scale, cursor, out);
        } else {
            Rational dur = it.duration * scale;
            Event ev;
            ev.is_rest = it.kind == Item::Kind::Rest;
            ev.pitch = ev.is_rest ? "r" : it.pitch;
            ev.start = cursor;
            ev.end = cursor + dur;
            cursor = ev.end;
            out.push_back(std::move(ev));
        }
    }
}

} // namespace

std::vector<Item> parse_score(const std::string& text) {
    return Parser(text).run();
}

std::vector<Event> expand(const std::vector<Item>& items) {
    std::vector<Event> out;
    Rational cursor;
    flatten(items, Rational(1, 1), cursor, out);
    return out;
}

std::vector<Event> expand_score(const std::string& text) {
    return expand(parse_score(text));
}

} // namespace score
