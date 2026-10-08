#include "score/parser.hpp"

#include <cctype>

namespace score {

std::string formatRational(const Rational& r) {
    if (r.den() == 1) return std::to_string(r.num());
    return std::to_string(r.num()) + "/" + std::to_string(r.den());
}

namespace {

// 一段已解析的内容：事件序列（相对于段起点）+ 段总时值。
struct Block {
    std::vector<Event> events;
    Rational duration{0};
};

class Parser {
public:
    explicit Parser(const std::string& text) : text_(text) {}

    Block run() {
        Block top = parseItems(0, false);
        skipWs();
        if (pos_ != text_.size())
            fail(std::string("unexpected character '") + text_[pos_] + "'");
        return top;
    }

private:
    const std::string& text_;
    std::size_t pos_ = 0;

    [[noreturn]] void fail(const std::string& msg) const {
        throw ParseError("parse error at offset " + std::to_string(pos_) + ": " + msg);
    }

    void skipWs() {
        while (pos_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[pos_])))
            ++pos_;
    }

    char peek() {
        skipWs();
        return pos_ < text_.size() ? text_[pos_] : '\0';
    }

    bool consume(char c) {
        if (peek() == c) { ++pos_; return true; }
        return false;
    }

    void expect(char c, const char* what) {
        if (!consume(c)) fail(std::string("expected ") + what);
    }

    long long parseUint(const char* what) {
        skipWs();
        std::size_t start = pos_;
        while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_])))
            ++pos_;
        if (start == pos_) fail(std::string("expected ") + what);
        return std::stoll(text_.substr(start, pos_ - start));
    }

    Block parseItems(int depth, bool inTuplet) {
        Block result;
        for (;;) {
            char c = peek();
            if (c == '\0') {
                if (inTuplet) fail("unterminated tuplet group");
                break;
            }
            if (c == '}') {
                if (!inTuplet) fail("unmatched '}'");
                ++pos_;
                break;
            }
            Block item = parseItem(depth);
            Rational offset = result.duration;
            for (auto& e : item.events) {
                e.start = e.start + offset;
                e.end = e.end + offset;
                result.events.push_back(std::move(e));
            }
            result.duration = result.duration + item.duration;
        }
        return result;
    }

    Block parseItem(int depth) {
        if (peek() == '{') return parseTuplet(depth);
        return parseAtom();
    }

    // 连音组：{拍数: 成员...}，将组内成员自然时值总和缩放到指定拍数。
    Block parseTuplet(int depth) {
        if (depth >= kMaxTupletDepth)
            fail("tuplet nesting exceeds maximum of " + std::to_string(kMaxTupletDepth));
        ++pos_; // '{'
        Rational target = parseBeatsSpec();
        expect(':', "':' after tuplet beat count");
        Block inner = parseItems(depth + 1, true);
        if (inner.duration.num() == 0) fail("tuplet group is empty");
        Rational scale = target / inner.duration;
        for (auto& e : inner.events) {
            e.start = e.start * scale;
            e.end = e.end * scale;
        }
        inner.duration = target;
        return inner;
    }

    // 拍数：正整数或 "p/q" 分数。
    Rational parseBeatsSpec() {
        long long p = parseUint("tuplet beat count");
        Rational r(p);
        if (peek() == '/') {
            ++pos_;
            long long q = parseUint("tuplet beat denominator");
            r = Rational(p, q);
        }
        if (r.num() <= 0) fail("tuplet beat count must be positive");
        return r;
    }

    Block parseAtom() {
        skipWs();
        if (pos_ >= text_.size()) fail("expected note or rest");
        char c = text_[pos_];
        Event ev;
        if (c == 'R') {
            ev.isRest = true;
            ++pos_;
        } else if (c >= 'A' && c <= 'G') {
            std::string pitch(1, c);
            ++pos_;
            if (pos_ < text_.size() && (text_[pos_] == '#' || text_[pos_] == 'b')) {
                pitch += text_[pos_];
                ++pos_;
            }
            if (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) {
                pitch += text_[pos_];
                ++pos_;
            }
            ev.pitch = std::move(pitch);
        } else {
            fail(std::string("unexpected character '") + c + "'");
        }
        Rational len = parseDuration();
        ev.start = Rational(0);
        ev.end = len;
        Block b;
        b.events.push_back(std::move(ev));
        b.duration = len;
        return b;
    }

    // 时值：/n 表示 n 分音符（四分音符 = 1 拍），可跟附点 '.'。
    Rational parseDuration() {
        if (peek() != '/') return Rational(1); // 默认四分音符
        ++pos_;
        long long den = parseUint("note duration denominator");
        if (den <= 0) fail("duration denominator must be positive");
        int dots = 0;
        while (peek() == '.') { ++pos_; ++dots; }
        if (dots > 20) fail("too many dots");
        long long multNum = (2LL << dots) - 1; // 附点倍增 (2^(d+1)-1)/2^d
        long long multDen = 1LL << dots;
        return Rational(4, den) * Rational(multNum, multDen);
    }
};

} // namespace

std::vector<Event> parseScore(const std::string& text) {
    Parser p(text);
    return p.run().events;
}

} // namespace score
