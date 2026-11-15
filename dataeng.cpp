#include "dataeng.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <dlfcn.h>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

namespace dataeng {

namespace {

using Bytes = std::span<const std::uint8_t>;

struct ParseError {
  ErrorCode code;
  std::string message;
};

[[noreturn]] void fail(ErrorCode code, std::string message) {
  throw ParseError{code, std::move(message)};
}

std::string hex_dump(Bytes data, std::size_t limit = 32) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  const std::size_t n = std::min(data.size(), limit);
  out.reserve(n * 2);
  for (std::size_t i = 0; i < n; ++i) {
    out.push_back(kHex[data[i] >> 4]);
    out.push_back(kHex[data[i] & 0x0f]);
  }
  if (data.size() > n) out += "...";
  return out;
}

class Reader {
 public:
  explicit Reader(Bytes data) : begin_(data.data()), cur_(data.data()), end_(data.data() + data.size()) {}

  bool empty() const noexcept { return cur_ == end_; }
  std::size_t remaining() const noexcept { return static_cast<std::size_t>(end_ - cur_); }
  std::size_t consumed() const noexcept { return static_cast<std::size_t>(cur_ - begin_); }
  const std::uint8_t* cursor() const noexcept { return cur_; }

  void require(std::size_t n) const {
    if (remaining() < n) {
      fail(ErrorCode::TruncatedEvent, "unexpected end of event payload");
    }
  }

  std::uint8_t u8() {
    require(1);
    return *cur_++;
  }

  std::uint16_t u16le() {
    require(2);
    const std::uint16_t v = static_cast<std::uint16_t>(cur_[0]) |
                            static_cast<std::uint16_t>(cur_[1] << 8);
    cur_ += 2;
    return v;
  }

  std::uint32_t u24le() {
    require(3);
    const std::uint32_t v = static_cast<std::uint32_t>(cur_[0]) |
                            (static_cast<std::uint32_t>(cur_[1]) << 8) |
                            (static_cast<std::uint32_t>(cur_[2]) << 16);
    cur_ += 3;
    return v;
  }

  std::uint32_t u32le() {
    require(4);
    const std::uint32_t v = static_cast<std::uint32_t>(cur_[0]) |
                            (static_cast<std::uint32_t>(cur_[1]) << 8) |
                            (static_cast<std::uint32_t>(cur_[2]) << 16) |
                            (static_cast<std::uint32_t>(cur_[3]) << 24);
    cur_ += 4;
    return v;
  }

  std::uint64_t u48le() {
    require(6);
    std::uint64_t v = 0;
    for (int i = 0; i < 6; ++i) v |= static_cast<std::uint64_t>(cur_[i]) << (8 * i);
    cur_ += 6;
    return v;
  }

  std::uint64_t u64le() {
    require(8);
    std::uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<std::uint64_t>(cur_[i]) << (8 * i);
    cur_ += 8;
    return v;
  }

  std::uint64_t ule(std::size_t n) {
    if (n > 8) fail(ErrorCode::InvalidArgument, "integer width is too large");
    require(n);
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < n; ++i) v |= static_cast<std::uint64_t>(cur_[i]) << (8 * i);
    cur_ += n;
    return v;
  }

  std::int64_t sle(std::size_t n) {
    const std::uint64_t raw = ule(n);
    if (n == 0) return 0;
    const std::size_t bits = n * 8;
    if (bits == 64) return static_cast<std::int64_t>(raw);
    const std::uint64_t sign = std::uint64_t{1} << (bits - 1);
    if (raw & sign) {
      return static_cast<std::int64_t>(raw | (~std::uint64_t{0} << bits));
    }
    return static_cast<std::int64_t>(raw);
  }

  std::uint16_t u16be() {
    require(2);
    const std::uint16_t v = static_cast<std::uint16_t>(cur_[0] << 8) |
                            static_cast<std::uint16_t>(cur_[1]);
    cur_ += 2;
    return v;
  }

  std::uint32_t u24be() {
    require(3);
    const std::uint32_t v = (static_cast<std::uint32_t>(cur_[0]) << 16) |
                            (static_cast<std::uint32_t>(cur_[1]) << 8) |
                            static_cast<std::uint32_t>(cur_[2]);
    cur_ += 3;
    return v;
  }

  std::uint32_t u32be() {
    require(4);
    const std::uint32_t v = (static_cast<std::uint32_t>(cur_[0]) << 24) |
                            (static_cast<std::uint32_t>(cur_[1]) << 16) |
                            (static_cast<std::uint32_t>(cur_[2]) << 8) |
                            static_cast<std::uint32_t>(cur_[3]);
    cur_ += 4;
    return v;
  }

  std::uint64_t ube(std::size_t n) {
    if (n > 8) fail(ErrorCode::InvalidArgument, "integer width is too large");
    require(n);
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < n; ++i) v = (v << 8) | cur_[i];
    cur_ += n;
    return v;
  }

  Bytes bytes(std::size_t n) {
    require(n);
    const std::uint8_t* p = cur_;
    cur_ += n;
    return Bytes(p, n);
  }

  void skip(std::size_t n) {
    require(n);
    cur_ += n;
  }

  std::string string(std::size_t n) {
    const Bytes b = bytes(n);
    return std::string(reinterpret_cast<const char*>(b.data()), b.size());
  }

  std::uint64_t lenenc() {
    const std::uint8_t first = u8();
    if (first < 0xfb) return first;
    if (first == 0xfb) fail(ErrorCode::InvalidArgument, "NULL length-encoded integer");
    if (first == 0xfc) return ule(2);
    if (first == 0xfd) return ule(3);
    if (first == 0xfe) return ule(8);
    fail(ErrorCode::MalformedRowEvent, "invalid length-encoded integer marker 0xff");
  }

 private:
  const std::uint8_t* begin_;
  const std::uint8_t* cur_;
  const std::uint8_t* end_;
};

std::uint32_t crc32_ieee(Bytes data) noexcept {
  static const auto table = [] {
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t i = 0; i < 256; ++i) {
      std::uint32_t c = i;
      for (int k = 0; k < 8; ++k) c = (c & 1u) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
      t[i] = c;
    }
    return t;
  }();
  std::uint32_t crc = 0xffffffffu;
  for (std::uint8_t b : data) crc = table[(crc ^ b) & 0xffu] ^ (crc >> 8);
  return crc ^ 0xffffffffu;
}

EventHeader parse_header(Bytes raw) {
  if (raw.size() < kEventHeaderSize) {
    fail(ErrorCode::TruncatedEvent, "binlog event is shorter than the 19-byte header");
  }
  Reader r(raw);
  EventHeader h;
  h.timestamp = r.u32le();
  h.type = static_cast<EventType>(r.u8());
  h.server_id = r.u32le();
  h.event_size = r.u32le();
  h.log_pos = r.u32le();
  h.flags = r.u16le();
  if (h.event_size < kEventHeaderSize) {
    fail(ErrorCode::InvalidEventSize, "event_size is smaller than the event header");
  }
  if (h.event_size > raw.size()) {
    fail(ErrorCode::TruncatedEvent, "event_size exceeds available bytes");
  }
  return h;
}

bool starts_with_ci(std::string_view text, std::string_view prefix) {
  if (text.size() < prefix.size()) return false;
  for (std::size_t i = 0; i < prefix.size(); ++i) {
    const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(text[i])));
    const char b = static_cast<char>(std::tolower(static_cast<unsigned char>(prefix[i])));
    if (a != b) return false;
  }
  return true;
}

std::string first_keyword(std::string_view query) {
  std::size_t i = 0;
  while (i < query.size() && std::isspace(static_cast<unsigned char>(query[i]))) ++i;
  std::size_t start = i;
  while (i < query.size() &&
         (std::isalnum(static_cast<unsigned char>(query[i])) || query[i] == '_')) {
    ++i;
  }
  std::string keyword(query.substr(start, i - start));
  for (char& c : keyword) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return keyword;
}

std::string trim(std::string_view text) {
  std::size_t begin = 0;
  std::size_t end = text.size();
  while (begin < end && std::isspace(static_cast<unsigned char>(text[begin]))) ++begin;
  while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1]))) --end;
  return std::string(text.substr(begin, end - begin));
}

bool is_ddl_keyword(std::string_view keyword) {
  return keyword == "CREATE" || keyword == "ALTER" || keyword == "DROP" ||
         keyword == "TRUNCATE" || keyword == "RENAME";
}

std::string uuid_to_string(Bytes sid) {
  if (sid.size() != 16) return {};
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(36);
  for (std::size_t i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out.push_back('-');
    out.push_back(kHex[sid[i] >> 4]);
    out.push_back(kHex[sid[i] & 0x0f]);
  }
  return out;
}

std::string format_date(int year, int month, int day) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d", year, month, day);
  return buf;
}

std::string format_time(bool negative, int hour, int minute, int second,
                        std::uint32_t micros, std::uint32_t precision) {
  if (precision > 6) precision = 6;
  char buf[64];
  if (precision == 0) {
    std::snprintf(buf, sizeof(buf), "%s%02d:%02d:%02d", negative ? "-" : "", hour,
                  minute, second);
  } else {
    std::uint32_t divisor = 1;
    for (std::uint32_t i = precision; i < 6; ++i) divisor *= 10;
    std::snprintf(buf, sizeof(buf), "%s%02d:%02d:%02d.%0*u", negative ? "-" : "", hour,
                  minute, second, static_cast<int>(precision), micros / divisor);
    return buf;
  }
  return buf;
}

std::string format_datetime(int year, int month, int day, int hour, int minute,
                            int second, std::uint32_t micros, std::uint32_t precision) {
  std::string out = format_date(year, month, day) + " " +
                    format_time(false, hour, minute, second, micros, precision);
  return out;
}

std::string format_timestamp(std::uint64_t seconds, std::uint32_t micros,
                             std::uint32_t precision) {
  const std::time_t t = static_cast<std::time_t>(seconds);
  std::tm tmv{};
#if defined(_WIN32)
  gmtime_s(&tmv, &t);
#else
  gmtime_r(&t, &tmv);
#endif
  return format_datetime(tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday, tmv.tm_hour,
                         tmv.tm_min, tmv.tm_sec, micros, precision);
}

std::uint32_t fractional_micros(std::uint64_t raw, std::uint32_t precision) {
  if (precision == 0) return 0;
  std::uint32_t value = static_cast<std::uint32_t>(raw);
  for (std::uint32_t i = precision; i < 6; ++i) value *= 10;
  return value;
}

std::size_t fractional_storage_bytes(std::uint32_t precision) {
  if (precision == 0) return 0;
  if (precision > 6) precision = 6;
  return (precision + 1) / 2;
}

int decimal_bin_size(int digits) {
  static constexpr int kSize[] = {0, 1, 1, 2, 2, 3, 3, 4, 4, 4};
  if (digits < 0 || digits > 9) return 0;
  return kSize[digits];
}

std::uint32_t read_be_group(const std::vector<std::uint8_t>& data, std::size_t& offset,
                            int nbytes) {
  std::uint32_t value = 0;
  for (int i = 0; i < nbytes; ++i) value = (value << 8) | data[offset++];
  return value;
}

std::string decode_decimal(Reader& r, int precision, int scale) {
  if (precision <= 0 || precision > 65 || scale < 0 || scale > precision) {
    fail(ErrorCode::InvalidColumnMetadata, "invalid DECIMAL precision/scale");
  }
  const int intg = precision - scale;
  const int intg0 = intg / 9;
  const int intg1 = intg % 9;
  const int frac0 = scale / 9;
  const int frac1 = scale % 9;
  const int intg1_size = decimal_bin_size(intg1);
  const int frac1_size = decimal_bin_size(frac1);
  const std::size_t total = static_cast<std::size_t>(intg0) * 4 + intg1_size +
                            static_cast<std::size_t>(frac0) * 4 + frac1_size;
  const Bytes raw = r.bytes(total);
  std::vector<std::uint8_t> data(raw.begin(), raw.end());

  const bool positive = (data[0] & 0x80u) != 0;
  if (positive) {
    data[0] &= 0x7fu;
  } else {
    for (auto& b : data) b = static_cast<std::uint8_t>(~b);
    int carry = 1;
    for (std::size_t i = data.size(); i-- > 0 && carry != 0;) {
      const int v = static_cast<int>(data[i]) + carry;
      data[i] = static_cast<std::uint8_t>(v & 0xff);
      carry = v >> 8;
    }
    data[0] &= 0x7fu;
  }

  std::size_t offset = 0;
  std::string int_part;
  bool first = true;
  auto append_group = [&](std::uint32_t value, int digits, bool pad) {
    std::string s = std::to_string(value);
    if (pad) {
      if (s.size() < static_cast<std::size_t>(digits)) {
        s.insert(0, static_cast<std::size_t>(digits) - s.size(), '0');
      }
    }
    int_part += s;
    first = false;
  };

  if (intg1 > 0) {
    append_group(read_be_group(data, offset, intg1_size), intg1, false);
  }
  for (int i = 0; i < intg0; ++i) {
    append_group(read_be_group(data, offset, 4), 9, !first);
  }
  if (int_part.empty()) int_part = "0";

  std::string frac_part;
  for (int i = 0; i < frac0; ++i) {
    std::string s = std::to_string(read_be_group(data, offset, 4));
    if (s.size() < 9) s.insert(0, 9 - s.size(), '0');
    frac_part += s;
  }
  if (frac1 > 0) {
    std::string s = std::to_string(read_be_group(data, offset, frac1_size));
    if (s.size() < static_cast<std::size_t>(frac1)) {
      s.insert(0, static_cast<std::size_t>(frac1) - s.size(), '0');
    }
    frac_part += s;
  }

  std::string out;
  if (!positive) out.push_back('-');
  out += int_part;
  if (scale > 0) {
    out.push_back('.');
    if (frac_part.size() < static_cast<std::size_t>(scale)) {
      frac_part.insert(0, static_cast<std::size_t>(scale) - frac_part.size(), '0');
    }
    out += frac_part;
  }
  return out;
}

void decode_string_metadata(ColumnDefinition& col) {
  const std::uint8_t low = static_cast<std::uint8_t>(col.metadata & 0xffu);
  const std::uint8_t high = static_cast<std::uint8_t>((col.metadata >> 8) & 0xffu);
  col.real_type = static_cast<std::uint8_t>(ColumnType::String);
  col.max_length = col.metadata;
  if (high != 0) {
    col.real_type = low;
    col.max_length = 255;
  }
  if (col.real_type == static_cast<std::uint8_t>(ColumnType::Enum)) {
    col.length_bytes = 1;
    if (high != 0 && low != 0) {
      // Some MySQL versions encode ENUM/SET as STRING with the real type in
      // the low byte.  The value pack width is not in that word; two bytes is
      // the safe choice for large enums.
      col.length_bytes = 2;
    }
  } else if (col.real_type == static_cast<std::uint8_t>(ColumnType::Set)) {
    col.length_bytes = 1;
    if (high != 0 && low != 0) col.length_bytes = 8;
  } else {
    col.length_bytes = col.max_length > 255 ? 2 : 1;
  }
}

ColumnDefinition parse_column_metadata(std::uint8_t type, Reader& meta) {
  ColumnDefinition col;
  col.type = type;
  col.real_type = type;

  switch (static_cast<ColumnType>(type)) {
    case ColumnType::Float:
    case ColumnType::Double:
      col.length_bytes = meta.u8();
      break;
    case ColumnType::VarChar:
    case ColumnType::VarString: {
      col.metadata = meta.u16le();
      col.max_length = col.metadata;
      col.length_bytes = col.max_length > 255 ? 2 : 1;
      break;
    }
    case ColumnType::String: {
      col.metadata = meta.u16le();
      decode_string_metadata(col);
      break;
    }
    case ColumnType::NewDecimal:
    case ColumnType::Decimal: {
      col.precision = meta.u8();
      col.scale = meta.u8();
      if (col.precision == 0 || col.precision > 65 || col.scale > col.precision) {
        fail(ErrorCode::InvalidColumnMetadata,
             "invalid DECIMAL precision/scale in table map");
      }
      break;
    }
    case ColumnType::Bit: {
      col.metadata = meta.u16le();
      col.max_length = static_cast<std::uint16_t>(((col.metadata >> 8) * 8) +
                                                  (col.metadata & 0xffu));
      col.length_bytes = static_cast<std::uint8_t>((col.max_length + 7) / 8);
      break;
    }
    case ColumnType::Blob:
    case ColumnType::TinyBlob:
    case ColumnType::MediumBlob:
    case ColumnType::LongBlob:
    case ColumnType::Json:
    case ColumnType::Geometry:
      col.length_bytes = meta.u8();
      break;
    case ColumnType::Enum:
    case ColumnType::Set: {
      col.metadata = meta.u16le();
      const std::uint16_t pack = col.metadata == 0 ? 1 : col.metadata;
      col.length_bytes = static_cast<std::uint8_t>(std::min<std::uint16_t>(pack, 8));
      break;
    }
    case ColumnType::Time2:
    case ColumnType::DateTime2:
    case ColumnType::Timestamp2: {
      const std::uint8_t precision = meta.u8();
      if (precision > 6) {
        fail(ErrorCode::InvalidColumnMetadata,
             "fractional-seconds precision must be between 0 and 6");
      }
      col.fractional_precision = precision;
      break;
    }
    default:
      break;
  }
  return col;
}

Cell decode_value(Reader& r, const ColumnDefinition& col) {
  const auto type = static_cast<ColumnType>(col.real_type ? col.real_type : col.type);
  const bool is_unsigned = col.is_unsigned;

  switch (type) {
    case ColumnType::Tiny: {
      if (is_unsigned) return Cell::from_unsigned(r.u8());
      return Cell::from_signed(static_cast<std::int8_t>(r.u8()));
    }
    case ColumnType::Short: {
      if (is_unsigned) return Cell::from_unsigned(r.u16le());
      return Cell::from_signed(static_cast<std::int16_t>(r.u16le()));
    }
    case ColumnType::Int24: {
      const std::uint32_t raw = r.u24le();
      if (is_unsigned) return Cell::from_unsigned(raw);
      std::uint32_t v = raw;
      if (v & 0x800000u) v |= 0xff000000u;
      return Cell::from_signed(static_cast<std::int32_t>(v));
    }
    case ColumnType::Long: {
      const std::uint32_t raw = r.u32le();
      if (is_unsigned) return Cell::from_unsigned(raw);
      return Cell::from_signed(static_cast<std::int32_t>(raw));
    }
    case ColumnType::LongLong: {
      const std::uint64_t raw = r.u64le();
      if (is_unsigned) return Cell::from_unsigned(raw);
      return Cell::from_signed(static_cast<std::int64_t>(raw));
    }
    case ColumnType::Float: {
      const std::uint32_t raw = r.u32le();
      return Cell::from_real(static_cast<double>(std::bit_cast<float>(raw)));
    }
    case ColumnType::Double: {
      const std::uint64_t raw = r.u64le();
      return Cell::from_real(std::bit_cast<double>(raw));
    }
    case ColumnType::NewDecimal:
      return Cell::from_decimal(decode_decimal(r, col.precision, col.scale), col.scale);
    case ColumnType::Date:
    case ColumnType::NewDate: {
      const std::uint32_t value = r.u24le();
      const int day = static_cast<int>(value & 0x1fu);
      const int month = static_cast<int>((value >> 5) & 0x0fu);
      const int year = static_cast<int>(value >> 9);
      return Cell::from_date(format_date(year, month, day));
    }
    case ColumnType::Time: {
      std::uint32_t raw = r.u24le();
      if (raw & 0x800000u) raw |= 0xff000000u;
      const std::int64_t value = static_cast<std::int32_t>(raw);
      const bool negative = value < 0;
      std::int64_t v = negative ? -value : value;
      const int hour = static_cast<int>(v / 10000);
      const int minute = static_cast<int>((v / 100) % 100);
      const int second = static_cast<int>(v % 100);
      return Cell::from_time(format_time(negative, hour, minute, second, 0, 0));
    }
    case ColumnType::DateTime: {
      const std::uint64_t value = r.u64le();
      const int year = static_cast<int>(value / 10000000000ull);
      const int month = static_cast<int>((value / 100000000ull) % 100);
      const int day = static_cast<int>((value / 1000000ull) % 100);
      const int hour = static_cast<int>((value / 10000ull) % 100);
      const int minute = static_cast<int>((value / 100ull) % 100);
      const int second = static_cast<int>(value % 100);
      return Cell::from_datetime(format_datetime(year, month, day, hour, minute, second,
                                                 0, 0));
    }
    case ColumnType::Timestamp: {
      const std::uint32_t seconds = r.u32le();
      return Cell::from_timestamp(seconds, 0, 0);
    }
    case ColumnType::Year: {
      const std::uint8_t value = r.u8();
      return Cell::from_signed(value == 0 ? 0 : 1900 + value);
    }
    case ColumnType::Timestamp2: {
      const std::uint32_t seconds = r.u32be();
      const std::uint32_t precision = col.fractional_precision;
      std::uint32_t micros = 0;
      if (precision > 0) {
        const std::size_t n = fractional_storage_bytes(precision);
        micros = fractional_micros(r.ube(n), precision);
      }
      return Cell::from_timestamp(seconds, micros, precision);
    }
    case ColumnType::DateTime2: {
      const std::uint64_t packed = r.ube(5);
      std::int64_t value = static_cast<std::int64_t>(packed) - 0x8000000000ll;
      const int year = static_cast<int>((value >> 22) / 13);
      const int month = static_cast<int>((value >> 22) % 13);
      const int day = static_cast<int>((value >> 17) & 0x1f);
      const int hour = static_cast<int>((value >> 12) & 0x1f);
      const int minute = static_cast<int>((value >> 6) & 0x3f);
      const int second = static_cast<int>(value & 0x3f);
      const std::uint32_t precision = col.fractional_precision;
      std::uint32_t micros = 0;
      if (precision > 0) {
        const std::size_t n = fractional_storage_bytes(precision);
        micros = fractional_micros(r.ube(n), precision);
      }
      return Cell::from_datetime(
          format_datetime(year, month, day, hour, minute, second, micros, precision),
          precision);
    }
    case ColumnType::Time2: {
      const std::uint32_t packed = r.u24be();
      std::int64_t value = static_cast<std::int64_t>(packed) - 0x800000;
      const bool negative = value < 0;
      if (negative) value = -value;
      const int hour = static_cast<int>(value >> 12);
      const int minute = static_cast<int>((value >> 6) & 0x3f);
      const int second = static_cast<int>(value & 0x3f);
      const std::uint32_t precision = col.fractional_precision;
      std::uint32_t micros = 0;
      if (precision > 0) {
        const std::size_t n = fractional_storage_bytes(precision);
        micros = fractional_micros(r.ube(n), precision);
      }
      return Cell::from_time(format_time(negative, hour, minute, second, micros, precision),
                             precision);
    }
    case ColumnType::VarChar:
    case ColumnType::VarString:
    case ColumnType::String: {
      const std::size_t width = col.length_bytes == 0 ? 1 : col.length_bytes;
      const std::uint64_t len = r.ule(width);
      return Cell::from_string(r.string(static_cast<std::size_t>(len)));
    }
    case ColumnType::Blob:
    case ColumnType::TinyBlob:
    case ColumnType::MediumBlob:
    case ColumnType::LongBlob: {
      const std::size_t width = col.length_bytes == 0 ? 1 : col.length_bytes;
      const std::uint64_t len = r.ule(width);
      const Bytes b = r.bytes(static_cast<std::size_t>(len));
      return Cell::from_bytes(std::vector<std::uint8_t>(b.begin(), b.end()));
    }
    case ColumnType::Json: {
      const std::size_t width = col.length_bytes == 0 ? 4 : col.length_bytes;
      const std::uint64_t len = r.ule(width);
      const Bytes b = r.bytes(static_cast<std::size_t>(len));
      return Cell::from_json(std::vector<std::uint8_t>(b.begin(), b.end()));
    }
    case ColumnType::Geometry: {
      const std::size_t width = col.length_bytes == 0 ? 4 : col.length_bytes;
      const std::uint64_t len = r.ule(width);
      const Bytes b = r.bytes(static_cast<std::size_t>(len));
      return Cell::from_geometry(std::vector<std::uint8_t>(b.begin(), b.end()));
    }
    case ColumnType::Bit: {
      const std::size_t width = col.length_bytes == 0
                                    ? static_cast<std::size_t>((col.max_length + 7) / 8)
                                    : col.length_bytes;
      const Bytes b = r.bytes(width);
      return Cell::from_bit(std::vector<std::uint8_t>(b.begin(), b.end()), col.max_length);
    }
    case ColumnType::Enum: {
      const std::size_t width = col.length_bytes == 0 ? 1 : col.length_bytes;
      const std::uint64_t index = r.ule(width);
      return Cell::from_enum(std::to_string(index), index);
    }
    case ColumnType::Set: {
      const std::size_t width = col.length_bytes == 0 ? 1 : col.length_bytes;
      const std::uint64_t mask = r.ule(width);
      return Cell::from_set(std::to_string(mask), mask);
    }
    case ColumnType::Null:
      return Cell::null();
    case ColumnType::Decimal:
      fail(ErrorCode::UnknownColumnType, "legacy DECIMAL row format is not supported");
    default:
      fail(ErrorCode::UnknownColumnType,
           "unsupported column type " + std::to_string(col.type));
  }
}

std::string read_lenenc_string(Reader& r) {
  const std::uint64_t len = r.lenenc();
  return r.string(static_cast<std::size_t>(len));
}

struct OptionalMetadataResult {
  bool complete = false;
};

OptionalMetadataResult parse_optional_metadata(Reader& r, TableMap& map) {
  OptionalMetadataResult result;
  const std::size_t count = map.columns.size();
  while (!r.empty()) {
    std::size_t before = r.consumed();
    try {
      const std::uint8_t field_type = r.u8();
      const std::uint64_t length = r.lenenc();
      Reader value(r.bytes(static_cast<std::size_t>(length)));
      switch (field_type) {
        case 1: {  // SIGNEDNESS
          if (length == count) {
            for (std::size_t i = 0; i < count; ++i) {
              map.columns[i].is_unsigned = value.u8() != 0;
            }
          } else {
            const std::size_t bytes = (count + 7) / 8;
            for (std::size_t i = 0; i < bytes && !value.empty(); ++i) {
              const std::uint8_t bits = value.u8();
              for (std::size_t bit = 0; bit < 8 && i * 8 + bit < count; ++bit) {
                map.columns[i * 8 + bit].is_unsigned = (bits & (1u << bit)) != 0;
              }
            }
          }
          break;
        }
        case 4: {  // COLUMN_NAME
          for (std::size_t i = 0; i < count && !value.empty(); ++i) {
            map.columns[i].name = read_lenenc_string(value);
          }
          break;
        }
        case 8: {  // SIMPLE_PRIMARY_KEY
          while (!value.empty()) {
            const std::uint64_t index = value.lenenc();
            if (index < count) map.columns[static_cast<std::size_t>(index)].is_primary_key = true;
          }
          break;
        }
        case 9: {  // PRIMARY_KEY_WITH_PREFIX
          while (!value.empty()) {
            const std::uint64_t index = value.lenenc();
            (void)value.lenenc();  // prefix length
            if (index < count) map.columns[static_cast<std::size_t>(index)].is_primary_key = true;
          }
          break;
        }
        case 11: {  // COLUMN_VISIBILITY
          (void)value;
          break;
        }
        default:
          break;
      }
      (void)before;
      result.complete = true;
    } catch (const ParseError&) {
      result.complete = false;
      break;
    }
  }
  return result;
}

}  // namespace

const char* event_type_name(EventType type) noexcept {
  switch (type) {
    case EventType::Unknown: return "Unknown";
    case EventType::StartEventV3: return "StartEventV3";
    case EventType::Query: return "Query";
    case EventType::Stop: return "Stop";
    case EventType::Rotate: return "Rotate";
    case EventType::Intvar: return "Intvar";
    case EventType::Load: return "Load";
    case EventType::Slave: return "Slave";
    case EventType::CreateFile: return "CreateFile";
    case EventType::AppendBlock: return "AppendBlock";
    case EventType::ExecLoad: return "ExecLoad";
    case EventType::DeleteFile: return "DeleteFile";
    case EventType::NewLoad: return "NewLoad";
    case EventType::Rand: return "Rand";
    case EventType::UserVar: return "UserVar";
    case EventType::FormatDescription: return "FormatDescription";
    case EventType::Xid: return "Xid";
    case EventType::BeginLoadQuery: return "BeginLoadQuery";
    case EventType::ExecuteLoadQuery: return "ExecuteLoadQuery";
    case EventType::TableMap: return "TableMap";
    case EventType::WriteRowsV0: return "WriteRowsV0";
    case EventType::UpdateRowsV0: return "UpdateRowsV0";
    case EventType::DeleteRowsV0: return "DeleteRowsV0";
    case EventType::WriteRowsV1: return "WriteRowsV1";
    case EventType::UpdateRowsV1: return "UpdateRowsV1";
    case EventType::DeleteRowsV1: return "DeleteRowsV1";
    case EventType::Incident: return "Incident";
    case EventType::Heartbeat: return "Heartbeat";
    case EventType::Ignorable: return "Ignorable";
    case EventType::RowsQuery: return "RowsQuery";
    case EventType::WriteRowsV2: return "WriteRowsV2";
    case EventType::UpdateRowsV2: return "UpdateRowsV2";
    case EventType::DeleteRowsV2: return "DeleteRowsV2";
    case EventType::Gtid: return "Gtid";
    case EventType::AnonymousGtid: return "AnonymousGtid";
    case EventType::PreviousGtids: return "PreviousGtids";
    case EventType::TransactionContext: return "TransactionContext";
    case EventType::ViewChange: return "ViewChange";
    case EventType::XaPrepare: return "XaPrepare";
    case EventType::PartialUpdateRows: return "PartialUpdateRows";
    case EventType::TransactionPayload: return "TransactionPayload";
    case EventType::HeartbeatV2: return "HeartbeatV2";
    case EventType::RowsQueryV2: return "RowsQueryV2";
  }
  return "Unknown";
}

bool is_write_rows_event(EventType type) noexcept {
  return type == EventType::WriteRowsV0 || type == EventType::WriteRowsV1 ||
         type == EventType::WriteRowsV2;
}

bool is_update_rows_event(EventType type) noexcept {
  return type == EventType::UpdateRowsV0 || type == EventType::UpdateRowsV1 ||
         type == EventType::UpdateRowsV2 ||
         type == EventType::PartialUpdateRows;
}

bool is_delete_rows_event(EventType type) noexcept {
  return type == EventType::DeleteRowsV0 || type == EventType::DeleteRowsV1 ||
         type == EventType::DeleteRowsV2;
}

bool is_row_event(EventType type) noexcept {
  return is_write_rows_event(type) || is_update_rows_event(type) ||
         is_delete_rows_event(type);
}

std::string BinlogPosition::to_string() const {
  if (file.empty()) return std::to_string(offset);
  return file + ":" + std::to_string(offset);
}

std::uint32_t binlog_crc32(std::span<const std::uint8_t> data) noexcept {
  return crc32_ieee(data);
}

std::string TableMap::qualified_name() const {
  if (database.empty()) return table;
  return database + "." + table;
}

Cell Cell::unknown() {
  Cell c;
  c.kind = Kind::Unknown;
  return c;
}

Cell Cell::null() {
  Cell c;
  c.kind = Kind::Null;
  return c;
}

Cell Cell::from_signed(std::int64_t value) {
  Cell c;
  c.kind = Kind::Signed;
  c.signed_value = value;
  c.text = std::to_string(value);
  return c;
}

Cell Cell::from_unsigned(std::uint64_t value) {
  Cell c;
  c.kind = Kind::Unsigned;
  c.unsigned_value = value;
  c.text = std::to_string(value);
  return c;
}

Cell Cell::from_real(double value) {
  Cell c;
  c.kind = Kind::Real;
  c.real_value = value;
  std::ostringstream ss;
  ss.precision(std::numeric_limits<double>::max_digits10);
  ss << value;
  c.text = ss.str();
  return c;
}

Cell Cell::from_decimal(std::string value, std::uint8_t scale) {
  Cell c;
  c.kind = Kind::Decimal;
  c.text = std::move(value);
  c.fractional_precision = scale;
  return c;
}

Cell Cell::from_string(std::string value) {
  Cell c;
  c.kind = Kind::String;
  c.text = std::move(value);
  return c;
}

Cell Cell::from_bytes(std::vector<std::uint8_t> value) {
  Cell c;
  c.kind = Kind::Bytes;
  c.bytes = std::move(value);
  c.text = hex_dump(c.bytes);
  return c;
}

Cell Cell::from_bit(std::vector<std::uint8_t> value, std::uint32_t bits) {
  Cell c;
  c.kind = Kind::Bit;
  c.bytes = std::move(value);
  std::uint64_t numeric = 0;
  for (std::uint8_t byte : c.bytes) {
    if (numeric <= (std::numeric_limits<std::uint64_t>::max() >> 8)) numeric = (numeric << 8) | byte;
  }
  c.unsigned_value = numeric;
  (void)bits;
  c.text = hex_dump(c.bytes);
  return c;
}

Cell Cell::from_date(std::string value) {
  Cell c;
  c.kind = Kind::Date;
  c.text = std::move(value);
  return c;
}

Cell Cell::from_time(std::string value, std::uint32_t fractional_precision) {
  Cell c;
  c.kind = Kind::Time;
  c.text = std::move(value);
  c.fractional_precision = fractional_precision;
  return c;
}

Cell Cell::from_datetime(std::string value, std::uint32_t fractional_precision) {
  Cell c;
  c.kind = Kind::DateTime;
  c.text = std::move(value);
  c.fractional_precision = fractional_precision;
  return c;
}

Cell Cell::from_timestamp(std::uint64_t seconds, std::uint32_t fractional_precision) {
  return from_timestamp(seconds, 0, fractional_precision);
}

Cell Cell::from_timestamp(std::uint64_t seconds, std::uint32_t micros,
                          std::uint32_t fractional_precision) {
  Cell c;
  c.kind = Kind::Timestamp;
  c.unsigned_value = seconds;
  c.fractional_precision = fractional_precision;
  c.text = format_timestamp(seconds, micros, fractional_precision);
  return c;
}

Cell Cell::from_enum(std::string value, std::uint64_t index) {
  Cell c;
  c.kind = Kind::Enum;
  c.text = std::move(value);
  c.unsigned_value = index;
  return c;
}

Cell Cell::from_set(std::string value, std::uint64_t mask) {
  Cell c;
  c.kind = Kind::Set;
  c.text = std::move(value);
  c.unsigned_value = mask;
  return c;
}

Cell Cell::from_json(std::vector<std::uint8_t> value) {
  Cell c;
  c.kind = Kind::Json;
  c.bytes = std::move(value);
  c.text = hex_dump(c.bytes);
  return c;
}

Cell Cell::from_geometry(std::vector<std::uint8_t> value) {
  Cell c;
  c.kind = Kind::Geometry;
  c.bytes = std::move(value);
  c.text = hex_dump(c.bytes);
  return c;
}

namespace {

std::optional<double> parse_number(const std::string& text) {
  if (text.empty()) return std::nullopt;
  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);
  if (end == text.c_str() || *end != '\0') return std::nullopt;
  return value;
}

}  // namespace

std::int64_t Cell::as_signed() const {
  switch (kind) {
    case Kind::Signed: return signed_value;
    case Kind::Unsigned: return static_cast<std::int64_t>(unsigned_value);
    case Kind::Real: return static_cast<std::int64_t>(real_value);
    case Kind::Decimal:
    case Kind::Enum:
    case Kind::Set:
    case Kind::String: {
      if (auto n = parse_number(text)) return static_cast<std::int64_t>(*n);
      return 0;
    }
    case Kind::Timestamp: return static_cast<std::int64_t>(unsigned_value);
    case Kind::Bit: return static_cast<std::int64_t>(unsigned_value);
    default: return 0;
  }
}

std::uint64_t Cell::as_unsigned() const {
  switch (kind) {
    case Kind::Signed: return static_cast<std::uint64_t>(signed_value);
    case Kind::Unsigned:
    case Kind::Enum:
    case Kind::Set:
    case Kind::Timestamp:
    case Kind::Bit:
      return unsigned_value;
    case Kind::Real: return static_cast<std::uint64_t>(real_value);
    case Kind::Decimal:
    case Kind::String: {
      if (auto n = parse_number(text)) return static_cast<std::uint64_t>(*n);
      return 0;
    }
    default: return 0;
  }
}

double Cell::as_double() const {
  switch (kind) {
    case Kind::Signed: return static_cast<double>(signed_value);
    case Kind::Unsigned:
    case Kind::Enum:
    case Kind::Set:
    case Kind::Bit:
    case Kind::Timestamp:
      return static_cast<double>(unsigned_value);
    case Kind::Real: return real_value;
    case Kind::Decimal:
    case Kind::String: return parse_number(text).value_or(0.0);
    default: return 0.0;
  }
}

const std::string& Cell::as_string() const { return text; }

std::string Cell::to_string() const {
  switch (kind) {
    case Kind::Unknown: return "unknown";
    case Kind::Null: return "null";
    case Kind::Bytes:
    case Kind::Json:
    case Kind::Geometry:
      return hex_dump(bytes);
    default:
      return text;
  }
}

bool RowImage::is_complete() const noexcept {
  if (columns.empty()) return false;
  if (present.size() != columns.size()) return false;
  return std::all_of(present.begin(), present.end(), [](bool b) { return b; });
}

std::size_t RowImage::missing_count() const noexcept {
  std::size_t count = 0;
  for (std::size_t i = 0; i < columns.size(); ++i) {
    if (i >= present.size() || !present[i]) ++count;
  }
  return count;
}

std::size_t RowImage::unknown_count() const noexcept {
  return static_cast<std::size_t>(
      std::count_if(columns.begin(), columns.end(),
                    [](const Cell& c) { return c.is_unknown(); }));
}

const Cell& RowImage::at(std::size_t index) const {
  if (index >= columns.size()) throw std::out_of_range("row image column index");
  return columns[index];
}

const RowImage& RowChange::primary_image() const noexcept {
  if (kind == Kind::Delete) return before;
  return after;
}

bool RowChange::is_minimal() const noexcept {
  if (kind == Kind::Update) {
    return !before.is_complete() || !after.is_complete();
  }
  return !primary_image().is_complete();
}

std::string RowChange::to_string() const {
  const char* kind_name = kind == Kind::Insert ? "insert"
                          : kind == Kind::Update ? "update"
                                                 : "delete";
  std::ostringstream ss;
  ss << kind_name << " " << table.qualified_name() << "#" << table.table_id << "/"
     << table.generation;
  if (kind != Kind::Delete) {
    ss << " after=[";
    for (std::size_t i = 0; i < after.columns.size(); ++i) {
      if (i) ss << ",";
      ss << after.columns[i].to_string();
    }
    ss << "]";
  }
  if (kind != Kind::Insert) {
    ss << " before=[";
    for (std::size_t i = 0; i < before.columns.size(); ++i) {
      if (i) ss << ",";
      ss << before.columns[i].to_string();
    }
    ss << "]";
  }
  return ss.str();
}

std::string Gtid::to_string() const {
  if (is_anonymous) return "anonymous:" + std::to_string(gno);
  if (sid.empty()) return std::to_string(gno);
  return sid + ":" + std::to_string(gno);
}

std::string Transaction::to_string() const {
  std::ostringstream ss;
  ss << "transaction{";
  if (has_gtid) ss << "gtid=" << gtid.to_string() << ",";
  ss << "changes=" << changes.size() << ",statements=" << statements.size();
  if (xid) ss << ",xid=" << *xid;
  ss << ",commit=" << commit_position.to_string() << "}";
  return ss.str();
}

const char* error_code_name(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::None: return "None";
    case ErrorCode::TruncatedEvent: return "TruncatedEvent";
    case ErrorCode::InvalidEventSize: return "InvalidEventSize";
    case ErrorCode::InvalidHeader: return "InvalidHeader";
    case ErrorCode::InvalidArgument: return "InvalidArgument";
    case ErrorCode::UnsupportedEvent: return "UnsupportedEvent";
    case ErrorCode::ChecksumMismatch: return "ChecksumMismatch";
    case ErrorCode::FormatDescriptionMissing: return "FormatDescriptionMissing";
    case ErrorCode::MalformedFormatDescription: return "MalformedFormatDescription";
    case ErrorCode::MalformedTableMap: return "MalformedTableMap";
    case ErrorCode::InvalidColumnMetadata: return "InvalidColumnMetadata";
    case ErrorCode::UnknownColumnType: return "UnknownColumnType";
    case ErrorCode::UnknownTableId: return "UnknownTableId";
    case ErrorCode::StaleTableMap: return "StaleTableMap";
    case ErrorCode::ColumnCountMismatch: return "ColumnCountMismatch";
    case ErrorCode::MalformedRowEvent: return "MalformedRowEvent";
    case ErrorCode::RowDataTruncated: return "RowDataTruncated";
    case ErrorCode::MalformedGtid: return "MalformedGtid";
    case ErrorCode::MalformedQuery: return "MalformedQuery";
    case ErrorCode::MalformedXid: return "MalformedXid";
    case ErrorCode::MalformedTransactionPayload: return "MalformedTransactionPayload";
    case ErrorCode::UnsupportedCompression: return "UnsupportedCompression";
    case ErrorCode::DecompressionFailed: return "DecompressionFailed";
    case ErrorCode::NonMonotonicPosition: return "NonMonotonicPosition";
    case ErrorCode::TransactionNotTerminated: return "TransactionNotTerminated";
    case ErrorCode::StreamPoisoned: return "StreamPoisoned";
    case ErrorCode::TrailingBytes: return "TrailingBytes";
  }
  return "Unknown";
}

std::string DecodeError::to_string() const {
  std::string out = std::string(error_code_name(code)) + " at " + position.to_string();
  if (!message.empty()) out += ": " + message;
  return out;
}

namespace {

ChecksumAlgorithm detect_fde_checksum(Bytes raw) noexcept {
  if (raw.size() < kEventHeaderSize + 5) return ChecksumAlgorithm::Off;
  const std::size_t payload_size = raw.size() - kEventHeaderSize;
  const std::uint8_t* payload = raw.data() + kEventHeaderSize;
  // With CRC32 the fifth-to-last payload byte is the algorithm descriptor (1).
  if (payload[payload_size - 5] == 1) return ChecksumAlgorithm::Crc32;
  // Without a checksum the descriptor is the final byte and is 0 in modern
  // format-description events.
  if (payload[payload_size - 1] == 0) return ChecksumAlgorithm::Off;
  if (payload[payload_size - 1] == 1) return ChecksumAlgorithm::Crc32;
  return ChecksumAlgorithm::Off;
}

bool bit_set(Bytes bitmap, std::size_t index) noexcept {
  const std::size_t byte = index / 8;
  if (byte >= bitmap.size()) return false;
  return (bitmap[byte] & (1u << (index % 8))) != 0;
}

std::size_t bit_count(Bytes bitmap, std::size_t columns) noexcept {
  std::size_t count = 0;
  for (std::size_t i = 0; i < columns; ++i) {
    if (bit_set(bitmap, i)) ++count;
  }
  return count;
}

bool all_zero(Bytes data) noexcept {
  return std::all_of(data.begin(), data.end(), [](std::uint8_t b) { return b == 0; });
}

std::string strip_nul(std::string value) {
  const auto pos = value.find('\0');
  if (pos != std::string::npos) value.resize(pos);
  return value;
}

struct ZstdApi {
  void* handle = nullptr;
  std::size_t (*decompress)(void*, std::size_t, const void*, std::size_t) = nullptr;
  unsigned (*is_error)(std::size_t) = nullptr;
  const char* (*error_name)(std::size_t) = nullptr;
};

const ZstdApi& zstd_api() {
  static const ZstdApi api = [] {
    ZstdApi result;
    result.handle = dlopen("libzstd.so.1", RTLD_LAZY | RTLD_LOCAL);
    if (!result.handle) result.handle = dlopen("libzstd.so", RTLD_LAZY | RTLD_LOCAL);
    if (!result.handle) return result;
    result.decompress = reinterpret_cast<std::size_t (*)(void*, std::size_t, const void*,
                                                         std::size_t)>(
        dlsym(result.handle, "ZSTD_decompress"));
    result.is_error = reinterpret_cast<unsigned (*)(std::size_t)>(
        dlsym(result.handle, "ZSTD_isError"));
    result.error_name = reinterpret_cast<const char* (*)(std::size_t)>(
        dlsym(result.handle, "ZSTD_getErrorName"));
    return result;
  }();
  return api;
}

std::vector<std::uint8_t> zstd_decompress(Bytes compressed, std::size_t output_size) {
  const ZstdApi& api = zstd_api();
  if (!api.handle || !api.decompress || !api.is_error) {
    fail(ErrorCode::UnsupportedCompression,
         "TRANSACTION_PAYLOAD uses ZSTD but libzstd is not available");
  }
  if (output_size == 0) fail(ErrorCode::DecompressionFailed, "invalid uncompressed size 0");
  std::vector<std::uint8_t> output(output_size);
  const std::size_t result =
      api.decompress(output.data(), output.size(), compressed.data(), compressed.size());
  if (api.is_error(result)) {
    std::string message = "ZSTD decompression failed";
    if (api.error_name) message += std::string(": ") + api.error_name(result);
    fail(ErrorCode::DecompressionFailed, std::move(message));
  }
  if (result != output_size) {
    output.resize(result);
  }
  return output;
}

struct TableMapState {
  std::vector<TableMap> maps;  // chronological; back() is current
};

struct ParsedQuery {
  std::uint32_t thread_id = 0;
  std::uint32_t exec_time = 0;
  std::uint16_t error_code = 0;
  std::string database;
  std::string query;
};

}  // namespace

struct BinlogAssembler::Impl {
  explicit Impl(AssemblerOptions options) : opt(std::move(options)) {
    auto_checksum = opt.checksum == ChecksumAlgorithm::Auto;
    checksum = auto_checksum ? ChecksumAlgorithm::Off : opt.checksum;
  }

  AssemblerOptions opt;
  ChecksumAlgorithm checksum = ChecksumAlgorithm::Off;
  bool auto_checksum = true;
  bool checksum_known = false;
  bool fde_seen = false;
  std::string file;
  std::string server_version;
  std::uint8_t fde_header_length = kEventHeaderSize;
  BinlogPosition last_pos;
  BinlogPosition checkpoint;
  bool has_last_pos = false;
  std::uint64_t stream_offset = 0;

  std::unordered_map<std::uint64_t, TableMapState> tables;
  std::unordered_map<std::uint64_t, std::uint64_t> generation_floor;

  std::optional<Transaction> active;
  bool active_has_begin = false;
  bool active_poisoned = false;
  bool poisoned = false;
  bool payload_commit_pending = false;
  bool in_payload = false;
  std::optional<DecodeError> last_error;
  std::vector<Transaction> completed;
  AssemblerStats stats;

  std::optional<DecodeError> current_error_position;

  void clear_stream_state() {
    file.clear();
    server_version.clear();
    fde_header_length = kEventHeaderSize;
    last_pos = {};
    checkpoint = {};
    has_last_pos = false;
    stream_offset = 0;
    auto_checksum = opt.checksum == ChecksumAlgorithm::Auto;
    checksum = auto_checksum ? ChecksumAlgorithm::Off : opt.checksum;
    checksum_known = false;
    fde_seen = false;
    tables.clear();
    generation_floor.clear();
    active.reset();
    active_has_begin = false;
    active_poisoned = false;
    poisoned = false;
    payload_commit_pending = false;
    in_payload = false;
    last_error.reset();
    completed.clear();
    stats = {};
    current_error_position.reset();
  }

  void switch_file(const std::string& next_file) {
    if (next_file.empty() || next_file == file) return;
    if (active && !active->empty()) {
      fail(ErrorCode::TransactionNotTerminated,
           "binlog file changed while a transaction was open");
    }
    active.reset();
    active_has_begin = false;
    active_poisoned = false;
    file = next_file;
    tables.clear();
    stream_offset = 0;
    has_last_pos = false;
    last_pos = BinlogPosition{file, 0};
    checkpoint = BinlogPosition{file, 0};
    payload_commit_pending = false;
  }

  BinlogPosition make_position(const EventHeader& header, const BinlogPosition* nested) const {
    if (nested) return *nested;
    BinlogPosition pos;
    pos.file = file;
    pos.offset = header.log_pos != 0 ? header.log_pos : stream_offset + header.event_size;
    return pos;
  }

  ChecksumAlgorithm effective_checksum(Bytes raw, EventType type) {
    if (type == EventType::FormatDescription && auto_checksum) {
      ChecksumAlgorithm detected = detect_fde_checksum(raw);
      checksum = detected;
      auto_checksum = false;
      checksum_known = true;
      return detected;
    }
    if (auto_checksum && type != EventType::FormatDescription && raw.size() >= 4) {
      // Some synthetic streams start mid-file without a format-description
      // event.  A matching trailing CRC32 is a safe, 1-in-2^32 heuristic.
      const std::uint32_t trailing = static_cast<std::uint32_t>(raw[raw.size() - 4]) |
                                     (static_cast<std::uint32_t>(raw[raw.size() - 3]) << 8) |
                                     (static_cast<std::uint32_t>(raw[raw.size() - 2]) << 16) |
                                     (static_cast<std::uint32_t>(raw[raw.size() - 1]) << 24);
      if (trailing == crc32_ieee(raw.first(raw.size() - 4))) {
        checksum = ChecksumAlgorithm::Crc32;
        auto_checksum = false;
        checksum_known = true;
        return ChecksumAlgorithm::Crc32;
      }
    }
    return checksum;
  }

  void verify_checksum(Bytes raw, ChecksumAlgorithm algorithm, const BinlogPosition& pos,
                       EventType type) {
    if (algorithm != ChecksumAlgorithm::Crc32) return;
    if (raw.size() < 4) {
      fail(ErrorCode::InvalidEventSize, "CRC32 event is shorter than its checksum");
    }
    Reader tail(raw.subspan(raw.size() - 4));
    const std::uint32_t expected = tail.u32le();
    const std::uint32_t actual = crc32_ieee(raw.first(raw.size() - 4));
    if (expected != actual) {
      fail(ErrorCode::ChecksumMismatch,
           "CRC32 mismatch at " + pos.to_string() + " (" + std::string(event_type_name(type)) +
               "): expected " + std::to_string(expected) + ", got " +
               std::to_string(actual));
    }
  }

  TableMap parse_table_map(Bytes payload, const EventHeader& header,
                           const BinlogPosition& pos) {
    Reader r(payload);
    TableMap map;
    map.table_id = r.u48le();
    if (map.table_id == 0) fail(ErrorCode::MalformedTableMap, "table id 0 is invalid");
    map.flags = r.u16le();
    const std::uint8_t db_len = r.u8();
    map.database = r.string(db_len);
    const std::uint8_t table_len = r.u8();
    map.table = r.string(table_len);
    const std::uint64_t column_count = r.lenenc();
    if (column_count == 0 || column_count > 10000) {
      fail(ErrorCode::MalformedTableMap, "invalid table-map column count");
    }
    std::vector<std::uint8_t> types(static_cast<std::size_t>(column_count));
    for (auto& type : types) type = r.u8();
    const std::uint64_t metadata_length = r.lenenc();
    const Bytes metadata = r.bytes(static_cast<std::size_t>(metadata_length));
    Reader mr(metadata);
    map.columns.reserve(static_cast<std::size_t>(column_count));
    for (std::size_t i = 0; i < types.size(); ++i) {
      try {
        map.columns.push_back(parse_column_metadata(types[i], mr));
      } catch (const ParseError& e) {
        throw ParseError{e.code, std::string("column ") + std::to_string(i) + ": " + e.message};
      }
    }
    if (!mr.empty()) {
      fail(ErrorCode::InvalidColumnMetadata,
           "table-map metadata has " + std::to_string(mr.remaining()) +
               " unconsumed byte(s)");
    }
    const std::size_t bitmap_length = (static_cast<std::size_t>(column_count) + 7) / 8;
    const Bytes null_bitmap = r.bytes(bitmap_length);
    for (std::size_t i = 0; i < map.columns.size(); ++i) {
      map.columns[i].nullable = bit_set(null_bitmap, i);
    }
    if (!r.empty()) {
      OptionalMetadataResult result = parse_optional_metadata(r, map);
      map.has_optional_metadata = result.complete;
    }
    map.server_id = header.server_id;
    map.position = pos;
    return map;
  }

  void install_table_map(TableMap map) {
    auto it = tables.find(map.table_id);
    if (it != tables.end() && !it->second.maps.empty()) {
      const TableMap& previous = it->second.maps.back();
      if (!map.position.file.empty() && !previous.position.file.empty() &&
          map.position.file == previous.position.file && map.position.offset != 0 &&
          previous.position.offset != 0 && map.position.offset < previous.position.offset) {
        fail(ErrorCode::StaleTableMap,
             "TABLE_MAP_EVENT moved backwards for table id " +
                 std::to_string(map.table_id));
      }
    }

    std::uint64_t generation = generation_floor[map.table_id] + 1;
    if (it != tables.end() && !it->second.maps.empty()) {
      generation = std::max(generation, it->second.maps.back().generation + 1);
    }
    generation_floor[map.table_id] = generation;
    map.generation = generation;

    TableMapState& state = tables[map.table_id];
    if (!opt.keep_table_map_history) state.maps.clear();
    state.maps.push_back(std::move(map));
    if (state.maps.size() > std::max<std::size_t>(opt.max_table_map_history, 1)) {
      state.maps.erase(state.maps.begin(),
                       state.maps.begin() +
                           static_cast<std::ptrdiff_t>(state.maps.size() -
                                                       std::max<std::size_t>(
                                                           opt.max_table_map_history, 1)));
    }
    ++stats.table_maps;
  }

  const TableMap* table_map_at(std::uint64_t table_id, const BinlogPosition& pos) const {
    auto it = tables.find(table_id);
    if (it == tables.end() || it->second.maps.empty()) return nullptr;
    const auto& maps = it->second.maps;
    if (pos.offset == 0) return &maps.back();
    for (auto map = maps.rbegin(); map != maps.rend(); ++map) {
      if (!pos.file.empty() && !map->position.file.empty() && pos.file != map->position.file) {
        continue;
      }
      if (map->position.offset != 0 && pos.offset < map->position.offset) continue;
      return &*map;
    }
    return nullptr;
  }

  const TableMap& require_table_map(std::uint64_t table_id, const BinlogPosition& pos) {
    if (const TableMap* map = table_map_at(table_id, pos)) return *map;
    auto it = tables.find(table_id);
    if (it != tables.end() && !it->second.maps.empty()) {
      const TableMap& latest = it->second.maps.back();
      if (latest.position.offset != 0 && pos.offset != 0 &&
          latest.position.offset > pos.offset &&
          (pos.file.empty() || latest.position.file.empty() || pos.file == latest.position.file)) {
        fail(ErrorCode::StaleTableMap,
             "row event precedes the TABLE_MAP_EVENT for table id " +
                 std::to_string(table_id));
      }
    }
    if (!opt.require_table_map) {
      // Relaxed mode: accept the most recent binding even if its position is
      // newer than the row event (useful for synthetic streams).  Values still
      // require typed table-map columns, so a completely unknown id is fatal.
      auto relaxed = tables.find(table_id);
      if (relaxed != tables.end() && !relaxed->second.maps.empty()) {
        return relaxed->second.maps.back();
      }
    }
    fail(ErrorCode::UnknownTableId,
         "no TABLE_MAP_EVENT for table id " + std::to_string(table_id));
  }

  RowImage decode_image(Reader& r, std::size_t column_count, Bytes present_bitmap,
                        const TableMap& map) {
    const std::size_t present_columns = bit_count(present_bitmap, column_count);
    const std::size_t null_bytes = (present_columns + 7) / 8;
    const Bytes null_bitmap = r.bytes(null_bytes);

    RowImage image;
    image.columns.assign(column_count, Cell::unknown());
    image.present.assign(column_count, false);

    std::size_t ordinal = 0;
    try {
      for (std::size_t i = 0; i < column_count; ++i) {
        if (!bit_set(present_bitmap, i)) continue;
        image.present[i] = true;
        const bool is_null = bit_set(null_bitmap, ordinal);
        ++ordinal;
        if (is_null) {
          image.columns[i] = Cell::null();
        } else {
          image.columns[i] = decode_value(r, map.columns[i]);
        }
      }
    } catch (const ParseError& e) {
      if (e.code == ErrorCode::TruncatedEvent) {
        throw ParseError{ErrorCode::RowDataTruncated,
                         "row image ended before all present columns were decoded"};
      }
      throw;
    }
    return image;
  }

  void append_change(RowChange change) {
    if (!active) {
      active.emplace();
      active->begin_position = change.position;
      active->server_id = change.server_id;
    }
    if (active->database.empty()) active->database = change.table.database;
    if (in_payload) active->from_transaction_payload = true;
    active->changes.push_back(std::move(change));
    ++active->event_count;
    ++stats.rows;
  }

  void handle_rows(Bytes payload, const EventHeader& header, const BinlogPosition& pos) {
    Reader r(payload);
    const EventType type = header.type;
    if (type == EventType::PartialUpdateRows) {
      fail(ErrorCode::UnsupportedEvent,
           "PARTIAL_UPDATE_ROWS_EVENT partial-JSON semantics are not supported");
    }
    const bool v0 = type == EventType::WriteRowsV0 || type == EventType::UpdateRowsV0 ||
                    type == EventType::DeleteRowsV0;
    const bool v2 = type == EventType::WriteRowsV2 || type == EventType::UpdateRowsV2 ||
                    type == EventType::DeleteRowsV2 ||
                    type == EventType::PartialUpdateRows;
    const std::uint64_t table_id = v0 ? r.u32le() : r.u48le();
    (void)r.u16le();  // flags
    if (v2) {
      const std::uint16_t extra_length = r.u16le();
      r.skip(extra_length);
    }
    const std::uint64_t column_count = r.lenenc();
    if (column_count == 0 || column_count > 10000) {
      fail(ErrorCode::MalformedRowEvent, "invalid row-event column count");
    }
    const std::size_t bitmap_bytes = (static_cast<std::size_t>(column_count) + 7) / 8;
    const Bytes first_bitmap = r.bytes(bitmap_bytes);
    Bytes second_bitmap;
    const bool is_update = is_update_rows_event(type);
    if (is_update) second_bitmap = r.bytes(bitmap_bytes);

    const TableMap& map = require_table_map(table_id, pos);
    if (map.columns.size() != column_count) {
      fail(ErrorCode::ColumnCountMismatch,
           "row event has " + std::to_string(column_count) +
               " columns but table map has " + std::to_string(map.columns.size()));
    }

    RowChange::Kind kind = RowChange::Kind::Insert;
    if (is_update) {
      kind = RowChange::Kind::Update;
    } else if (is_delete_rows_event(type)) {
      kind = RowChange::Kind::Delete;
    }

    std::size_t rows_in_event = 0;
    while (!r.empty()) {
      const std::size_t consumed_before = r.consumed();
      RowChange change;
      change.kind = kind;
      change.table = map;
      change.position = pos;
      change.server_id = header.server_id;
      if (kind == RowChange::Kind::Insert) {
        change.after = decode_image(r, static_cast<std::size_t>(column_count), first_bitmap, map);
        change.before.columns.assign(static_cast<std::size_t>(column_count), Cell::unknown());
        change.before.present.assign(static_cast<std::size_t>(column_count), false);
      } else if (kind == RowChange::Kind::Delete) {
        change.before = decode_image(r, static_cast<std::size_t>(column_count), first_bitmap, map);
        change.after.columns.assign(static_cast<std::size_t>(column_count), Cell::unknown());
        change.after.present.assign(static_cast<std::size_t>(column_count), false);
      } else {
        change.before = decode_image(r, static_cast<std::size_t>(column_count), first_bitmap, map);
        change.after =
            decode_image(r, static_cast<std::size_t>(column_count), second_bitmap, map);
      }
      if (r.consumed() == consumed_before) {
        fail(ErrorCode::MalformedRowEvent,
             "row image consumed no bytes (present bitmap may be empty)");
      }
      append_change(std::move(change));
      ++rows_in_event;
    }
    if (rows_in_event == 0) {
      // An empty row event is legal (for example, after filtering) but it is
      // still counted as a row event for diagnostics.
    }
    ++stats.row_events;
  }

  Gtid parse_gtid(Bytes payload, EventType type) {
    Reader r(payload);
    Gtid gtid;
    gtid.is_anonymous = type == EventType::AnonymousGtid;
    (void)r.u8();  // flags
    const Bytes sid = r.bytes(16);
    gtid.sid = uuid_to_string(sid);
    gtid.gno = r.u64le();
    if (gtid.is_anonymous && all_zero(sid)) {
      // Keep an explicit marker but avoid pretending the zero UUID is a real
      // server UUID.
      gtid.sid.clear();
    }
    if (!r.empty()) {
      const std::uint8_t logical_type = r.u8();
      if (logical_type == 2) {
        gtid.has_logical_timestamps = true;
        gtid.last_committed = r.u64le();
        gtid.sequence_number = r.u64le();
        if (r.remaining() >= 14) {
          gtid.immediate_commit_timestamp = static_cast<std::int64_t>(r.ube(7));
          gtid.original_commit_timestamp = static_cast<std::int64_t>(r.ube(7));
        }
        if (r.remaining() >= 16) {
          // MySQL 8.0 writes transaction_length as a fixed 64-bit value,
          // followed by immediate/original server versions.
          gtid.transaction_length = r.u64le();
          r.skip(8);
        } else if (!r.empty()) {
          try {
            gtid.transaction_length = r.lenenc();
          } catch (const ParseError&) {
            // Older 8.0 events can end directly after the timestamps.
          }
        }
      }
    }
    return gtid;
  }

  void handle_gtid(const Gtid& gtid, const EventHeader& header, const BinlogPosition& pos,
                   bool nested) {
    (void)nested;
    if (active) {
      const bool same_gtid = active->has_gtid && active->gtid.sid == gtid.sid &&
                             active->gtid.gno == gtid.gno;
      if (same_gtid) return;  // duplicate GTID inside a transaction payload
      if (!active->empty()) {
        fail(ErrorCode::TransactionNotTerminated,
             "new GTID arrived before the previous transaction was committed");
      }
      active->gtid = gtid;
      active->has_gtid = true;
      if (active->begin_position.empty()) active->begin_position = pos;
    } else {
      active.emplace();
      active->gtid = gtid;
      active->has_gtid = true;
      active->begin_position = pos;
    }
    active->server_id = header.server_id;
    if (in_payload) active->from_transaction_payload = true;
    ++active->event_count;
  }

  ParsedQuery parse_query(Bytes payload) {
    Reader r(payload);
    ParsedQuery q;
    q.thread_id = r.u32le();
    q.exec_time = r.u32le();
    const std::uint8_t db_len = r.u8();
    q.error_code = r.u16le();
    const std::uint16_t status_len = r.u16le();
    r.skip(status_len);
    q.database = r.string(db_len);
    q.query = strip_nul(r.string(r.remaining()));
    return q;
  }

  void emit_statement(const Statement& statement, const BinlogPosition& pos,
                      const EventHeader& header) {
    if (!opt.emit_statement_transactions) return;
    Transaction txn;
    txn.statements.push_back(statement);
    txn.begin_position = pos;
    txn.commit_position = pos;
    txn.server_id = header.server_id;
    txn.is_ddl = statement.is_ddl;
    txn.event_count = 1;
    ++stats.transactions;
    completed.push_back(std::move(txn));
  }

  void handle_query(Bytes payload, const EventHeader& header, const BinlogPosition& pos) {
    ParsedQuery q = parse_query(payload);
    const std::string sql = trim(q.query);
    const std::string keyword = first_keyword(sql);
    const bool begin = keyword == "BEGIN" || starts_with_ci(sql, "START TRANSACTION") ||
                       starts_with_ci(sql, "XA START");
    const bool commit = keyword == "COMMIT" || starts_with_ci(sql, "XA COMMIT");
    const bool rollback_to_savepoint = starts_with_ci(sql, "ROLLBACK TO") ||
                                       starts_with_ci(sql, "ROLLBACK WORK TO");
    const bool rollback = (keyword == "ROLLBACK" && !rollback_to_savepoint) ||
                          starts_with_ci(sql, "XA ROLLBACK");
    const bool ddl = is_ddl_keyword(keyword);

    if (begin) {
      if (!active) {
        active.emplace();
        active->begin_position = pos;
        active->server_id = header.server_id;
        active_has_begin = true;
      } else if (!active->empty()) {
        fail(ErrorCode::TransactionNotTerminated, "BEGIN inside an open transaction");
      } else {
        active_has_begin = true;
      }
      if (!q.database.empty()) active->database = q.database;
      ++active->event_count;
      return;
    }

    if (commit) {
      if (active) {
        commit_active(pos, std::nullopt, in_payload);
      } else if (payload_commit_pending) {
        payload_commit_pending = false;
        if (!completed.empty() && completed.back().from_transaction_payload) {
          completed.back().commit_position = pos;
        }
        if (!poisoned && !active_poisoned) checkpoint = pos;
      } else {
        if (!gate_checkpoint(pos)) return;
      }
      return;
    }

    if (rollback) {
      if (active_poisoned) {
        active.reset();
        active_has_begin = false;
        active_poisoned = false;
        return;  // never advance past a damaged transaction
      }
      active.reset();
      active_has_begin = false;
      payload_commit_pending = false;
      if (!poisoned) checkpoint = pos;
      return;
    }

    Statement statement;
    statement.database = q.database;
    statement.query = q.query;
    statement.thread_id = q.thread_id;
    statement.error_code = q.error_code;
    statement.is_ddl = ddl;

    if (active) {
      if (active_has_begin) {
        if (ddl) {
          // DDL implicitly commits the preceding transaction.
          commit_active(pos, std::nullopt, false);
        } else {
          if (opt.emit_statement_transactions) {
            active->statements.push_back(std::move(statement));
          }
          if (active->database.empty()) active->database = q.database;
          ++active->event_count;
          return;
        }
      }
      if (!active) {
        // The DDL committed the previous transaction above.
        if (active_poisoned || poisoned) return;
      } else if (active->changes.empty() && active->statements.empty()) {
        // A GTID followed by a statement-based (or DDL) query and no BEGIN:
        // the query itself is the autocommit transaction body.
        if (opt.emit_statement_transactions) {
          active->statements.push_back(std::move(statement));
          statement.query.clear();
        }
        active->is_ddl = ddl;
        if (active->database.empty()) active->database = q.database;
        ++active->event_count;
        commit_active(pos, std::nullopt, false);
        return;
      } else {
        fail(ErrorCode::TransactionNotTerminated,
             "query arrived before the previous transaction was committed");
      }
    }

    if (poisoned || active_poisoned) return;
    emit_statement(statement, pos, header);
    checkpoint = pos;
  }

  bool gate_checkpoint(const BinlogPosition& pos) {
    if (active_poisoned || poisoned) return false;
    checkpoint = pos;
    return true;
  }

  void commit_active(const BinlogPosition& pos, std::optional<std::uint64_t> xid,
                     bool from_payload) {
    if (!active) {
      if (opt.emit_empty_transactions) {
        Transaction txn;
        txn.begin_position = pos;
        txn.commit_position = pos;
        txn.xid = xid;
        txn.server_id = 0;
        txn.from_transaction_payload = from_payload;
        ++stats.transactions;
        completed.push_back(std::move(txn));
      }
      if (!active_poisoned && !poisoned) checkpoint = pos;
      return;
    }

    if (active_poisoned || poisoned) {
      // The transaction contained a validation failure.  Drop it and, most
      // importantly, leave checkpoint at the last complete transaction.
      active.reset();
      active_has_begin = false;
      active_poisoned = false;
      return;
    }

    Transaction txn = std::move(*active);
    active.reset();
    active_has_begin = false;
    txn.commit_position = pos;
    if (xid) txn.xid = xid;
    txn.from_transaction_payload = txn.from_transaction_payload || from_payload;
    if (!txn.empty() || opt.emit_empty_transactions) {
      ++stats.transactions;
      completed.push_back(std::move(txn));
    }
    checkpoint = pos;
  }

  void handle_xid(Bytes payload, const EventHeader& header, const BinlogPosition& pos) {
    (void)header;
    Reader r(payload);
    if (r.remaining() < 8) fail(ErrorCode::MalformedXid, "XID event is shorter than 8 bytes");
    const std::uint64_t xid = r.u64le();
    if (active) {
      commit_active(pos, xid, in_payload);
      payload_commit_pending = false;
    } else if (payload_commit_pending) {
      payload_commit_pending = false;
      if (!completed.empty() && completed.back().from_transaction_payload) {
        completed.back().commit_position = pos;
        completed.back().xid = xid;
      }
      if (!active_poisoned && !poisoned) checkpoint = pos;
    } else {
      if (opt.emit_empty_transactions) {
        Transaction txn;
        txn.begin_position = pos;
        txn.commit_position = pos;
        txn.xid = xid;
        ++stats.transactions;
        completed.push_back(std::move(txn));
      }
      if (!active_poisoned && !poisoned) checkpoint = pos;
    }
  }

  void handle_format_description(Bytes payload) {
    Reader r(payload);
    if (r.remaining() < 57) {
      fail(ErrorCode::MalformedFormatDescription,
           "FORMAT_DESCRIPTION_EVENT payload is too short");
    }
    (void)r.u16le();  // binlog version
    server_version = strip_nul(r.string(50));
    (void)r.u32le();  // create timestamp
    fde_header_length = r.u8();
    if (fde_header_length < kEventHeaderSize) {
      fail(ErrorCode::MalformedFormatDescription,
           "format-description header length is smaller than 19");
    }
    fde_seen = true;
  }

  void handle_rotate(Bytes payload, const EventHeader& header, const BinlogPosition& pos,
                     bool nested) {
    if (nested) {
      fail(ErrorCode::MalformedTransactionPayload,
           "ROTATE_EVENT is not valid inside a transaction payload");
    }
    (void)header;
    (void)pos;
    Reader r(payload);
    const std::uint64_t next_position = r.u64le();
    std::string next_file = strip_nul(r.string(r.remaining()));
    if (next_file.empty()) {
      fail(ErrorCode::MalformedFormatDescription, "ROTATE_EVENT has an empty file name");
    }
    if (poisoned || active_poisoned) {
      fail(ErrorCode::TransactionNotTerminated,
           "ROTATE_EVENT cannot advance past a validation failure");
    }
    if (active && !active->empty()) {
      fail(ErrorCode::TransactionNotTerminated,
           "ROTATE_EVENT arrived before the active transaction was committed");
    }
    active.reset();
    active_has_begin = false;
    active_poisoned = false;
    payload_commit_pending = false;
    file = std::move(next_file);
    tables.clear();
    stream_offset = next_position;
    has_last_pos = true;
    last_pos = BinlogPosition{file, next_position};
    checkpoint = BinlogPosition{file, next_position};
  }

  void handle_transaction_payload(Bytes payload, const EventHeader& header,
                                  const BinlogPosition& pos) {
    Reader r(payload);
    const std::uint64_t compressed_size = r.lenenc();
    const std::uint8_t compression = r.u8();
    const std::uint64_t uncompressed_size = r.lenenc();
    if (compressed_size == 0 || compressed_size > r.remaining()) {
      fail(ErrorCode::MalformedTransactionPayload,
           "transaction payload size does not match the event");
    }
    const Bytes compressed = r.bytes(static_cast<std::size_t>(compressed_size));
    if (!r.empty()) {
      fail(ErrorCode::MalformedTransactionPayload,
           "transaction payload has trailing bytes");
    }

    std::vector<std::uint8_t> decoded;
    if (compression == 0) {  // ZSTD
      if (!opt.decompress_transaction_payload) {
        fail(ErrorCode::UnsupportedCompression,
             "ZSTD transaction payload decompression is disabled");
      }
      decoded = zstd_decompress(compressed, static_cast<std::size_t>(uncompressed_size));
    } else if (compression == 255) {  // NONE
      decoded.assign(compressed.begin(), compressed.end());
    } else {
      fail(ErrorCode::UnsupportedCompression,
           "unsupported transaction payload compression type " +
               std::to_string(compression));
    }
    if (decoded.size() < kEventHeaderSize) {
      fail(ErrorCode::MalformedTransactionPayload,
           "decompressed transaction payload is too short");
    }
    if (uncompressed_size != 0 && decoded.size() != uncompressed_size) {
      fail(ErrorCode::DecompressionFailed,
           "decompressed transaction payload has unexpected length");
    }

    // Transaction payloads are atomic: if any nested event fails, restore the
    // transaction and checkpoint state so the outer event cannot advance the
    // safe position.
    const auto saved_active = active;
    const bool saved_active_has_begin = active_has_begin;
    const bool saved_active_poisoned = active_poisoned;
    const auto saved_checkpoint = checkpoint;
    const auto saved_completed_size = completed.size();
    const auto saved_stats = stats;
    const bool saved_payload_commit_pending = payload_commit_pending;
    const bool saved_in_payload = in_payload;
    const auto saved_tables = tables;
    const auto saved_generation_floor = generation_floor;
    const auto saved_server_version = server_version;
    const auto saved_fde_seen = fde_seen;
    const auto saved_fde_header_length = fde_header_length;
    if (active) active->from_transaction_payload = true;
    in_payload = true;

    try {
      std::size_t offset = 0;
      std::size_t nested_count = 0;
      while (offset < decoded.size()) {
        if (decoded.size() - offset < kEventHeaderSize) {
          fail(ErrorCode::MalformedTransactionPayload,
               "nested event header is truncated");
        }
        const Bytes remaining(decoded.data() + offset, decoded.size() - offset);
        const EventHeader nested_header = parse_header(remaining);
        if (nested_header.event_size > remaining.size()) {
          fail(ErrorCode::MalformedTransactionPayload,
               "nested event extends beyond the transaction payload");
        }
        const Bytes nested_event(remaining.data(), nested_header.event_size);
        if (nested_header.type == EventType::Gtid ||
            nested_header.type == EventType::AnonymousGtid) {
          // A payload normally carries no GTID; tolerate a duplicate one.
        }
        process_event(nested_event, &pos);
        ++nested_count;
        offset += nested_header.event_size;
      }
      if (nested_count == 0) {
        fail(ErrorCode::MalformedTransactionPayload, "transaction payload is empty");
      }
      if (completed.size() > saved_completed_size) {
        payload_commit_pending = true;
      }
      if (active) active->from_transaction_payload = true;
    } catch (...) {
      active = saved_active;
      active_has_begin = saved_active_has_begin;
      active_poisoned = saved_active_poisoned;
      checkpoint = saved_checkpoint;
      completed.resize(saved_completed_size);
      stats = saved_stats;
      payload_commit_pending = saved_payload_commit_pending;
      in_payload = saved_in_payload;
      tables = saved_tables;
      generation_floor = saved_generation_floor;
      server_version = saved_server_version;
      fde_seen = saved_fde_seen;
      fde_header_length = saved_fde_header_length;
      throw;
    }
    in_payload = saved_in_payload;
    (void)header;
  }

  void process_event(Bytes raw, const BinlogPosition* nested) {
    ++stats.events;
    const EventHeader header = parse_header(raw);
    BinlogPosition pos = make_position(header, nested);

    DecodeError position_error;
    position_error.code = ErrorCode::None;
    position_error.position = pos;
    position_error.event_type = header.type;
    current_error_position = position_error;

    const ChecksumAlgorithm algorithm =
        nested ? ChecksumAlgorithm::Off : effective_checksum(raw, header.type);
    if (!nested) {
      if (opt.verify_checksum) verify_checksum(raw, algorithm, pos, header.type);
      if (has_last_pos && pos.file == last_pos.file &&
          pos.offset != 0 && last_pos.offset != 0 &&
          opt.reject_non_monotonic_positions && pos.offset < last_pos.offset) {
        fail(ErrorCode::NonMonotonicPosition,
             "event position " + pos.to_string() + " precedes " +
                 last_pos.to_string());
      }
    }

    std::size_t body_end = raw.size();
    if (algorithm == ChecksumAlgorithm::Crc32) {
      if (body_end < 4) fail(ErrorCode::InvalidEventSize, "missing CRC32 bytes");
      body_end -= 4;
    }
    if (body_end < kEventHeaderSize) {
      fail(ErrorCode::InvalidEventSize, "event body is truncated");
    }
    const Bytes payload(raw.data() + kEventHeaderSize, body_end - kEventHeaderSize);

    bool checkpoint_handled = false;
    switch (header.type) {
      case EventType::FormatDescription:
        handle_format_description(payload);
        break;
      case EventType::Rotate:
        handle_rotate(payload, header, pos, nested != nullptr);
        checkpoint_handled = true;
        break;
      case EventType::Query:
        handle_query(payload, header, pos);
        checkpoint_handled = true;
        break;
      case EventType::Xid:
        handle_xid(payload, header, pos);
        checkpoint_handled = true;
        break;
      case EventType::TableMap:
        install_table_map(parse_table_map(payload, header, pos));
        if (active) ++active->event_count;
        break;
      case EventType::Gtid:
      case EventType::AnonymousGtid:
        handle_gtid(parse_gtid(payload, header.type), header, pos, nested != nullptr);
        checkpoint_handled = true;
        break;
      case EventType::TransactionPayload:
        handle_transaction_payload(payload, header, pos);
        checkpoint_handled = true;
        break;
      default:
        if (is_row_event(header.type)) {
          handle_rows(payload, header, pos);
          checkpoint_handled = true;
        } else {
          ++stats.ignored_events;
          if (active) ++active->event_count;
        }
        break;
    }

    ++stats.accepted_events;
    if (!nested && header.type != EventType::Rotate) {
      last_pos = pos;
      stream_offset = pos.offset;
      has_last_pos = true;
      if (!checkpoint_handled && !active && !active_poisoned && !poisoned) {
        checkpoint = pos;
      }
    }
  }

  void record_error(const ParseError& error) {
    ++stats.errors;
    DecodeError out;
    out.code = error.code;
    out.message = error.message;
    if (current_error_position) {
      out.position = current_error_position->position;
      out.event_type = current_error_position->event_type;
    } else {
      out.position = BinlogPosition{file, stream_offset};
    }
    last_error = out;
    if (opt.stop_on_error) poisoned = true;
    if (active) active_poisoned = true;
  }

  void discard_transaction_impl() {
    active.reset();
    active_has_begin = false;
    active_poisoned = false;
    payload_commit_pending = false;
  }
};

BinlogAssembler::BinlogAssembler(AssemblerOptions options)
    : impl_(std::make_unique<Impl>(std::move(options))) {}

BinlogAssembler::~BinlogAssembler() = default;

BinlogAssembler::BinlogAssembler(BinlogAssembler&&) noexcept = default;

BinlogAssembler& BinlogAssembler::operator=(BinlogAssembler&&) noexcept = default;

FeedResult BinlogAssembler::push_event(std::span<const std::uint8_t> event,
                                       std::string_view file) {
  if (event.size() < kEventHeaderSize) {
    FeedResult result;
    result.ok = false;
    result.error = DecodeError{ErrorCode::TruncatedEvent,
                               "binlog event is shorter than the event header",
                               BinlogPosition{std::string(file), 0},
                               EventType::Unknown};
    impl_->last_error = result.error;
    result.checkpoint = impl_->checkpoint;
    return result;
  }
  try {
    const EventHeader header = parse_header(event);
    if (header.event_size != event.size()) {
      FeedResult result;
      result.ok = false;
      result.error = DecodeError{
          ErrorCode::InvalidEventSize,
          "push_event requires exactly one event (" + std::to_string(header.event_size) +
              " bytes declared, " + std::to_string(event.size()) + " supplied)",
          BinlogPosition{std::string(file), header.log_pos},
          header.type};
      impl_->last_error = result.error;
      result.checkpoint = impl_->checkpoint;
      return result;
    }
  } catch (const ParseError& e) {
    FeedResult result;
    result.ok = false;
    result.error = DecodeError{e.code, e.message, BinlogPosition{std::string(file), 0},
                               EventType::Unknown};
    impl_->last_error = result.error;
    result.checkpoint = impl_->checkpoint;
    return result;
  }
  return push_events(event, file);
}

FeedResult BinlogAssembler::push_events(std::span<const std::uint8_t> events,
                                        std::string_view file) {
  FeedResult result;
  const BinlogPosition checkpoint_before = impl_->checkpoint;
  const std::size_t completed_before = impl_->completed.size();
  result.checkpoint = impl_->checkpoint;
  impl_->current_error_position.reset();

  if (impl_->poisoned && impl_->opt.stop_on_error) {
    result.ok = false;
    result.error = DecodeError{ErrorCode::StreamPoisoned,
                               "assembler is poisoned after a validation failure; "
                               "call recover() or reset()",
                               impl_->checkpoint,
                               EventType::Unknown};
    return result;
  }

  try {
    if (!file.empty()) impl_->switch_file(std::string(file));
  } catch (const ParseError& e) {
    impl_->record_error(e);
    result.ok = false;
    result.error = impl_->last_error;
    result.checkpoint = impl_->checkpoint;
    return result;
  }

  impl_->stats.bytes += events.size();
  std::size_t offset = 0;
  while (offset < events.size()) {
    if (events.size() - offset < kEventHeaderSize) {
      if (impl_->opt.allow_trailing_bytes) {
        offset = events.size();
        break;
      }
      ParseError e{ErrorCode::TruncatedEvent, "trailing bytes do not form an event header"};
      impl_->record_error(e);
      result.ok = false;
      result.error = impl_->last_error;
      break;
    }
    EventHeader header;
    impl_->current_error_position.reset();
    try {
      header = parse_header(events.subspan(offset));
    } catch (const ParseError& e) {
      impl_->record_error(e);
      result.ok = false;
      result.error = impl_->last_error;
      break;
    }
    if (header.event_size > events.size() - offset) {
      if (impl_->opt.allow_trailing_bytes) {
        offset = events.size();
        break;
      }
      ParseError e{ErrorCode::TruncatedEvent,
                   "declared event size exceeds the supplied buffer"};
      impl_->current_error_position =
          DecodeError{ErrorCode::None, "", BinlogPosition{impl_->file,
                                                          header.log_pos != 0
                                                              ? header.log_pos
                                                              : impl_->stream_offset +
                                                                    header.event_size},
                      header.type};
      impl_->record_error(e);
      result.ok = false;
      result.error = impl_->last_error;
      break;
    }

    try {
      impl_->process_event(events.subspan(offset, header.event_size), nullptr);
      ++result.events_processed;
    } catch (const ParseError& e) {
      impl_->record_error(e);
      result.ok = false;
      result.error = impl_->last_error;
      if (impl_->opt.stop_on_error) break;
    } catch (const std::exception& e) {
      ParseError wrapped{ErrorCode::InvalidArgument, e.what()};
      impl_->record_error(wrapped);
      result.ok = false;
      result.error = impl_->last_error;
      if (impl_->opt.stop_on_error) break;
    }
    offset += header.event_size;
  }

  if (result.ok && offset < events.size() && !impl_->opt.allow_trailing_bytes) {
    result.ok = false;
    result.error = DecodeError{ErrorCode::TrailingBytes,
                               "buffer ends with an incomplete event",
                               BinlogPosition{impl_->file, impl_->stream_offset},
                               EventType::Unknown};
  }

  result.event_accepted = result.events_processed > 0 && result.ok;
  result.checkpoint = impl_->checkpoint;
  result.event_position = impl_->last_pos;
  result.position_advanced = impl_->checkpoint != checkpoint_before;
  if (impl_->completed.size() > completed_before) {
    result.transactions.assign(
        impl_->completed.begin() + static_cast<std::ptrdiff_t>(completed_before),
        impl_->completed.end());
  }
  return result;
}

FeedResult BinlogAssembler::rotate(std::string next_file, std::uint64_t next_position) {
  FeedResult result;
  const BinlogPosition before = impl_->checkpoint;
  try {
    if (impl_->poisoned || impl_->active_poisoned) {
      fail(ErrorCode::StreamPoisoned,
           "cannot rotate while the assembler is poisoned; call recover() first");
    }
    if (next_file.empty()) {
      fail(ErrorCode::InvalidArgument, "rotate requires a non-empty file name");
    }
    if (impl_->active && !impl_->active->empty()) {
      fail(ErrorCode::TransactionNotTerminated,
           "cannot rotate while a transaction is open");
    }
    impl_->active.reset();
    impl_->active_poisoned = false;
    impl_->payload_commit_pending = false;
    impl_->file = std::move(next_file);
    impl_->tables.clear();
    impl_->stream_offset = next_position;
    impl_->has_last_pos = true;
    impl_->last_pos = BinlogPosition{impl_->file, next_position};
    impl_->checkpoint = BinlogPosition{impl_->file, next_position};
    impl_->poisoned = false;
    result.ok = true;
    result.event_accepted = true;
    result.events_processed = 0;
  } catch (const ParseError& e) {
    impl_->record_error(e);
    result.ok = false;
    result.error = impl_->last_error;
  }
  result.checkpoint = impl_->checkpoint;
  result.event_position = impl_->last_pos;
  result.position_advanced = impl_->checkpoint != before;
  return result;
}

BinlogPosition BinlogAssembler::checkpoint() const { return impl_->checkpoint; }

BinlogPosition BinlogAssembler::last_position() const { return impl_->last_pos; }

bool BinlogAssembler::in_transaction() const { return impl_->active.has_value(); }

bool BinlogAssembler::poisoned() const { return impl_->poisoned; }

std::optional<DecodeError> BinlogAssembler::last_error() const {
  return impl_->last_error;
}

ChecksumAlgorithm BinlogAssembler::checksum_algorithm() const {
  return impl_->auto_checksum ? ChecksumAlgorithm::Auto : impl_->checksum;
}

void BinlogAssembler::set_checksum_algorithm(ChecksumAlgorithm algorithm) {
  impl_->opt.checksum = algorithm;
  impl_->auto_checksum = algorithm == ChecksumAlgorithm::Auto;
  impl_->checksum =
      impl_->auto_checksum ? ChecksumAlgorithm::Off : algorithm;
  impl_->checksum_known = !impl_->auto_checksum;
}

const TableMap* BinlogAssembler::table_map(std::uint64_t table_id) const {
  auto it = impl_->tables.find(table_id);
  if (it == impl_->tables.end() || it->second.maps.empty()) return nullptr;
  return &it->second.maps.back();
}

const TableMap* BinlogAssembler::table_map_at(std::uint64_t table_id,
                                              const BinlogPosition& position) const {
  return impl_->table_map_at(table_id, position);
}

std::uint64_t BinlogAssembler::table_map_generation(std::uint64_t table_id) const {
  const TableMap* map = table_map(table_id);
  return map ? map->generation : 0;
}

std::vector<Transaction> BinlogAssembler::take_completed_transactions() {
  std::vector<Transaction> out = std::move(impl_->completed);
  impl_->completed.clear();
  return out;
}

const std::vector<Transaction>& BinlogAssembler::completed_transactions() const {
  return impl_->completed;
}

const AssemblerStats& BinlogAssembler::stats() const { return impl_->stats; }

const AssemblerOptions& BinlogAssembler::options() const { return impl_->opt; }

void BinlogAssembler::set_options(AssemblerOptions options) {
  impl_->opt = std::move(options);
  impl_->auto_checksum = impl_->opt.checksum == ChecksumAlgorithm::Auto;
  impl_->checksum =
      impl_->auto_checksum ? ChecksumAlgorithm::Off : impl_->opt.checksum;
  impl_->checksum_known = !impl_->auto_checksum;
}

void BinlogAssembler::reset() { impl_->clear_stream_state(); }

void BinlogAssembler::recover() {
  impl_->poisoned = false;
  impl_->last_error.reset();
  impl_->discard_transaction_impl();
}

void BinlogAssembler::discard_transaction() { impl_->discard_transaction_impl(); }

}  // namespace dataeng
