#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

// A complete JSON Lines record.  `text` excludes the UTF-8 BOM and the
// line terminator (LF or CRLF).  Offsets are absolute input byte offsets and
// `end` is one past the last record byte.
struct Record {
    std::string text;
    std::uint64_t begin = 0;
    std::uint64_t end = 0;
    std::uint64_t line = 1;
};

enum class ErrorKind {
    InvalidUtf8,
    LineTooLong,
};

// Decoding errors never invalidate the stream.  For InvalidUtf8, [begin, end)
// is the exact maximal invalid byte subpart.  For LineTooLong, [begin, end)
// spans the whole oversized record body.  `line` is one-based.
struct Error {
    ErrorKind kind = ErrorKind::InvalidUtf8;
    std::uint64_t begin = 0;
    std::uint64_t end = 0;
    std::uint64_t line = 1;
};

struct Result {
    std::vector<Record> records;
    std::vector<Error> errors;

    [[nodiscard]] bool empty() const noexcept
    {
        return records.empty() && errors.empty();
    }

    [[nodiscard]] bool has_errors() const noexcept { return !errors.empty(); }
    [[nodiscard]] std::size_t size() const noexcept { return records.size(); }

    [[nodiscard]] Record& operator[](std::size_t index) noexcept
    {
        return records[index];
    }
    [[nodiscard]] const Record& operator[](std::size_t index) const noexcept
    {
        return records[index];
    }

    [[nodiscard]] auto begin() noexcept { return records.begin(); }
    [[nodiscard]] auto end() noexcept { return records.end(); }
    [[nodiscard]] auto begin() const noexcept { return records.begin(); }
    [[nodiscard]] auto end() const noexcept { return records.end(); }
};

struct Options {
    // Maximum number of record bytes, excluding the trailing CR/LF and BOM.
    // A line that grows past this limit is discarded without retaining its
    // body.  Zero means unlimited.
    std::size_t max_line_bytes = 16U * 1024U * 1024U;

    // Strip one UTF-8 BOM (EF BB BF) at the beginning of the stream only.
    bool strip_bom = true;

    // Validate every completed record as strict UTF-8.
    bool validate_utf8 = true;

    // Ignore empty records (including lines containing only the CR of CRLF).
    bool skip_empty_lines = true;
};

// Stateful incremental decoder for a byte stream of JSON Lines.
//
// The decoder deliberately does not parse JSON.  It frames records, validates
// their UTF-8 encoding, and reports framing/encoding failures so callers can
// feed each retained record to their own JSON parser.  One decoder instance
// holds all state for one stream; it is not internally synchronised.
class JsonLinesDecoder {
public:
    JsonLinesDecoder();
    explicit JsonLinesDecoder(Options options);
    explicit JsonLinesDecoder(std::size_t max_line_bytes);

    // Consume the next arbitrary chunk.  Record/error offsets refer to the
    // concatenation of all chunks supplied since construction or reset().
    // Calling feed() after finish() throws std::logic_error.
    Result feed(std::string_view chunk);

    // Flush a final record that has no trailing newline.  Idempotent.
    Result finish();

    // Discard buffered input and start a new stream at offset zero.
    void reset();

    [[nodiscard]] bool finished() const noexcept { return finished_; }

    // Body bytes currently retained for an incomplete line.  This is zero for
    // an oversized line, even before its terminating newline arrives.
    [[nodiscard]] std::size_t pending_bytes() const noexcept
    {
        return line_.size();
    }

    [[nodiscard]] const Options& options() const noexcept { return options_; }

private:
    void process_bytes(std::string_view bytes, std::uint64_t base, Result& out);
    void finish_line(Result& out);
    void discard_line();
    void report_utf8_errors(const std::string& bytes, std::uint64_t base,
                            Result& out) const;

    Options options_;
    bool bom_settled_ = false;
    std::string bom_prefix_;
    bool finished_ = false;

    std::uint64_t stream_offset_ = 0;
    std::uint64_t line_number_ = 1;

    std::string line_;
    std::uint64_t line_start_ = 0;
    bool line_active_ = false;
    bool overflow_ = false;
    std::uint64_t overflow_bytes_ = 0;
    bool last_was_cr_ = false;
};

// Convenience aliases for embedders that prefer a shorter type name.
using JsonlDecoder = JsonLinesDecoder;
using JSONLinesDecoder = JsonLinesDecoder;
using JSONLDecoder = JsonLinesDecoder;
using Decoder = JsonLinesDecoder;
using JsonLinesOptions = Options;
using DecodeResult = Result;
using DecodeError = Error;

// Decode one complete in-memory buffer.
Result decode_json_lines(std::string_view input, Options options = {});
Result decode(std::string_view input, Options options = {});

} // namespace dataeng
