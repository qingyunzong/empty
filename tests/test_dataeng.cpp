#include "dataeng.hpp"

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

int failures = 0;

#define REQUIRE(condition)                                                     \
    do {                                                                       \
        if (!(condition)) {                                                    \
            std::cerr << __FILE__ << ':' << __LINE__                           \
                      << ": requirement failed: " #condition << '\n';          \
            ++failures;                                                        \
            return;                                                            \
        }                                                                      \
    } while (false)

void require_record(const dataeng::Record& record, std::string_view text,
                    std::uint64_t begin, std::uint64_t end, std::uint64_t line)
{
    REQUIRE(record.text == text);
    REQUIRE(record.begin == begin);
    REQUIRE(record.end == end);
    REQUIRE(record.line == line);
}

void require_error(const dataeng::Error& error, dataeng::ErrorKind kind,
                   std::uint64_t begin, std::uint64_t end, std::uint64_t line)
{
    REQUIRE(error.kind == kind);
    REQUIRE(error.begin == begin);
    REQUIRE(error.end == end);
    REQUIRE(error.line == line);
}

void test_basic_crlf_offsets_and_tail()
{
    const std::string input =
        "\xEF\xBB\xBF{\"a\":1}\r\n{\"b\":2}\n{\"c\":3}";
    const auto result = dataeng::decode_json_lines(input);

    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 3);
    require_record(result.records[0], "{\"a\":1}", 3, 10, 1);
    require_record(result.records[1], "{\"b\":2}", 12, 19, 2);
    require_record(result.records[2], "{\"c\":3}", 20, 27, 3);
}

void test_chunked_bom_and_utf8()
{
    dataeng::JsonLinesDecoder decoder;

    auto result = decoder.feed("\xEF");
    REQUIRE(result.empty());
    REQUIRE(decoder.pending_bytes() == 0);

    result = decoder.feed("\xBB");
    REQUIRE(result.empty());

    result = decoder.feed("\xBF{\"s\":\"");
    REQUIRE(result.empty());

    // Split a four-byte code point in the middle.
    result = decoder.feed("\xF0\x9F");
    REQUIRE(result.empty());
    result = decoder.feed("\x98\x80\"}\r");
    REQUIRE(result.empty());

    result = decoder.feed("\n");
    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0],
                   "{\"s\":\"\xF0\x9F\x98\x80\"}", 3, 15, 1);

    REQUIRE(decoder.finish().empty());
}

void test_bom_prefix_mismatch_is_data()
{
    dataeng::JsonLinesDecoder decoder;
    auto result = decoder.feed("\xEF");
    REQUIRE(result.empty());

    result = decoder.feed("A\nok\n");
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::InvalidUtf8, 0, 1, 1);
    require_record(result.records[0], "ok", 3, 5, 2);
}

void test_escaped_newline_is_not_a_boundary()
{
    const std::string first =
        "{\"m\":\"a\\nb\",\"x\":\"\\\\n\"}\n"
        "{\"m\":\"second\"}\n";
    const auto result = dataeng::decode_json_lines(first);

    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 2);
    REQUIRE(result.records[0].text == "{\"m\":\"a\\nb\",\"x\":\"\\\\n\"}");
    REQUIRE(result.records[1].text == "{\"m\":\"second\"}");

    dataeng::JsonLinesDecoder decoder;
    auto part = decoder.feed("{\"m\":\"a\\");
    REQUIRE(part.empty());
    part = decoder.feed("nb\"}\n");
    REQUIRE(part.errors.empty());
    REQUIRE(part.records.size() == 1);
    REQUIRE(part.records[0].text == "{\"m\":\"a\\nb\"}");
}

void test_invalid_utf8_exact_range_and_recovery()
{
    std::string input = "{\"a\":";
    input.push_back(static_cast<char>(0xFF));
    input += "}\nok\n";

    const auto result = dataeng::decode_json_lines(input);
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::InvalidUtf8, 5, 6, 1);
    require_record(result.records[0], "ok", 8, 10, 2);
}

void test_multiple_invalid_subparts_are_reported()
{
    std::string input;
    input += 'A';
    input += "\xE2";
    input += '(';
    input += "\xA1";
    input += 'B';
    input += "\nok\n";

    const auto result = dataeng::decode_json_lines(input);
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 2);
    require_error(result.errors[0], dataeng::ErrorKind::InvalidUtf8, 1, 2, 1);
    require_error(result.errors[1], dataeng::ErrorKind::InvalidUtf8, 3, 4, 1);
    require_record(result.records[0], "ok", 6, 8, 2);
}

void test_invalid_sequence_ranges()
{
    const auto overlong = dataeng::decode_json_lines("\xE0\x80\x80\nok\n");
    REQUIRE(overlong.records.size() == 1);
    REQUIRE(overlong.errors.size() == 3);
    require_error(overlong.errors[0], dataeng::ErrorKind::InvalidUtf8, 0, 1, 1);
    require_error(overlong.errors[1], dataeng::ErrorKind::InvalidUtf8, 1, 2, 1);
    require_error(overlong.errors[2], dataeng::ErrorKind::InvalidUtf8, 2, 3, 1);

    const auto surrogate = dataeng::decode_json_lines("\xED\xA0\x80\n");
    REQUIRE(surrogate.records.empty());
    REQUIRE(surrogate.errors.size() == 3);

    const auto above_max = dataeng::decode_json_lines("\xF4\x90\x80\x80\n");
    REQUIRE(above_max.records.empty());
    REQUIRE(above_max.errors.size() == 4);
}

void test_truncated_sequence_at_line_and_eof()
{
    dataeng::JsonLinesDecoder decoder;
    auto result = decoder.feed("ok\n\xC3");
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0], "ok", 0, 2, 1);

    result = decoder.feed("\nok\n");
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::InvalidUtf8, 3, 4, 2);
    require_record(result.records[0], "ok", 5, 7, 3);

    const auto eof = dataeng::decode_json_lines("ok\n\xE2\x82");
    REQUIRE(eof.records.size() == 1);
    REQUIRE(eof.errors.size() == 1);
    require_error(eof.errors[0], dataeng::ErrorKind::InvalidUtf8, 3, 5, 2);
}

void test_crlf_split_and_trailing_cr()
{
    dataeng::JsonLinesDecoder decoder;
    auto result = decoder.feed("abc\r");
    REQUIRE(result.empty());
    REQUIRE(decoder.pending_bytes() == 4);

    result = decoder.feed("\ndef\r");
    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0], "abc", 0, 3, 1);

    result = decoder.finish();
    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0], "def", 5, 8, 2);
}

void test_line_budget_recovery_without_body_retention()
{
    dataeng::Options options;
    options.max_line_bytes = 4;
    dataeng::JsonLinesDecoder decoder(options);

    auto result = decoder.feed("12345");
    REQUIRE(result.empty());
    REQUIRE(decoder.pending_bytes() == 0);

    result = decoder.feed("\r\nok\r\n");
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::LineTooLong, 0, 5, 1);
    require_record(result.records[0], "ok", 7, 9, 2);

    REQUIRE(decoder.finish().empty());
}

void test_crlf_does_not_consume_budget()
{
    dataeng::Options options;
    options.max_line_bytes = 4;
    dataeng::JsonLinesDecoder decoder(options);

    auto result = decoder.feed("1234\r\n");
    REQUIRE(result.errors.empty());
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0], "1234", 0, 4, 1);

    result = decoder.feed("12345\r\n");
    REQUIRE(result.records.empty());
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::LineTooLong, 6, 11, 2);
}

void test_large_oversized_line_does_not_accumulate()
{
    dataeng::Options options;
    options.max_line_bytes = 64;
    dataeng::JsonLinesDecoder decoder(options);

    const std::string oversized(1'000'000, 'x');
    auto result = decoder.feed(oversized);
    REQUIRE(result.empty());
    REQUIRE(decoder.pending_bytes() == 0);

    result = decoder.feed("\nnext\n");
    REQUIRE(result.records.size() == 1);
    REQUIRE(result.errors.size() == 1);
    require_error(result.errors[0], dataeng::ErrorKind::LineTooLong, 0,
                  oversized.size(), 1);
    require_record(result.records[0], "next", oversized.size() + 1,
                   oversized.size() + 5, 2);
}

void test_empty_lines_and_line_numbers()
{
    const auto skipped = dataeng::decode_json_lines("\n\r\nok\n");
    REQUIRE(skipped.errors.empty());
    REQUIRE(skipped.records.size() == 1);
    require_record(skipped.records[0], "ok", 3, 5, 3);

    dataeng::Options options;
    options.skip_empty_lines = false;
    const auto retained = dataeng::decode_json_lines("\n\r\nok\n", options);
    REQUIRE(retained.errors.empty());
    REQUIRE(retained.records.size() == 3);
    require_record(retained.records[0], "", 0, 0, 1);
    require_record(retained.records[1], "", 1, 1, 2);
    require_record(retained.records[2], "ok", 3, 5, 3);
}

void test_bom_only_and_partial_bom_at_eof()
{
    const auto bom_only = dataeng::decode_json_lines("\xEF\xBB\xBF");
    REQUIRE(bom_only.empty());

    const auto partial = dataeng::decode_json_lines("\xEF");
    REQUIRE(partial.records.empty());
    REQUIRE(partial.errors.size() == 1);
    require_error(partial.errors[0], dataeng::ErrorKind::InvalidUtf8, 0, 1, 1);
}

void test_bom_and_utf8_options()
{
    dataeng::Options options;
    options.strip_bom = false;
    const auto kept_bom =
        dataeng::decode_json_lines("\xEF\xBB\xBF{}\n", options);
    REQUIRE(kept_bom.errors.empty());
    REQUIRE(kept_bom.records.size() == 1);
    REQUIRE(kept_bom.records[0].text == "\xEF\xBB\xBF{}");
    require_record(kept_bom.records[0], "\xEF\xBB\xBF{}", 0, 5, 1);

    options.strip_bom = true;
    options.validate_utf8 = false;
    std::string invalid = "A";
    invalid.push_back(static_cast<char>(0xFF));
    invalid += "B\n";
    const auto unvalidated = dataeng::decode_json_lines(invalid, options);
    REQUIRE(unvalidated.errors.empty());
    REQUIRE(unvalidated.records.size() == 1);
    REQUIRE(unvalidated.records[0].text == invalid.substr(0, 3));
}

void test_reset_and_finish_contract()
{
    dataeng::JsonLinesDecoder decoder;
    auto result = decoder.feed("one\n");
    REQUIRE(result.records.size() == 1);
    REQUIRE(decoder.finish().empty());
    REQUIRE(decoder.finish().empty());

    bool threw = false;
    try {
        (void)decoder.feed("two\n");
    } catch (const std::logic_error&) {
        threw = true;
    }
    REQUIRE(threw);

    decoder.reset();
    result = decoder.feed("two\n");
    REQUIRE(result.records.size() == 1);
    require_record(result.records[0], "two", 0, 3, 1);
}

} // namespace

int main()
{
    test_basic_crlf_offsets_and_tail();
    test_chunked_bom_and_utf8();
    test_bom_prefix_mismatch_is_data();
    test_escaped_newline_is_not_a_boundary();
    test_invalid_utf8_exact_range_and_recovery();
    test_multiple_invalid_subparts_are_reported();
    test_invalid_sequence_ranges();
    test_truncated_sequence_at_line_and_eof();
    test_crlf_split_and_trailing_cr();
    test_line_budget_recovery_without_body_retention();
    test_crlf_does_not_consume_budget();
    test_large_oversized_line_does_not_accumulate();
    test_empty_lines_and_line_numbers();
    test_bom_only_and_partial_bom_at_eof();
    test_bom_and_utf8_options();
    test_reset_and_finish_contract();

    if (failures != 0) {
        std::cerr << failures << " test requirement(s) failed\n";
        return 1;
    }
    std::cout << "all dataeng tests passed\n";
    return 0;
}
