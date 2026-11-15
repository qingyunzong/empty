#include "dataeng.hpp"

#include <cstdio>

namespace dataeng {
namespace {

bool is_filler(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

// Split on sep, honoring the release character; escape sequences are
// resolved in the output (e.g. "?+" -> "+", "??" -> "?").
std::vector<std::string> split_unescaped(const std::string& text, char sep,
                                         char release) {
    std::vector<std::string> out;
    std::string current;
    for (std::size_t i = 0; i < text.size(); ++i) {
        char c = text[i];
        if (c == release && i + 1 < text.size()) {
            current.push_back(text[i + 1]);
            ++i;
        } else if (c == sep) {
            out.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    out.push_back(current);
    return out;
}

std::size_t to_count(const std::string& text) {
    std::size_t value = 0;
    for (char c : text) {
        if (c < '0' || c > '9')
            break;
        value = value * 10 + static_cast<std::size_t>(c - '0');
    }
    return value;
}

std::string element(const Segment& seg, std::size_t index,
                    std::size_t component = 0) {
    if (index >= seg.elements.size())
        return {};
    const auto& el = seg.elements[index];
    if (component >= el.size())
        return {};
    return el[component];
}

std::string fingerprint(const std::vector<Segment>& segments,
                        std::string_view una_advice) {
    std::uint64_t hash = 1469598103934665603ull;
    auto mix = [&hash](std::string_view text) {
        for (char c : text) {
            hash ^= static_cast<unsigned char>(c);
            hash *= 1099511628211ull;
        }
    };
    mix(una_advice);
    for (const auto& seg : segments) {
        mix(seg.raw);
        mix("\x1e");
    }
    char buf[17];
    std::snprintf(buf, sizeof buf, "%016llx",
                  static_cast<unsigned long long>(hash));
    return buf;
}

} // namespace

bool ParseResult::ok() const {
    for (const auto& issue : issues)
        if (issue.severity == Severity::Error)
            return false;
    return true;
}

ParseResult parse_interchange(std::string_view data) {
    ParseResult result;
    auto& out = result.interchange;
    auto fail = [&result](std::string code, std::string detail,
                          std::size_t offset) {
        result.issues.push_back(
            {Severity::Error, std::move(code), std::move(detail), offset});
    };

    std::size_t pos = 0;
    std::string una_advice;
    if (data.substr(0, 3) == "UNA") {
        if (data.size() < 9) {
            fail("UNA_TRUNCATED", "UNA advice shorter than 9 characters", 0);
            return result;
        }
        out.delimiters.component = data[3];
        out.delimiters.element = data[4];
        out.delimiters.decimal = data[5];
        out.delimiters.release = data[6];
        // data[7] is reserved for future use.
        out.delimiters.terminator = data[8];
        out.used_una = true;
        una_advice = std::string(data.substr(0, 9));
        pos = 9;
    }
    const Delimiters& delim = out.delimiters;

    // --- Tokenize into segments -------------------------------------
    std::vector<Segment> segments;
    while (pos < data.size()) {
        while (pos < data.size() && is_filler(data[pos]))
            ++pos;
        if (pos >= data.size())
            break;
        const std::size_t start = pos;
        std::string raw;
        bool closed = false;
        while (pos < data.size()) {
            char c = data[pos];
            if (c == delim.release && pos + 1 < data.size()) {
                raw.push_back(c);
                raw.push_back(data[pos + 1]);
                pos += 2;
                continue;
            }
            if (c == delim.terminator) {
                closed = true;
                ++pos;
                break;
            }
            raw.push_back(c);
            ++pos;
        }
        if (!closed) {
            fail("SEGMENT_UNTERMINATED", "segment missing terminator '" +
                                             std::string(1, delim.terminator),
                 start);
            break;
        }
        Segment seg;
        seg.offset = start;
        seg.raw = raw;
        const auto tag_end = raw.find(delim.element);
        seg.tag = raw.substr(0, tag_end);
        if (tag_end != std::string::npos) {
            for (auto& el :
                 split_unescaped(raw.substr(tag_end + 1), delim.element,
                                 delim.release))
                seg.elements.push_back(
                    split_unescaped(el, delim.component, delim.release));
        }
        segments.push_back(std::move(seg));
    }

    if (segments.empty()) {
        fail("EMPTY", "no segments found", 0);
        return result;
    }
    if (segments.front().tag != "UNB") {
        fail("UNB_MISSING", "interchange must start with UNB",
             segments.front().offset);
        return result;
    }

    // --- UNB header ---------------------------------------------------
    const Segment& unb = segments.front();
    out.syntax_id = element(unb, 0, 0);
    out.syntax_version = element(unb, 0, 1);
    out.sender_id = element(unb, 1, 0);
    out.recipient_id = element(unb, 2, 0);
    out.control_ref = element(unb, 4, 0);

    // --- Structural assembly ------------------------------------------
    std::size_t total_messages = 0;
    std::size_t i = 1;

    auto parse_message = [&]() -> Message {
        Message msg;
        const Segment& unh = segments[i];
        msg.reference = element(unh, 0);
        msg.type = element(unh, 1, 0);
        msg.version = element(unh, 1, 1);
        msg.segments.push_back(unh);
        ++i;
        bool terminated = false;
        while (i < segments.size()) {
            const Segment& seg = segments[i];
            if (seg.tag == "UNT") {
                terminated = true;
                msg.declared_segment_count = to_count(element(seg, 0));
                const std::string ref = element(seg, 1);
                if (!ref.empty() && ref != msg.reference) {
                    fail("UNT_REF_MISMATCH",
                         "UNT reference " + ref + " != UNH reference " +
                             msg.reference,
                         seg.offset);
                    msg.isolated = true;
                }
                msg.segments.push_back(seg);
                ++i;
                break;
            }
            if (seg.tag == "UNH" || seg.tag == "UNE" || seg.tag == "UNZ" ||
                seg.tag == "UNG") {
                break; // missing UNT; reprocess boundary segment outside
            }
            msg.segments.push_back(seg);
            ++i;
        }
        if (!terminated) {
            fail("UNT_MISSING", "message " + msg.reference + " has no UNT",
                 unh.offset);
            msg.isolated = true;
        } else if (msg.declared_segment_count != msg.segments.size()) {
            fail("UNT_COUNT_MISMATCH",
                 "message " + msg.reference + " declares " +
                     std::to_string(msg.declared_segment_count) +
                     " segments but contains " +
                     std::to_string(msg.segments.size()),
                 unh.offset);
            msg.isolated = true;
        }
        msg.count_ok = !msg.isolated;
        ++total_messages;
        return msg;
    };

    bool saw_unz = false;
    while (i < segments.size()) {
        const Segment& seg = segments[i];
        if (seg.tag == "UNG") {
            Group group;
            group.type = element(seg, 0, 0);
            group.control_ref = element(seg, 4, 0);
            ++i;
            bool closed = false;
            while (i < segments.size()) {
                if (segments[i].tag == "UNH") {
                    group.messages.push_back(parse_message());
                } else if (segments[i].tag == "UNE") {
                    closed = true;
                    group.declared_message_count =
                        to_count(element(segments[i], 0));
                    const std::string ref = element(segments[i], 1);
                    if (!ref.empty() && ref != group.control_ref)
                        fail("UNE_REF_MISMATCH",
                             "UNE reference " + ref + " != UNG reference " +
                                 group.control_ref,
                             segments[i].offset);
                    ++i;
                    break;
                } else {
                    fail("UNEXPECTED_SEGMENT",
                         "unexpected segment " + segments[i].tag +
                             " inside group",
                         segments[i].offset);
                    ++i;
                }
            }
            if (!closed) {
                fail("UNE_MISSING", "group " + group.control_ref +
                                        " has no UNE",
                     seg.offset);
            } else if (group.declared_message_count !=
                       group.messages.size()) {
                fail("UNE_COUNT_MISMATCH",
                     "group " + group.control_ref + " declares " +
                         std::to_string(group.declared_message_count) +
                         " messages but contains " +
                         std::to_string(group.messages.size()),
                     seg.offset);
            }
            group.count_ok =
                closed && group.declared_message_count == group.messages.size();
            out.groups.push_back(std::move(group));
        } else if (seg.tag == "UNH") {
            out.messages.push_back(parse_message());
        } else if (seg.tag == "UNZ") {
            saw_unz = true;
            out.declared_count = to_count(element(seg, 0));
            const std::string ref = element(seg, 1);
            if (!ref.empty() && ref != out.control_ref)
                fail("UNZ_REF_MISMATCH", "UNZ reference " + ref +
                                             " != UNB reference " +
                                             out.control_ref,
                     seg.offset);
            ++i;
            if (i < segments.size())
                fail("TRAILING_SEGMENTS",
                     "segments found after UNZ", segments[i].offset);
            break;
        } else {
            fail("UNEXPECTED_SEGMENT",
                 "segment " + seg.tag + " outside any message", seg.offset);
            ++i;
        }
    }
    if (!saw_unz) {
        fail("UNZ_MISSING", "interchange has no UNZ trailer", 0);
    } else {
        // UNZ/1 counts functional groups when grouping is used,
        // otherwise the messages directly under the interchange.
        const std::size_t actual = out.groups.empty()
                                       ? total_messages
                                       : out.groups.size();
        out.count_ok = out.declared_count == actual;
        if (!out.count_ok)
            fail("UNZ_COUNT_MISMATCH",
                 "UNZ declares " + std::to_string(out.declared_count) +
                     " but interchange contains " + std::to_string(actual) +
                     (out.groups.empty() ? " messages" : " groups"),
                 segments.back().offset);
    }

    out.content_fingerprint = fingerprint(segments, una_advice);
    return result;
}

std::size_t InterchangeRegistry::KeyHash::operator()(const Key& key) const {
    std::size_t h = std::hash<std::string>{}(key.sender);
    auto mix = [&h](const std::string& value) {
        const std::size_t v = std::hash<std::string>{}(value);
        h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
    };
    mix(key.syntax_version);
    mix(key.control_ref);
    return h;
}

DedupOutcome InterchangeRegistry::submit(const Interchange& interchange) {
    Key key{interchange.sender_id, interchange.syntax_version,
            interchange.control_ref};
    auto [it, inserted] =
        seen_.emplace(key, interchange.content_fingerprint);
    if (inserted)
        return {DedupStatus::Accepted,
                "control number " + key.control_ref + " registered"};
    if (it->second == interchange.content_fingerprint)
        return {DedupStatus::Duplicate,
                "control number " + key.control_ref +
                    " already received with identical content"};
    return {DedupStatus::Conflict,
            "control number " + key.control_ref +
                " reused with different content"};
}

} // namespace dataeng
