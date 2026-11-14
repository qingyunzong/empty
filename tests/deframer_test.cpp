#include "dataeng.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, std::string_view what) {
    if (!condition) {
        std::cerr << "FAIL: " << what << '\n';
        ++failures;
    }
}

using dataeng::Clock;
using dataeng::FramingMode;
using dataeng::SyslogDeframer;
using dataeng::Timestamp;

Timestamp at(int seconds) {
    return Timestamp(std::chrono::seconds(seconds));
}

void test_octet_basic_and_ranges() {
    SyslogDeframer deframer(FramingMode::OctetCounting);
    const auto frames = deframer.feed("11 hello world", at(10));
    check(frames.size() == 1, "one octet-counted frame");
    if (frames.size() != 1) {
        return;
    }
    const auto& frame = frames.front();
    check(frame.message() == "hello world", "octet message excludes prefix");
    check(frame.raw() == "11 hello world", "octet raw keeps prefix");
    check(frame.stream_begin == 0 && frame.stream_end == 14, "octet stream range");
    check(frame.message_begin == 3 && frame.message_end == 14, "octet message range");
    check(frame.received_at == at(10), "octet receive time");
    check(deframer.at_reliable_boundary(), "octet parser back at boundary");
}

void test_prefix_spans_chunks_and_embedded_newline() {
    SyslogDeframer deframer(FramingMode::OctetCounting);
    check(deframer.feed("1", at(1)).empty(), "partial first length digit");
    check(deframer.feed("1 ", at(2)).empty(), "partial prefix delimiter");
    const auto frames = deframer.feed("abc\ndef\nghi", at(3));
    check(frames.size() == 1, "newline bytes do not split octet frame");
    if (!frames.empty()) {
        check(frames.front().message() == "abc\ndef\nghi", "embedded LF retained");
        check(frames.front().first_received_at == at(1), "first chunk timestamp retained");
        check(frames.front().received_at == at(3), "last chunk timestamp retained");
    }

    const auto second = deframer.feed("1 x", at(4));
    check(second.size() == 1 && second.front().message() == "x",
          "parser resumes exactly after octet frame");
    check(second.front().stream_begin == 14, "second frame absolute offset");
}

void test_prefix_must_be_minimal_and_known_errors_skip_exactly() {
    SyslogDeframer deframer(FramingMode::OctetCounting);
    const auto frames = deframer.feed("05 hello1 x", at(5));
    check(deframer.errors_available() == 1, "leading zero is rejected");
    const auto error = deframer.next_error();
    check(error && error->code == dataeng::ErrorCode::NonMinimalLength,
          "leading zero error code");
    check(frames.size() == 1, "known bad length skips to exact boundary");
    if (!frames.empty()) {
        check(frames.front().message() == "x", "frame after exact skip");
        check(frames.front().stream_begin == 8, "exact skip preserves offsets");
    }

    SyslogDeframer separated(FramingMode::OctetCounting);
    const auto after_line = separated.feed("05 hello\n1 x", at(5));
    check(separated.errors_available() == 1,
          "one separator LF is consumed after an exact skip");
    check(after_line.size() == 1 && after_line.front().message() == "x",
          "record after separator LF");
}

void test_invalid_prefix_recovers_only_at_line_boundary() {
    SyslogDeframer deframer(FramingMode::OctetCounting);
    const auto frames = deframer.feed("noise\n1 a2 bc", at(6));
    check(deframer.errors_available() == 1, "invalid prefix reports one error");
    check(frames.size() == 2, "valid records after line boundary");
    if (frames.size() == 2) {
        check(frames[0].message() == "a", "first recovered record");
        check(frames[1].message() == "bc", "second recovered record");
        check(frames[0].stream_begin == 6, "recovery keeps absolute offsets");
    }
}

void test_non_transparent_mode() {
    SyslogDeframer deframer(FramingMode::NonTransparent);
    const auto frames = deframer.feed("<13>one\n<13>two\n", at(7));
    check(frames.size() == 2, "two non-transparent records");
    if (frames.size() == 2) {
        check(frames[0].message() == "<13>one", "non-transparent strips LF");
        check(frames[0].raw() == "<13>one\n", "non-transparent raw keeps LF");
        check(frames[0].stream_end == 8, "non-transparent absolute range");
        check(frames[1].stream_begin == 8, "second non-transparent range");
    }
    const auto split = deframer.feed("partial", at(8));
    check(split.empty(), "non-transparent waits for LF");
    const auto rest = deframer.feed("\n", at(9));
    check(rest.size() == 1 && rest.front().message() == "partial",
          "non-transparent split record");
    if (!rest.empty()) {
        check(rest.front().received_at == at(9), "LF chunk completed record time");
    }
}

void test_limits_and_incomplete() {
    dataeng::Config config;
    config.framing = FramingMode::OctetCounting;
    config.max_message_size = 3;
    SyslogDeframer deframer(config);
    const auto frames = deframer.feed("4 abcd1 z", at(11));
    check(frames.size() == 1 && frames.front().message() == "z",
          "oversized octet frame skipped exactly");
    check(deframer.errors_available() == 1, "oversized frame reports error");
    const auto error = deframer.next_error();
    check(error && error->code == dataeng::ErrorCode::FrameTooLarge,
          "oversized frame error code");

    SyslogDeframer incomplete(FramingMode::NonTransparent);
    incomplete.feed("tail", at(12));
    const auto eof = incomplete.finish(at(13));
    check(eof && eof->code == dataeng::ErrorCode::IncompleteFrame,
          "incomplete trailing record reported at EOF");
}

void test_callbacks() {
    SyslogDeframer deframer(FramingMode::OctetCounting);
    std::string seen;
    deframer.on_frame([&](const dataeng::Frame& frame) {
        seen.append(frame.message());
    });
    (void)deframer.feed("1 a1 b", at(14));
    check(seen == "ab", "frame callback order");
}

void test_large_frame_across_many_chunks() {
    dataeng::Config config;
    config.framing = FramingMode::OctetCounting;
    config.max_message_size = 0;
    SyslogDeframer deframer(config);

    const std::string message(200000, 'x');
    const std::string input = std::to_string(message.size()) + " " + message;
    std::vector<dataeng::Frame> frames;
    for (std::size_t offset = 0; offset < input.size(); offset += 7) {
        const auto part = std::string_view(input).substr(offset, 7);
        const auto produced = deframer.feed(part, at(20));
        frames.insert(frames.end(), produced.begin(), produced.end());
    }

    check(frames.size() == 1, "large split frame emitted once");
    if (!frames.empty()) {
        check(frames.front().message().size() == message.size(),
              "large split frame size");
        check(frames.front().message() == message, "large split frame bytes");
        check(frames.front().stream_begin == 0 &&
                  frames.front().stream_end == input.size(),
              "large split frame absolute range");
        check(frames.front().received_at == at(20),
              "large split frame completion time");
    }
}

}  // namespace

int main() {
    test_octet_basic_and_ranges();
    test_prefix_spans_chunks_and_embedded_newline();
    test_prefix_must_be_minimal_and_known_errors_skip_exactly();
    test_invalid_prefix_recovers_only_at_line_boundary();
    test_non_transparent_mode();
    test_limits_and_incomplete();
    test_callbacks();
    test_large_frame_across_many_chunks();

    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all deframer tests passed\n";
    return EXIT_SUCCESS;
}
