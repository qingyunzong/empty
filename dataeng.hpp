#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

// EDIFACT service characters. Defaults follow UN/EDIFACT syntax level 4
// (component ':', element '+', decimal '.', release '?', repetition '*',
// segment terminator '\''). A UNA segment overrides them for the interchange.
struct SyntaxChars {
    char component = ':';
    char element = '+';
    char decimal = '.';
    char release = '?';
    char repetition = '*';
    char segment = '\'';
};

struct Component {
    std::string value;       // unescaped component value
    std::string raw;         // raw component text, still carrying release chars
};

struct DataElement {
    std::vector<Component> components;
    std::string raw;         // raw element text, still carrying release chars

    // Convenience accessor: value of the first component.
    [[nodiscard]] const std::string& value() const;
};

struct Segment {
    std::string tag;                          // e.g. "UNB", "DTM"
    std::vector<DataElement> elements;        // tag is elements[0]
    std::string raw;                          // raw segment text without terminator
    std::size_t offset = 0;                   // byte offset of the tag in the stream

    // Value of the first component of element index (0 == tag).
    // Returns an empty string when the element/component does not exist.
    [[nodiscard]] const std::string& field(std::size_t element_index) const;
};

enum class ErrorCode {
    MalformedUna,            // UNA present but shorter than six service chars
    InvalidUnsignedInteger,  // count/control field is not an unsigned integer
    UntCountMismatch,        // UNT declared count != actual segments in the message
    UntOutsideMessage,       // UNT without a matching UNH
    UnhInsideMessage,        // UNH while another message is still open
    UnzOutsideInterchange,   // UNZ without a matching UNB
    UnzCountMismatch,        // UNZ control count != number of actual messages
    UnzReferenceMismatch,    // UNZ control reference != UNB control reference
    UnbInsideInterchange,    // UNB while an interchange is already open
    UnbMissing,              // stream ends / UNZ seen before any UNB
    UnterminatedInterchange, // stream ended before UNZ
    UnterminatedMessage,     // stream ended while a message was open
};

struct ParseError {
    ErrorCode code;
    std::string message;
    std::size_t offset = 0;  // byte offset in the stream where the issue was detected
};

struct InterchangeInfo {
    std::string control_reference;  // UNB S002 first component / UNZ DE 0020
    std::size_t declared_message_count = 0;  // UNZ DE 0030
    std::size_t actual_message_count = 0;    // number of UNH seen
};

struct MessageInfo {
    std::string control_reference;  // UNH DE 0062 / UNT DE 0062
    std::size_t declared_segment_count = 0;  // UNT DE 0074
    std::size_t actual_segment_count = 0;    // segments including UNH and UNT
    bool failed = false;            // a message-level error was reported for it
};

// Callbacks used by a supply-chain collector. All callbacks are optional.
// Message-level failures are delivered via on_error and isolated: parsing of the
// following messages and the interchange envelope continues normally.
struct ParseCallbacks {
    std::function<void(const InterchangeInfo&)> on_interchange_start;
    std::function<void(const InterchangeInfo&)> on_interchange_end;
    std::function<void(const MessageInfo&)> on_message_start;
    std::function<void(const MessageInfo&)> on_message_end;
    std::function<void(const Segment&)> on_segment;
    std::function<void(const ParseError&)> on_error;
};

// Streaming, push-based EDIFACT parser. Feed any number of byte chunks; a
// segment terminator may be split across consecutive feed() calls and a
// release-escaped terminator is kept as data rather than ending the segment.
class EdifactParser {
public:
    EdifactParser() = default;
    explicit EdifactParser(ParseCallbacks callbacks);

    void set_callbacks(ParseCallbacks callbacks);

 // Feed one chunk of the EDIFACT byte stream. Returns false only when an
    // interchange-level error makes further processing pointless; message-level
    // errors are isolated and never make feed() return false.
    bool feed(std::string_view chunk);
    bool feed(const char* data, std::size_t size);

    // Flush after the final chunk. Reports any dangling interchange/message.
    // Returns false when at least one error (of any level) was observed.
    bool finish();

    [[nodiscard]] const std::vector<ParseError>& errors() const noexcept;
    [[nodiscard]] bool has_errors() const noexcept;
    [[nodiscard]] const SyntaxChars& syntax() const noexcept;

private:
    enum class State {
        SegmentStart,  // at a segment boundary; check UNA / skip trailing CRLF
        Body,          // inside a segment, collecting raw text
        Released,      // previous body character was the release character
        Una,           // collecting the six UNA service characters
    };

    void handle_una_char(char ch);
    void emit_segment();
    void process_segment(const Segment& segment);
    void report(ErrorCode code, std::string message, std::size_t offset);
    static std::string unescape(std::string_view raw, char release);
    static bool parse_count(std::string_view text, std::size_t& out);

    ParseCallbacks callbacks_;
    SyntaxChars syntax_{};
    State state_ = State::SegmentStart;

    std::string segment_buffer_;       // raw text of the segment being built
    std::size_t segment_offset_ = 0;   // offset of the first segment byte
    std::size_t stream_offset_ = 0;    // total bytes consumed so far

    int una_matched_ = 0;              // UNA prefix matched in SegmentStart
    int una_field_index_ = 0;          // service chars collected in State::Una

    bool in_interchange_ = false;
    bool in_message_ = false;
    InterchangeInfo interchange_{};
    MessageInfo message_{};
    std::string unb_reference_;        // remembered for the UNZ cross-check

    std::vector<ParseError> errors_;
};

}  // namespace dataeng
