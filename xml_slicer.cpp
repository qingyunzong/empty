#include "xml_slicer.hpp"

#include <array>
#include <cctype>
#include <cstdint>
#include <unordered_map>

namespace dataeng::xml {

namespace {

constexpr std::size_t kMaxEntityRecursion = 64;

bool is_name_start(char c) noexcept {
    unsigned char u = static_cast<unsigned char>(c);
    return c == '_' || c == ':' || (u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z') || u >= 0xC0;
}

bool is_name_char(char c) noexcept {
    unsigned char u = static_cast<unsigned char>(c);
    return is_name_start(c) || (u >= '0' && u <= '9') || c == '-' || c == '.' || u == 0xB7 ||
           c == ':';
}

bool is_ws(char c) noexcept {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

void encode_utf8(std::uint32_t cp, std::string& out) {
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

bool is_valid_xml_cp(std::uint32_t cp) noexcept {
    return cp == 0x9 || cp == 0xA || cp == 0xD || (cp >= 0x20 && cp <= 0xD7FF) ||
           (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

}  // namespace

struct XmlSlicer::Impl {
    enum class State { Content, Markup };

    struct Frame {
        std::string qname;
        std::string resolved;
        std::size_t start_offset;
        std::unordered_map<std::string, std::string> prefix_decls;
    };

    struct Capture {
        std::string path;
        std::string raw;
        std::size_t start_offset;
        std::size_t frame_depth;
    };

    SlicerConfig config;
    std::string buffer;
    std::size_t fed_total = 0;
    bool finished = false;
    ParseError err;
    std::vector<Slice> slices;
    std::vector<UnclosedElement> unclosed_list;

    State state = State::Content;

    std::vector<Frame> stack;
    std::vector<Capture> captures;
    std::unordered_map<std::string, std::string> entities;
    std::size_t expansion_used = 0;

    explicit Impl(SlicerConfig cfg) : config(std::move(cfg)) {
        entities.reserve(16);
    }

    std::size_t global_off(std::size_t local) const noexcept {
        return fed_total - buffer.size() + local;
    }

    void fail(ErrorCode code, std::string msg, std::size_t off) {
        if (err.code == ErrorCode::None) {
            err.code = code;
            err.message = std::move(msg);
            err.offset = off;
        }
    }

    void consume(std::size_t n) {
        buffer.erase(0, n);
    }

    void append_captures(const char* p, std::size_t n) {
        for (Capture& cap : captures) {
            cap.raw.append(p, n);
        }
    }

    std::string lookup_prefix(const std::string& prefix) const {
        for (auto it = stack.rbegin(); it != stack.rend(); ++it) {
            auto found = it->prefix_decls.find(prefix);
            if (found != it->prefix_decls.end()) {
                return found->second;
            }
        }
        return {};
    }

    std::string resolve_name(std::string_view qname) const {
        auto colon = qname.find(':');
        if (colon == std::string_view::npos) {
            std::string uri = lookup_prefix(std::string{});
            if (uri.empty()) {
                return std::string{qname};
            }
        std::string out;
        out.reserve(uri.size() + 2 + qname.size());
        out.push_back('{');
        out.append(uri);
        out.push_back('}');
        out.append(qname);
        return out;
    }
        std::string prefix{qname.substr(0, colon)};
        std::string_view local = qname.substr(colon + 1);
        std::string uri = lookup_prefix(prefix);
        if (uri.empty()) {
            return std::string{qname};
        }
        std::string out;
        out.reserve(uri.size() + 2 + local.size());
        out.push_back('{');
        out.append(uri);
        out.push_back('}');
        out.append(local);
        return out;
    }

    static std::vector<std::string_view> split_path(std::string_view path) {
        std::vector<std::string_view> segments;
        std::size_t i = 0;
        while (i < path.size()) {
            std::size_t j = path.find('/', i);
            if (j == std::string_view::npos) {
                if (path.size() > i) {
                    segments.emplace_back(path.data() + i, path.size() - i);
                }
                break;
            }
            if (j > i) {
                segments.emplace_back(path.data() + i, j - i);
            }
            i = j + 1;
        }
        return segments;
    }

    static bool segment_match(std::string_view wanted, std::string_view resolved,
                              std::string_view qname) {
        return wanted == "*" || wanted == resolved || wanted == qname;
    }

    bool path_matches(const std::string& resolved_new_name,
                      std::string_view qname_new) const {
        for (const std::string& target : config.target_paths) {
            std::vector<std::string_view> wanted = split_path(target);
            if (wanted.size() != stack.size()) {
                continue;
            }
            bool ok = true;
            for (std::size_t i = 0; i + 1 < wanted.size(); ++i) {
                if (!segment_match(wanted[i], stack[i].resolved, stack[i].qname)) {
                    ok = false;
                    break;
                }
            }
            if (ok && segment_match(wanted.back(), resolved_new_name, qname_new)) {
                return true;
            }
        }
        return false;
    }

    std::string build_path(const std::string& resolved_new_name) const {
        std::string path;
        for (std::size_t i = 0; i + 1 < stack.size(); ++i) {
            const Frame& frame = stack[i];
            path.push_back('/');
            path.append(frame.resolved);
        }
        path.push_back('/');
        path.append(resolved_new_name);
        return path;
    }

    bool charge_budget(std::size_t n, std::size_t off) {
        if (expansion_used > config.entity_expansion_budget ||
            n > config.entity_expansion_budget - expansion_used) {
            fail(ErrorCode::EntityBudgetExceeded, "entity expansion budget exceeded", off);
            return false;
        }
        expansion_used += n;
        return true;
    }

    bool append_char_ref(std::string_view digits, bool hex, std::string& out, std::size_t off) {
        std::uint64_t value = 0;
        for (char c : digits) {
            unsigned d;
            if (c >= '0' && c <= '9') {
                d = static_cast<unsigned>(c - '0');
            } else if (hex && c >= 'a' && c <= 'f') {
                d = static_cast<unsigned>(c - 'a' + 10);
            } else if (hex && c >= 'A' && c <= 'F') {
                d = static_cast<unsigned>(c - 'A' + 10);
            } else {
                fail(ErrorCode::Malformed, "invalid character reference", off);
                return false;
            }
            value = value * (hex ? 16u : 10u) + d;
            if (value > 0x10FFFF) {
                fail(ErrorCode::Malformed, "character reference out of range", off);
                return false;
            }
        }
        auto cp = static_cast<std::uint32_t>(value);
        if (!is_valid_xml_cp(cp)) {
            fail(ErrorCode::Malformed, "character reference is not a valid XML character", off);
            return false;
        }
        std::size_t before = out.size();
        encode_utf8(cp, out);
        return charge_budget(out.size() - before, off);
    }

    bool decode_inner(std::string_view src, std::size_t base_offset, std::string& out,
                      unsigned depth) {
        std::size_t i = 0;
        while (i < src.size()) {
            char c = src[i];
            if (c != '&') {
                out.push_back(c);
                ++i;
                continue;
            }
            std::size_t semi = src.find(';', i + 1);
            if (semi == std::string_view::npos) {
                fail(ErrorCode::Malformed, "unterminated entity reference", base_offset + i);
                return false;
            }
            std::string_view body = src.substr(i + 1, semi - i - 1);
            if (!body.empty() && body[0] == '#') {
                bool hex = body.size() > 2 && (body[1] == 'x' || body[1] == 'X');
                std::string_view digits = hex ? body.substr(2) : body.substr(1);
                if (digits.empty() || !append_char_ref(digits, hex, out, base_offset + i)) {
                    return false;
                }
                i = semi + 1;
                continue;
            }
            if (body == "lt" || body == "gt" || body == "amp" || body == "quot" ||
                body == "apos") {
                static const std::array<std::pair<std::string_view, char>, 5> predef = {{
                    {"lt", '<'}, {"gt", '>'}, {"amp", '&'}, {"quot", '"'}, {"apos", '\''},
                }};
                for (const auto& kv : predef) {
                    if (kv.first == body) {
                        out.push_back(kv.second);
                        if (!charge_budget(1, base_offset + i)) {
                            return false;
                        }
                        break;
                    }
                }
                i = semi + 1;
                continue;
            }
            auto found = entities.find(std::string{body});
            if (found == entities.end()) {
                fail(ErrorCode::UndefinedEntity,
                     std::string{"reference to undefined internal entity: "}.append(body),
                     base_offset + i);
                return false;
            }
            if (depth + 1 >= kMaxEntityRecursion) {
                fail(ErrorCode::EntityRecursion,
                     std::string{"entity recursion or excessive nesting: "}.append(body),
                     base_offset + i);
                return false;
            }
            std::size_t before = out.size();
            if (!decode_inner(found->second, base_offset + i, out, depth + 1)) {
                return false;
            }
            if (!charge_budget(out.size() - before, base_offset + i)) {
                return false;
            }
            i = semi + 1;
        }
        return true;
    }

    bool decode_entities(std::string_view src, std::size_t base_offset, std::string& out) {
        return decode_inner(src, base_offset, out, 0);
    }

    bool validate_text_entities(std::size_t begin, std::size_t end) {
        std::string discarded;
        discarded.reserve(256);
        return decode_inner(std::string_view{buffer.data() + begin, end - begin},
                            global_off(begin), discarded, 0);
    }

    void skip_ws(std::size_t& pos) {
        while (pos < buffer.size() && is_ws(buffer[pos])) {
            ++pos;
        }
    }

    bool parse_name(std::size_t& pos, std::string_view& name) {
        if (pos >= buffer.size() || !is_name_start(buffer[pos])) {
            return false;
        }
        std::size_t start = pos;
        ++pos;
        while (pos < buffer.size() && is_name_char(buffer[pos])) {
            ++pos;
        }
        name = std::string_view{buffer.data() + start, pos - start};
        return true;
    }

    std::size_t find_tag_end(std::size_t from) const {
        bool in_quote = false;
        char quote = 0;
        for (std::size_t i = from; i < buffer.size(); ++i) {
            char c = buffer[i];
            if (in_quote) {
                if (c == quote) {
                    in_quote = false;
                }
                continue;
            }
            if (c == '"' || c == '\'') {
                in_quote = true;
                quote = c;
            } else if (c == '>') {
                return i;
            }
        }
        return std::string::npos;
    }

    bool parse_attributes(std::size_t begin, std::size_t end, Frame& frame) {
        std::size_t pos = begin;
        while (pos < end) {
            skip_ws(pos);
            if (pos >= end) {
                break;
            }
            std::string_view attr_name;
            if (!parse_name(pos, attr_name)) {
                fail(ErrorCode::Malformed, "invalid attribute name", global_off(pos));
                return false;
            }
            skip_ws(pos);
            if (pos >= end || buffer[pos] != '=') {
                fail(ErrorCode::Malformed, "expected '=' after attribute name", global_off(pos));
                return false;
            }
            ++pos;
            skip_ws(pos);
            if (pos >= end || (buffer[pos] != '"' && buffer[pos] != '\'')) {
                fail(ErrorCode::Malformed, "expected quoted attribute value", global_off(pos));
                return false;
            }
            char quote = buffer[pos];
            ++pos;
            std::size_t value_start = pos;
            while (pos < end && buffer[pos] != quote) {
                ++pos;
            }
            if (pos >= end) {
                fail(ErrorCode::Malformed, "unterminated attribute value", global_off(end));
                return false;
            }
            std::size_t value_end = pos;
            ++pos;

            std::string decoded;
            if (!decode_entities(std::string_view{buffer.data() + value_start,
                                                  value_end - value_start},
                                 global_off(value_start), decoded)) {
                return false;
            }
            if (attr_name == "xmlns") {
                frame.prefix_decls[std::string{}] = std::move(decoded);
            } else if (attr_name.size() > 6 && attr_name.substr(0, 6) == "xmlns:") {
                frame.prefix_decls[std::string{attr_name.substr(6)}] = std::move(decoded);
            }
        }
        return true;
    }

    void emit_capture_at(std::size_t frame_depth, std::size_t end_pos) {
        for (auto it = captures.begin(); it != captures.end();) {
            if (it->frame_depth == frame_depth) {
                Slice slice;
                slice.path = it->path;
                slice.raw = std::move(it->raw);
                slice.start_offset = it->start_offset;
                slice.end_offset = global_off(end_pos) + 1;
                slices.push_back(std::move(slice));
                it = captures.erase(it);
            } else {
                ++it;
            }
        }
    }

    bool handle_start_tag(std::size_t open_pos, std::size_t close_pos) {
        bool self_closing = close_pos > open_pos + 1 && buffer[close_pos - 1] == '/';
        std::size_t name_end = close_pos - (self_closing ? 1 : 0);
        std::size_t pos = open_pos + 1;
        std::string_view qname;
        if (!parse_name(pos, qname)) {
            fail(ErrorCode::Malformed, "invalid element name", global_off(open_pos + 1));
            return false;
        }

        Frame frame;
        frame.qname = std::string{qname};
        frame.start_offset = global_off(open_pos);
        std::size_t attr_begin = pos;
        skip_ws(attr_begin);
        if (!parse_attributes(attr_begin, name_end, frame)) {
            return false;
        }

        std::size_t frame_depth = stack.size();
        stack.push_back(frame);

        std::string resolved = resolve_name(qname);
        stack.back().resolved = resolved;
        bool matched = path_matches(resolved, qname);
        std::string full_path = build_path(resolved);

        std::size_t tag_len = close_pos - open_pos + 1;
        append_captures(buffer.data() + open_pos, tag_len);

        if (matched) {
            Capture cap;
            cap.path = full_path;
            cap.start_offset = global_off(open_pos);
            cap.frame_depth = frame_depth;
            cap.raw.assign(buffer.data() + open_pos, tag_len);
            captures.push_back(std::move(cap));
        }

        if (self_closing) {
            emit_capture_at(frame_depth, close_pos);
            stack.pop_back();
        }
        consume(tag_len);
        return true;
    }

    bool handle_end_tag(std::size_t open_pos, std::size_t close_pos) {
        std::size_t pos = open_pos + 2;
        std::string_view qname;
        if (!parse_name(pos, qname)) {
            fail(ErrorCode::Malformed, "invalid end tag name", global_off(open_pos + 2));
            return false;
        }
        std::size_t tail = pos;
        skip_ws(tail);
        if (tail != close_pos) {
            fail(ErrorCode::Malformed, "unexpected characters in end tag", global_off(tail));
            return false;
        }
        if (stack.empty() || stack.back().qname != qname) {
            fail(ErrorCode::Malformed, "mismatched end tag", global_off(open_pos));
            return false;
        }
        std::size_t tag_len = close_pos - open_pos + 1;
        append_captures(buffer.data() + open_pos, tag_len);
        emit_capture_at(stack.size() - 1, close_pos);
        stack.pop_back();
        consume(tag_len);
        return true;
    }

    bool parse_xml_declaration(std::size_t close_pos) {
        std::size_t pos = 5;
        while (pos < close_pos) {
            skip_ws(pos);
            if (pos >= close_pos || buffer[pos] == '?') {
                break;
            }
            std::string_view attr_name;
            if (!parse_name(pos, attr_name)) {
                fail(ErrorCode::Malformed, "invalid XML declaration", global_off(pos));
                return false;
            }
            skip_ws(pos);
            if (pos >= close_pos || buffer[pos] != '=') {
                fail(ErrorCode::Malformed, "invalid XML declaration", global_off(pos));
                return false;
            }
            ++pos;
            skip_ws(pos);
            if (pos >= close_pos || (buffer[pos] != '"' && buffer[pos] != '\'')) {
                fail(ErrorCode::Malformed, "invalid XML declaration", global_off(pos));
                return false;
            }
            char quote = buffer[pos++];
            std::size_t value_start = pos;
            while (pos < close_pos && buffer[pos] != quote) {
                ++pos;
            }
            if (pos >= close_pos) {
                fail(ErrorCode::Malformed, "unterminated XML declaration value", global_off(pos));
                return false;
            }
            std::string_view value{buffer.data() + value_start, pos - value_start};
            ++pos;
            if (attr_name == "encoding") {
                std::string lower;
                lower.reserve(value.size());
                for (char c : value) {
                    lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
                }
                if (lower != "utf-8" && lower != "utf8") {
                    fail(ErrorCode::EncodingNotSupported,
                         std::string{"unsupported encoding: "}.append(value),
                         global_off(value_start));
                    return false;
                }
            }
        }
        consume(close_pos + 1);
        return true;
    }

    std::size_t find_decl_end(std::size_t pos, std::size_t limit) const {
        bool in_quote = false;
        char quote = 0;
        for (std::size_t i = pos; i < limit; ++i) {
            char c = buffer[i];
            if (in_quote) {
                if (c == quote) {
                    in_quote = false;
                }
            } else if (c == '"' || c == '\'') {
                in_quote = true;
                quote = c;
            } else if (c == '>') {
                return i;
            }
        }
        return std::string::npos;
    }

    std::size_t find_doctype_end() const {
        int depth = 0;
        bool in_quote = false;
        char quote = 0;
        for (std::size_t i = 0; i < buffer.size(); ++i) {
            char c = buffer[i];
            if (in_quote) {
                if (c == quote) {
                    in_quote = false;
                }
                continue;
            }
            if (c == '"' || c == '\'') {
                in_quote = true;
                quote = c;
            } else if (c == '[') {
                ++depth;
            } else if (c == ']') {
                if (depth > 0) {
                    --depth;
                }
            } else if (c == '>' && depth == 0) {
                return i;
            }
        }
        return std::string::npos;
    }

    bool parse_entity_declaration(std::size_t start, std::size_t decl_end) {
        std::size_t pos = start + 8;
        skip_ws(pos);
        if (pos < decl_end && buffer[pos] == '%') {
            fail(ErrorCode::ExternalEntity,
                 "parameter entity declarations are disabled", global_off(pos));
            return false;
        }
        std::string_view name;
        if (!parse_name(pos, name)) {
            fail(ErrorCode::Malformed, "invalid entity declaration", global_off(pos));
            return false;
        }
        skip_ws(pos);
        if (pos >= decl_end) {
            fail(ErrorCode::Malformed, "invalid entity declaration", global_off(pos));
            return false;
        }
        if (buffer[pos] != '"' && buffer[pos] != '\'') {
            fail(ErrorCode::ExternalEntity,
                 "external and unparsed entities are disabled", global_off(pos));
            return false;
        }
        char quote = buffer[pos++];
        std::size_t value_start = pos;
        while (pos < decl_end && buffer[pos] != quote) {
            ++pos;
        }
        if (pos >= decl_end) {
            fail(ErrorCode::Malformed, "unterminated entity value", global_off(decl_end));
            return false;
        }
        std::string value{buffer.data() + value_start, pos - value_start};
        ++pos;
        skip_ws(pos);
        if (pos != decl_end) {
            fail(ErrorCode::ExternalEntity,
                 "external identifiers in entity declarations are disabled", global_off(pos));
            return false;
        }
        entities[std::string{name}] = std::move(value);
        return true;
    }

    bool parse_internal_subset(std::size_t begin, std::size_t end) {
        std::size_t pos = begin;
        while (pos < end) {
            skip_ws(pos);
            if (pos >= end) {
                break;
            }
            if (buffer.compare(pos, 4, "<!--") == 0) {
                std::size_t dash = buffer.find("-->", pos + 4);
                if (dash == std::string::npos || dash + 3 > end) {
                    fail(ErrorCode::Malformed, "unterminated comment in internal subset",
                         global_off(pos));
                    return false;
                }
                pos = dash + 3;
                continue;
            }
            if (pos + 8 <= end && buffer.compare(pos, 8, "<!ENTITY") == 0 &&
                (pos + 8 == end || is_ws(buffer[pos + 8]))) {
                std::size_t decl_end = buffer.find('>', pos);
                if (decl_end == std::string::npos || decl_end > end) {
                    fail(ErrorCode::Malformed, "unterminated entity declaration", global_off(pos));
                    return false;
                }
                if (!parse_entity_declaration(pos, decl_end)) {
                    return false;
                }
                pos = decl_end + 1;
                continue;
            }
            if (buffer.compare(pos, 9, "<!ELEMENT") == 0 ||
                buffer.compare(pos, 9, "<!ATTLIST") == 0 ||
                buffer.compare(pos, 9, "<!NOTATION") == 0) {
                std::size_t decl_end = find_decl_end(pos, end);
                if (decl_end == std::string::npos) {
                    fail(ErrorCode::Malformed, "unterminated markup declaration", global_off(pos));
                    return false;
                }
                pos = decl_end + 1;
                continue;
            }
            if (buffer.compare(pos, 2, "<?") == 0) {
                std::size_t pi_end = buffer.find("?>", pos + 2);
                if (pi_end == std::string::npos || pi_end + 2 > end) {
                    fail(ErrorCode::Malformed, "unterminated processing instruction",
                         global_off(pos));
                    return false;
                }
                pos = pi_end + 2;
                continue;
            }
            if (buffer[pos] == '%') {
                fail(ErrorCode::ExternalEntity,
                     "parameter entity references are disabled", global_off(pos));
                return false;
            }
            fail(ErrorCode::Malformed, "unsupported construct in internal subset",
                 global_off(pos));
            return false;
        }
        return true;
    }

    bool handle_doctype(std::size_t open_pos, std::size_t close_pos) {
        std::size_t pos = open_pos + 9;
        skip_ws(pos);
        std::string_view root_name;
        if (!parse_name(pos, root_name)) {
            fail(ErrorCode::Malformed, "invalid DOCTYPE declaration", global_off(pos));
            return false;
        }
        skip_ws(pos);
        if (pos < close_pos &&
            (buffer.compare(pos, 6, "SYSTEM") == 0 || buffer.compare(pos, 6, "PUBLIC") == 0)) {
            fail(ErrorCode::ExternalEntity,
                 "external DTD references are disabled", global_off(pos));
            return false;
        }
        std::size_t bracket = std::string::npos;
        for (std::size_t i = pos; i < close_pos; ++i) {
            if (buffer[i] == '"' || buffer[i] == '\'') {
                char quote = buffer[i];
                ++i;
                while (i < close_pos && buffer[i] != quote) {
                    ++i;
                }
            } else if (buffer[i] == '[') {
                bracket = i;
                break;
            }
        }
        if (bracket != std::string::npos && !parse_internal_subset(bracket + 1, close_pos - 1)) {
            return false;
        }
        consume(close_pos + 1);
        return true;
    }

    bool parse_once() {
        while (err.code == ErrorCode::None) {
            if (state == State::Content) {
                std::size_t lt = buffer.find('<');
                if (lt == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    if (buffer.find("]]>") != std::string::npos) {
                        fail(ErrorCode::Malformed,
                             "character sequence ']]>' is not allowed in text content",
                             global_off(0));
                        return false;
                    }
                    if (!buffer.empty() && !validate_text_entities(0, buffer.size())) {
                        return false;
                    }
                    buffer.clear();
                    return true;
                }
                if (lt > 0) {
                    bool has_cdata_end = false;
                    for (std::size_t i = 0; i + 3 <= lt; ++i) {
                        if (buffer.compare(i, 3, "]]>") == 0) {
                            has_cdata_end = true;
                            break;
                        }
                    }
                    if (has_cdata_end) {
                        fail(ErrorCode::Malformed,
                             "character sequence ']]>' is not allowed in text content",
                             global_off(0));
                        return false;
                    }
                    if (!validate_text_entities(0, lt)) {
                        return false;
                    }
                    append_captures(buffer.data(), lt);
                    consume(lt);
                }
                state = State::Markup;
            }

            if (buffer.size() < 2) {
                if (finished) {
                    fail(ErrorCode::Malformed, "truncated markup at end of input",
                         global_off(0));
                    return false;
                }
                return false;
            }

            if (buffer[1] == '?') {
                std::size_t end = buffer.find("?>", 2);
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "unterminated processing instruction",
                         global_off(0));
                    return false;
                }
                std::size_t close_pos = end + 1;
                if (close_pos >= 5 && buffer.compare(2, 3, "xml") == 0 &&
                    buffer.size() > 5 && is_ws(buffer[5])) {
                    if (!parse_xml_declaration(close_pos)) {
                        return false;
                    }
                } else {
                    append_captures(buffer.data(), close_pos + 1);
                    consume(close_pos + 1);
                }
                state = State::Content;
                continue;
            }
            if (buffer.compare(0, 4, "<!--") == 0) {
                std::size_t end = buffer.find("-->", 4);
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "unterminated comment", global_off(0));
                    return false;
                }
                if (end < 5 || buffer[end - 1] == '-') {
                    fail(ErrorCode::Malformed, "comments must not contain '--'",
                         global_off(0));
                    return false;
                }
                std::size_t close_pos = end + 2;
                append_captures(buffer.data(), close_pos + 1);
                consume(close_pos + 1);
                state = State::Content;
                continue;
            }
            if (buffer.compare(0, 9, "<![CDATA[") == 0) {
                std::size_t end = buffer.find("]]>", 9);
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "unterminated CDATA section", global_off(0));
                    return false;
                }
                std::size_t close_pos = end + 2;
                append_captures(buffer.data(), close_pos + 1);
                consume(close_pos + 1);
                state = State::Content;
                continue;
            }
            if (buffer.compare(0, 9, "<!DOCTYPE") == 0 &&
                (9 >= buffer.size() || is_ws(buffer[9]))) {
                std::size_t end = find_doctype_end();
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "unterminated DOCTYPE declaration",
                         global_off(0));
                    return false;
                }
                if (!handle_doctype(0, end)) {
                    return false;
                }
                state = State::Content;
                continue;
            }
            if (buffer[1] == '!') {
                if (!finished) {
                    return false;
                }
                fail(ErrorCode::Malformed, "unsupported or truncated markup declaration",
                     global_off(0));
                return false;
            }
            if (buffer[1] == '/') {
                std::size_t end = find_tag_end(2);
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "truncated end tag", global_off(0));
                    return false;
                }
                if (!handle_end_tag(0, end)) {
                    return false;
                }
                state = State::Content;
                continue;
            }
            if (is_name_start(buffer[1])) {
                std::size_t end = find_tag_end(1);
                if (end == std::string::npos) {
                    if (!finished) {
                        return false;
                    }
                    fail(ErrorCode::Malformed, "truncated start tag", global_off(0));
                    return false;
                }
                if (!handle_start_tag(0, end)) {
                    return false;
                }
                state = State::Content;
                continue;
            }
            fail(ErrorCode::Malformed, "invalid markup", global_off(0));
            return false;
        }
        return false;
    }

    std::string build_path_for(const Frame& target) const {
        std::string path;
        for (const Frame& frame : stack) {
            path.push_back('/');
            path.append(frame.resolved);
            if (&frame == &target) {
                break;
            }
        }
        return path;
    }

    bool feed_chunk(const char* data, std::size_t len) {
        if (err.code != ErrorCode::None) {
            return false;
        }
        if (len > 0) {
            buffer.append(data, len);
            fed_total += len;
        }
        parse_once();
        return err.code == ErrorCode::None;
    }

    bool finish_stream() {
        if (err.code != ErrorCode::None) {
            return false;
        }
        finished = true;
        parse_once();
        if (err.code != ErrorCode::None) {
            return false;
        }
        for (const Frame& frame : stack) {
            UnclosedElement item;
            item.qname = frame.qname;
            item.resolved_path = build_path_for(frame);
            item.start_offset = frame.start_offset;
            unclosed_list.push_back(std::move(item));
        }
        return true;
    }
};

XmlSlicer::XmlSlicer(SlicerConfig config)
    : impl_(new Impl(std::move(config))) {}

XmlSlicer::~XmlSlicer() {
    delete impl_;
}

bool XmlSlicer::feed(const char* data, std::size_t len) {
    return impl_->feed_chunk(data, len);
}

bool XmlSlicer::feed(std::string_view chunk) {
    return impl_->feed_chunk(chunk.data(), chunk.size());
}

bool XmlSlicer::finish() {
    return impl_->finish_stream();
}

std::vector<Slice> XmlSlicer::take_slices() {
    return std::move(impl_->slices);
}

const std::vector<UnclosedElement>& XmlSlicer::unclosed() const noexcept {
    return impl_->unclosed_list;
}

bool XmlSlicer::has_error() const noexcept {
    return impl_->err.code != ErrorCode::None;
}

const ParseError& XmlSlicer::error() const noexcept {
    return impl_->err;
}

std::size_t XmlSlicer::bytes_fed() const noexcept {
    return impl_->fed_total;
}

std::size_t XmlSlicer::entity_expansion_used() const noexcept {
    return impl_->expansion_used;
}

std::size_t XmlSlicer::entity_expansion_budget() const noexcept {
    return impl_->config.entity_expansion_budget;
}

}  // namespace dataeng::xml
