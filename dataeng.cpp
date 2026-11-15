#include "dataeng.hpp"

#include <algorithm>
#include <atomic>
#include <charconv>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <system_error>
#include <utility>

#if defined(_WIN32)
#include <process.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace dataeng {
namespace {

constexpr std::uint32_t kSha256Constants[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
    0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
    0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
    0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
    0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
    0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
    0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
    0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

inline std::uint32_t rotate_right(std::uint32_t value, int bits) noexcept {
  return (value >> bits) | (value << (32 - bits));
}

inline void set_error(std::string* error, std::string message) {
  if (error != nullptr) {
    *error = std::move(message);
  }
}

std::string_view trim(std::string_view text) {
  while (!text.empty() &&
         (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' ||
          text.front() == '\n')) {
    text.remove_prefix(1);
  }
  while (!text.empty() &&
         (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' ||
          text.back() == '\n')) {
    text.remove_suffix(1);
  }
  return text;
}

bool is_ascii_digit(char c) noexcept { return c >= '0' && c <= '9'; }

bool all_ascii_digits(std::string_view text) noexcept {
  if (text.empty()) {
    return false;
  }
  for (char c : text) {
    if (!is_ascii_digit(c)) {
      return false;
    }
  }
  return true;
}

int digit_value(char c) noexcept { return c - '0'; }

bool parse_uint64_strict(std::string_view text, std::uint64_t& out) {
  text = trim(text);
  if (!all_ascii_digits(text)) {
    return false;
  }
  std::uint64_t value = 0;
  const auto result =
      std::from_chars(text.data(), text.data() + text.size(), value, 10);
  if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) {
    return false;
  }
  out = value;
  return true;
}

bool parse_int64_strict(std::string_view text, std::int64_t& out) {
  text = trim(text);
  if (text.empty()) {
    return false;
  }
  std::int64_t value = 0;
  const auto result =
      std::from_chars(text.data(), text.data() + text.size(), value, 10);
  if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) {
    return false;
  }
  out = value;
  return true;
}

// Howard Hinnant's civil calendar algorithms, with the epoch shifted to
// 1970-01-01.  They are valid for the proleptic Gregorian calendar.
std::int64_t days_from_civil(std::int64_t year, unsigned month,
                             unsigned day) noexcept {
  year -= month <= 2;
  const std::int64_t era = (year >= 0 ? year : year - 399) / 400;
  const unsigned year_of_era = static_cast<unsigned>(year - era * 400);
  const unsigned day_of_year =
      (153u * (month > 2 ? month - 3u : month + 9u) + 2u) / 5u +
      day - 1u;
  const unsigned day_of_era =
      year_of_era * 365u + year_of_era / 4u - year_of_era / 100u + day_of_year;
  return era * 146097 + static_cast<std::int64_t>(day_of_era) - 719468;
}

void civil_from_days(std::int64_t days, std::int64_t& year, unsigned& month,
                     unsigned& day) noexcept {
  days += 719468;
  const std::int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const unsigned day_of_era = static_cast<unsigned>(days - era * 146097);
  const unsigned year_of_era =
      (day_of_era - day_of_era / 1460u + day_of_era / 36524u -
       day_of_era / 146096u) /
      365u;
  year = static_cast<std::int64_t>(year_of_era) + era * 400;
  const unsigned day_of_year =
      day_of_era - (365u * year_of_era + year_of_era / 4u - year_of_era / 100u);
  const unsigned month_prime = (5u * day_of_year + 2u) / 153u;
  day = day_of_year - (153u * month_prime + 2u) / 5u + 1u;
  const int adjusted_month =
      static_cast<int>(month_prime) + (month_prime < 10u ? 3 : -9);
  month = static_cast<unsigned>(adjusted_month);
  year += month <= 2u;
}

bool is_leap_year(std::int64_t year) noexcept {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

unsigned days_in_month(std::int64_t year, unsigned month) noexcept {
  static constexpr unsigned kDays[] = {31, 28, 31, 30, 31, 30,
                                       31, 31, 30, 31, 30, 31};
  if (month == 2 && is_leap_year(year)) {
    return 29;
  }
  return month >= 1 && month <= 12 ? kDays[month - 1] : 0;
}

struct ParsedMdtm {
  Mdtm value;
  unsigned fraction_digits = 0;
};

std::optional<ParsedMdtm> parse_mdtm_shape(std::string_view text) {
  text = trim(text);
  if (text.size() >= 4 && text.substr(0, 3) == "213" && text[3] == ' ') {
    text.remove_prefix(4);
    text = trim(text);
  }
  if (text.size() < 14) {
    return std::nullopt;
  }
  for (std::size_t i = 0; i < 14; ++i) {
    if (!is_ascii_digit(text[i])) {
      return std::nullopt;
    }
  }
  const auto number = [&](std::size_t offset, std::size_t length) {
    unsigned value = 0;
    for (std::size_t i = 0; i < length; ++i) {
      value = value * 10u + static_cast<unsigned>(digit_value(text[offset + i]));
    }
    return value;
  };

  const std::int64_t year = number(0, 4);
  const unsigned month = number(4, 2);
  const unsigned day = number(6, 2);
  const unsigned hour = number(8, 2);
  const unsigned minute = number(10, 2);
  const unsigned second = number(12, 2);

  if (year < 0 || month < 1 || month > 12 || day < 1 ||
      day > days_in_month(year, month) || hour > 23 || minute > 59 ||
      second > 59) {
    return std::nullopt;
  }

  unsigned fraction_digits = 0;
  std::uint16_t milliseconds = 0;
  if (text.size() > 14) {
    if (text[14] != '.' || text.size() == 15) {
      return std::nullopt;
    }
    const std::string_view fraction = text.substr(15);
    if (!all_ascii_digits(fraction)) {
      return std::nullopt;
    }
    fraction_digits = static_cast<unsigned>(fraction.size());
    unsigned scale = 100u;
    for (std::size_t i = 0; i < fraction.size() && i < 3; ++i) {
      milliseconds = static_cast<std::uint16_t>(
          milliseconds +
          static_cast<unsigned>(digit_value(fraction[i])) * scale);
      scale /= 10u;
    }
  }

  ParsedMdtm parsed;
  parsed.fraction_digits = fraction_digits;
  parsed.value.unix_seconds =
      days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 +
      second;
  parsed.value.milliseconds = milliseconds;
  return parsed;
}

std::string hex_encode(std::string_view bytes) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (char character : bytes) {
    const auto byte = static_cast<unsigned char>(character);
    result.push_back(kHex[byte >> 4]);
    result.push_back(kHex[byte & 0x0f]);
  }
  return result;
}

int hex_value(char c) noexcept {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

bool hex_decode(std::string_view text, std::string& out) {
  if (text.size() % 2 != 0) {
    return false;
  }
  std::string result;
  result.resize(text.size() / 2);
  for (std::size_t i = 0; i < text.size(); i += 2) {
    const int high = hex_value(text[i]);
    const int low = hex_value(text[i + 1]);
    if (high < 0 || low < 0) {
      return false;
    }
    result[i / 2] = static_cast<char>((high << 4) | low);
  }
  out = std::move(result);
  return true;
}

bool consume_prefix(std::string_view line, std::string_view prefix,
                    std::string_view& rest) {
  if (line.size() < prefix.size() ||
      line.substr(0, prefix.size()) != prefix) {
    return false;
  }
  rest = line.substr(prefix.size());
  return true;
}

std::string format_milliseconds(std::uint16_t milliseconds) {
  char buffer[8];
  std::snprintf(buffer, sizeof(buffer), "%03u",
                static_cast<unsigned>(milliseconds));
  return buffer;
}

std::uint64_t process_id() noexcept {
#if defined(_WIN32)
  return static_cast<std::uint64_t>(_getpid());
#else
  return static_cast<std::uint64_t>(getpid());
#endif
}

bool sync_file(const std::filesystem::path& file, std::string* error) {
#if defined(_WIN32)
  (void)file;
  (void)error;
  return true;
#else
  const int fd = ::open(file.c_str(), O_RDONLY);
  if (fd < 0) {
    set_error(error, "cannot open file for fsync: " + file.string());
    return false;
  }
  const int result = ::fsync(fd);
  ::close(fd);
  if (result != 0) {
    set_error(error, "fsync failed for " + file.string());
    return false;
  }
  return true;
#endif
}

bool sync_directory(const std::filesystem::path& directory) {
#if defined(_WIN32)
  (void)directory;
  return true;
#else
  const int fd = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY);
  if (fd < 0) {
    return false;
  }
  const int result = ::fsync(fd);
  ::close(fd);
  return result == 0;
#endif
}

}  // namespace

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

Sha256::Sha256() noexcept
    : state_{0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
             0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u} {}

void Sha256::transform(const unsigned char* block) noexcept {
  std::uint32_t schedule[64];
  for (std::size_t i = 0; i < 16; ++i) {
    schedule[i] = (static_cast<std::uint32_t>(block[i * 4]) << 24) |
                  (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
                  (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) |
                  static_cast<std::uint32_t>(block[i * 4 + 3]);
  }
  for (std::size_t i = 16; i < 64; ++i) {
    const std::uint32_t s0 = rotate_right(schedule[i - 15], 7) ^
                             rotate_right(schedule[i - 15], 18) ^
                             (schedule[i - 15] >> 3);
    const std::uint32_t s1 = rotate_right(schedule[i - 2], 17) ^
                             rotate_right(schedule[i - 2], 19) ^
                             (schedule[i - 2] >> 10);
    schedule[i] = schedule[i - 16] + s0 + schedule[i - 7] + s1;
  }

  std::uint32_t a = state_[0];
  std::uint32_t b = state_[1];
  std::uint32_t c = state_[2];
  std::uint32_t d = state_[3];
  std::uint32_t e = state_[4];
  std::uint32_t f = state_[5];
  std::uint32_t g = state_[6];
  std::uint32_t h = state_[7];

  for (std::size_t i = 0; i < 64; ++i) {
    const std::uint32_t s1 =
        rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    const std::uint32_t choose = (e & f) ^ (~e & g);
    const std::uint32_t temp1 =
        h + s1 + choose + kSha256Constants[i] + schedule[i];
    const std::uint32_t s0 =
        rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t temp2 = s0 + majority;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  state_[0] += a;
  state_[1] += b;
  state_[2] += c;
  state_[3] += d;
  state_[4] += e;
  state_[5] += f;
  state_[6] += g;
  state_[7] += h;
}

void Sha256::update(const void* data, std::size_t size) noexcept {
  if (size == 0) {
    return;
  }
  const auto* bytes = static_cast<const unsigned char*>(data);
  bit_count_ += static_cast<std::uint64_t>(size) * 8u;

  if (buffer_size_ != 0) {
    const std::size_t take = std::min(size, 64u - buffer_size_);
    std::memcpy(buffer_.data() + buffer_size_, bytes, take);
    buffer_size_ += take;
    bytes += take;
    size -= take;
    if (buffer_size_ == 64) {
      transform(buffer_.data());
      buffer_size_ = 0;
    }
  }

  while (size >= 64) {
    transform(bytes);
    bytes += 64;
    size -= 64;
  }

  if (size != 0) {
    std::memcpy(buffer_.data(), bytes, size);
    buffer_size_ = size;
  }
}

std::string Sha256::hex_digest() const {
  Sha256 copy = *this;
  const std::uint64_t bit_count = copy.bit_count_;

  unsigned char padding[128] = {};
  padding[0] = 0x80;
  const std::size_t padding_size =
      copy.buffer_size_ < 56 ? 56 - copy.buffer_size_
                             : 120 - copy.buffer_size_;
  copy.update(padding, padding_size);

  unsigned char length[8];
  for (std::size_t i = 0; i < 8; ++i) {
    length[7 - i] = static_cast<unsigned char>(bit_count >> (i * 8));
  }
  copy.update(length, sizeof(length));

  static constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.reserve(64);
  for (std::uint32_t word : copy.state_) {
    for (int shift = 28; shift >= 0; shift -= 4) {
      result.push_back(kHex[(word >> shift) & 0x0fu]);
    }
  }
  return result;
}

std::string sha256_hex(std::string_view data) { return Sha256::hex(data); }

bool is_sha256_hex(std::string_view text) noexcept {
  if (text.size() != 64) {
    return false;
  }
  for (char c : text) {
    if (hex_value(c) < 0) {
      return false;
    }
  }
  return true;
}

std::string normalize_sha256(std::string_view text) {
  if (!is_sha256_hex(text)) {
    return std::string(text);
  }
  std::string result(text);
  for (char& c : result) {
    if (c >= 'A' && c <= 'F') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  return result;
}

std::optional<std::string> sha256_file_prefix(const std::filesystem::path& file,
                                              std::uint64_t length,
                                              std::string* error) {
  std::ifstream input(file, std::ios::binary);
  if (!input) {
    set_error(error, "cannot open file: " + file.string());
    return std::nullopt;
  }

  Sha256 hasher;
  std::array<char, 64 * 1024> buffer{};
  std::uint64_t remaining = length;
  while (remaining != 0) {
    const std::uint64_t chunk =
        std::min<std::uint64_t>(remaining, buffer.size());
    input.read(buffer.data(), static_cast<std::streamsize>(chunk));
    const std::streamsize read = input.gcount();
    if (read != static_cast<std::streamsize>(chunk)) {
      set_error(error, "file is shorter than requested prefix: " + file.string());
      return std::nullopt;
    }
    hasher.update(buffer.data(), static_cast<std::size_t>(read));
    remaining -= static_cast<std::uint64_t>(read);
  }
  if (!input) {
    set_error(error, "I/O error while hashing: " + file.string());
    return std::nullopt;
  }
  return hasher.hex_digest();
}

void PrefixDigest::update(const void* data, std::size_t size) noexcept {
  if (size > std::numeric_limits<std::uint64_t>::max() - size_) {
    size_ = std::numeric_limits<std::uint64_t>::max();
  } else {
    size_ += static_cast<std::uint64_t>(size);
  }
  hash_.update(data, size);
}

// ---------------------------------------------------------------------------
// MDTM
// ---------------------------------------------------------------------------

std::optional<Mdtm> parse_mdtm(std::string_view text) {
  const auto parsed = parse_mdtm_shape(text);
  if (!parsed) {
    return std::nullopt;
  }
  return parsed->value;
}

std::optional<Mdtm> parse_mdtm_reply(std::string_view reply) {
  return parse_mdtm(reply);
}

std::string format_mdtm(const Mdtm& mdtm) {
  if (mdtm.milliseconds > 999) {
    return {};
  }
  std::int64_t days = mdtm.unix_seconds / 86400;
  std::int64_t remainder = mdtm.unix_seconds % 86400;
  if (remainder < 0) {
    remainder += 86400;
    --days;
  }
  std::int64_t year = 0;
  unsigned month = 0;
  unsigned day = 0;
  civil_from_days(days, year, month, day);
  if (year < 0 || year > 9999) {
    return {};
  }

  const unsigned hour = static_cast<unsigned>(remainder / 3600);
  const unsigned minute = static_cast<unsigned>((remainder % 3600) / 60);
  const unsigned second = static_cast<unsigned>(remainder % 60);

  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%04lld%02u%02u%02u%02u%02u",
                static_cast<long long>(year), month, day, hour, minute, second);
  std::string result(buffer);
  if (mdtm.milliseconds != 0) {
    result.push_back('.');
    result += format_milliseconds(mdtm.milliseconds);
  }
  return result;
}

std::optional<std::chrono::milliseconds> mdtm_resolution(std::string_view text) {
  const auto parsed = parse_mdtm_shape(text);
  if (!parsed) {
    return std::nullopt;
  }
  switch (parsed->fraction_digits) {
    case 0:
      return std::chrono::milliseconds{1000};
    case 1:
      return std::chrono::milliseconds{100};
    case 2:
      return std::chrono::milliseconds{10};
    default:
      return std::chrono::milliseconds{1};
  }
}

std::optional<std::uint64_t> parse_size_reply(std::string_view reply) {
  reply = trim(reply);
  if (reply.size() >= 4 && reply.substr(0, 3) == "213" && reply[3] == ' ') {
    reply.remove_prefix(4);
    reply = trim(reply);
  }
  std::uint64_t size = 0;
  if (!parse_uint64_strict(reply, size)) {
    return std::nullopt;
  }
  return size;
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

ResumeState ResumeState::fresh(std::string remote_path,
                               std::uint64_t remote_size,
                               std::optional<Mdtm> remote_mtime,
                               std::chrono::milliseconds remote_mtime_resolution) {
  ResumeState state;
  state.path = std::move(remote_path);
  state.size = remote_size;
  state.mtime = remote_mtime;
  state.mtime_resolution = remote_mtime_resolution;
  state.offset = 0;
  state.prefix_sha256 = std::string(kSha256Empty);
  return state;
}

std::optional<ResumeState> ResumeState::from_prefix(
    std::string remote_path,
    std::uint64_t remote_size,
    std::optional<Mdtm> remote_mtime,
    std::chrono::milliseconds remote_mtime_resolution,
    std::uint64_t offset,
    std::string prefix_sha256,
    std::string* error) {
  ResumeState state;
  state.path = std::move(remote_path);
  state.size = remote_size;
  state.mtime = remote_mtime;
  state.mtime_resolution = remote_mtime_resolution;
  state.offset = offset;
  state.prefix_sha256 = normalize_sha256(prefix_sha256);
  if (!state.valid(error)) {
    return std::nullopt;
  }
  return state;
}

bool ResumeState::valid(std::string* error) const {
  if (path.empty()) {
    set_error(error, "remote path is empty");
    return false;
  }
  if (offset > size) {
    set_error(error, "offset exceeds SIZE");
    return false;
  }
  if (mtime_resolution.count() < 0) {
    set_error(error, "negative MDTM resolution");
    return false;
  }
  if (mtime && mtime->milliseconds > 999) {
    set_error(error, "invalid MDTM milliseconds");
    return false;
  }
  if (!is_sha256_hex(prefix_sha256)) {
    set_error(error, "prefix digest is not a SHA-256 hex string");
    return false;
  }
  if (offset == 0 &&
      normalize_sha256(prefix_sha256) != std::string(kSha256Empty)) {
    set_error(error, "zero-length prefix must use the empty SHA-256 digest");
    return false;
  }
  return true;
}

bool ResumeState::advance(std::uint64_t new_offset,
                          std::string new_prefix_sha256,
                          std::string* error) {
  if (!valid(error)) {
    return false;
  }
  if (new_offset < offset) {
    set_error(error, "cannot rewind resume state");
    return false;
  }
  if (new_offset > size) {
    set_error(error, "new offset exceeds SIZE");
    return false;
  }
  if (!is_sha256_hex(new_prefix_sha256)) {
    set_error(error, "new prefix digest is not a SHA-256 hex string");
    return false;
  }
  const std::string normalized = normalize_sha256(new_prefix_sha256);
  if (new_offset == 0 &&
      normalized != std::string(kSha256Empty)) {
    set_error(error, "zero-length prefix must use the empty SHA-256 digest");
    return false;
  }
  if (new_offset > 0 && normalized == std::string(kSha256Empty)) {
    set_error(error, "non-empty prefix cannot use the empty SHA-256 digest");
    return false;
  }
  if (new_offset == offset &&
      normalized != normalize_sha256(prefix_sha256)) {
    set_error(error, "digest changed without progress");
    return false;
  }
  offset = new_offset;
  prefix_sha256 = normalized;
  return true;
}

std::optional<std::string> encode_state(const ResumeState& state) {
  if (!state.valid()) {
    return std::nullopt;
  }
  std::string body;
  body.reserve(256);
  body += "dataeng-resume 1\n";
  body += "path=" + hex_encode(state.path) + "\n";
  body += "size=" + std::to_string(state.size) + "\n";
  if (state.mtime) {
    body += "mtime=" + std::to_string(state.mtime->unix_seconds) + "." +
            format_milliseconds(state.mtime->milliseconds) + "\n";
  } else {
    body += "mtime=-\n";
  }
  body += "resolution_ms=" +
          std::to_string(static_cast<long long>(state.mtime_resolution.count())) +
          "\n";
  body += "offset=" + std::to_string(state.offset) + "\n";
  body += "prefix_sha256=" + normalize_sha256(state.prefix_sha256) + "\n";
  return body + "checksum=" + sha256_hex(body) + "\n";
}

std::optional<ResumeState> decode_state(std::string_view encoded,
                                        std::string* error) {
  if (encoded.empty() || encoded.back() != '\n') {
    set_error(error, "state is empty or not newline terminated");
    return std::nullopt;
  }

  const std::size_t checksum_position = encoded.rfind("checksum=");
  if (checksum_position == std::string_view::npos ||
      (checksum_position != 0 && encoded[checksum_position - 1] != '\n')) {
    set_error(error, "state checksum line is missing");
    return std::nullopt;
  }
  std::string_view checksum_text = encoded.substr(checksum_position + 9);
  if (!checksum_text.empty() && checksum_text.back() == '\n') {
    checksum_text.remove_suffix(1);
  }
  if (checksum_text.find('\n') != std::string_view::npos ||
      !is_sha256_hex(checksum_text)) {
    set_error(error, "state checksum is malformed");
    return std::nullopt;
  }

  const std::string_view body = encoded.substr(0, checksum_position);
  if (sha256_hex(body) != normalize_sha256(checksum_text)) {
    set_error(error, "state checksum mismatch");
    return std::nullopt;
  }

  std::vector<std::string_view> lines;
  std::size_t start = 0;
  while (start < body.size()) {
    const std::size_t end = body.find('\n', start);
    if (end == std::string_view::npos) {
      set_error(error, "state body is not newline terminated");
      return std::nullopt;
    }
    lines.push_back(body.substr(start, end - start));
    start = end + 1;
  }
  if (lines.size() != 7) {
    set_error(error, "state has an unexpected number of fields");
    return std::nullopt;
  }
  if (lines[0] != "dataeng-resume 1") {
    set_error(error, "unsupported state version");
    return std::nullopt;
  }

  std::string_view value;
  if (!consume_prefix(lines[1], "path=", value)) {
    set_error(error, "missing path field");
    return std::nullopt;
  }
  std::string path;
  if (!hex_decode(value, path)) {
    set_error(error, "invalid path encoding");
    return std::nullopt;
  }

  std::uint64_t size = 0;
  if (!consume_prefix(lines[2], "size=", value) ||
      !parse_uint64_strict(value, size)) {
    set_error(error, "invalid size field");
    return std::nullopt;
  }

  std::optional<Mdtm> mtime;
  if (!consume_prefix(lines[3], "mtime=", value)) {
    set_error(error, "missing mtime field");
    return std::nullopt;
  }
  if (value != "-") {
    const std::size_t dot = value.find('.');
    if (dot == std::string_view::npos) {
      set_error(error, "invalid mtime field");
      return std::nullopt;
    }
    std::int64_t seconds = 0;
    const std::string_view fraction = value.substr(dot + 1);
    if (!parse_int64_strict(value.substr(0, dot), seconds) ||
        fraction.size() != 3 || !all_ascii_digits(fraction)) {
      set_error(error, "invalid mtime field");
      return std::nullopt;
    }
    const unsigned milliseconds =
        static_cast<unsigned>(digit_value(fraction[0]) * 100 +
                              digit_value(fraction[1]) * 10 +
                              digit_value(fraction[2]));
    if (milliseconds > 999) {
      set_error(error, "invalid mtime milliseconds");
      return std::nullopt;
    }
    mtime = Mdtm{seconds, static_cast<std::uint16_t>(milliseconds)};
  }

  std::int64_t resolution_count = 0;
  if (!consume_prefix(lines[4], "resolution_ms=", value) ||
      !parse_int64_strict(value, resolution_count) || resolution_count < 0) {
    set_error(error, "invalid resolution_ms field");
    return std::nullopt;
  }

  std::uint64_t offset = 0;
  if (!consume_prefix(lines[5], "offset=", value) ||
      !parse_uint64_strict(value, offset)) {
    set_error(error, "invalid offset field");
    return std::nullopt;
  }

  if (!consume_prefix(lines[6], "prefix_sha256=", value) ||
      !is_sha256_hex(value)) {
    set_error(error, "invalid prefix_sha256 field");
    return std::nullopt;
  }

  ResumeState state;
  state.path = std::move(path);
  state.size = size;
  state.mtime = mtime;
  state.mtime_resolution = std::chrono::milliseconds{resolution_count};
  state.offset = offset;
  state.prefix_sha256 = normalize_sha256(value);
  if (!state.valid(error)) {
    return std::nullopt;
  }
  return state;
}

bool save_state_atomic(const std::filesystem::path& file,
                       const ResumeState& state,
                       std::string* error) {
  const auto encoded = encode_state(state);
  if (!encoded) {
    set_error(error, "cannot encode invalid resume state");
    return false;
  }

  std::filesystem::path directory = file.parent_path();
  if (directory.empty()) {
    directory = ".";
  }
  std::error_code ec;
  if (!std::filesystem::is_directory(directory, ec) || ec) {
    set_error(error, "state directory does not exist: " + directory.string());
    return false;
  }

  static std::atomic<std::uint64_t> sequence{0};
  const std::uint64_t nonce = sequence.fetch_add(1, std::memory_order_relaxed);
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  std::filesystem::path temporary =
      directory / (".dataeng-state-" + std::to_string(process_id()) + "." +
                   std::to_string(nonce) + "." + std::to_string(stamp) +
                   ".tmp");

  {
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output) {
      set_error(error, "cannot create temporary state file: " +
                           temporary.string());
      return false;
    }
    output.write(encoded->data(),
                 static_cast<std::streamsize>(encoded->size()));
    output.flush();
    if (!output) {
      set_error(error, "cannot write temporary state file: " +
                           temporary.string());
      output.close();
      std::filesystem::remove(temporary, ec);
      return false;
    }
  }

  if (!sync_file(temporary, error)) {
    std::filesystem::remove(temporary, ec);
    return false;
  }

  std::filesystem::rename(temporary, file, ec);
  if (ec) {
#if defined(_WIN32)
    // Windows does not replace an existing file with rename().  This fallback
    // is not atomic, but keeps the API usable there.
    std::error_code remove_error;
    std::filesystem::remove(file, remove_error);
    ec.clear();
    std::filesystem::rename(temporary, file, ec);
#endif
  }
  if (ec) {
    set_error(error, "cannot replace state file: " + ec.message());
    std::filesystem::remove(temporary, ec);
    return false;
  }
  sync_directory(directory);
  return true;
}

std::optional<ResumeState> load_state(const std::filesystem::path& file,
                                      std::string* error) {
  constexpr std::uintmax_t kMaximumStateBytes = 1024 * 1024;
  std::error_code size_error;
  const std::uintmax_t file_size =
      std::filesystem::file_size(file, size_error);
  if (size_error) {
    set_error(error, "cannot stat state file: " + file.string());
    return std::nullopt;
  }
  if (file_size > kMaximumStateBytes) {
    set_error(error, "state file is unreasonably large");
    return std::nullopt;
  }

  std::ifstream input(file, std::ios::binary);
  if (!input) {
    set_error(error, "cannot open state file: " + file.string());
    return std::nullopt;
  }
  std::string encoded((std::istreambuf_iterator<char>(input)),
                      std::istreambuf_iterator<char>());
  if (!input.eof() && input.fail()) {
    set_error(error, "cannot read state file: " + file.string());
    return std::nullopt;
  }
  if (encoded.size() > kMaximumStateBytes) {
    set_error(error, "state file is unreasonably large");
    return std::nullopt;
  }
  return decode_state(encoded, error);
}

std::optional<ResumeState> capture_state_from_local(
    std::string remote_path,
    std::uint64_t remote_size,
    std::optional<Mdtm> remote_mtime,
    std::chrono::milliseconds remote_mtime_resolution,
    const std::filesystem::path& local_part,
    std::string* error) {
  ResumeState fresh = ResumeState::fresh(std::move(remote_path), remote_size,
                                         remote_mtime,
                                         remote_mtime_resolution);
  if (!fresh.valid(error)) {
    return std::nullopt;
  }

  std::error_code ec;
  std::filesystem::file_status status =
      std::filesystem::status(local_part, ec);
  if (ec == std::errc::no_such_file_or_directory) {
    status = std::filesystem::file_status(std::filesystem::file_type::not_found);
    ec.clear();
  }
  if (ec) {
    set_error(error, "cannot stat local partial file: " + local_part.string());
    return std::nullopt;
  }
  if (!std::filesystem::exists(status)) {
    return fresh;
  }
  if (!std::filesystem::is_regular_file(status)) {
    set_error(error, "local partial file is not a regular file");
    return std::nullopt;
  }

  const std::uint64_t local_size =
      std::filesystem::file_size(local_part, ec);
  if (ec) {
    set_error(error, "cannot stat local partial file: " + local_part.string());
    return std::nullopt;
  }
  if (local_size > remote_size) {
    set_error(error, "local partial file is larger than remote SIZE");
    return std::nullopt;
  }

  std::string hash_error;
  const auto digest = sha256_file_prefix(local_part, local_size, &hash_error);
  if (!digest) {
    set_error(error, hash_error);
    return std::nullopt;
  }

  const std::uint64_t post_hash_size =
      std::filesystem::file_size(local_part, ec);
  if (ec || post_hash_size != local_size) {
    set_error(error, "local partial file changed while hashing");
    return std::nullopt;
  }

  return ResumeState::from_prefix(
      fresh.path, remote_size, remote_mtime, remote_mtime_resolution,
      local_size, *digest, error);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

std::string_view to_string(GenerationVerdict verdict) noexcept {
  switch (verdict) {
    case GenerationVerdict::Same:
      return "same";
    case GenerationVerdict::Changed:
      return "changed";
    case GenerationVerdict::Unproven:
      return "unproven";
    case GenerationVerdict::Invalid:
      return "invalid";
  }
  return "invalid";
}

std::string_view to_string(Conflict conflict) noexcept {
  switch (conflict) {
    case Conflict::InvalidState:
      return "invalid-state";
    case Conflict::InvalidObservation:
      return "invalid-observation";
    case Conflict::InvalidOptions:
      return "invalid-options";
    case Conflict::PathMismatch:
      return "path-mismatch";
    case Conflict::SizeMissing:
      return "size-missing";
    case Conflict::SizeMismatch:
      return "size-mismatch";
    case Conflict::MtimeMissing:
      return "mtime-missing";
    case Conflict::MtimeMismatch:
      return "mtime-mismatch";
    case Conflict::MtimeResolutionInsufficient:
      return "mtime-resolution-insufficient";
    case Conflict::PrefixProofMissing:
      return "prefix-proof-missing";
    case Conflict::PrefixProofLengthMismatch:
      return "prefix-proof-length-mismatch";
    case Conflict::PrefixProofInvalid:
      return "prefix-proof-invalid";
    case Conflict::PrefixDigestMismatch:
      return "prefix-digest-mismatch";
  }
  return "unknown";
}

std::string_view to_string(LocalPrefixStatus status) noexcept {
  switch (status) {
    case LocalPrefixStatus::Ok:
      return "ok";
    case LocalPrefixStatus::InvalidState:
      return "invalid-state";
    case LocalPrefixStatus::Missing:
      return "missing";
    case LocalPrefixStatus::NotRegular:
      return "not-regular";
    case LocalPrefixStatus::Short:
      return "short";
    case LocalPrefixStatus::Longer:
      return "longer";
    case LocalPrefixStatus::IoError:
      return "io-error";
    case LocalPrefixStatus::DigestMismatch:
      return "digest-mismatch";
  }
  return "unknown";
}

bool ResumeDecision::has(Conflict conflict) const noexcept {
  return std::find(conflicts.begin(), conflicts.end(), conflict) !=
         conflicts.end();
}

std::string ResumeDecision::explain() const {
  std::string result(to_string(verdict));
  if (!conflicts.empty()) {
    result += ": ";
    for (std::size_t i = 0; i < conflicts.size(); ++i) {
      if (i != 0) {
        result += ", ";
      }
      result += to_string(conflicts[i]);
    }
  }
  return result;
}

namespace {

void add_conflict(ResumeDecision& decision, Conflict conflict) {
  if (!decision.has(conflict)) {
    decision.conflicts.push_back(conflict);
  }
}

bool valid_duration(std::chrono::milliseconds duration) noexcept {
  return duration.count() >= 0;
}

}  // namespace

ResumeDecision verify_resume(const ResumeState& state,
                             const RemoteObservation& remote,
                             const VerifyOptions& options) {
  ResumeDecision decision;
  decision.verdict = GenerationVerdict::Invalid;

  if (!state.valid()) {
    add_conflict(decision, Conflict::InvalidState);
    return decision;
  }
  if (!valid_duration(options.max_trusted_mtime_resolution) ||
      !valid_duration(options.mtime_conflict_margin)) {
    add_conflict(decision, Conflict::InvalidOptions);
    return decision;
  }
  if (remote.path.empty()) {
    add_conflict(decision, Conflict::InvalidObservation);
    return decision;
  }
  if (!valid_duration(remote.mtime_resolution)) {
    add_conflict(decision, Conflict::InvalidObservation);
    return decision;
  }
  if (remote.mtime && remote.mtime->milliseconds > 999) {
    add_conflict(decision, Conflict::InvalidObservation);
    return decision;
  }

  bool definitely_changed = false;
  bool missing_evidence = false;

  if (remote.path != state.path) {
    add_conflict(decision, Conflict::PathMismatch);
    definitely_changed = true;
  }

  bool size_matches = false;
  if (!remote.size) {
    add_conflict(decision, Conflict::SizeMissing);
    missing_evidence = true;
  } else if (*remote.size != state.size) {
    add_conflict(decision, Conflict::SizeMismatch);
    definitely_changed = true;
  } else {
    size_matches = true;
  }

  bool mtime_matches = false;
  if (!state.mtime || !remote.mtime) {
    add_conflict(decision, Conflict::MtimeMissing);
    missing_evidence = true;
  } else if (*state.mtime != *remote.mtime) {
    add_conflict(decision, Conflict::MtimeMismatch);
    definitely_changed = true;
  } else {
    mtime_matches = true;
  }

  bool prefix_matches = false;
  bool prefix_unusable = false;
  if (remote.prefix) {
    if (remote.prefix->length != state.offset) {
      add_conflict(decision, Conflict::PrefixProofLengthMismatch);
      missing_evidence = true;
      prefix_unusable = true;
    } else if (!is_sha256_hex(remote.prefix->sha256_hex)) {
      add_conflict(decision, Conflict::PrefixProofInvalid);
      missing_evidence = true;
      prefix_unusable = true;
    } else if (normalize_sha256(remote.prefix->sha256_hex) !=
               normalize_sha256(state.prefix_sha256)) {
      add_conflict(decision, Conflict::PrefixDigestMismatch);
      definitely_changed = true;
    } else {
      prefix_matches = true;
      decision.prefix_verified = true;
    }
  }

  if (definitely_changed) {
    decision.verdict = GenerationVerdict::Changed;
    decision.same_generation = false;
    return decision;
  }

  decision.metadata_verified =
      size_matches && mtime_matches && remote.path == state.path;
  if (!decision.metadata_verified || missing_evidence) {
    decision.needs_prefix_proof = prefix_unusable;
    decision.verdict = GenerationVerdict::Unproven;
    return decision;
  }

  std::chrono::milliseconds effective_resolution =
      std::max(state.mtime_resolution, remote.mtime_resolution);
  if (effective_resolution > std::chrono::milliseconds::max() -
                                 options.mtime_conflict_margin) {
    effective_resolution = std::chrono::milliseconds::max();
  } else {
    effective_resolution += options.mtime_conflict_margin;
  }
  const bool timestamp_precise =
      effective_resolution.count() > 0 &&
      effective_resolution <= options.max_trusted_mtime_resolution;

  const bool proof_required =
      state.offset > 0 &&
      (options.require_prefix_proof || !timestamp_precise);
  if (proof_required && !prefix_matches) {
    if (!timestamp_precise) {
      add_conflict(decision, Conflict::MtimeResolutionInsufficient);
    }
    if (!remote.prefix) {
      add_conflict(decision, Conflict::PrefixProofMissing);
    }
    decision.needs_prefix_proof = true;
    decision.verdict = GenerationVerdict::Unproven;
    return decision;
  }

  decision.verdict = GenerationVerdict::Same;
  decision.same_generation = true;
  return decision;
}

// ---------------------------------------------------------------------------
// Local prefix check
// ---------------------------------------------------------------------------

LocalPrefixCheck check_local_prefix(const ResumeState& state,
                                    const std::filesystem::path& local_part) {
  LocalPrefixCheck check;
  std::string state_error;
  if (!state.valid(&state_error)) {
    check.status = LocalPrefixStatus::InvalidState;
    check.detail = state_error;
    return check;
  }

  std::error_code ec;
  std::filesystem::file_status status =
      std::filesystem::status(local_part, ec);
  if (ec == std::errc::no_such_file_or_directory) {
    status = std::filesystem::file_status(std::filesystem::file_type::not_found);
    ec.clear();
  }
  if (ec) {
    check.status = LocalPrefixStatus::IoError;
    check.detail = ec.message();
    return check;
  }
  if (!std::filesystem::exists(status)) {
    if (state.offset == 0) {
      check.status = LocalPrefixStatus::Ok;
      check.actual_sha256 = std::string(kSha256Empty);
      return check;
    }
    check.status = LocalPrefixStatus::Missing;
    check.detail = "local partial file does not exist";
    return check;
  }
  if (!std::filesystem::is_regular_file(status)) {
    check.status = LocalPrefixStatus::NotRegular;
    check.detail = "local partial file is not a regular file";
    return check;
  }

  const std::uint64_t local_size = std::filesystem::file_size(local_part, ec);
  if (ec) {
    check.status = LocalPrefixStatus::IoError;
    check.detail = ec.message();
    return check;
  }
  check.local_size = local_size;
  if (local_size < state.offset) {
    check.status = LocalPrefixStatus::Short;
    check.detail = "local partial file is shorter than the recorded offset";
    return check;
  }
  if (local_size > state.offset) {
    check.status = LocalPrefixStatus::Longer;
    check.detail = "local partial file is longer than the recorded offset";
    return check;
  }
  if (state.offset == 0) {
    check.status = LocalPrefixStatus::Ok;
    check.actual_sha256 = std::string(kSha256Empty);
    return check;
  }

  std::string hash_error;
  const auto digest =
      sha256_file_prefix(local_part, state.offset, &hash_error);
  if (!digest) {
    check.status = LocalPrefixStatus::IoError;
    check.detail = hash_error;
    return check;
  }
  check.actual_sha256 = *digest;

  // Detect a writer that changed the file while it was being hashed.
  const std::uint64_t post_hash_size =
      std::filesystem::file_size(local_part, ec);
  if (ec) {
    check.status = LocalPrefixStatus::IoError;
    check.detail = ec.message();
    return check;
  }
  if (post_hash_size < state.offset) {
    check.status = LocalPrefixStatus::Short;
    check.local_size = post_hash_size;
    check.detail = "local partial file changed while hashing";
    return check;
  }
  if (post_hash_size > state.offset) {
    check.status = LocalPrefixStatus::Longer;
    check.local_size = post_hash_size;
    check.detail = "local partial file changed while hashing";
    return check;
  }

  if (normalize_sha256(*digest) != normalize_sha256(state.prefix_sha256)) {
    check.status = LocalPrefixStatus::DigestMismatch;
    check.detail = "local prefix digest does not match the resume state";
    return check;
  }
  check.status = LocalPrefixStatus::Ok;
  return check;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

std::optional<CompletionProof> verify_completion(
    const ResumeState& state,
    const RemoteObservation& remote,
    const VerifyOptions& options,
    std::string* error) {
  if (!state.valid(error)) {
    return std::nullopt;
  }
  if (!state.complete()) {
    set_error(error, "download is not complete (offset != SIZE)");
    return std::nullopt;
  }
  const ResumeDecision decision = verify_resume(state, remote, options);
  if (!decision.same_generation) {
    set_error(error, decision.explain());
    return std::nullopt;
  }
  return CompletionProof(state);
}

bool commit_completion(CompletionProof proof,
                       const std::filesystem::path& local_part,
                       const std::filesystem::path& target,
                       std::string* error) {
  const ResumeState state = proof.state();
  std::string state_error;
  if (!state.valid(&state_error)) {
    set_error(error, "invalid completion proof: " + state_error);
    return false;
  }
  if (!state.complete()) {
    set_error(error, "completion proof refers to an incomplete download");
    return false;
  }

  if (state.size == 0) {
    std::error_code exists_error;
    if (!std::filesystem::exists(local_part, exists_error) && !exists_error) {
      std::ofstream empty(local_part, std::ios::binary | std::ios::trunc);
      if (!empty) {
        set_error(error, "cannot create empty partial file: " +
                             local_part.string());
        return false;
      }
    }
  }

  const LocalPrefixCheck check = check_local_prefix(state, local_part);
  if (!check.ok()) {
    set_error(error, std::string("local partial file rejected: ") +
                         std::string(to_string(check.status)) +
                         (check.detail.empty() ? "" : " (" + check.detail + ")"));
    return false;
  }

  if (!sync_file(local_part, error)) {
    return false;
  }

  std::error_code ec;
  if (std::filesystem::equivalent(local_part, target, ec) && !ec) {
    return true;
  }
  ec.clear();
  std::filesystem::rename(local_part, target, ec);
  if (ec) {
#if defined(_WIN32)
    std::error_code remove_error;
    std::filesystem::remove(target, remove_error);
    ec.clear();
    std::filesystem::rename(local_part, target, ec);
#endif
  }
  if (ec) {
    set_error(error, "cannot publish completed file: " + ec.message());
    return false;
  }

  std::filesystem::path directory = target.parent_path();
  if (directory.empty()) {
    directory = ".";
  }
  sync_directory(directory);
  return true;
}

}  // namespace dataeng
