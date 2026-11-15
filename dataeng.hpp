#pragma once

// dataeng - a small, dependency-free, streaming MIME parser.
//
// The parser consumes a message in arbitrary chunks.  It does not require the
// complete message to be resident in memory and reports decoded leaf bodies
// through a Sink.  Multipart containers are parsed recursively; boundaries may
// be split across feed() calls.  Malformed leaf parts are reported with byte
// ranges into the original message and do not prevent sibling parts from being
// delivered.

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

enum class TransferEncoding : std::uint8_t {
  seven_bit,
  eight_bit,
  binary,
  base64,
  quoted_printable,
  unknown,
};

enum class PartKind : std::uint8_t {
  root,
  multipart,
  text,
  attachment,
  message,
  other,
};

enum class ErrorCode : std::uint8_t {
  none = 0,
  malformed_header,
  header_limit,
  missing_boundary,
  invalid_boundary,
  nesting_too_deep,
  too_many_parts,
  unsupported_transfer_encoding,
  invalid_base64,
  truncated_base64,
  data_after_base64_padding,
  invalid_quoted_printable,
  truncated_quoted_printable,
  decoded_size_limit,
  total_size_limit,
  expansion_limit,
  message_size_limit,
  unexpected_eof,
};

[[nodiscard]] const char* to_string(TransferEncoding value) noexcept;
[[nodiscard]] const char* to_string(PartKind value) noexcept;
[[nodiscard]] const char* to_string(ErrorCode value) noexcept;

// A half-open range [begin, end) in the original, undecoded input stream.
// Offsets are absolute and start at zero for the first byte passed to feed().
struct ByteRange {
  std::uint64_t begin = 0;
  std::uint64_t end = 0;

  [[nodiscard]] constexpr bool valid() const noexcept { return end >= begin; }
  [[nodiscard]] constexpr std::uint64_t size() const noexcept { return end - begin; }
};

struct PartError {
  ErrorCode code = ErrorCode::none;
  std::string message;
  ByteRange range;
  // Repeated occurrences of the same error are coalesced into one record.
  std::uint64_t occurrences = 1;
  bool fatal = false;
};

struct HeaderField {
  std::string name;
  // Folded continuation lines are unfolded with single spaces.
  std::string value;
  // Range of the field in the original input, excluding the final line break.
  ByteRange range;
};

struct PartInfo {
  std::size_t index = 0;
  std::size_t depth = 0;
  PartKind kind = PartKind::other;
  std::string media_type;  // lower-case, e.g. "text/plain"
  std::string charset;
  std::string disposition;  // lower-case disposition type
  std::string filename;     // RFC 2231/2047 decoded, if present
  std::string content_id;
  TransferEncoding transfer_encoding = TransferEncoding::seven_bit;
  bool is_multipart = false;
  bool is_attachment = false;
  // True when decoded data was cut short by a limit or a decoding error.
  bool truncated = false;
  ByteRange header_range;
  // Encoded body bytes in the original message.  For a multipart container
  // this spans its body (including child parts).  Boundary delimiters and the
  // CRLF immediately preceding them are not included.
  ByteRange body_range;
  std::vector<HeaderField> headers;
  std::vector<PartError> errors;

  [[nodiscard]] bool complete() const noexcept { return !truncated && errors.empty(); }
};

struct Limits {
  // Maximum MIME nesting depth.  The root part has depth 0.  A multipart part
  // at depth N is allowed to create children while N + 1 <= max_depth; when the
  // limit is reached the multipart part is delivered as an opaque leaf.
  std::size_t max_depth = 32;
  std::size_t max_parts = 10'000;
  std::size_t max_header_bytes = 256 * 1024;
  std::size_t max_header_count = 1'000;
  std::size_t max_header_line_bytes = 16 * 1024;
  std::size_t max_boundary_length = 200;
  // Per leaf part and whole-message decoded output limits.
  std::uint64_t max_decoded_part_bytes = 64ull * 1024 * 1024;
  std::uint64_t max_total_decoded_bytes = 512ull * 1024 * 1024;
  // Output/input ratio guard for pathological decoder expansion.  It is only
  // checked after a few KiB have been seen to avoid penalising tiny parts.
  double max_expansion_ratio = 64.0;
  // Total bytes accepted from the input stream.  Set to 0 for no limit.
  std::uint64_t max_message_bytes = 1024ull * 1024 * 1024;
};

struct ParseStats {
  std::uint64_t input_bytes = 0;
  std::uint64_t decoded_bytes = 0;
  std::uint64_t encoded_body_bytes = 0;
  std::size_t parts = 0;
  std::size_t errors = 0;
  bool truncated = false;
  bool input_limit_hit = false;
};

struct MessageResult {
  bool completed = false;

  [[nodiscard]] bool ok() const noexcept { return completed && stats.errors == 0; }

  ParseStats stats;
};

class Sink {
 public:
  virtual ~Sink() = default;

  // Called once per part after its headers have been parsed.  For a leaf part,
  // one or more on_part_data() calls follow.
  virtual void on_part_begin(const PartInfo& /*part*/) {}
  // Decoded payload bytes.  The span is valid only for the duration of the
  // call.  Multipart containers and suppressed parts do not emit body data.
  virtual void on_part_data(const PartInfo& /*part*/,
                            std::span<const std::uint8_t> /*data*/) {}
  // Called with the final PartInfo, including the exact encoded body_range.
  virtual void on_part_end(const PartInfo& /*part*/) {}
  // Called when a part error is discovered.  The error range points at the
  // offending bytes in the original input.
  virtual void on_part_error(const PartInfo& /*part*/, const PartError& /*error*/) {}
  // Called exactly once when finish() completes.
  virtual void on_message_end(const MessageResult& /*result*/) {}
};

using Handler = Sink;

struct Callbacks {
  std::function<void(const PartInfo&)> on_part_begin;
  std::function<void(const PartInfo&, std::span<const std::uint8_t>)> on_part_data;
  std::function<void(const PartInfo&)> on_part_end;
  std::function<void(const PartInfo&, const PartError&)> on_part_error;
  std::function<void(const MessageResult&)> on_message_end;
};

// Adapter for callback-based integrations.
class CallbackSink final : public Sink {
 public:
  explicit CallbackSink(Callbacks callbacks);

  void on_part_begin(const PartInfo& part) override;
  void on_part_data(const PartInfo& part, std::span<const std::uint8_t> data) override;
  void on_part_end(const PartInfo& part) override;
  void on_part_error(const PartInfo& part, const PartError& error) override;
  void on_message_end(const MessageResult& result) override;

 private:
  Callbacks callbacks_;
};

class MimeParser {
 public:
  explicit MimeParser(Limits limits = {});
  explicit MimeParser(Sink& sink, Limits limits = {});
  ~MimeParser();

  MimeParser(const MimeParser&) = delete;
  MimeParser& operator=(const MimeParser&) = delete;
  MimeParser(MimeParser&&) noexcept;
  MimeParser& operator=(MimeParser&&) noexcept;

  void set_sink(Sink* sink) noexcept;
  [[nodiscard]] Sink* sink() const noexcept;

  // Start a new message.  The parser is also reset automatically on
  // construction.
  void reset(Limits limits = {});

  void feed(std::string_view bytes);
  void feed(const void* data, std::size_t size);
  void feed(std::span<const std::uint8_t> bytes);

  // Complete the current message.  It is safe to call finish() more than once;
  // subsequent calls are no-ops.  Calling feed() after finish() is an error.
  void finish();

  [[nodiscard]] bool finished() const noexcept;
  [[nodiscard]] const ParseStats& stats() const noexcept;
  [[nodiscard]] const Limits& limits() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

using Parser = MimeParser;
using StreamParser = MimeParser;
using MimeStreamParser = MimeParser;

struct CollectedPart {
  PartInfo info;
  std::string data;  // decoded body (empty for multipart containers)
};

struct CollectedMessage {
  bool completed = false;
  ParseStats stats;
  std::vector<CollectedPart> parts;
  std::vector<PartError> message_errors;

  [[nodiscard]] bool ok() const noexcept {
    return completed && stats.errors == 0;
  }
};

// Convenience wrapper around MimeParser that retains decoded bodies in memory.
// Prefer MimeParser directly for large or unbounded attachments.
[[nodiscard]] CollectedMessage collect(std::string_view message, Limits limits = {});
[[nodiscard]] CollectedMessage parse_message(std::string_view message, Limits limits = {});

// Case-insensitive header lookup.  Returns nullptr when not present.
[[nodiscard]] const HeaderField* find_header(const PartInfo& part,
                                             std::string_view name) noexcept;
[[nodiscard]] const HeaderField* find_header(const std::vector<HeaderField>& headers,
                                             std::string_view name) noexcept;

}  // namespace dataeng
