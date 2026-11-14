#include "dataeng.hpp"

#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using dataeng::EdifactParser;
using dataeng::ErrorCode;
using dataeng::InterchangeInfo;
using dataeng::MessageInfo;
using dataeng::ParseCallbacks;
using dataeng::ParseError;
using dataeng::Segment;

struct Collector {
    std::vector<InterchangeInfo> ic_starts;
    std::vector<InterchangeInfo> ic_ends;
    std::vector<MessageInfo> msg_starts;
    std::vector<MessageInfo> msg_ends;
    std::vector<Segment> segments;
    std::vector<ParseError> errors;

    ParseCallbacks callbacks() {
        ParseCallbacks cb;
        cb.on_interchange_start = [this](const InterchangeInfo& info) {
            ic_starts.push_back(info);
        };
        cb.on_interchange_end = [this](const InterchangeInfo& info) {
            ic_ends.push_back(info);
        };
        cb.on_message_start = [this](const MessageInfo& info) {
            msg_starts.push_back(info);
        };
        cb.on_message_end = [this](const MessageInfo& info) {
            msg_ends.push_back(info);
        };
        cb.on_segment = [this](const Segment& segment) {
            segments.push_back(segment);
        };
        cb.on_error = [this](const ParseError& error) {
            errors.push_back(error);
        };
        return cb;
    }
};

// Feeds the whole input one byte at a time so cross-chunk behaviour is tested.
bool parse_bytewise(std::string_view input, Collector& collector) {
    EdifactParser parser(collector.callbacks());
    for (char ch : input) {
        parser.feed(std::string_view(&ch, 1));
    }
    return parser.finish();
}

bool parse_in_chunks(std::string_view input, std::size_t chunk_size,
                     Collector& collector) {
    EdifactParser parser(collector.callbacks());
    for (std::size_t i = 0; i < input.size(); i += chunk_size) {
        parser.feed(input.substr(i, chunk_size));
    }
    return parser.finish();
}

bool has_code(const std::vector<ParseError>& errors, ErrorCode code) {
    for (const auto& error : errors) {
        if (error.code == code) {
            return true;
        }
    }
    return false;
}

int g_failures = 0;

void check(bool condition, const std::string& name) {
    if (condition) {
        std::cout << "  ok - " << name << '\n';
    } else {
        std::cout << "FAIL - " << name << '\n';
        ++g_failures;
    }
}

// Minimal valid interchange: one message with UNH + DTM + UNT.
constexpr const char* kSimple =
    "UNA:+,? '"
    "UNB+UNOC:3+SENDER+RECEIVER+260101:1200+REF1'"
    "UNH+MSG1+ORDERS:D:96A:UN'"
    "DTM+137:20260101:102'"
    "UNT+3+MSG1'"
    "UNZ+1+REF1'";

void test_happy_path() {
    std::cout << "test_happy_path\n";
    Collector collector;
    bool ok = parse_bytewise(kSimple, collector);

    check(ok, "finish() reports no errors");
    check(collector.ic_starts.size() == 1, "one interchange start");
    check(collector.ic_ends.size() == 1, "one interchange end");
    check(collector.msg_starts.size() == 1, "one message start");
    check(collector.msg_ends.size() == 1, "one message end");
    check(collector.ic_starts[0].control_reference == "REF1",
          "interchange reference from UNB");
    check(collector.msg_starts[0].control_reference == "MSG1",
          "message reference from UNH");
    check(collector.msg_ends[0].actual_segment_count == 3,
          "message segment count includes UNH and UNT");
    check(collector.msg_ends[0].declared_segment_count == 3,
          "declared count matches actual count");
    check(collector.ic_ends[0].actual_message_count == 1 &&
              collector.ic_ends[0].declared_message_count == 1,
          "interchange message count matches");

    const Segment& dtm = collector.segments[2];
    check(dtm.tag == "DTM", "DTM segment parsed");
    check(dtm.elements[1].raw == "137:20260101:102", "element raw accessor");
    check(dtm.elements[1].components.size() == 3, "components split by ':'");
    check(dtm.elements[1].components[1].value == "20260101",
          "second component value");
    check(dtm.raw.find('+') != std::string::npos, "raw segment text retained");
}

void test_default_syntax_without_una() {
    std::cout << "test_default_syntax_without_una\n";
    Collector collector;
    bool ok = parse_bytewise(
        "UNB+UNOC:3+S+R+260101:1200+R2'"
        "UNH+M+ORDERS:D:96A:UN'UNT+2+M'UNZ+1+R2'",
        collector);
    check(ok, "default service chars work without UNA");
    check(collector.segments.size() == 4, "all four envelope segments emitted");
}

void test_release_escapes_terminator_and_separators() {
    std::cout << "test_release_escapes_terminator_and_separators\n";
    // FTX free text contains a released release char, element separator,
    // component separator and segment terminator; all remain data in one
    // segment.
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+R3'"
        "UNH+M+ORDERS:D:96A:UN'"
        "FTX+AAA+hello??world?+plus?:colon?\'\'"
        "UNT+3+M'"
        "UNZ+1+R3'";
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(ok, "released characters do not break parsing");
    const Segment& ftx = collector.segments[2];
    check(ftx.tag == "FTX", "single FTX segment despite released terminator");
    check(ftx.elements.size() == 3,
          "released '+' stays inside the element");
    check(ftx.elements[2].value() == "hello?world+plus:colon\'",
          "unescaped element value strips release characters");
    check(ftx.elements[2].raw == "hello??world?+plus?:colon?\'",
          "raw element value keeps release characters");
}

void test_terminator_split_across_chunks() {
    std::cout << "test_terminator_split_across_chunks\n";
    // The release/terminator pair of the FTX data is split at the chunk
    // boundary, as is the real UNT terminator below it.
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+R4'"
        "UNH+M+ORDERS:D:96A:UN'"
        "FTX+abc?\'\'"
        "UNT+3+M'"
        "UNZ+1+R4'";
    Collector collector;
    bool ok = parse_in_chunks(input, 3, collector);

    check(ok, "chunks splitting release and terminator parse cleanly");
    check(collector.segments.size() == 5, "all five segments recovered");
    check(collector.segments[2].tag == "FTX", "FTX recovered across chunks");
    check(collector.segments[2].elements[1].value() == "abc\'",
          "released terminator kept as data");
}

void test_unt_count_mismatch_isolated() {
    std::cout << "test_unt_count_mismatch_isolated\n";
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+R5'"
        "UNH+M1+ORDERS:D:96A:UN'"
        "DTM+1'"
        "UNT+9+M1'"  // declares 9, actual is 3
        "UNH+M2+ORDERS:D:96A:UN'"
        "UNT+2+M2'"
        "UNZ+2+R5'";  // two real messages despite the failed first one
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(!ok, "finish() surfaces the message error");
    check(has_code(collector.errors, ErrorCode::UntCountMismatch),
          "UNT mismatch reported");
    check(collector.msg_ends.size() == 2, "both messages closed");
    check(collector.msg_ends[0].failed, "first message marked failed");
    check(!collector.msg_ends[1].failed, "second message unaffected");
    check(collector.ic_ends.size() == 1, "interchange still completed");
    check(collector.ic_ends[0].actual_message_count == 2,
          "interchange counts both actual messages");
    check(collector.ic_ends[0].declared_message_count == 2,
          "UNZ count checked against actual messages");
    check(!has_code(collector.errors, ErrorCode::UnzCountMismatch),
          "UNZ count matches the two real messages");
}

void test_unz_count_checked_against_actual_messages() {
    std::cout << "test_unz_count_checked_against_actual_messages\n";
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+R6'"
        "UNH+M1+ORDERS:D:96A:UN'UNT+2+M1'"
        "UNH+M2+ORDERS:D:96A:UN'UNT+2+M2'"
        "UNZ+5+R6'";  // claims 5, only 2 present
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(!ok, "finish() reports the interchange error");
    check(has_code(collector.errors, ErrorCode::UnzCountMismatch),
          "UNZ count mismatch reported");
    check(collector.ic_ends[0].actual_message_count == 2,
          "actual count is two");
}

void test_unz_reference_mismatch() {
    std::cout << "test_unz_reference_mismatch\n";
    Collector collector;
    bool ok = parse_bytewise(
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+GOOD'"
        "UNH+M+ORDERS:D:96A:UN'UNT+2+M'"
        "UNZ+1+BAD'",
        collector);
    check(!ok, "mismatched reference fails");
    check(has_code(collector.errors, ErrorCode::UnzReferenceMismatch),
          "reference mismatch reported");
}

void test_custom_service_chars_via_una() {
    std::cout << "test_custom_service_chars_via_una\n";
    // component '^', element '-', decimal ',', release '\', repetition '%',
    // segment terminator '#'
    std::string input =
        "UNA^-,\\%#"
        "UNB-UNOC^3-S-R-260101^1200-R7#"
        "UNH-M-ORDERS^D^96A^UN#"
        "FTX-a\\-b#"  // released element separator stays as data
        "UNT-3-M#"
        "UNZ-1-R7#";
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(ok, "custom UNA syntax parsed");

    EdifactParser parser;
    parser.feed("UNA^-,\\%#");
    check(parser.syntax().component == '^' && parser.syntax().element == '-' &&
              parser.syntax().decimal == ',' && parser.syntax().release == '\\' &&
              parser.syntax().repetition == '%' && parser.syntax().segment == '#',
          "syntax object updated from UNA");

    const Segment& ftx = collector.segments[2];
    check(ftx.elements[1].value() == "a-b",
          "custom release escapes custom element separator");
}

void test_malformed_and_truncated_una() {
    std::cout << "test_malformed_and_truncated_una\n";
    Collector duplicate;
    bool ok_dup = parse_bytewise("UNA::+,? 'UNB+X'", duplicate);
    check(!ok_dup, "duplicate service chars rejected");
    check(has_code(duplicate.errors, ErrorCode::MalformedUna),
          "malformed UNA reported");

    Collector truncated;
    EdifactParser parser(truncated.callbacks());
    parser.feed("UNA:+,?");
    bool ok_finish = parser.finish();
    check(!ok_finish, "truncated UNA rejected at finish");
    check(has_code(truncated.errors, ErrorCode::MalformedUna),
          "truncated UNA reported at finish");
}

void test_truncated_streams() {
    std::cout << "test_truncated_streams\n";
    Collector no_unz;
    parse_bytewise(
        "UNA:+,? 'UNB+UNOC:3+S+R+260101:1200+R8'"
        "UNH+M+ORDERS:D:96A:UN'UNT+2+M'",
        no_unz);
    check(has_code(no_unz.errors, ErrorCode::UnterminatedInterchange),
          "missing UNZ reported");

    Collector no_unt;
    parse_bytewise(
        "UNA:+,? 'UNB+UNOC:3+S+R+260101:1200+R9'"
        "UNH+M+ORDERS:D:96A:UN'DTM+1'",
        no_unt);
    check(has_code(no_unt.errors, ErrorCode::UnterminatedMessage),
          "missing UNT reported");
    check(has_code(no_unt.errors, ErrorCode::UnterminatedInterchange),
          "missing UNZ reported as well");
}

void test_two_interchanges_in_one_stream() {
    std::cout << "test_two_interchanges_in_one_stream\n";
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+A1'"
        "UNH+M+ORDERS:D:96A:UN'UNT+2+M'UNZ+1+A1'"
        "UNB+UNOC:3+S+R+260101:1300+A2'"
        "UNH+N+ORDERS:D:96A:UN'UNT+2+N'UNZ+1+A2'";
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(ok, "consecutive interchanges parse without error");
    check(collector.ic_starts.size() == 2, "two interchange starts");
    check(collector.ic_ends.size() == 2, "two interchange ends");
    check(collector.msg_ends.size() == 2, "two messages");
    check(collector.ic_ends[0].control_reference == "A1" &&
              collector.ic_ends[1].control_reference == "A2",
          "interchange references tracked independently");
}

void test_unt_without_unh_isolated() {
    std::cout << "test_unt_without_unh_isolated\n";
    std::string input =
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+RA'"
        "UNT+1+ORPHAN'"
        "UNH+M+ORDERS:D:96A:UN'UNT+2+M'"
        "UNZ+1+RA'";
    Collector collector;
    bool ok = parse_bytewise(input, collector);

    check(!ok, "orphan UNT flagged");
    check(has_code(collector.errors, ErrorCode::UntOutsideMessage),
          "UNT outside message reported");
    check(collector.msg_ends.size() == 1, "the real message still completes");
    check(collector.ic_ends[0].actual_message_count == 1,
          "interchange count based on real UNH only");
}

void test_non_numeric_count_rejected() {
    std::cout << "test_non_numeric_count_rejected\n";
    Collector collector;
    bool ok = parse_bytewise(
        "UNA:+,? '"
        "UNB+UNOC:3+S+R+260101:1200+RB'"
        "UNH+M+ORDERS:D:96A:UN'UNT+X+M'UNZ+1+RB'",
        collector);
    check(!ok, "non-numeric UNT count rejected");
    check(has_code(collector.errors, ErrorCode::InvalidUnsignedInteger),
          "invalid count reported");
}

}  // namespace

int main() {
    test_happy_path();
    test_default_syntax_without_una();
    test_release_escapes_terminator_and_separators();
    test_terminator_split_across_chunks();
    test_unt_count_mismatch_isolated();
    test_unz_count_checked_against_actual_messages();
    test_unz_reference_mismatch();
    test_custom_service_chars_via_una();
    test_malformed_and_truncated_una();
    test_truncated_streams();
    test_two_interchanges_in_one_stream();
    test_unt_without_unh_isolated();
    test_non_numeric_count_rejected();

    if (g_failures == 0) {
        std::cout << "All EDIFACT tests passed.\n";
        return 0;
    }
    std::cout << g_failures << " test(s) failed.\n";
    return 1;
}
