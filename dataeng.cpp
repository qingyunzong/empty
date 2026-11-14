#include "dataeng.hpp"

#include <utility>

namespace dataeng {

namespace {

constexpr char kUnaTag[] = "UNA";
constexpr std::size_t kUnaFieldCount = 6;

const std::string kEmpty;

// Splits on `delimiter` while ignoring occurrences escaped by `release`.
// Returned views keep the release characters so callers retain raw text.
std::vector<std::string_view> split_released(std::string_view text,
                                             char delimiter, char release) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    bool released = false;
    for (std::size_t i = 0; i < text.size(); ++i) {
        char ch = text[i];
        if (released) {
            released = false;
            continue;
        }
        if (ch == release) {
            released = true;
        } else if (ch == delimiter) {
            parts.push_back(text.substr(start, i - start));
            start = i + 1;
        }
    }
    parts.push_back(text.substr(start));
    return parts;
}

}  // namespace

const std::string& DataElement::value() const {
    if (components.empty()) {
        return kEmpty;
    }
    return components.front().value;
}

const std::string& Segment::field(std::size_t element_index) const {
    if (element_index >= elements.size()) {
        return kEmpty;
    }
    return elements[element_index].value();
}

EdifactParser::EdifactParser(ParseCallbacks callbacks)
    : callbacks_(std::move(callbacks)) {}

void EdifactParser::set_callbacks(ParseCallbacks callbacks) {
    callbacks_ = std::move(callbacks);
}

const std::vector<ParseError>& EdifactParser::errors() const noexcept {
    return errors_;
}

bool EdifactParser::has_errors() const noexcept {
    return !errors_.empty();
}

const SyntaxChars& EdifactParser::syntax() const noexcept {
    return syntax_;
}

bool EdifactParser::feed(const char* data, std::size_t size) {
    for (std::size_t i = 0; i < size; ++i) {
        char ch = data[i];
        ++stream_offset_;

        switch (state_) {
            case State::Una:
                handle_una_char(ch);
                break;

            case State::Released:
                // The release character makes the following byte literal data,
                // even when it is the segment terminator or another release.
                segment_buffer_.push_back(ch);
                state_ = State::Body;
                break;

            case State::SegmentStart: {
                // CRLF padding emitted after a terminator is not segment data.
                if (una_matched_ == 0 && (ch == '\r' || ch == '\n')) {
                    break;
                }
                if (ch == kUnaTag[una_matched_]) {
                    ++una_matched_;
                    if (una_matched_ == 3) {
                        state_ = State::Una;
                        una_matched_ = 0;
                        una_field_index_ = 0;
                    }
                    break;
                }
                // Not a UNA segment: replay the matched prefix as segment data.
                segment_offset_ = stream_offset_ - 1 - static_cast<std::size_t>(una_matched_);
                segment_buffer_.assign(kUnaTag, static_cast<std::size_t>(una_matched_));
                una_matched_ = 0;
                state_ = State::Body;
                [[fallthrough]];
            }

            case State::Body:
                if (ch == syntax_.release) {
                    segment_buffer_.push_back(ch);
                    state_ = State::Released;
                } else if (ch == syntax_.segment) {
                    emit_segment();
                    segment_buffer_.clear();
                    state_ = State::SegmentStart;
                } else {
                    segment_buffer_.push_back(ch);
                }
                break;
        }
    }
    return true;
}

bool EdifactParser::feed(std::string_view chunk) {
    return feed(chunk.data(), chunk.size());
}

bool EdifactParser::finish() {
    if (state_ == State::Una) {
        report(ErrorCode::MalformedUna,
               "UNA segment truncated: six service characters expected",
               stream_offset_);
    }

    if (state_ == State::Body || state_ == State::Released ||
        !segment_buffer_.empty()) {
        if (in_message_) {
            report(ErrorCode::UnterminatedMessage,
                   "stream ended before the closing UNT segment",
                   segment_offset_);
            message_.failed = true;
            if (callbacks_.on_message_end) {
                callbacks_.on_message_end(message_);
            }
            in_message_ = false;
        }
        if (in_interchange_) {
            report(ErrorCode::UnterminatedInterchange,
                   "stream ended before the closing UNZ segment",
                   segment_offset_);
        } else {
            report(ErrorCode::UnbMissing,
                   "trailing segment data without an interchange envelope",
                   segment_offset_);
        }
    } else if (in_message_) {
        report(ErrorCode::UnterminatedMessage,
               "stream ended before the closing UNT segment",
               stream_offset_);
        message_.failed = true;
        if (callbacks_.on_message_end) {
            callbacks_.on_message_end(message_);
        }
        in_message_ = false;
        if (in_interchange_) {
            report(ErrorCode::UnterminatedInterchange,
                   "stream ended before the closing UNZ segment",
                   stream_offset_);
        }
    } else if (in_interchange_) {
        report(ErrorCode::UnterminatedInterchange,
               "stream ended before the closing UNZ segment",
               stream_offset_);
    }

    in_interchange_ = false;
    state_ = State::SegmentStart;
    segment_buffer_.clear();
    una_matched_ = 0;
    return errors_.empty();
}

void EdifactParser::handle_una_char(char ch) {
    switch (una_field_index_) {
        case 0: syntax_.component = ch; break;
        case 1: syntax_.element = ch; break;
        case 2: syntax_.decimal = ch; break;
        case 3: syntax_.release = ch; break;
        case 4: syntax_.repetition = ch; break;
        case 5:
            syntax_.segment = ch;
            if (syntax_.component == syntax_.element ||
                syntax_.component == syntax_.release ||
                syntax_.component == syntax_.segment ||
                syntax_.element == syntax_.release ||
                syntax_.element == syntax_.segment ||
                syntax_.release == syntax_.segment) {
                report(ErrorCode::MalformedUna,
                       "UNA service characters must be distinct",
                       stream_offset_);
            }
            // The sixth UNA byte is itself the segment terminator: the UNA
            // segment ends here and the next byte starts a new segment.
            state_ = State::SegmentStart;
            una_field_index_ = 0;
            return;
        default:
            break;
    }
    ++una_field_index_;
}

std::string EdifactParser::unescape(std::string_view raw, char release) {
    std::string result;
    result.reserve(raw.size());
    for (std::size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == release && i + 1 < raw.size()) {
            result.push_back(raw[i + 1]);
            ++i;
        } else {
            result.push_back(raw[i]);
        }
    }
    return result;
}

bool EdifactParser::parse_count(std::string_view text, std::size_t& out) {
    if (text.empty()) {
        return false;
    }
    std::size_t value = 0;
    for (char ch : text) {
        if (ch < '0' || ch > '9') {
            return false;
        }
        value = value * 10 + static_cast<std::size_t>(ch - '0');
    }
    out = value;
    return true;
}

void EdifactParser::report(ErrorCode code, std::string message, std::size_t offset) {
    ParseError error{code, std::move(message), offset};
    errors_.push_back(error);
    if (callbacks_.on_error) {
        callbacks_.on_error(errors_.back());
    }
}

void EdifactParser::emit_segment() {
    if (segment_buffer_.empty()) {
        // A doubled terminator carries no segment; stay aligned with the stream.
        return;
    }

    Segment segment;
    segment.offset = segment_offset_;
    segment.raw = segment_buffer_;

    for (std::string_view element_raw :
         split_released(segment_buffer_, syntax_.element, syntax_.release)) {
        DataElement element;
        element.raw = std::string(element_raw);
        for (std::string_view component_raw : split_released(
                 element_raw, syntax_.component, syntax_.release)) {
            Component component;
            component.raw = std::string(component_raw);
            component.value = unescape(component_raw, syntax_.release);
            element.components.push_back(std::move(component));
        }
        segment.elements.push_back(std::move(element));
    }

    if (segment.elements.empty()) {
        return;
    }
    segment.tag = segment.elements.front().value();
    process_segment(segment);
}

void EdifactParser::process_segment(const Segment& segment) {
    const std::string& tag = segment.tag;

    if (tag == "UNB") {
        if (in_interchange_) {
            report(ErrorCode::UnbInsideInterchange,
                   "UNB encountered while another interchange is open",
                   segment.offset);
            if (callbacks_.on_segment) {
                callbacks_.on_segment(segment);
            }
            return;
        }
        in_interchange_ = true;
        interchange_ = InterchangeInfo{};
        unb_reference_ = segment.field(5);  // DE 0020 interchange control reference
        interchange_.control_reference = unb_reference_;
        if (callbacks_.on_interchange_start) {
            callbacks_.on_interchange_start(interchange_);
        }
        if (callbacks_.on_segment) {
            callbacks_.on_segment(segment);
        }
        return;
    }

    if (tag == "UNZ") {
        if (!in_interchange_) {
            report(ErrorCode::UnzOutsideInterchange,
                   "UNZ encountered without an open interchange",
                   segment.offset);
            if (callbacks_.on_segment) {
                callbacks_.on_segment(segment);
            }
            return;
        }
        if (in_message_) {
            report(ErrorCode::UnterminatedMessage,
                   "UNZ encountered while message '" + message_.control_reference +
                       "' was still open",
                   segment.offset);
            message_.failed = true;
            if (callbacks_.on_message_end) {
                callbacks_.on_message_end(message_);
            }
            in_message_ = false;
        }

        if (callbacks_.on_segment) {
            callbacks_.on_segment(segment);
        }

        std::size_t declared = 0;
        if (!parse_count(segment.field(1), declared)) {
            report(ErrorCode::InvalidUnsignedInteger,
                   "UNZ control count '" + segment.field(1) +
                       "' is not an unsigned integer",
                   segment.offset);
        }
        interchange_.declared_message_count = declared;
        if (declared != interchange_.actual_message_count) {
            report(ErrorCode::UnzCountMismatch,
                   "UNZ declares " + std::to_string(declared) +
                       " messages but " +
                       std::to_string(interchange_.actual_message_count) +
                       " were actually parsed",
                   segment.offset);
        }
        const std::string& unz_reference = segment.field(2);
        if (unz_reference != unb_reference_) {
            report(ErrorCode::UnzReferenceMismatch,
                   "UNZ reference '" + unz_reference +
                       "' does not match UNB reference '" + unb_reference_ + "'",
                   segment.offset);
        }
        if (callbacks_.on_interchange_end) {
            callbacks_.on_interchange_end(interchange_);
        }
        in_interchange_ = false;
        return;
    }

    if (tag == "UNH") {
        if (!in_interchange_) {
            report(ErrorCode::UnbMissing,
                   "UNH encountered without an enclosing UNB",
                   segment.offset);
            in_interchange_ = true;
            interchange_ = InterchangeInfo{};
            unb_reference_.clear();
            if (callbacks_.on_interchange_start) {
                callbacks_.on_interchange_start(interchange_);
            }
        }
        if (in_message_) {
            report(ErrorCode::UnhInsideMessage,
                   "UNH encountered while message '" +
                       message_.control_reference + "' was still open",
                   segment.offset);
            report(ErrorCode::UnterminatedMessage,
                   "message '" + message_.control_reference +
                       "' closed implicitly by the next UNH",
                   segment.offset);
            message_.failed = true;
            if (callbacks_.on_message_end) {
                callbacks_.on_message_end(message_);
            }
            in_message_ = false;
        }

        in_message_ = true;
        message_ = MessageInfo{};
        message_.control_reference = segment.field(1);  // DE 0062
        message_.actual_segment_count = 1;             // UNH counts itself
        ++interchange_.actual_message_count;
        if (callbacks_.on_message_start) {
            callbacks_.on_message_start(message_);
        }
        if (callbacks_.on_segment) {
            callbacks_.on_segment(segment);
        }
        return;
    }

    if (tag == "UNT") {
        if (callbacks_.on_segment) {
            callbacks_.on_segment(segment);
        }
        if (!in_message_) {
            report(ErrorCode::UntOutsideMessage,
                   "UNT encountered without an open message",
                   segment.offset);
            return;
        }

        std::size_t declared = 0;
        if (!parse_count(segment.field(1), declared)) {
            report(ErrorCode::InvalidUnsignedInteger,
                   "UNT segment count '" + segment.field(1) +
                       "' is not an unsigned integer",
                   segment.offset);
        }
        message_.declared_segment_count = declared;
        ++message_.actual_segment_count;  // UNT counts itself
        if (declared != message_.actual_segment_count) {
            report(ErrorCode::UntCountMismatch,
                   "UNT declares " + std::to_string(declared) +
                       " segments but the message contains " +
                       std::to_string(message_.actual_segment_count),
                   segment.offset);
            message_.failed = true;
        }
        if (callbacks_.on_message_end) {
            callbacks_.on_message_end(message_);
        }
        in_message_ = false;
        return;
    }

    if (callbacks_.on_segment) {
        callbacks_.on_segment(segment);
    }
    if (in_message_) {
        ++message_.actual_segment_count;
    }
}

}  // namespace dataeng
