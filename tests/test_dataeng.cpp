#include "dataeng.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* expression, int line) {
  if (condition) return;
  std::cerr << "FAIL line " << line << ": " << expression << '\n';
  ++failures;
}

#define CHECK(expr) check((expr), #expr, __LINE__)
#define CHECK_EQ(lhs, rhs) check((lhs) == (rhs), #lhs " == " #rhs, __LINE__)

class Capture final : public dataeng::Sink {
 public:
  void on_part_begin(const dataeng::PartInfo& part) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].info = part;
  }

  void on_part_data(const dataeng::PartInfo& part,
                    std::span<const std::uint8_t> data) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].data.append(reinterpret_cast<const char*>(data.data()),
                                  data.size());
  }

  void on_part_end(const dataeng::PartInfo& part) override {
    if (part.index >= parts.size()) parts.resize(part.index + 1);
    parts[part.index].info = part;
  }

  std::vector<dataeng::CollectedPart> parts;
};

struct Result {
  bool completed = false;
  dataeng::ParseStats stats;
  std::vector<dataeng::CollectedPart> parts;
};

Result parse(std::string_view message, std::size_t chunk, dataeng::Limits limits) {
  Capture capture;
  dataeng::MimeParser parser(capture, limits);
  if (chunk == 0) {
    parser.feed(message);
  } else {
    for (std::size_t offset = 0; offset < message.size(); offset += chunk) {
      parser.feed(message.substr(offset, std::min(chunk, message.size() - offset)));
    }
  }
  parser.finish();
  return {parser.finished(), parser.stats(), std::move(capture.parts)};
}

Result parse_one_byte(std::string_view message, dataeng::Limits limits = {}) {
  return parse(message, 1, limits);
}

const dataeng::CollectedPart* by_filename(const Result& result,
                                          std::string_view filename) {
  for (const auto& part : result.parts) {
    if (part.info.filename == filename) return &part;
  }
  return nullptr;
}

const dataeng::PartError* find_error(const dataeng::PartInfo& part,
                                     dataeng::ErrorCode code) {
  for (const auto& error : part.errors) {
    if (error.code == code) return &error;
  }
  return nullptr;
}

void test_folded_headers_and_quoted_printable() {
  const std::string message =
      "From: sender@example.test\r\n"
      "Subject: hello\r\n"
      "\tfolded world\r\n"
      "Content-Type: text/plain; charset=utf-8\r\n"
      "Content-Transfer-Encoding: quoted-printable\r\n"
      "\r\n"
      "caf=C3=A9 =\r\n"
      "soft\r\n";

  for (std::size_t chunk = 1; chunk <= 13; ++chunk) {
    const Result result = parse(message, chunk, {});
    CHECK(result.completed);
    CHECK_EQ(result.stats.parts, 1u);
    CHECK_EQ(result.parts.size(), 1u);
    const auto& part = result.parts.at(0);
    CHECK(part.info.complete());
    CHECK(part.info.kind == dataeng::PartKind::root);
    CHECK_EQ(part.info.media_type, "text/plain");
    CHECK_EQ(part.info.charset, "utf-8");
    CHECK_EQ(part.data, "caf\xC3\xA9 soft\r\n");
    const auto* subject = dataeng::find_header(part.info, "subject");
    CHECK(subject != nullptr);
    CHECK_EQ(subject->value, "hello folded world");
  }
}

void test_nested_multipart_boundary_split_rfc2231() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=\"outer\"\r\n"
      "\r\n"
      "preamble ignored\r\n"
      "--outer\r\n"
      "Content-Type: multipart/alternative; boundary=inner\r\n"
      "\r\n"
      "--inner\r\n"
      "Content-Type: text/plain; charset=us-ascii\r\n"
      "\r\n"
      "hello\r\n"
      "--inner--\r\n"
      "--outer\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment;\r\n"
      " filename*0*=utf-8''%E6%B5%8B;\r\n"
      " filename*1*=%E8%AF%95.bin\r\n"
      "Content-Transfer-Encoding: base64\r\n"
      "\r\n"
      "SGVsbG8=\r\n"
      "--outer--\r\n"
      "epilogue ignored\r\n";

  for (std::size_t chunk : {std::size_t{1}, std::size_t{2}, std::size_t{3},
                            std::size_t{5}, std::size_t{7}, std::size_t{11},
                            std::size_t{16}, std::size_t{31}}) {
    const Result result = parse(message, chunk, {});
    CHECK(result.completed);
    CHECK_EQ(result.stats.parts, 4u);
    if (result.parts.size() != 4) continue;

    const auto& root = result.parts[0];
    CHECK(root.info.is_multipart);
    CHECK_EQ(root.info.media_type, "multipart/mixed");
    CHECK_EQ(root.data, "");

    const auto& alternative = result.parts[1];
    CHECK(alternative.info.is_multipart);
    CHECK_EQ(alternative.info.depth, 1u);
    CHECK_EQ(alternative.info.media_type, "multipart/alternative");

    const auto& text = result.parts[2];
    CHECK_EQ(text.info.depth, 2u);
    CHECK_EQ(text.data, "hello");
    CHECK(text.info.complete());

    const auto* attachment = by_filename(result, "\xE6\xB5\x8B\xE8\xAF\x95.bin");
    CHECK(attachment != nullptr);
    if (attachment != nullptr) {
      CHECK_EQ(attachment->data, "Hello");
      CHECK(attachment->info.is_attachment);
      CHECK(attachment->info.complete());
      CHECK_EQ(attachment->info.transfer_encoding,
               dataeng::TransferEncoding::base64);
    }
    CHECK(result.stats.errors == 0);
  }
}

void test_corrupt_base64_marks_range_and_keeps_sibling() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=b\r\n"
      "\r\n"
      "--b\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename=bad.bin\r\n"
      "Content-Transfer-Encoding: base64\r\n"
      "\r\n"
      "SGVsbG8=*\r\n"
      "--b\r\n"
      "Content-Type: text/plain\r\n"
      "\r\n"
      "still here\r\n"
      "--b--\r\n";

  for (std::size_t chunk = 1; chunk <= 9; ++chunk) {
    const Result result = parse(message, chunk, {});
    CHECK(result.completed);
    CHECK_EQ(result.stats.parts, 3u);
    if (result.parts.size() != 3) continue;

    const auto* bad = by_filename(result, "bad.bin");
    CHECK(bad != nullptr);
    if (bad != nullptr) {
      CHECK_EQ(bad->data, "Hello");
      CHECK(!bad->info.complete());
      CHECK(bad->info.truncated);
      const dataeng::PartError* error =
          find_error(bad->info, dataeng::ErrorCode::invalid_base64);
      CHECK(error != nullptr);
      if (error != nullptr) {
        const std::size_t body_begin = message.find("SGVsbG8=*");
        CHECK_EQ(error->range.begin, body_begin + 8);
        CHECK_EQ(error->range.end, body_begin + 9);
      }
      CHECK_EQ(bad->info.body_range.begin, message.find("SGVsbG8=*"));
      CHECK_EQ(bad->info.body_range.end,
               message.find("\r\n--b", bad->info.body_range.begin));
    }

    const auto& sibling = result.parts[2];
    CHECK_EQ(sibling.data, "still here");
    CHECK(sibling.info.complete());
  }
}

void test_quoted_printable_error_keeps_sibling() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=q\r\n"
      "\r\n"
      "--q\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename=bad.qp\r\n"
      "Content-Transfer-Encoding: quoted-printable\r\n"
      "\r\n"
      "good=ZZbad\r\n"
      "--q\r\n"
      "Content-Type: text/plain\r\n"
      "\r\n"
      "sibling\r\n"
      "--q--\r\n";

  const Result result = parse_one_byte(message);
  CHECK(result.completed);
  CHECK_EQ(result.stats.parts, 3u);
  const auto* bad = by_filename(result, "bad.qp");
  CHECK(bad != nullptr);
  if (bad != nullptr) {
    CHECK_EQ(bad->data, "good=ZZbad");
    CHECK(find_error(bad->info, dataeng::ErrorCode::invalid_quoted_printable) !=
          nullptr);
  }
  CHECK_EQ(result.parts[2].data, "sibling");
  CHECK(result.parts[2].info.complete());
}

void test_depth_limit_keeps_siblings() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=o\r\n"
      "\r\n"
      "--o\r\n"
      "Content-Type: multipart/alternative; boundary=i\r\n"
      "\r\n"
      "--i\r\n"
      "Content-Type: text/plain\r\n"
      "\r\n"
      "inner\r\n"
      "--i--\r\n"
      "--o\r\n"
      "Content-Type: text/plain\r\n"
      "\r\n"
      "outer sibling\r\n"
      "--o--\r\n";

  dataeng::Limits limits;
  limits.max_depth = 1;
  const Result result = parse(message, 3, limits);
  CHECK(result.completed);
  CHECK_EQ(result.stats.parts, 3u);
  if (result.parts.size() != 3) return;

  const auto& nested = result.parts[1];
  CHECK(nested.info.is_multipart);
  CHECK(find_error(nested.info, dataeng::ErrorCode::nesting_too_deep) != nullptr);
  CHECK(nested.data.find("inner") != std::string::npos);
  CHECK_EQ(result.parts[2].data, "outer sibling");
  CHECK(result.parts[2].info.complete());
}

void test_decoded_size_limit_keeps_sibling() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=s\r\n"
      "\r\n"
      "--s\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename=big.bin\r\n"
      "Content-Transfer-Encoding: base64\r\n"
      "\r\n"
      "MDEyMzQ1Njc4OUFCQ0RFRg==\r\n"
      "--s\r\n"
      "Content-Type: text/plain\r\n"
      "\r\n"
      "tail\r\n"
      "--s--\r\n";

  dataeng::Limits limits;
  limits.max_decoded_part_bytes = 10;
  const Result result = parse(message, 4, limits);
  CHECK(result.completed);
  CHECK_EQ(result.stats.parts, 3u);
  const auto* big = by_filename(result, "big.bin");
  CHECK(big != nullptr);
  if (big != nullptr) {
    CHECK_EQ(big->data, "0123456789");
    CHECK(big->info.truncated);
    CHECK(find_error(big->info, dataeng::ErrorCode::decoded_size_limit) != nullptr);
  }
  CHECK_EQ(result.parts[2].data, "tail");
  CHECK(result.parts[2].info.complete());
}

void test_empty_header_section_and_boundary_like_text() {
  {
    const Result result = parse_one_byte("\r\nbody bytes\r\n");
    CHECK(result.completed);
    CHECK_EQ(result.parts.size(), 1u);
    CHECK_EQ(result.parts[0].data, "body bytes\r\n");
    CHECK_EQ(result.parts[0].info.media_type, "text/plain");
  }
  {
    const std::string message =
        "Content-Type: multipart/mixed; boundary=z\r\n"
        "\r\n"
        "--z\r\n"
        "Content-Type: text/plain\r\n"
        "\r\n"
        "not a --z boundary\r\n"
        "--z--\r\n";
    const Result result = parse_one_byte(message);
    CHECK_EQ(result.parts.size(), 2u);
    CHECK_EQ(result.parts[1].data, "not a --z boundary");
  }
}

void test_rfc2231_single_extended_and_charset() {
  const std::string message =
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename*=iso-8859-1''caf%E9.txt\r\n"
      "Content-Transfer-Encoding: base64\r\n"
      "\r\n"
      "eA==\r\n";
  const Result result = parse_one_byte(message);
  CHECK_EQ(result.parts.size(), 1u);
  CHECK_EQ(result.parts[0].info.filename, "caf\xC3\xA9.txt");
  CHECK_EQ(result.parts[0].data, "x");
}

void test_header_limit_still_parses_body() {
  std::string message = "X-Long: ";
  message.append(80, 'a');
  message += "\r\nContent-Type: text/plain\r\n\r\nbody\r\n";

  dataeng::Limits limits;
  limits.max_header_bytes = 40;
  const Result result = parse(message, 5, limits);
  CHECK(result.completed);
  CHECK_EQ(result.parts.size(), 1u);
  CHECK_EQ(result.parts[0].data, "body\r\n");
  CHECK(find_error(result.parts[0].info, dataeng::ErrorCode::header_limit) !=
        nullptr);
}

void test_whole_message_convenience() {
  const auto result = dataeng::collect(
      "Content-Type: text/plain\r\n\r\nhello\r\n");
  CHECK(result.completed);
  CHECK(result.ok());
  CHECK_EQ(result.parts.size(), 1u);
  CHECK_EQ(result.parts[0].data, "hello\r\n");
}

void test_random_chunk_boundaries() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=\"abcdef\"\r\n"
      "\r\n"
      "--abcdef\r\n"
      "Content-Type: text/plain\r\n"
      "Content-Transfer-Encoding: quoted-printable\r\n"
      "\r\n"
      "line=20one=\r\n"
      "line two\r\n"
      "--abcdef\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename*=utf-8''%E6%B5%8B.bin\r\n"
      "Content-Transfer-Encoding: base64\r\n"
      "\r\n"
      "SGVsbG8sIHdvcmxkIQ==\r\n"
      "--abcdef--\r\n";

  const Result baseline = parse(message, 0, {});
  CHECK_EQ(baseline.parts.size(), 3u);
  CHECK_EQ(baseline.parts[1].data, "line oneline two");
  CHECK_EQ(baseline.parts[2].data, "Hello, world!");

  std::mt19937 generator(0x5eed);
  for (int iteration = 0; iteration < 500; ++iteration) {
    Capture capture;
    dataeng::MimeParser parser(capture);
    std::size_t offset = 0;
    while (offset < message.size()) {
      const std::size_t chunk = std::min<std::size_t>(
          1 + generator() % 17, message.size() - offset);
      parser.feed(std::string_view(message).substr(offset, chunk));
      offset += chunk;
    }
    parser.finish();
    CHECK_EQ(capture.parts.size(), baseline.parts.size());
    for (std::size_t i = 0; i < capture.parts.size() && i < baseline.parts.size();
         ++i) {
      CHECK_EQ(capture.parts[i].data, baseline.parts[i].data);
      CHECK_EQ(capture.parts[i].info.filename, baseline.parts[i].info.filename);
      CHECK_EQ(capture.parts[i].info.body_range.begin,
               baseline.parts[i].info.body_range.begin);
      CHECK_EQ(capture.parts[i].info.body_range.end,
               baseline.parts[i].info.body_range.end);
    }
  }
}

void test_rfc2047_filename() {
  const std::string message =
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename=\"=?utf-8?B?5rWL6K+VLmJpbg==?=\"\r\n"
      "\r\n"
      "x";
  const Result result = parse_one_byte(message);
  CHECK_EQ(result.parts.size(), 1u);
  CHECK_EQ(result.parts[0].info.filename, "\xE6\xB5\x8B\xE8\xAF\x95.bin");
}

void test_lf_only_multipart() {
  const std::string message =
      "Content-Type: multipart/mixed; boundary=b\n"
      "\n"
      "--b\n"
      "Content-Type: text/plain\n"
      "\n"
      "hello\n"
      "--b--\n";
  const Result result = parse_one_byte(message);
  CHECK_EQ(result.parts.size(), 2u);
  CHECK_EQ(result.parts[1].data, "hello");
  CHECK(result.parts[1].info.complete());
}

}  // namespace

int main() {
  test_folded_headers_and_quoted_printable();
  test_nested_multipart_boundary_split_rfc2231();
  test_corrupt_base64_marks_range_and_keeps_sibling();
  test_quoted_printable_error_keeps_sibling();
  test_depth_limit_keeps_siblings();
  test_decoded_size_limit_keeps_sibling();
  test_empty_header_section_and_boundary_like_text();
  test_rfc2231_single_extended_and_charset();
  test_header_limit_still_parses_body();
  test_whole_message_convenience();
  test_random_chunk_boundaries();
  test_rfc2047_filename();
  test_lf_only_multipart();

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "all dataeng tests passed\n";
  return EXIT_SUCCESS;
}
