#include "dataeng.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace dataeng {
namespace {

using u8 = std::uint8_t;

constexpr std::size_t npos = std::string_view::npos;

[[nodiscard]] bool is_ws(char c) noexcept {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
}

[[nodiscard]] bool is_line_ws(char c) noexcept { return c == ' ' || c == '\t'; }

[[nodiscard]] std::string_view trim_ws(std::string_view value) noexcept {
  while (!value.empty() && is_ws(value.front())) value.remove_prefix(1);
  while (!value.empty() && is_ws(value.back())) value.remove_suffix(1);
  return value;
}

[[nodiscard]] char ascii_lower(char c) noexcept {
  if (c >= 'A' && c <= 'Z') return static_cast<char>(c - 'A' + 'a');
  return c;
}

[[nodiscard]] std::string lower_ascii(std::string_view value) {
  std::string result(value);
  for (char& c : result) c = ascii_lower(c);
  return result;
}

[[nodiscard]] bool iequals(std::string_view lhs, std::string_view rhs) noexcept {
  if (lhs.size() != rhs.size()) return false;
  for (std::size_t i = 0; i < lhs.size(); ++i) {
    if (ascii_lower(lhs[i]) != ascii_lower(rhs[i])) return false;
  }
  return true;
}

[[nodiscard]] bool starts_with_ci(std::string_view value,
                                  std::string_view prefix) noexcept {
  return value.size() >= prefix.size() && iequals(value.substr(0, prefix.size()), prefix);
}

[[nodiscard]] int hex_value(char c) noexcept {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

[[nodiscard]] bool is_token_char(char c) noexcept {
  if (c <= 0x20 || c >= 0x7f) return false;
  switch (c) {
    case '(':
    case ')':
    case '<':
    case '>':
    case '@':
    case ',':
    case ';':
    case ':':
    case '\\':
    case '"':
    case '/':
    case '[':
    case ']':
    case '?':
    case '=':
      return false;
    default:
      return true;
  }
}

[[nodiscard]] std::string strip_comments(std::string_view value) {
  std::string result;
  result.reserve(value.size());
  int depth = 0;
  bool quoted = false;
  bool escaped = false;
  for (char c : value) {
    if (quoted) {
      result.push_back(c);
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        quoted = false;
      }
      continue;
    }
    if (c == '"') {
      quoted = true;
      result.push_back(c);
    } else if (c == '(') {
      ++depth;
    } else if (c == ')') {
      if (depth > 0) --depth;
    } else if (depth == 0) {
      result.push_back(c);
    }
  }
  return result;
}

[[nodiscard]] std::string percent_decode(std::string_view value) {
  std::string result;
  result.reserve(value.size());
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '%' && i + 2 < value.size()) {
      const int hi = hex_value(value[i + 1]);
      const int lo = hex_value(value[i + 2]);
      if (hi >= 0 && lo >= 0) {
        result.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    result.push_back(value[i]);
  }
  return result;
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp <= 0x7f) {
    out.push_back(static_cast<char>(cp));
  } else if (cp <= 0x7ff) {
    out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
  } else if (cp <= 0xffff) {
    out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
  } else {
    out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
  }
}

[[nodiscard]] std::string transcode_charset(std::string_view charset,
                                             std::string_view bytes) {
  const std::string name = lower_ascii(trim_ws(charset));
  if (name.empty() || name == "utf-8" || name == "utf8" || name == "us-ascii" ||
      name == "ascii" || name == "cp65001") {
    return std::string(bytes);
  }

  if (name == "iso-8859-1" || name == "iso8859-1" || name == "latin1" ||
      name == "latin-1" || name == "cp819") {
    std::string out;
    out.reserve(bytes.size() * 2);
    for (unsigned char c : bytes) append_utf8(out, c);
    return out;
  }

  if (name == "windows-1252" || name == "cp1252") {
    static constexpr std::array<std::uint16_t, 32> kTable = {
        0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
        0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
        0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
        0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
    };
    std::string out;
    out.reserve(bytes.size() * 2);
    for (unsigned char c : bytes) {
      if (c >= 0x80 && c <= 0x9f) {
        append_utf8(out, kTable[c - 0x80]);
      } else {
        append_utf8(out, c);
      }
    }
    return out;
  }

  // Unknown charsets are passed through.  Most real-world messages use UTF-8
  // even when they advertise something more exotic.
  return std::string(bytes);
}

struct RawParam {
  std::string name;
  std::string value;
};

[[nodiscard]] std::vector<RawParam> parse_parameters(std::string_view value) {
  std::vector<RawParam> params;
  std::size_t i = 0;
  while (i < value.size() && value[i] != ';') ++i;

  while (i < value.size()) {
    while (i < value.size() && (value[i] == ';' || is_line_ws(value[i]))) ++i;
    if (i >= value.size()) break;

    const std::size_t name_start = i;
    while (i < value.size() && value[i] != '=' && value[i] != ';') ++i;
    const std::string name =
        lower_ascii(trim_ws(value.substr(name_start, i - name_start)));
    if (name.empty()) {
      if (i < value.size() && value[i] == ';') ++i;
      continue;
    }
    if (i >= value.size() || value[i] == ';') {
      params.push_back({name, {}});
      continue;
    }

    ++i;  // '='
    while (i < value.size() && is_line_ws(value[i])) ++i;

    std::string parsed;
    if (i < value.size() && value[i] == '"') {
      ++i;
      bool closed = false;
      while (i < value.size()) {
        const char c = value[i];
        if (c == '\\' && i + 1 < value.size()) {
          parsed.push_back(value[i + 1]);
          i += 2;
        } else if (c == '"') {
          ++i;
          closed = true;
          break;
        } else {
          parsed.push_back(c);
          ++i;
        }
      }
      (void)closed;
      while (i < value.size() && value[i] != ';') ++i;
    } else {
      const std::size_t value_start = i;
      while (i < value.size() && value[i] != ';') ++i;
      parsed = std::string(trim_ws(value.substr(value_start, i - value_start)));
    }
    params.push_back({name, std::move(parsed)});
  }
  return params;
}

struct ExtendedValue {
  std::string charset;
  std::string data;
};

[[nodiscard]] ExtendedValue split_extended_value(std::string_view value) {
  const std::size_t first = value.find('\'');
  if (first != npos) {
    const std::size_t second = value.find('\'', first + 1);
    if (second != npos) {
      return {std::string(value.substr(0, first)),
              std::string(value.substr(second + 1))};
    }
  }
  return {"", std::string(value)};
}

[[nodiscard]] bool parse_continuation_name(std::string_view name,
                                           std::string_view base,
                                           std::size_t& index,
                                           bool& extended) {
  if (name.size() <= base.size() + 1) return false;
  if (name.substr(0, base.size()) != base || name[base.size()] != '*') return false;

  std::size_t pos = base.size() + 1;
  const std::size_t digits_start = pos;
  std::size_t parsed = 0;
  while (pos < name.size() && name[pos] >= '0' && name[pos] <= '9') {
    if (parsed > 1'000'000) return false;
    parsed = parsed * 10 + static_cast<std::size_t>(name[pos] - '0');
    ++pos;
  }
  if (pos == digits_start) return false;

  extended = false;
  if (pos < name.size() && name[pos] == '*') {
    extended = true;
    ++pos;
  }
  if (pos != name.size()) return false;
  index = parsed;
  return true;
}

[[nodiscard]] std::optional<std::string> resolve_parameter(
    const std::vector<RawParam>& params, std::string_view base) {
  const RawParam* regular = nullptr;
  const RawParam* single_extended = nullptr;
  std::map<std::size_t, std::pair<bool, std::string>> continuations;

  for (const RawParam& param : params) {
    if (param.name == base) {
      regular = &param;
      continue;
    }
    if (param.name.size() == base.size() + 1 && param.name.back() == '*' &&
        param.name.compare(0, base.size(), base) == 0) {
      single_extended = &param;
      continue;
    }
    std::size_t index = 0;
    bool extended = false;
    if (parse_continuation_name(param.name, base, index, extended)) {
      continuations[index] = {extended, param.value};
    }
  }

  if (single_extended != nullptr) {
    const ExtendedValue extended = split_extended_value(single_extended->value);
    const std::string bytes = percent_decode(extended.data);
    return transcode_charset(extended.charset, bytes);
  }

  if (!continuations.empty()) {
    std::string bytes;
    std::string charset = "utf-8";
    bool any_extended = false;
    bool first = true;
    for (const auto& [index, segment] : continuations) {
      (void)index;
      if (segment.first) {
        std::string data = segment.second;
        std::string segment_charset;
        if (first) {
          const ExtendedValue split = split_extended_value(data);
          segment_charset = split.charset;
          data = split.data;
          if (!segment_charset.empty()) charset = segment_charset;
        }
        bytes += percent_decode(data);
        any_extended = true;
      } else {
        bytes += segment.second;
      }
      first = false;
    }
    return any_extended ? transcode_charset(charset, bytes) : bytes;
  }

  if (regular != nullptr) return regular->value;
  return std::nullopt;
}

[[nodiscard]] bool decode_base64_string(std::string_view input, std::string& out) {
  std::array<u8, 4> quad{};
  std::size_t count = 0;
  bool padded = false;
  bool ok = true;

  auto flush = [&](std::size_t produced) {
    if (count < 2) {
      ok = false;
      count = 0;
      return;
    }
    if (quad[2] == 64 && quad[3] == 64) produced = 1;
    else if (quad[2] < 64 && quad[3] == 64) produced = 2;
    else if (quad[2] < 64 && quad[3] < 64) produced = 3;
    else {
      ok = false;
      produced = 0;
    }
    const std::uint32_t value = (static_cast<std::uint32_t>(quad[0]) << 18) |
                                (static_cast<std::uint32_t>(quad[1]) << 12) |
                                (static_cast<std::uint32_t>(quad[2] & 63) << 6) |
                                static_cast<std::uint32_t>(quad[3] & 63);
    for (std::size_t i = 0; i < produced; ++i) {
      out.push_back(static_cast<char>((value >> (16 - 8 * i)) & 0xff));
    }
    count = 0;
  };

  for (char c : input) {
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
    if (c == '=') {
      if ((padded && count == 0) || count < 2) {
        ok = false;
        continue;
      }
      quad[count++] = 64;
      if (count == 4) {
        flush(0);
        padded = true;
      }
      continue;
    }
    const int value = [&]() {
      if (c >= 'A' && c <= 'Z') return c - 'A';
      if (c >= 'a' && c <= 'z') return c - 'a' + 26;
      if (c >= '0' && c <= '9') return c - '0' + 52;
      if (c == '+') return 62;
      if (c == '/') return 63;
      return -1;
    }();
    if (value < 0 || padded) {
      ok = false;
      continue;
    }
    quad[count++] = static_cast<u8>(value);
    if (count == 4) flush(0);
  }
  if (count != 0) ok = false;
  return ok;
}

[[nodiscard]] std::string decode_q_encoding(std::string_view input) {
  std::string out;
  out.reserve(input.size());
  for (std::size_t i = 0; i < input.size(); ++i) {
    const char c = input[i];
    if (c == '_') {
      out.push_back(' ');
    } else if (c == '=' && i + 2 < input.size()) {
      const int hi = hex_value(input[i + 1]);
      const int lo = hex_value(input[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
      } else {
        out.push_back(c);
      }
    } else {
      out.push_back(c);
    }
  }
  return out;
}

[[nodiscard]] std::string decode_rfc2047(std::string_view input) {
  if (input.find("=?") == npos) return std::string(input);

  std::string out;
  std::size_t pos = 0;
  bool previous_encoded = false;

  while (pos < input.size()) {
    const std::size_t start = input.find("=?", pos);
    if (start == npos) {
      out.append(input.substr(pos));
      break;
    }

    const std::string_view between = input.substr(pos, start - pos);
    bool only_ws = true;
    for (char c : between) {
      if (!is_ws(c)) {
        only_ws = false;
        break;
      }
    }
    if (!(previous_encoded && only_ws)) out.append(between);

    const std::size_t charset_end = input.find('?', start + 2);
    if (charset_end == npos || charset_end + 2 >= input.size()) {
      out.append(input.substr(start));
      break;
    }
    const std::size_t encoding_pos = charset_end + 1;
    const char encoding = ascii_lower(input[encoding_pos]);
    if ((encoding != 'b' && encoding != 'q') || input[encoding_pos + 1] != '?') {
      out.append(input.substr(start, 2));
      pos = start + 2;
      previous_encoded = false;
      continue;
    }
    const std::size_t text_start = encoding_pos + 2;
    const std::size_t end = input.find("?=", text_start);
    if (end == npos) {
      out.append(input.substr(start));
      break;
    }

    const std::string_view text = input.substr(text_start, end - text_start);
    const std::string charset(input.substr(start + 2, charset_end - start - 2));
    std::string decoded;
    bool ok = true;
    if (encoding == 'b') {
      ok = decode_base64_string(text, decoded);
    } else {
      decoded = decode_q_encoding(text);
    }
    if (ok) {
      out += transcode_charset(charset, decoded);
      previous_encoded = true;
    } else {
      out.append(input.substr(start, end + 2 - start));
      previous_encoded = false;
    }
    pos = end + 2;
  }
  return out;
}

[[nodiscard]] TransferEncoding parse_transfer_encoding(std::string_view value) {
  const std::string stripped =
      strip_comments(value.substr(0, value.find(';')));
  const std::string token = lower_ascii(trim_ws(stripped));
  if (token == "base64") return TransferEncoding::base64;
  if (token == "quoted-printable") return TransferEncoding::quoted_printable;
  if (token == "7bit") return TransferEncoding::seven_bit;
  if (token == "8bit") return TransferEncoding::eight_bit;
  if (token == "binary") return TransferEncoding::binary;
  if (token.empty()) return TransferEncoding::seven_bit;
  return TransferEncoding::unknown;
}

struct MediaType {
  std::string value = "text/plain";
  std::vector<RawParam> params;
};

[[nodiscard]] MediaType parse_media_type(std::string_view header) {
  MediaType result;
  const std::size_t semicolon = header.find(';');
  const std::string stripped =
      strip_comments(header.substr(0, semicolon));
  const std::string_view main = trim_ws(stripped);
  if (!main.empty()) result.value = lower_ascii(main);
  result.params = parse_parameters(header);
  return result;
}

struct HeaderTerminator {
  std::size_t content_end = 0;
  std::size_t end = 0;
};

[[nodiscard]] std::optional<HeaderTerminator> find_header_terminator(
    const u8* data, std::size_t size) {
  // A message with no header fields starts with an empty line.
  if (size >= 2 && data[0] == '\r' && data[1] == '\n') {
    return HeaderTerminator{0, 2};
  }
  if (size >= 1 && data[0] == '\n') {
    return HeaderTerminator{0, 1};
  }

  std::optional<HeaderTerminator> best;
  for (std::size_t i = 0; i < size; ++i) {
    if (data[i] != '\n') continue;

    HeaderTerminator candidate{};
    if (i + 1 < size && data[i + 1] == '\n') {
      candidate.end = i + 2;
      candidate.content_end = (i > 0 && data[i - 1] == '\r') ? i - 1 : i;
    } else if (i + 2 < size && data[i + 1] == '\r' && data[i + 2] == '\n') {
      candidate.end = i + 3;
      candidate.content_end = (i > 0 && data[i - 1] == '\r') ? i - 1 : i;
    } else {
      continue;
    }

    if (!best.has_value() || candidate.end < best->end ||
        (candidate.end == best->end && candidate.content_end < best->content_end)) {
      best = candidate;
    }
  }
  return best;
}

struct BoundaryHit {
  bool found = false;
  bool closing = false;
  std::size_t break_start = 0;
  std::size_t line_start = 0;
  std::size_t after_marker = 0;
  std::size_t need_more_from = npos;
};

[[nodiscard]] BoundaryHit find_boundary(const u8* data, std::size_t size,
                                        std::string_view boundary,
                                        bool at_line_start, bool at_eof) {
  BoundaryHit result;
  const std::string needle = "--" + std::string(boundary);

  for (std::size_t i = 0; i + needle.size() <= size; ++i) {
    if (std::memcmp(data + i, needle.data(), needle.size()) != 0) continue;
    const bool line_start = (i == 0 && at_line_start) || (i > 0 && data[i - 1] == '\n');
    if (!line_start) continue;

    std::size_t break_start = i;
    if (i >= 2 && data[i - 2] == '\r' && data[i - 1] == '\n') {
      break_start = i - 2;
    } else if (i >= 1 && data[i - 1] == '\n') {
      break_start = i - 1;
    }

    std::size_t cursor = i + needle.size();
    bool closing = false;
    if (cursor < size && data[cursor] == '-') {
      if (cursor + 1 < size && data[cursor + 1] == '-') {
        closing = true;
        cursor += 2;
      } else if (cursor + 1 == size) {
        if (!at_eof) {
          result.need_more_from = std::min(result.need_more_from, break_start);
        }
        continue;
      } else {
        continue;
      }
    }

    while (cursor < size && is_line_ws(static_cast<char>(data[cursor]))) ++cursor;

    std::size_t after = 0;
    if (cursor == size) {
      if (!at_eof) {
        result.need_more_from = std::min(result.need_more_from, break_start);
        continue;
      }
      after = cursor;
    } else if (data[cursor] == '\n') {
      after = cursor + 1;
    } else if (data[cursor] == '\r') {
      if (cursor + 1 == size) {
        if (!at_eof) {
          result.need_more_from = std::min(result.need_more_from, break_start);
          continue;
        }
        continue;
      }
      if (data[cursor + 1] != '\n') continue;
      after = cursor + 2;
    } else {
      continue;
    }

    result.found = true;
    result.closing = closing;
    result.break_start = break_start;
    result.line_start = i;
    result.after_marker = after;
    return result;
  }
  return result;
}

}  // namespace

struct MimeParser::Impl {
  enum class State { headers, multipart, body, done };
  enum class QpState { normal, after_eq, after_eq_cr, after_hex };

  struct Decoder {
    TransferEncoding encoding = TransferEncoding::seven_bit;
    bool initialized = false;

    std::array<u8, 4> quad{};
    std::size_t quad_count = 0;
    bool base64_padded = false;
    std::uint64_t quad_start = 0;

    QpState qp_state = QpState::normal;
    u8 qp_high = 0;
    std::uint64_t qp_pending_abs = 0;
  };

  struct Context {
    PartInfo info;
    State state = State::headers;
    std::string boundary;
    bool is_multipart = false;
    bool deny_multipart = false;
    bool suppress = false;
    bool emitted_begin = false;
    std::size_t notified_errors = 0;
    bool header_overflow = false;
    bool header_skipped = false;
    bool has_decoder = false;
    bool at_line_start = true;
    std::uint64_t header_start = 0;
    std::uint64_t body_start = 0;
    std::uint64_t decoded_bytes = 0;
    std::uint64_t encoded_bytes = 0;
    bool truncated = false;
    Decoder decoder;
  };

  Limits limits;
  Sink* sink = nullptr;
  std::vector<u8> buffer;
  std::size_t position = 0;
  std::uint64_t buffer_base = 0;
  std::vector<Context> stack;
  ParseStats stats;
  std::vector<PartError> message_errors;
  bool finish_requested = false;
  bool message_ended = false;

  explicit Impl(Limits configured) : limits(configured) {
    if (limits.max_parts == 0) limits.max_parts = 1;
    reset();
  }

  [[nodiscard]] std::size_t available() const noexcept {
    return buffer.size() - position;
  }

  [[nodiscard]] const u8* input_data() const noexcept {
    return buffer.data() + position;
  }

  [[nodiscard]] std::uint64_t absolute_position() const noexcept {
    return buffer_base + static_cast<std::uint64_t>(position);
  }

  void consume(std::size_t count) {
    position += std::min(count, available());
  }

  void compact() {
    if (position == 0) return;
    if (position == buffer.size()) {
      buffer_base += static_cast<std::uint64_t>(position);
      buffer.clear();
      position = 0;
      return;
    }
    if (position >= 64 * 1024 || position * 2 >= buffer.size()) {
      buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(position));
      buffer_base += static_cast<std::uint64_t>(position);
      position = 0;
    }
  }

  void reset() {
    buffer.clear();
    position = 0;
    buffer_base = 0;
    stack.clear();
    stats = {};
    message_errors.clear();
    finish_requested = false;
    message_ended = false;

    Context root;
    root.info.index = 0;
    root.info.depth = 0;
    root.header_start = 0;
    root.body_start = 0;
    root.at_line_start = true;
    stack.push_back(std::move(root));
    stats.parts = 1;
  }

  void add_error(Context& context, ErrorCode code, ByteRange range,
                 std::string message, bool fatal = false) {
    for (PartError& existing : context.info.errors) {
      if (existing.code == code) {
        ++existing.occurrences;
        existing.range.begin = std::min(existing.range.begin, range.begin);
        existing.range.end = std::max(existing.range.end, range.end);
        existing.fatal = existing.fatal || fatal;
        return;
      }
    }

    PartError error;
    error.code = code;
    error.message = std::move(message);
    error.range = range;
    error.fatal = fatal;
    context.info.errors.push_back(std::move(error));
    ++stats.errors;

    switch (code) {
      case ErrorCode::invalid_base64:
      case ErrorCode::truncated_base64:
      case ErrorCode::data_after_base64_padding:
      case ErrorCode::invalid_quoted_printable:
      case ErrorCode::truncated_quoted_printable:
      case ErrorCode::decoded_size_limit:
      case ErrorCode::total_size_limit:
      case ErrorCode::expansion_limit:
        context.truncated = true;
        stats.truncated = true;
        break;
      default:
        break;
    }

    if (context.emitted_begin && sink != nullptr && !context.suppress) {
      sink->on_part_error(context.info, context.info.errors.back());
      context.notified_errors = context.info.errors.size();
    }
  }

  void notify_pending_errors(Context& context) {
    if (context.suppress || sink == nullptr) return;
    while (context.notified_errors < context.info.errors.size()) {
      sink->on_part_error(context.info, context.info.errors[context.notified_errors]);
      ++context.notified_errors;
    }
  }

  void emit_begin(Context& context) {
    if (context.emitted_begin) return;
    context.info.header_range = {context.header_start, context.body_start};
    context.info.body_range = {context.body_start, context.body_start};
    context.emitted_begin = true;
    if (sink != nullptr && !context.suppress) sink->on_part_begin(context.info);
    notify_pending_errors(context);
  }

  void init_decoder(Context& context) {
    Decoder decoder;
    decoder.encoding = context.info.transfer_encoding;
    decoder.initialized = true;
    context.decoder = decoder;
    context.has_decoder = true;
    if (decoder.encoding == TransferEncoding::unknown) {
      add_error(context, ErrorCode::unsupported_transfer_encoding,
                {context.header_start, context.body_start},
                "unsupported Content-Transfer-Encoding; passing bytes through");
    }
  }

  void emit(Context& context, const u8* data, std::size_t size,
            std::uint64_t range_begin, std::uint64_t range_end);

  void decode_base64(Context& context, const u8* data, std::size_t size,
                     std::uint64_t absolute);
  void decode_quoted_printable(Context& context, const u8* data, std::size_t size,
                               std::uint64_t absolute);
  void decode(Context& context, const u8* data, std::size_t size,
              std::uint64_t absolute);
  void flush_decoder(Context& context, std::uint64_t body_end);

  void parse_header_block(Context& context, const u8* data, std::size_t size,
                          std::uint64_t absolute);
  void configure_context(Context& context);
  void create_child(Context& parent, std::uint64_t header_start);

  bool process_headers(std::size_t index);
  bool process_multipart(std::size_t index);
  bool process_body(std::size_t index);
  void finish_context(std::size_t index, std::uint64_t body_end);

  void pump();
  void feed(std::string_view bytes);
  void finish();
};

void MimeParser::Impl::emit(Context& context, const u8* data, std::size_t size,
                            std::uint64_t range_begin, std::uint64_t range_end) {
  if (size == 0 || context.suppress) return;

  std::size_t output = size;
  ErrorCode limit_code = ErrorCode::none;

  if (limits.max_decoded_part_bytes != 0) {
    const std::uint64_t used = context.decoded_bytes;
    const std::uint64_t limit = limits.max_decoded_part_bytes;
    if (used >= limit) {
      output = 0;
      limit_code = ErrorCode::decoded_size_limit;
    } else if (output > limit - used) {
      output = static_cast<std::size_t>(limit - used);
      limit_code = ErrorCode::decoded_size_limit;
    }
  }

  if (limits.max_total_decoded_bytes != 0) {
    const std::uint64_t used = stats.decoded_bytes;
    const std::uint64_t limit = limits.max_total_decoded_bytes;
    if (used >= limit) {
      output = 0;
      if (limit_code == ErrorCode::none) limit_code = ErrorCode::total_size_limit;
    } else if (output > limit - used) {
      output = static_cast<std::size_t>(limit - used);
      if (limit_code == ErrorCode::none) limit_code = ErrorCode::total_size_limit;
    }
  }

  if (limits.max_expansion_ratio > 0.0 && context.encoded_bytes >= 4096 &&
      context.decoded_bytes >= 4096) {
    const double cap = static_cast<double>(context.encoded_bytes) *
                       limits.max_expansion_ratio;
    const double used = static_cast<double>(context.decoded_bytes);
    if (used + static_cast<double>(output) > cap) {
      const std::size_t allowed =
          cap <= used ? 0 : static_cast<std::size_t>(cap - used);
      if (allowed < output) {
        output = allowed;
        if (limit_code == ErrorCode::none) limit_code = ErrorCode::expansion_limit;
      }
    }
  }

  if (output < size) {
    add_error(context, limit_code, {range_begin, range_end},
              limit_code == ErrorCode::expansion_limit
                  ? "decoded body exceeded the configured expansion ratio"
                  : "decoded body exceeded the configured size limit");
    context.truncated = true;
    stats.truncated = true;
  }
  if (output == 0) return;

  if (sink != nullptr) {
    sink->on_part_data(context.info, std::span<const u8>(data, output));
  }
  context.decoded_bytes += output;
  stats.decoded_bytes += output;
}

void MimeParser::Impl::decode_base64(Context& context, const u8* data,
                                     std::size_t size, std::uint64_t absolute) {
  Decoder& decoder = context.decoder;

  auto finish_quad = [&](std::uint64_t end_absolute) {
    if (decoder.quad_count != 4) return;
    const u8 q0 = decoder.quad[0];
    const u8 q1 = decoder.quad[1];
    const u8 q2 = decoder.quad[2];
    const u8 q3 = decoder.quad[3];
    std::size_t produced = 0;

    if (q0 >= 64 || q1 >= 64 || (q2 == 64 && q3 < 64)) {
      add_error(context, ErrorCode::invalid_base64,
                {decoder.quad_start, end_absolute},
                "invalid base64 quartet");
      decoder.quad_count = 0;
      return;
    }
    if (q2 == 64 && q3 == 64) {
      produced = 1;
    } else if (q2 < 64 && q3 == 64) {
      produced = 2;
    } else if (q2 < 64 && q3 < 64) {
      produced = 3;
    } else {
      add_error(context, ErrorCode::invalid_base64,
                {decoder.quad_start, end_absolute},
                "invalid base64 padding");
      decoder.quad_count = 0;
      return;
    }
    if (q2 == 64 || q3 == 64) decoder.base64_padded = true;

    const std::uint32_t value =
        (static_cast<std::uint32_t>(q0) << 18) |
        (static_cast<std::uint32_t>(q1) << 12) |
        (static_cast<std::uint32_t>(q2 & 63) << 6) |
        static_cast<std::uint32_t>(q3 & 63);
    const u8 out[3] = {
        static_cast<u8>((value >> 16) & 0xff),
        static_cast<u8>((value >> 8) & 0xff),
        static_cast<u8>(value & 0xff),
    };
    emit(context, out, produced, decoder.quad_start, end_absolute);
    decoder.quad_count = 0;
  };

  for (std::size_t i = 0; i < size; ++i) {
    const u8 raw = data[i];
    const char c = static_cast<char>(raw);
    const std::uint64_t current = absolute + static_cast<std::uint64_t>(i);

    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;

    if (c == '=') {
      if (decoder.base64_padded && decoder.quad_count == 0) {
        add_error(context, ErrorCode::data_after_base64_padding,
                  {current, current + 1}, "base64 data after padding");
        continue;
      }
      if (decoder.quad_count < 2) {
        add_error(context, ErrorCode::invalid_base64,
                  {current, current + 1},
                  "base64 padding appears too early");
        decoder.quad_count = 0;
        continue;
      }
      decoder.quad[decoder.quad_count++] = 64;
      if (decoder.quad_count == 4) finish_quad(current + 1);
      continue;
    }

    int value = -1;
    if (c >= 'A' && c <= 'Z') value = c - 'A';
    else if (c >= 'a' && c <= 'z') value = c - 'a' + 26;
    else if (c >= '0' && c <= '9') value = c - '0' + 52;
    else if (c == '+') value = 62;
    else if (c == '/') value = 63;

    if (value < 0) {
      add_error(context, ErrorCode::invalid_base64, {current, current + 1},
                "invalid character in base64 body");
      continue;
    }
    if (decoder.base64_padded) {
      add_error(context, ErrorCode::data_after_base64_padding,
                {current, current + 1}, "base64 data after padding");
      continue;
    }
    if (decoder.quad_count == 0) decoder.quad_start = current;
    decoder.quad[decoder.quad_count++] = static_cast<u8>(value);
    if (decoder.quad_count == 4) finish_quad(current + 1);
  }
}

void MimeParser::Impl::decode_quoted_printable(Context& context, const u8* data,
                                               std::size_t size,
                                               std::uint64_t absolute) {
  Decoder& decoder = context.decoder;
  std::size_t i = 0;

  while (i < size) {
    const char c = static_cast<char>(data[i]);
    const std::uint64_t current = absolute + static_cast<std::uint64_t>(i);

    switch (decoder.qp_state) {
      case QpState::normal:
        if (c == '=') {
          decoder.qp_state = QpState::after_eq;
          decoder.qp_pending_abs = current;
          ++i;
        } else {
          const std::size_t run_start = i;
          while (i < size && data[i] != '=') ++i;
          emit(context, data + run_start, i - run_start,
               absolute + static_cast<std::uint64_t>(run_start),
               absolute + static_cast<std::uint64_t>(i));
        }
        break;

      case QpState::after_eq:
        if (const int hi = hex_value(c); hi >= 0) {
          decoder.qp_high = static_cast<u8>(hi);
          decoder.qp_state = QpState::after_hex;
          ++i;
        } else if (c == '\r') {
          decoder.qp_state = QpState::after_eq_cr;
          ++i;
        } else if (c == '\n') {
          decoder.qp_state = QpState::normal;
          ++i;
        } else {
          add_error(context, ErrorCode::invalid_quoted_printable,
                    {decoder.qp_pending_abs, current + 1},
                    "invalid quoted-printable escape");
          const u8 equals = '=';
          emit(context, &equals, 1, decoder.qp_pending_abs, current);
          decoder.qp_state = QpState::normal;
        }
        break;

      case QpState::after_eq_cr:
        if (c == '\n') {
          decoder.qp_state = QpState::normal;
          ++i;
        } else {
          add_error(context, ErrorCode::invalid_quoted_printable,
                    {decoder.qp_pending_abs, current},
                    "quoted-printable soft break is not followed by a newline");
          const u8 literal[2] = {'=', '\r'};
          emit(context, literal, 2, decoder.qp_pending_abs, current);
          decoder.qp_state = QpState::normal;
        }
        break;

      case QpState::after_hex:
        if (const int lo = hex_value(c); lo >= 0) {
          const u8 decoded =
              static_cast<u8>((static_cast<unsigned>(decoder.qp_high) << 4) |
                              static_cast<unsigned>(lo));
          emit(context, &decoded, 1, decoder.qp_pending_abs, current + 1);
          decoder.qp_state = QpState::normal;
          ++i;
        } else {
          add_error(context, ErrorCode::invalid_quoted_printable,
                    {decoder.qp_pending_abs, current + 1},
                    "invalid quoted-printable hex digit");
          const char high_char =
              decoder.qp_high < 10
                  ? static_cast<char>('0' + decoder.qp_high)
                  : static_cast<char>('A' + decoder.qp_high - 10);
          const u8 literal[2] = {'=', static_cast<u8>(high_char)};
          emit(context, literal, 2, decoder.qp_pending_abs, current);
          decoder.qp_state = QpState::normal;
        }
        break;
    }
  }
}

void MimeParser::Impl::decode(Context& context, const u8* data, std::size_t size,
                              std::uint64_t absolute) {
  if (size == 0 || context.suppress) return;
  context.encoded_bytes += size;

  switch (context.decoder.encoding) {
    case TransferEncoding::base64:
      decode_base64(context, data, size, absolute);
      break;
    case TransferEncoding::quoted_printable:
      decode_quoted_printable(context, data, size, absolute);
      break;
    case TransferEncoding::seven_bit:
    case TransferEncoding::eight_bit:
    case TransferEncoding::binary:
    case TransferEncoding::unknown:
      emit(context, data, size, absolute, absolute + size);
      break;
  }
}

void MimeParser::Impl::flush_decoder(Context& context, std::uint64_t body_end) {
  if (!context.has_decoder || context.suppress) return;
  Decoder& decoder = context.decoder;

  if (decoder.encoding == TransferEncoding::base64 && decoder.quad_count != 0) {
    add_error(context, ErrorCode::truncated_base64,
              {decoder.quad_start, body_end},
              "base64 body ended in the middle of a quartet");
    decoder.quad_count = 0;
  }

  if (decoder.encoding == TransferEncoding::quoted_printable &&
      decoder.qp_state != QpState::normal) {
    add_error(context, ErrorCode::truncated_quoted_printable,
              {decoder.qp_pending_abs, body_end},
              "quoted-printable body ended in the middle of an escape");
    decoder.qp_state = QpState::normal;
  }
}

void MimeParser::Impl::parse_header_block(Context& context, const u8* data,
                                          std::size_t size,
                                          std::uint64_t absolute) {
  HeaderField* current = nullptr;
  bool capacity_reported = false;

  std::size_t line_start = 0;
  while (line_start < size) {
    std::size_t line_end = line_start;
    while (line_end < size && data[line_end] != '\n') ++line_end;
    std::size_t content_end = line_end;
    if (content_end > line_start && data[content_end - 1] == '\r') --content_end;
    const std::size_t next = line_end < size ? line_end + 1 : size;

    const std::size_t length = content_end - line_start;
    if (length == 0) {
      line_start = next;
      continue;
    }

    const std::uint64_t line_abs =
        absolute + static_cast<std::uint64_t>(line_start);
    const std::uint64_t line_content_abs =
        absolute + static_cast<std::uint64_t>(content_end);

    if (data[line_start] == ' ' || data[line_start] == '\t') {
      if (current == nullptr) {
        add_error(context, ErrorCode::malformed_header,
                  {line_abs, line_content_abs},
                  "header continuation without a preceding field");
      } else {
        std::size_t value_start = line_start;
        std::size_t value_end = content_end;
        if (limits.max_header_line_bytes != 0 &&
            value_end - value_start > limits.max_header_line_bytes) {
          add_error(context, ErrorCode::header_limit,
                    {line_abs, line_content_abs},
                    "header continuation line is too long");
          value_end = value_start + limits.max_header_line_bytes;
        }
        const std::string_view continuation =
            trim_ws(std::string_view(
                reinterpret_cast<const char*>(data + value_start),
                value_end - value_start));
        if (!current->value.empty() && !continuation.empty()) {
          current->value.push_back(' ');
        }
        current->value.append(continuation);
        current->range.end = line_content_abs;
      }
      line_start = next;
      continue;
    }

    const std::size_t scan_length =
        limits.max_header_line_bytes != 0 &&
                length > limits.max_header_line_bytes
            ? limits.max_header_line_bytes
            : length;
    if (scan_length != length) {
      add_error(context, ErrorCode::header_limit, {line_abs, line_content_abs},
                "header line is too long");
    }

    const u8* colon_ptr = static_cast<const u8*>(
        std::memchr(data + line_start, ':', scan_length));
    if (colon_ptr == nullptr) {
      add_error(context, ErrorCode::malformed_header,
                {line_abs, line_content_abs}, "header field has no colon");
      current = nullptr;
      line_start = next;
      continue;
    }

    const std::size_t colon = static_cast<std::size_t>(colon_ptr - data);
    std::string_view name(reinterpret_cast<const char*>(data + line_start),
                          colon - line_start);
    name = trim_ws(name);
    bool valid_name = !name.empty();
    for (char c : name) {
      if (!is_token_char(c)) {
        valid_name = false;
        break;
      }
    }
    if (!valid_name) {
      add_error(context, ErrorCode::malformed_header,
                {line_abs, line_content_abs}, "invalid header field name");
      current = nullptr;
      line_start = next;
      continue;
    }

    if (limits.max_header_count != 0 &&
        context.info.headers.size() >= limits.max_header_count) {
      if (!capacity_reported) {
        add_error(context, ErrorCode::header_limit, {line_abs, line_content_abs},
                  "too many header fields");
        capacity_reported = true;
      }
      current = nullptr;
      line_start = next;
      continue;
    }

    std::size_t value_begin = colon + 1;
    while (value_begin < content_end &&
           is_line_ws(static_cast<char>(data[value_begin]))) {
      ++value_begin;
    }
    std::size_t value_end = content_end;
    while (value_end > value_begin &&
           is_line_ws(static_cast<char>(data[value_end - 1]))) {
      --value_end;
    }

    HeaderField field;
    field.name = std::string(name);
    field.value.assign(reinterpret_cast<const char*>(data + value_begin),
                       value_end - value_begin);
    field.range = {line_abs, line_content_abs};
    context.info.headers.push_back(std::move(field));
    current = &context.info.headers.back();
    line_start = next;
  }
}

void MimeParser::Impl::configure_context(Context& context) {
  const HeaderField* content_type = find_header(context.info.headers, "Content-Type");
  const HeaderField* disposition_header =
      find_header(context.info.headers, "Content-Disposition");
  const HeaderField* transfer_header =
      find_header(context.info.headers, "Content-Transfer-Encoding");
  const HeaderField* content_id = find_header(context.info.headers, "Content-ID");

  const MediaType media =
      parse_media_type(content_type != nullptr ? content_type->value : "text/plain");
  context.info.media_type = media.value;

  std::string disposition_value =
      disposition_header != nullptr ? disposition_header->value : "";
  const std::size_t disposition_semicolon = disposition_value.find(';');
  std::string disposition_main = lower_ascii(trim_ws(strip_comments(
      std::string_view(disposition_value).substr(0, disposition_semicolon))));
  context.info.disposition = disposition_main;
  const std::vector<RawParam> disposition_params =
      parse_parameters(disposition_value);

  std::optional<std::string> filename = resolve_parameter(disposition_params, "filename");
  if (!filename.has_value()) filename = resolve_parameter(media.params, "name");
  if (filename.has_value()) {
    context.info.filename = decode_rfc2047(*filename);
  }

  if (const auto charset = resolve_parameter(media.params, "charset");
      charset.has_value()) {
    context.info.charset = lower_ascii(trim_ws(*charset));
  }

  if (content_id != nullptr) {
    context.info.content_id =
        std::string(trim_ws(content_id->value));
  }

  context.info.transfer_encoding = parse_transfer_encoding(
      transfer_header != nullptr ? transfer_header->value : "");

  const bool is_multipart = starts_with_ci(context.info.media_type, "multipart/");
  context.info.is_multipart = is_multipart;
  context.is_multipart = is_multipart;
  const bool disposition_attachment = context.info.disposition == "attachment";
  const bool has_filename = !context.info.filename.empty();
  context.info.is_attachment =
      disposition_attachment ||
      (has_filename && context.info.disposition != "inline");

  if (context.info.depth == 0) {
    context.info.kind = PartKind::root;
  } else if (is_multipart) {
    context.info.kind = PartKind::multipart;
  } else if (iequals(context.info.media_type, "message/rfc822")) {
    context.info.kind = PartKind::message;
  } else if (context.info.is_attachment) {
    context.info.kind = PartKind::attachment;
  } else if (starts_with_ci(context.info.media_type, "text/")) {
    context.info.kind = PartKind::text;
  } else {
    context.info.kind = PartKind::other;
  }

  if (!is_multipart) {
    context.state = State::body;
    init_decoder(context);
    return;
  }

  std::string boundary =
      resolve_parameter(media.params, "boundary").value_or(std::string());
  bool deny = context.suppress;
  const ByteRange header_range = {context.header_start, context.body_start};

  if (boundary.empty()) {
    add_error(context, ErrorCode::missing_boundary,
              content_type != nullptr ? content_type->range : header_range,
              "multipart part has no boundary parameter");
    deny = true;
  } else if (limits.max_boundary_length != 0 &&
             boundary.size() > limits.max_boundary_length) {
    add_error(context, ErrorCode::invalid_boundary, header_range,
              "multipart boundary is longer than the configured limit");
    deny = true;
  }

  if (context.info.depth + 1 > limits.max_depth) {
    add_error(context, ErrorCode::nesting_too_deep, header_range,
              "multipart nesting depth limit reached; part is delivered as a leaf");
    deny = true;
  }

  if (deny) {
    context.deny_multipart = true;
    context.boundary.clear();
    context.state = State::body;
    init_decoder(context);
    return;
  }

  context.boundary = std::move(boundary);
  context.state = State::multipart;
}

void MimeParser::Impl::create_child(Context& parent,
                                    std::uint64_t header_start) {
  const bool suppress = parent.suppress || stats.parts >= limits.max_parts;
  Context child;
  if (suppress) {
    child.info.index = stats.parts;
    if (!parent.suppress) {
      add_error(parent, ErrorCode::too_many_parts, {header_start, header_start},
                "part count limit reached; this part is scanned but not delivered");
    }
  } else {
    child.info.index = stats.parts++;
  }
  child.info.depth = parent.info.depth + 1;
  child.header_start = header_start;
  child.body_start = header_start;
  child.at_line_start = true;
  child.suppress = suppress;
  stack.push_back(std::move(child));
}

bool MimeParser::Impl::process_headers(std::size_t index) {
  Context& context = stack[index];
  const std::size_t size = available();
  const u8* data = input_data();
  const std::uint64_t absolute = absolute_position();

  std::optional<HeaderTerminator> terminator =
      find_header_terminator(data, size);
  std::size_t content_end = 0;
  std::size_t block_end = 0;

  if (terminator.has_value()) {
    content_end = terminator->content_end;
    block_end = terminator->end;
  } else if (finish_requested) {
    content_end = size;
    block_end = size;
  } else if (limits.max_header_bytes != 0 &&
             size > limits.max_header_bytes) {
    if (!context.header_overflow) {
      add_error(context, ErrorCode::header_limit,
                {context.header_start,
                 context.header_start +
                     static_cast<std::uint64_t>(limits.max_header_bytes)},
                "header block exceeds the configured limit");
      context.header_overflow = true;
      context.header_skipped = true;
    }
    constexpr std::size_t keep = 3;
    if (size > keep) consume(size - keep);
    return true;
  } else {
    return false;
  }

  if (limits.max_header_bytes != 0 && content_end > limits.max_header_bytes &&
      !context.header_overflow) {
    add_error(context, ErrorCode::header_limit,
              {absolute, absolute + static_cast<std::uint64_t>(limits.max_header_bytes)},
              "header block exceeds the configured limit");
    context.header_overflow = true;
  }

  if (!context.header_skipped) {
    parse_header_block(context, data, content_end, absolute);
  }

  consume(block_end);
  context.body_start = absolute_position();
  configure_context(context);
  emit_begin(context);
  return true;
}

bool MimeParser::Impl::process_multipart(std::size_t index) {
  Context& context = stack[index];
  const std::size_t size = available();
  const u8* data = input_data();
  const std::uint64_t absolute = absolute_position();

  const BoundaryHit hit =
      find_boundary(data, size, context.boundary, context.at_line_start,
                    finish_requested);

  if (hit.found) {
    consume(hit.after_marker);
    if (hit.closing) {
      finish_context(index, absolute + static_cast<std::uint64_t>(hit.break_start));
      return true;
    }
    context.at_line_start = true;
    create_child(context, absolute + static_cast<std::uint64_t>(hit.after_marker));
    return true;
  }

  if (finish_requested) {
    add_error(context, ErrorCode::unexpected_eof,
              {context.body_start, absolute + static_cast<std::uint64_t>(size)},
              "multipart body ended without a closing boundary");
    finish_context(index, absolute + static_cast<std::uint64_t>(size));
    return true;
  }

  std::size_t safe = size;
  if (hit.need_more_from != npos) safe = std::min(safe, hit.need_more_from);
  const std::size_t keep = context.boundary.size() + 8;
  if (size > keep) {
    safe = std::min(safe, size - keep);
  } else {
    safe = 0;
  }
  if (safe == 0) return false;

  const u8 last = data[safe - 1];
  consume(safe);
  context.at_line_start = last == '\n';
  return true;
}

bool MimeParser::Impl::process_body(std::size_t index) {
  Context& context = stack[index];
  const std::size_t size = available();
  const u8* data = input_data();
  const std::uint64_t absolute = absolute_position();

  std::string_view boundary;
  if (index > 0) {
    const Context& parent = stack[index - 1];
    if (parent.is_multipart && !parent.deny_multipart &&
        !parent.boundary.empty()) {
      boundary = parent.boundary;
    }
  }

  if (boundary.empty()) {
    if (size != 0) {
      decode(context, data, size, absolute);
      consume(size);
      return true;
    }
    if (finish_requested) {
      finish_context(index, absolute);
      return true;
    }
    return false;
  }

  const BoundaryHit hit =
      find_boundary(data, size, boundary, context.at_line_start,
                    finish_requested);

  if (hit.found) {
    const std::size_t body_size = hit.break_start;
    decode(context, data, body_size, absolute);
    consume(hit.line_start);
    if (index > 0) stack[index - 1].at_line_start = true;
    finish_context(index, absolute + static_cast<std::uint64_t>(body_size));
    return true;
  }

  if (finish_requested) {
    if (size != 0) {
      decode(context, data, size, absolute);
      consume(size);
    }
    finish_context(index, absolute + static_cast<std::uint64_t>(size));
    return true;
  }

  std::size_t safe = size;
  if (hit.need_more_from != npos) safe = std::min(safe, hit.need_more_from);
  const std::size_t keep = boundary.size() + 8;
  if (size > keep) {
    safe = std::min(safe, size - keep);
  } else {
    safe = 0;
  }
  if (safe == 0) return false;

  decode(context, data, safe, absolute);
  const u8 last = data[safe - 1];
  consume(safe);
  context.at_line_start = last == '\n';
  return true;
}

void MimeParser::Impl::finish_context(std::size_t index,
                                      std::uint64_t body_end) {
  Context& context = stack[index];
  if (body_end < context.body_start) body_end = context.body_start;

  if (!context.emitted_begin) emit_begin(context);
  flush_decoder(context, body_end);
  context.info.body_range = {context.body_start, body_end};
  context.info.truncated = context.truncated;

  if (context.truncated) stats.truncated = true;
  if (context.has_decoder) {
    stats.encoded_body_bytes += body_end - context.body_start;
  }
  if (sink != nullptr && !context.suppress) sink->on_part_end(context.info);

  context.state = State::done;
  stack.pop_back();
}

void MimeParser::Impl::pump() {
  while (!stack.empty()) {
    const std::size_t index = stack.size() - 1;
    bool progress = false;
    switch (stack[index].state) {
      case State::headers:
        progress = process_headers(index);
        break;
      case State::multipart:
        progress = process_multipart(index);
        break;
      case State::body:
        progress = process_body(index);
        break;
      case State::done:
        stack.pop_back();
        progress = true;
        break;
    }
    if (!progress) break;
    compact();
  }
  compact();
}

void MimeParser::Impl::feed(std::string_view bytes) {
  if (message_ended) {
    throw std::logic_error("dataeng::MimeParser::feed called after finish()");
  }
  if (bytes.empty()) {
    pump();
    return;
  }

  const std::uint64_t already = stats.input_bytes;
  const std::uint64_t incoming = static_cast<std::uint64_t>(bytes.size());
  std::uint64_t accepted = incoming;
  if (limits.max_message_bytes != 0 && already + incoming > limits.max_message_bytes) {
    accepted = limits.max_message_bytes > already ? limits.max_message_bytes - already : 0;
    stats.input_limit_hit = true;
    stats.truncated = true;
    const ByteRange range = {already + accepted, already + incoming};
    if (!stack.empty() && !stack.back().suppress) {
      add_error(stack.back(), ErrorCode::message_size_limit, range,
                "message byte limit reached; trailing input was ignored");
    } else {
      PartError error;
      error.code = ErrorCode::message_size_limit;
      error.message = "message byte limit reached; trailing input was ignored";
      error.range = range;
      message_errors.push_back(std::move(error));
      ++stats.errors;
    }
  }
  stats.input_bytes += incoming;

  if (stack.empty()) return;  // epilogue after the root part has completed
  buffer.insert(buffer.end(), bytes.begin(),
                bytes.begin() + static_cast<std::ptrdiff_t>(accepted));
  pump();
}

void MimeParser::Impl::finish() {
  if (message_ended) return;
  finish_requested = true;
  pump();

  // A well-formed finish always drains the stack.  Keep a small guard for
  // defensive recovery in case a future state fails to make progress.
  std::size_t guard = stack.size() + 8;
  while (!stack.empty() && guard-- > 0) {
    const std::size_t index = stack.size() - 1;
    switch (stack[index].state) {
      case State::headers:
        (void)process_headers(index);
        break;
      case State::multipart:
        (void)process_multipart(index);
        break;
      case State::body:
        (void)process_body(index);
        break;
      case State::done:
        stack.pop_back();
        break;
    }
  }
  while (!stack.empty()) finish_context(stack.size() - 1, absolute_position() + available());

  message_ended = true;
  MessageResult result;
  result.completed = true;
  result.stats = stats;
  if (sink != nullptr) sink->on_message_end(result);
}

const char* to_string(TransferEncoding value) noexcept {
  switch (value) {
    case TransferEncoding::seven_bit:
      return "7bit";
    case TransferEncoding::eight_bit:
      return "8bit";
    case TransferEncoding::binary:
      return "binary";
    case TransferEncoding::base64:
      return "base64";
    case TransferEncoding::quoted_printable:
      return "quoted-printable";
    case TransferEncoding::unknown:
      return "unknown";
  }
  return "unknown";
}

const char* to_string(PartKind value) noexcept {
  switch (value) {
    case PartKind::root:
      return "root";
    case PartKind::multipart:
      return "multipart";
    case PartKind::text:
      return "text";
    case PartKind::attachment:
      return "attachment";
    case PartKind::message:
      return "message";
    case PartKind::other:
      return "other";
  }
  return "other";
}

const char* to_string(ErrorCode value) noexcept {
  switch (value) {
    case ErrorCode::none:
      return "none";
    case ErrorCode::malformed_header:
      return "malformed_header";
    case ErrorCode::header_limit:
      return "header_limit";
    case ErrorCode::missing_boundary:
      return "missing_boundary";
    case ErrorCode::invalid_boundary:
      return "invalid_boundary";
    case ErrorCode::nesting_too_deep:
      return "nesting_too_deep";
    case ErrorCode::too_many_parts:
      return "too_many_parts";
    case ErrorCode::unsupported_transfer_encoding:
      return "unsupported_transfer_encoding";
    case ErrorCode::invalid_base64:
      return "invalid_base64";
    case ErrorCode::truncated_base64:
      return "truncated_base64";
    case ErrorCode::data_after_base64_padding:
      return "data_after_base64_padding";
    case ErrorCode::invalid_quoted_printable:
      return "invalid_quoted_printable";
    case ErrorCode::truncated_quoted_printable:
      return "truncated_quoted_printable";
    case ErrorCode::decoded_size_limit:
      return "decoded_size_limit";
    case ErrorCode::total_size_limit:
      return "total_size_limit";
    case ErrorCode::expansion_limit:
      return "expansion_limit";
    case ErrorCode::message_size_limit:
      return "message_size_limit";
    case ErrorCode::unexpected_eof:
      return "unexpected_eof";
  }
  return "unknown";
}

CallbackSink::CallbackSink(Callbacks callbacks) : callbacks_(std::move(callbacks)) {}

void CallbackSink::on_part_begin(const PartInfo& part) {
  if (callbacks_.on_part_begin) callbacks_.on_part_begin(part);
}

void CallbackSink::on_part_data(const PartInfo& part,
                                std::span<const std::uint8_t> data) {
  if (callbacks_.on_part_data) callbacks_.on_part_data(part, data);
}

void CallbackSink::on_part_end(const PartInfo& part) {
  if (callbacks_.on_part_end) callbacks_.on_part_end(part);
}

void CallbackSink::on_part_error(const PartInfo& part, const PartError& error) {
  if (callbacks_.on_part_error) callbacks_.on_part_error(part, error);
}

void CallbackSink::on_message_end(const MessageResult& result) {
  if (callbacks_.on_message_end) callbacks_.on_message_end(result);
}

MimeParser::MimeParser(Limits limits) : impl_(std::make_unique<Impl>(limits)) {}

MimeParser::MimeParser(Sink& sink, Limits limits) : impl_(std::make_unique<Impl>(limits)) {
  impl_->sink = &sink;
}

MimeParser::~MimeParser() = default;

MimeParser::MimeParser(MimeParser&&) noexcept = default;
MimeParser& MimeParser::operator=(MimeParser&&) noexcept = default;

void MimeParser::set_sink(Sink* sink) noexcept { impl_->sink = sink; }

Sink* MimeParser::sink() const noexcept { return impl_->sink; }

void MimeParser::reset(Limits limits) {
  if (limits.max_parts == 0) limits.max_parts = 1;
  impl_->limits = limits;
  impl_->reset();
}

void MimeParser::feed(std::string_view bytes) { impl_->feed(bytes); }

void MimeParser::feed(const void* data, std::size_t size) {
  if (size == 0) {
    impl_->feed(std::string_view());
    return;
  }
  if (data == nullptr) throw std::invalid_argument("dataeng::MimeParser::feed null data");
  impl_->feed(std::string_view(static_cast<const char*>(data), size));
}

void MimeParser::feed(std::span<const std::uint8_t> bytes) {
  if (bytes.empty()) {
    impl_->feed(std::string_view());
    return;
  }
  impl_->feed(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}

void MimeParser::finish() { impl_->finish(); }

bool MimeParser::finished() const noexcept { return impl_->message_ended; }

const ParseStats& MimeParser::stats() const noexcept { return impl_->stats; }

const Limits& MimeParser::limits() const noexcept { return impl_->limits; }

const HeaderField* find_header(const std::vector<HeaderField>& headers,
                               std::string_view name) noexcept {
  for (const HeaderField& header : headers) {
    if (iequals(header.name, name)) return &header;
  }
  return nullptr;
}

const HeaderField* find_header(const PartInfo& part,
                               std::string_view name) noexcept {
  return find_header(part.headers, name);
}

namespace {

class Collector final : public Sink {
 public:
  void on_part_begin(const PartInfo& part) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].info = part;
  }

  void on_part_data(const PartInfo& part,
                    std::span<const std::uint8_t> data) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].data.append(reinterpret_cast<const char*>(data.data()),
                                  data.size());
  }

  void on_part_end(const PartInfo& part) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].info = part;
  }

  std::vector<CollectedPart> parts;
};

}  // namespace

CollectedMessage collect(std::string_view message, Limits limits) {
  Collector collector;
  MimeParser parser(collector, limits);
  parser.feed(message);
  parser.finish();

  CollectedMessage result;
  result.completed = parser.finished();
  result.stats = parser.stats();
  result.parts = std::move(collector.parts);
  return result;
}

CollectedMessage parse_message(std::string_view message, Limits limits) {
  return collect(message, limits);
}

}  // namespace dataeng
