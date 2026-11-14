#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace dataeng {

using Clock = std::chrono::system_clock;
using Timestamp = Clock::time_point;
using ReceiveTime = Timestamp;

/// The two framing methods defined by RFC 6587.
///
/// The mode is always selected explicitly; the deframer never guesses it from
/// the first bytes of a stream.
enum class FramingMode {
    OctetCounting,
    NonTransparent,

    // Spelling aliases for callers that use the longer RFC terminology.
    OctetCounted = OctetCounting,
    NonTransparentFraming = NonTransparent,
    NewlineDelimited = NonTransparent,
};

using Framing = FramingMode;

inline constexpr FramingMode OctetCounting = FramingMode::OctetCounting;
inline constexpr FramingMode NonTransparent = FramingMode::NonTransparent;

enum class ErrorCode {
    InvalidLengthPrefix,
    NonMinimalLength,
    LengthOverflow,
    FrameTooLarge,
    EmptyFrame,
    IncompleteFrame,
};

using DeframeErrorCode = ErrorCode;

std::string_view error_code_name(ErrorCode code) noexcept;

/// A framing error. Errors never contain a partially decoded frame.
struct DeframeError {
    ErrorCode code = ErrorCode::InvalidLengthPrefix;
    std::string detail;

    /// Absolute byte range that caused the error. `stream_end` is the position
    /// at which the error was detected, not necessarily the end of the bad
    /// record.
    std::uint64_t stream_begin = 0;
    std::uint64_t stream_end = 0;

    /// Populated when a syntactically valid decimal length was available.
    std::uint64_t declared_length = 0;
    std::size_t length_digits = 0;

    /// Reception time associated with the first byte of the bad record.
    Timestamp received_at{};

    std::string_view name() const noexcept { return error_code_name(code); }
};

using Error = DeframeError;

struct ByteRange {
    std::uint64_t begin = 0;
    std::uint64_t end = 0;

    std::uint64_t size() const noexcept { return end - begin; }
    bool empty() const noexcept { return begin == end; }
};

/// A decoded frame.
///
/// `raw_bytes` is an exact copy of the bytes occupied by the frame in the
/// stream, including the RFC 6587 length prefix or the trailing LF. The
/// absolute range is [stream_begin, stream_end), and [message_begin,
/// message_end) is the SYSLOG-MSG range without framing bytes.
struct Frame {
    std::string raw_bytes;
    std::size_t message_offset = 0;
    std::size_t message_size = 0;

    std::uint64_t stream_begin = 0;
    std::uint64_t stream_end = 0;
    std::uint64_t message_begin = 0;
    std::uint64_t message_end = 0;

    /// Time of the chunk that completed this frame.
    Timestamp received_at{};
    /// Time of the chunk that contained the first byte of this frame.
    Timestamp first_received_at{};
    FramingMode framing = FramingMode::OctetCounting;

    std::string_view message() const noexcept {
        return std::string_view(raw_bytes).substr(message_offset, message_size);
    }
    std::string_view payload() const noexcept { return message(); }
    std::string_view syslog_message() const noexcept { return message(); }
    std::string_view raw() const noexcept { return raw_bytes; }
    std::string_view data() const noexcept { return raw_bytes; }

    std::uint64_t begin() const noexcept { return stream_begin; }
    std::uint64_t end() const noexcept { return stream_end; }
    ByteRange stream_range() const noexcept { return {stream_begin, stream_end}; }
    ByteRange message_range() const noexcept { return {message_begin, message_end}; }
    std::size_t size() const noexcept { return raw_bytes.size(); }
    bool empty() const noexcept { return raw_bytes.empty(); }
    Timestamp timestamp() const noexcept { return received_at; }
};

struct Config {
    FramingMode framing = FramingMode::OctetCounting;

    /// Maximum SYSLOG-MSG size in octets. Zero disables the limit.
    std::uint64_t max_message_size = 1024 * 1024;
    /// Compatibility alias. When non-zero, the lower of this value and
    /// max_message_size is used.
    std::uint64_t max_frame_size = 0;

    /// RFC 6587 permits at most 20 decimal digits for a uint64 length.
    std::size_t max_length_digits = 20;

    /// Non-transparent mode otherwise emits a zero-length message for an empty
    /// line, leaving semantic validation to the caller.
    bool emit_empty_frames = true;

    /// If false, parsing stops after the first error and requires reset().
    /// With the default, an impossible prefix is discarded through LF and the
    /// parser resumes only at the next line that starts with a valid prefix.
    /// A frame with a known declared length is skipped exactly, which is also
    /// a reliable frame boundary.
    bool recover_at_record_boundary = true;

    std::uint64_t effective_max_message_size() const noexcept {
        if (max_message_size == 0) {
            return max_frame_size;
        }
        if (max_frame_size == 0) {
            return max_message_size;
        }
        return std::min(max_message_size, max_frame_size);
    }
};

using Options = Config;
using DeframerConfig = Config;

/// Incremental, non-owning-connection syslog stream deframer.
///
/// The class owns only copied frame bytes and parser state. It is safe to
/// embed in a gateway and is not internally synchronized.
class SyslogDeframer {
public:
    SyslogDeframer() { reset_state(); }

    explicit SyslogDeframer(FramingMode mode) {
        config_.framing = mode;
        reset_state();
    }

    explicit SyslogDeframer(Config config) : config_(config) { reset_state(); }

    SyslogDeframer(FramingMode mode, std::uint64_t max_message_size) {
        config_.framing = mode;
        config_.max_message_size = max_message_size;
        reset_state();
    }

    /// Feed a chunk and return every frame completed by this call.
    ///
    /// The same frames are also queued for next()/poll()/pop(). The timestamp
    /// is associated with all bytes in this chunk.
    std::vector<Frame> feed(std::string_view bytes, Timestamp received_at = Clock::now()) {
        if (stopped_) {
            return {};
        }

        const std::size_t first_new = frames_.size();
        if (!bytes.empty()) {
            const std::uint64_t begin = stream_offset_;
            const std::uint64_t end = begin + static_cast<std::uint64_t>(bytes.size());
            buffer_.append(bytes.data(), bytes.size());
            append_metadata(begin, end, received_at);
            stream_offset_ = end;
            last_timestamp_ = received_at;
            process(received_at);
        }

        std::vector<Frame> completed;
        if (frames_.size() > first_new) {
            completed.reserve(frames_.size() - first_new);
        }
        for (std::size_t i = first_new; i < frames_.size(); ++i) {
            completed.push_back(frames_[i]);
        }
        return completed;
    }

    template <typename OtherClock, typename OtherDuration>
    std::vector<Frame> feed(
        std::string_view bytes,
        std::chrono::time_point<OtherClock, OtherDuration> received_at) {
        const Timestamp converted(std::chrono::duration_cast<Timestamp::duration>(
            received_at.time_since_epoch()));
        return feed(bytes, converted);
    }

    std::vector<Frame> push(std::string_view bytes, Timestamp received_at = Clock::now()) {
        return feed(bytes, received_at);
    }

    std::vector<Frame> append(std::string_view bytes, Timestamp received_at = Clock::now()) {
        return feed(bytes, received_at);
    }

    std::vector<Frame> feed(const char* data,
                            std::size_t size,
                            Timestamp received_at = Clock::now()) {
        return feed(std::string_view(data, size), received_at);
    }

    std::vector<Frame> feed(const unsigned char* data,
                            std::size_t size,
                            Timestamp received_at = Clock::now()) {
        return feed(std::string_view(reinterpret_cast<const char*>(data), size),
                    received_at);
    }

    std::optional<Frame> next() {
        if (frames_.empty()) {
            return std::nullopt;
        }
        Frame frame = std::move(frames_.front());
        frames_.pop_front();
        return frame;
    }

    std::optional<Frame> poll() { return next(); }
    std::optional<Frame> pop() { return next(); }

    std::optional<DeframeError> next_error() {
        if (errors_.empty()) {
            return std::nullopt;
        }
        DeframeError error = std::move(errors_.front());
        errors_.pop_front();
        return error;
    }

    std::optional<DeframeError> poll_error() { return next_error(); }

    std::size_t frames_available() const noexcept { return frames_.size(); }
    std::size_t errors_available() const noexcept { return errors_.size(); }
    bool has_frames() const noexcept { return !frames_.empty(); }
    bool has_errors() const noexcept { return !errors_.empty(); }

    /// True when there is no partial prefix, partial message, or active resync.
    bool at_reliable_boundary() const noexcept {
        if (stopped_) {
            return false;
        }
        if (config_.framing == FramingMode::OctetCounting) {
            return state_ == State::OctetPrefix && read_pos_ == buffer_.size();
        }
        return state_ == State::NonTransparentScan && read_pos_ == buffer_.size();
    }

    std::uint64_t bytes_fed() const noexcept { return stream_offset_; }
    std::size_t buffered_bytes() const noexcept { return buffer_.size() - read_pos_; }
    bool stopped() const noexcept { return stopped_; }
    FramingMode framing_mode() const noexcept { return config_.framing; }
    FramingMode mode() const noexcept { return config_.framing; }
    const Config& config() const noexcept { return config_; }

    SyslogDeframer& set_framing_mode(FramingMode mode) {
        if (config_.framing != mode) {
            config_.framing = mode;
            clear_pending();
        }
        return *this;
    }

    SyslogDeframer& set_mode(FramingMode mode) { return set_framing_mode(mode); }

    SyslogDeframer& set_max_message_size(std::uint64_t bytes) {
        config_.max_message_size = bytes;
        config_.max_frame_size = 0;
        return *this;
    }

    SyslogDeframer& set_max_frame_size(std::uint64_t bytes) {
        return set_max_message_size(bytes);
    }

    SyslogDeframer& set_recovery(bool recover_at_record_boundary) {
        config_.recover_at_record_boundary = recover_at_record_boundary;
        return *this;
    }

    SyslogDeframer& configure(Config config) {
        config_ = config;
        clear_pending();
        return *this;
    }

    SyslogDeframer& configure(FramingMode mode) {
        return set_framing_mode(mode);
    }

    void on_frame(std::function<void(const Frame&)> callback) {
        frame_callback_ = std::move(callback);
    }

    void on_error(std::function<void(const DeframeError&)> callback) {
        error_callback_ = std::move(callback);
    }

    /// Clear parser state and queued results, and restart stream offsets at 0.
    void reset() {
        buffer_.clear();
        metadata_.clear();
        frames_.clear();
        errors_.clear();
        read_pos_ = 0;
        buffer_begin_ = 0;
        stream_offset_ = 0;
        stopped_ = false;
        skip_remaining_ = 0;
        pending_length_ = 0;
        pending_prefix_ = 0;
        pending_frame_begin_ = 0;
        accept_separator_lf_ = false;
        reset_state();
    }

    /// The caller has found an external transport boundary (for example after
    /// reconnecting). Discard partial input but keep absolute offsets, config,
    /// and already queued results.
    void resync() {
        clear_pending();
    }

    /// Report leftover bytes as an incomplete frame at end of stream. New input
    /// should not be fed afterwards without reset().
    std::optional<DeframeError> finish(Timestamp received_at = Clock::now()) {
        if (stopped_ || at_reliable_boundary()) {
            return std::nullopt;
        }
        const std::uint64_t begin = state_ == State::OctetSkipExact
                                        ? pending_frame_begin_
                                        : absolute(read_pos_);
        const std::uint64_t end = absolute(buffer_.size());
        report_error(ErrorCode::IncompleteFrame, begin, end,
                     pending_length_, pending_prefix_, "truncated frame at end of stream",
                     received_at);
        clear_pending();
        stopped_ = true;
        return errors_.empty() ? std::nullopt
                               : std::optional<DeframeError>(errors_.back());
    }

private:
    enum class State {
        OctetPrefix,
        OctetPayload,
        OctetSkipExact,
        OctetResyncDiscardLine,
        OctetResyncCandidate,
        NonTransparentScan,
        NonTransparentDiscardLine,
    };

    struct ChunkMetadata {
        std::uint64_t begin = 0;
        std::uint64_t end = 0;
        Timestamp received_at{};
    };

    struct PrefixInspection {
        enum class Status {
            NeedMore,
            Valid,
            InvalidNoLength,
            InvalidKnownLength,
            Overflow,
        };

        Status status = Status::NeedMore;
        std::size_t prefix_bytes = 0;
        std::size_t digit_count = 0;
        std::uint64_t length = 0;
        bool leading_zero = false;
        std::string detail;
    };

    Config config_{};
    std::string buffer_;
    std::vector<ChunkMetadata> metadata_;
    std::deque<Frame> frames_;
    std::deque<DeframeError> errors_;
    std::function<void(const Frame&)> frame_callback_;
    std::function<void(const DeframeError&)> error_callback_;

    std::size_t read_pos_ = 0;
    std::uint64_t buffer_begin_ = 0;
    std::uint64_t stream_offset_ = 0;
    Timestamp last_timestamp_{};

    State state_ = State::OctetPrefix;
    std::uint64_t pending_length_ = 0;
    std::size_t pending_prefix_ = 0;
    std::uint64_t pending_frame_begin_ = 0;
    std::uint64_t skip_remaining_ = 0;
    bool accept_separator_lf_ = false;
    bool stopped_ = false;

    static bool is_digit(char c) noexcept {
        return c >= '0' && c <= '9';
    }

    void reset_state() noexcept {
        state_ = config_.framing == FramingMode::OctetCounting
                     ? State::OctetPrefix
                     : State::NonTransparentScan;
    }

    std::uint64_t absolute(std::size_t position) const noexcept {
        return buffer_begin_ + static_cast<std::uint64_t>(position);
    }

    std::size_t available() const noexcept {
        return buffer_.size() - read_pos_;
    }

    void append_metadata(std::uint64_t begin, std::uint64_t end, Timestamp at) {
        if (!metadata_.empty() && metadata_.back().end == begin &&
            metadata_.back().received_at == at) {
            metadata_.back().end = end;
            return;
        }
        metadata_.push_back(ChunkMetadata{begin, end, at});
    }

    Timestamp timestamp_at(std::uint64_t absolute_offset, Timestamp fallback) const {
        for (auto it = metadata_.rbegin(); it != metadata_.rend(); ++it) {
            if (absolute_offset >= it->begin && absolute_offset < it->end) {
                return it->received_at;
            }
        }
        return fallback;
    }

    void trim_metadata() {
        while (!metadata_.empty() && metadata_.front().end <= buffer_begin_) {
            metadata_.erase(metadata_.begin());
        }
    }

    void consume(std::size_t bytes) {
        read_pos_ += bytes;
        if (read_pos_ == 0) {
            return;
        }
        if (read_pos_ == buffer_.size()) {
            buffer_begin_ += static_cast<std::uint64_t>(read_pos_);
            buffer_.clear();
            read_pos_ = 0;
            trim_metadata();
            return;
        }
        constexpr std::size_t compact_threshold = 64 * 1024;
        if (read_pos_ >= compact_threshold && read_pos_ >= buffer_.size() / 2) {
            buffer_.erase(0, read_pos_);
            buffer_begin_ += static_cast<std::uint64_t>(read_pos_);
            read_pos_ = 0;
            trim_metadata();
        }
    }

    void clear_pending() {
        metadata_.clear();
        buffer_.clear();
        buffer_begin_ = stream_offset_;
        read_pos_ = 0;
        skip_remaining_ = 0;
        pending_length_ = 0;
        pending_prefix_ = 0;
        pending_frame_begin_ = 0;
        accept_separator_lf_ = false;
        stopped_ = false;
        reset_state();
    }

    void report_error(ErrorCode code,
                      std::uint64_t begin,
                      std::uint64_t end,
                      std::uint64_t declared_length,
                      std::size_t digits,
                      std::string detail,
                      Timestamp fallback) {
        DeframeError error;
        error.code = code;
        error.detail = std::move(detail);
        error.stream_begin = begin;
        error.stream_end = end;
        error.declared_length = declared_length;
        error.length_digits = digits;
        error.received_at = timestamp_at(begin, fallback);
        errors_.push_back(error);
        if (error_callback_) {
            error_callback_(errors_.back());
        }
        if (!config_.recover_at_record_boundary) {
            stopped_ = true;
        }
    }

    PrefixInspection inspect_octet_prefix() const {
        PrefixInspection result;
        const std::size_t n = available();
        if (n == 0) {
            return result;
        }

        const char* data = buffer_.data() + read_pos_;
        if (!is_digit(data[0])) {
            result.status = PrefixInspection::Status::InvalidNoLength;
            result.detail = "length prefix must start with a decimal digit";
            return result;
        }

        result.leading_zero = data[0] == '0';
        std::uint64_t value = 0;
        bool overflow = false;

        for (std::size_t i = 0; i < n; ++i) {
            const char c = data[i];
            if (is_digit(c)) {
                ++result.digit_count;
                const std::uint64_t digit = static_cast<std::uint64_t>(c - '0');
                if (!overflow) {
                    if (value > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) {
                        overflow = true;
                    } else {
                        value = value * 10 + digit;
                    }
                }
                if (overflow || result.digit_count > config_.max_length_digits) {
                    result.status = PrefixInspection::Status::Overflow;
                    result.prefix_bytes = i + 1;
                    result.length = value;
                    result.detail = "length prefix exceeds the supported decimal range";
                    return result;
                }
                continue;
            }

            if (c == ' ') {
                result.prefix_bytes = i + 1;
                result.length = value;
                if (result.leading_zero) {
                    result.status = PrefixInspection::Status::InvalidKnownLength;
                    result.detail = "length prefix has a leading zero";
                } else {
                    result.status = PrefixInspection::Status::Valid;
                }
                return result;
            }

            result.status = PrefixInspection::Status::InvalidNoLength;
            result.prefix_bytes = i;
            result.detail = "length prefix must be followed by one SP";
            return result;
        }

        // A split prefix is not an error until its terminator is known.
        result.status = PrefixInspection::Status::NeedMore;
        result.length = value;
        return result;
    }

    void process(Timestamp now) {
        while (!stopped_) {
            switch (state_) {
                case State::OctetPrefix: {
                    if (available() != 0) {
                        if (accept_separator_lf_ && buffer_[read_pos_] == '\n') {
                            accept_separator_lf_ = false;
                            consume(1);
                            continue;
                        }
                        accept_separator_lf_ = false;
                    }

                    const PrefixInspection prefix = inspect_octet_prefix();
                    if (prefix.status == PrefixInspection::Status::NeedMore) {
                        return;
                    }

                    const std::uint64_t begin = absolute(read_pos_);
                    const std::uint64_t detected_end =
                        begin + static_cast<std::uint64_t>(
                                    std::max<std::size_t>(prefix.prefix_bytes, 1));

                    if (prefix.status == PrefixInspection::Status::InvalidNoLength) {
                        report_error(ErrorCode::InvalidLengthPrefix, begin, detected_end, 0,
                                     prefix.digit_count, prefix.detail, now);
                        if (stopped_) {
                            return;
                        }
                        state_ = State::OctetResyncDiscardLine;
                        continue;
                    }

                    if (prefix.status == PrefixInspection::Status::Overflow) {
                        report_error(ErrorCode::LengthOverflow, begin, detected_end, 0,
                                     prefix.digit_count, prefix.detail, now);
                        if (stopped_) {
                            return;
                        }
                        state_ = State::OctetResyncDiscardLine;
                        continue;
                    }

                    if (prefix.status ==
                        PrefixInspection::Status::InvalidKnownLength) {
                        report_error(ErrorCode::NonMinimalLength, begin, detected_end,
                                     prefix.length, prefix.digit_count, prefix.detail, now);
                        if (stopped_) {
                            return;
                        }
                        start_exact_skip(begin, prefix.prefix_bytes, prefix.length);
                        continue;
                    }

                    const std::uint64_t size_t_max =
                        static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max());
                    if (prefix.length > size_t_max ||
                        static_cast<std::uint64_t>(prefix.prefix_bytes) > size_t_max - prefix.length) {
                        report_error(ErrorCode::LengthOverflow, begin, detected_end, 0,
                                     prefix.digit_count,
                                     "declared length cannot be represented in memory",
                                     now);
                        if (stopped_) {
                            return;
                        }
                        state_ = State::OctetResyncDiscardLine;
                        continue;
                    }

                    const std::uint64_t max = config_.effective_max_message_size();
                    if (max != 0 && prefix.length > max) {
                        report_error(ErrorCode::FrameTooLarge, begin, detected_end,
                                     prefix.length, prefix.digit_count,
                                     "declared SYSLOG-MSG length exceeds max_message_size",
                                     now);
                        if (stopped_) {
                            return;
                        }
                        start_exact_skip(begin, prefix.prefix_bytes, prefix.length);
                        continue;
                    }

                    pending_prefix_ = prefix.prefix_bytes;
                    pending_length_ = prefix.length;
                    pending_frame_begin_ = begin;
                    state_ = State::OctetPayload;
                    continue;
                }

                case State::OctetPayload: {
                    const std::uint64_t total =
                        static_cast<std::uint64_t>(pending_prefix_) + pending_length_;
                    if (total > static_cast<std::uint64_t>(available())) {
                        return;
                    }
                    emit_octet_frame(static_cast<std::size_t>(total), now);
                    continue;
                }

                case State::OctetSkipExact: {
                    if (skip_remaining_ == 0) {
                        pending_length_ = 0;
                        pending_prefix_ = 0;
                        state_ = State::OctetPrefix;
                        continue;
                    }
                    const std::uint64_t take =
                        std::min<std::uint64_t>(skip_remaining_, available());
                    if (take == 0) {
                        return;
                    }
                    consume(static_cast<std::size_t>(take));
                    skip_remaining_ -= take;
                    continue;
                }

                case State::OctetResyncDiscardLine: {
                    const std::size_t n = available();
                    if (n == 0) {
                        return;
                    }
                    const char* data = buffer_.data() + read_pos_;
                    const void* found = std::memchr(data, '\n', n);
                    if (found == nullptr) {
                        consume(n);
                        return;
                    }
                    const std::size_t through =
                        static_cast<const char*>(found) - data + 1;
                    consume(through);
                    state_ = State::OctetResyncCandidate;
                    continue;
                }

                case State::OctetResyncCandidate: {
                    if (available() == 0) {
                        return;
                    }
                    const PrefixInspection prefix = inspect_octet_prefix();
                    if (prefix.status == PrefixInspection::Status::NeedMore) {
                        return;
                    }
                    if (prefix.status ==
                        PrefixInspection::Status::InvalidNoLength) {
                        state_ = State::OctetResyncDiscardLine;
                        continue;
                    }
                    // A complete decimal prefix at a line start is a usable
                    // record boundary. Let the normal parser validate and
                    // account for it.
                    state_ = State::OctetPrefix;
                    continue;
                }

                case State::NonTransparentScan: {
                    const std::size_t n = available();
                    const char* data = buffer_.data() + read_pos_;
                    const void* found = n == 0 ? nullptr : std::memchr(data, '\n', n);
                    if (found == nullptr) {
                        const std::uint64_t max = config_.effective_max_message_size();
                        if (max != 0 && static_cast<std::uint64_t>(n) > max) {
                            const std::uint64_t begin = absolute(read_pos_);
                            report_error(ErrorCode::FrameTooLarge, begin,
                                         begin + static_cast<std::uint64_t>(n), n, 0,
                                         "non-transparent message exceeds max_message_size",
                                         now);
                            if (stopped_) {
                                return;
                            }
                            state_ = State::NonTransparentDiscardLine;
                            continue;
                        }
                        return;
                    }

                    const std::size_t message_size =
                        static_cast<const char*>(found) - data;
                    const std::size_t raw_size = message_size + 1;
                    const std::uint64_t begin = absolute(read_pos_);
                    const std::uint64_t end =
                        begin + static_cast<std::uint64_t>(raw_size);
                    const std::uint64_t max = config_.effective_max_message_size();

                    if (max != 0 && static_cast<std::uint64_t>(message_size) > max) {
                        report_error(ErrorCode::FrameTooLarge, begin, end,
                                     message_size, 0,
                                     "non-transparent message exceeds max_message_size",
                                     now);
                        if (stopped_) {
                            return;
                        }
                        consume(raw_size);
                        continue;
                    }

                    if (message_size == 0 && !config_.emit_empty_frames) {
                        report_error(ErrorCode::EmptyFrame, begin, end, 0, 0,
                                     "empty non-transparent frame", now);
                        if (stopped_) {
                            return;
                        }
                        consume(raw_size);
                        continue;
                    }

                    emit_non_transparent_frame(raw_size, message_size, now);
                    continue;
                }

                case State::NonTransparentDiscardLine: {
                    const std::size_t n = available();
                    if (n == 0) {
                        return;
                    }
                    const char* data = buffer_.data() + read_pos_;
                    const void* found = std::memchr(data, '\n', n);
                    if (found == nullptr) {
                        consume(n);
                        return;
                    }
                    const std::size_t through =
                        static_cast<const char*>(found) - data + 1;
                    consume(through);
                    state_ = State::NonTransparentScan;
                    continue;
                }
            }
        }
    }

    void start_exact_skip(std::uint64_t frame_begin,
                          std::size_t prefix_bytes,
                          std::uint64_t message_length) {
        consume(prefix_bytes);
        skip_remaining_ = message_length;
        pending_length_ = message_length;
        pending_prefix_ = 0;
        pending_frame_begin_ = frame_begin;
        accept_separator_lf_ = true;
        state_ = State::OctetSkipExact;
    }

    void emit_octet_frame(std::size_t total, Timestamp fallback) {
        const std::uint64_t begin = absolute(read_pos_);
        const std::uint64_t end = begin + static_cast<std::uint64_t>(total);

        Frame frame;
        frame.raw_bytes.assign(buffer_.data() + read_pos_, total);
        frame.message_offset = pending_prefix_;
        frame.message_size = static_cast<std::size_t>(pending_length_);
        frame.stream_begin = begin;
        frame.stream_end = end;
        frame.message_begin = begin + static_cast<std::uint64_t>(pending_prefix_);
        frame.message_end = end;
        frame.first_received_at = timestamp_at(begin, fallback);
        frame.received_at = timestamp_at(end - 1, fallback);
        frame.framing = FramingMode::OctetCounting;

        consume(total);
        pending_length_ = 0;
        pending_prefix_ = 0;
        pending_frame_begin_ = 0;
        state_ = State::OctetPrefix;
        enqueue(std::move(frame));
    }

    void emit_non_transparent_frame(std::size_t raw_size,
                                    std::size_t message_size,
                                    Timestamp fallback) {
        const std::uint64_t begin = absolute(read_pos_);
        const std::uint64_t end = begin + static_cast<std::uint64_t>(raw_size);

        Frame frame;
        frame.raw_bytes.assign(buffer_.data() + read_pos_, raw_size);
        frame.message_offset = 0;
        frame.message_size = message_size;
        frame.stream_begin = begin;
        frame.stream_end = end;
        frame.message_begin = begin;
        frame.message_end = begin + static_cast<std::uint64_t>(message_size);
        frame.first_received_at = timestamp_at(begin, fallback);
        frame.received_at = timestamp_at(end - 1, fallback);
        frame.framing = FramingMode::NonTransparent;

        consume(raw_size);
        enqueue(std::move(frame));
    }

    void enqueue(Frame frame) {
        if (frame_callback_) {
            frame_callback_(frame);
        }
        frames_.push_back(std::move(frame));
    }
};

using SyslogStreamDeframer = SyslogDeframer;
using Deframer = SyslogDeframer;
using SyslogFramer = SyslogDeframer;
using SyslogParser = SyslogDeframer;
using SyslogStreamParser = SyslogDeframer;
using SyslogSplitter = SyslogDeframer;
using SyslogStreamSplitter = SyslogDeframer;
using StreamDeframer = SyslogDeframer;

namespace syslog {
using dataeng::Config;
using dataeng::DeframeError;
using dataeng::Deframer;
using dataeng::Error;
using dataeng::ErrorCode;
using dataeng::Frame;
using dataeng::Framing;
using dataeng::FramingMode;
using dataeng::StreamDeframer;
using dataeng::SyslogDeframer;
using dataeng::SyslogFramer;
using dataeng::SyslogParser;
using dataeng::SyslogSplitter;
using dataeng::SyslogStreamDeframer;
using dataeng::SyslogStreamParser;
using dataeng::SyslogStreamSplitter;
using dataeng::Timestamp;
}  // namespace syslog

inline std::string_view error_code_name(ErrorCode code) noexcept {
    switch (code) {
        case ErrorCode::InvalidLengthPrefix:
            return "InvalidLengthPrefix";
        case ErrorCode::NonMinimalLength:
            return "NonMinimalLength";
        case ErrorCode::LengthOverflow:
            return "LengthOverflow";
        case ErrorCode::FrameTooLarge:
            return "FrameTooLarge";
        case ErrorCode::EmptyFrame:
            return "EmptyFrame";
        case ErrorCode::IncompleteFrame:
            return "IncompleteFrame";
    }
    return "Unknown";
}

/// One-shot convenience wrapper. It returns all complete frames in `bytes` and
/// discards errors. Use SyslogDeframer when errors or chunk timestamps matter.
inline std::vector<Frame> deframe(std::string_view bytes,
                                  FramingMode mode = FramingMode::OctetCounting,
                                  Timestamp received_at = Clock::now()) {
    SyslogDeframer deframer(mode);
    return deframer.feed(bytes, received_at);
}

}  // namespace dataeng
