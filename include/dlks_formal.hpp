#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <string_view>

namespace dlks_formal {

inline constexpr std::uint32_t kDefaultInitialWindowSize = 65'535;
inline constexpr std::uint32_t kMaxWindowSize = 0x7fff'ffff;
inline constexpr std::uint32_t kMaxStreamId = 0x7fff'ffff;
inline constexpr std::uint32_t kDefaultMaxFrameSize = 16'384;
inline constexpr std::uint32_t kMaxMaxFrameSize = 0x00ff'ffff;
inline constexpr std::uint32_t kMinPriorityWeight = 1;
inline constexpr std::uint32_t kMaxPriorityWeight = 256;

enum class ErrorCode : std::uint32_t {
    no_error = 0x00,
    protocol_error = 0x01,
    internal_error = 0x02,
    flow_control_error = 0x03,
    settings_timeout = 0x04,
    stream_closed = 0x05,
    frame_size_error = 0x06,
    refused_stream = 0x07,
    cancel = 0x08,
    compression_error = 0x09,
    connect_error = 0x0a,
    enhance_your_calm = 0x0b,
    inadequate_security = 0x0c,
    http_1_1_required = 0x0d,
};

enum class ErrorScope : std::uint8_t {
    connection,
    stream,
};

struct Error {
    ErrorCode code = ErrorCode::no_error;
    ErrorScope scope = ErrorScope::connection;
    std::uint32_t stream_id = 0;

    friend bool operator==(const Error&, const Error&) = default;
};

struct Priority {
    std::uint32_t weight = 16;

    friend bool operator==(const Priority&, const Priority&) = default;
};

struct Settings {
    std::optional<std::uint32_t> initial_window_size;
    std::optional<std::uint32_t> max_frame_size;
};

struct Config {
    std::uint32_t connection_send_window = kDefaultInitialWindowSize;
    std::uint32_t peer_initial_window_size = kDefaultInitialWindowSize;
    std::uint32_t peer_max_frame_size = kDefaultMaxFrameSize;
};

struct DataFrame {
    std::uint32_t stream_id = 0;
    std::uint32_t length = 0;

    friend bool operator==(const DataFrame&, const DataFrame&) = default;
};

using SendGrant = DataFrame;

[[nodiscard]] inline constexpr std::string_view to_string(ErrorCode code) noexcept {
    switch (code) {
    case ErrorCode::no_error: return "NO_ERROR";
    case ErrorCode::protocol_error: return "PROTOCOL_ERROR";
    case ErrorCode::internal_error: return "INTERNAL_ERROR";
    case ErrorCode::flow_control_error: return "FLOW_CONTROL_ERROR";
    case ErrorCode::settings_timeout: return "SETTINGS_TIMEOUT";
    case ErrorCode::stream_closed: return "STREAM_CLOSED";
    case ErrorCode::frame_size_error: return "FRAME_SIZE_ERROR";
    case ErrorCode::refused_stream: return "REFUSED_STREAM";
    case ErrorCode::cancel: return "CANCEL";
    case ErrorCode::compression_error: return "COMPRESSION_ERROR";
    case ErrorCode::connect_error: return "CONNECT_ERROR";
    case ErrorCode::enhance_your_calm: return "ENHANCE_YOUR_CALM";
    case ErrorCode::inadequate_security: return "INADEQUATE_SECURITY";
    case ErrorCode::http_1_1_required: return "HTTP_1_1_REQUIRED";
    }
    return "UNKNOWN_ERROR";
}

[[nodiscard]] inline constexpr std::string_view to_string(ErrorScope scope) noexcept {
    return scope == ErrorScope::connection ? "connection" : "stream";
}

class FlowController {
public:
    explicit FlowController(Config config = {}) noexcept
        : connection_send_window_(static_cast<std::int64_t>(
              std::min(config.connection_send_window, kMaxWindowSize))),
          peer_initial_window_size_(std::min(config.peer_initial_window_size, kMaxWindowSize)),
          peer_max_frame_size_(
              std::clamp(config.peer_max_frame_size, kDefaultMaxFrameSize, kMaxMaxFrameSize)) {}

    [[nodiscard]] std::optional<Error> open_stream(
        std::uint32_t stream_id,
        Priority priority = {}) {
        if (stream_id == 0 || stream_id > kMaxStreamId ||
            streams_.contains(stream_id)) {
            return Error{ErrorCode::protocol_error, ErrorScope::stream, stream_id};
        }

        Stream stream;
        stream.send_window = static_cast<std::int64_t>(peer_initial_window_size_);
        stream.weight = normalize_weight(priority.weight);
        streams_.emplace(stream_id, stream);
        return std::nullopt;
    }

    [[nodiscard]] std::optional<Error> set_priority(
        std::uint32_t stream_id,
        Priority priority) noexcept {
        auto* stream = find_active(stream_id);
        if (stream == nullptr) {
            return Error{ErrorCode::stream_closed, ErrorScope::stream, stream_id};
        }

        stream->weight = normalize_weight(priority.weight);
        return std::nullopt;
    }

    [[nodiscard]] std::optional<Error> enqueue_data(
        std::uint32_t stream_id,
        std::uint64_t bytes) noexcept {
        auto* stream = find_active(stream_id);
        if (stream == nullptr) {
            return Error{ErrorCode::stream_closed, ErrorScope::stream, stream_id};
        }
        if (bytes == 0) {
            return std::nullopt;
        }

        if (stream->pending == 0) {
            stream->finish = std::max(stream->finish, virtual_time_);
        }
        const auto room = std::numeric_limits<std::uint64_t>::max() - stream->pending;
        stream->pending += std::min(bytes, room);
        return std::nullopt;
    }

    [[nodiscard]] std::optional<DataFrame> reserve_data(
        std::uint32_t stream_id,
        std::uint64_t wanted,
        std::uint32_t max_frame_size = kDefaultMaxFrameSize) noexcept {
        if (connection_failed_ || wanted == 0) {
            return std::nullopt;
        }

        auto* stream = find_active(stream_id);
        if (stream == nullptr || stream->send_window <= 0 || connection_send_window_ <= 0) {
            return std::nullopt;
        }

        const auto frame_cap =
            std::min<std::uint64_t>(max_frame_size, peer_max_frame_size_);
        const auto available = std::min<std::int64_t>(
            connection_send_window_, stream->send_window);
        const auto length = static_cast<std::uint32_t>(std::min<std::uint64_t>({
            wanted,
            static_cast<std::uint64_t>(available),
            frame_cap,
        }));
        if (length == 0) {
            return std::nullopt;
        }

        if (stream->pending != 0) {
            stream->pending -= std::min<std::uint64_t>(stream->pending, length);
        }
        consume(*stream, length);
        return DataFrame{stream_id, length};
    }

    [[nodiscard]] std::optional<DataFrame> next_frame(
        std::uint32_t max_frame_size = kDefaultMaxFrameSize) noexcept {
        if (connection_failed_ || connection_send_window_ <= 0) {
            return std::nullopt;
        }

        const auto frame_cap =
            std::min<std::uint64_t>(max_frame_size, peer_max_frame_size_);
        if (frame_cap == 0) {
            return std::nullopt;
        }

        Stream* best = nullptr;
        std::uint32_t best_id = 0;
        std::uint64_t best_start = 0;

        for (auto& [stream_id, stream] : streams_) {
            if (!is_runnable(stream_id, stream)) {
                continue;
            }

            const auto start = std::max(stream.finish, virtual_time_);
            const bool better =
                best == nullptr ||
                start < best_start ||
                (start == best_start && stream.weight > best->weight) ||
                (start == best_start && stream.weight == best->weight &&
                 stream_id < best_id);
            if (better) {
                best = &stream;
                best_id = stream_id;
                best_start = start;
            }
        }

        if (best == nullptr) {
            return std::nullopt;
        }

        const auto available = std::min<std::int64_t>(
            connection_send_window_, best->send_window);
        const auto length = static_cast<std::uint32_t>(std::min<std::uint64_t>({
            best->pending,
            static_cast<std::uint64_t>(available),
            frame_cap,
        }));
        if (length == 0) {
            return std::nullopt;
        }

        best->pending -= length;
        consume(*best, length);
        return DataFrame{best_id, length};
    }

    [[nodiscard]] std::optional<Error> receive_window_update(
        std::uint32_t stream_id,
        std::uint32_t increment) noexcept {
        if (connection_failed_) {
            return std::nullopt;
        }

        if (stream_id == 0) {
            if (increment == 0) {
                return fail_connection(ErrorCode::protocol_error);
            }
            if (connection_send_window_ + static_cast<std::int64_t>(increment) >
                static_cast<std::int64_t>(kMaxWindowSize)) {
                return fail_connection(ErrorCode::flow_control_error);
            }
            connection_send_window_ += increment;
            return std::nullopt;
        }

        auto it = streams_.find(stream_id);
        if (it == streams_.end()) {
            return fail_connection(ErrorCode::protocol_error);
        }
        if (it->second.reset || it->second.send_closed) {
            return std::nullopt;
        }
        if (increment == 0) {
            return fail_stream(it->second, stream_id, ErrorCode::protocol_error);
        }
        if (it->second.send_window + static_cast<std::int64_t>(increment) >
            static_cast<std::int64_t>(kMaxWindowSize)) {
            return fail_stream(it->second, stream_id, ErrorCode::flow_control_error);
        }

        it->second.send_window += increment;
        return std::nullopt;
    }

    [[nodiscard]] std::optional<Error> apply_settings(const Settings& settings) noexcept {
        if (connection_failed_) {
            return std::nullopt;
        }

        if (settings.max_frame_size.has_value() &&
            (*settings.max_frame_size < kDefaultMaxFrameSize ||
             *settings.max_frame_size > kMaxMaxFrameSize)) {
            return fail_connection(ErrorCode::protocol_error);
        }
        if (settings.initial_window_size.has_value() &&
            *settings.initial_window_size > kMaxWindowSize) {
            return fail_connection(ErrorCode::flow_control_error);
        }

        if (settings.initial_window_size.has_value()) {
            const auto delta =
                static_cast<std::int64_t>(*settings.initial_window_size) -
                static_cast<std::int64_t>(peer_initial_window_size_);

            if (delta != 0) {
                for (const auto& [stream_id, stream] : streams_) {
                    if (stream.reset) {
                        continue;
                    }
                    if (stream.send_window + delta >
                        static_cast<std::int64_t>(kMaxWindowSize)) {
                        return fail_connection(ErrorCode::flow_control_error);
                    }
                }
                for (auto& [stream_id, stream] : streams_) {
                    if (!stream.reset) {
                        stream.send_window += delta;
                    }
                }
            }
            peer_initial_window_size_ = *settings.initial_window_size;
        }

        if (settings.max_frame_size.has_value()) {
            peer_max_frame_size_ = *settings.max_frame_size;
        }
        return std::nullopt;
    }

    [[nodiscard]] std::optional<Error> set_peer_initial_window_size(
        std::uint32_t initial_window_size) noexcept {
        Settings settings;
        settings.initial_window_size = initial_window_size;
        return apply_settings(settings);
    }

    [[nodiscard]] std::optional<Error> receive_settings(
        const Settings& settings) noexcept {
        return apply_settings(settings);
    }

    [[nodiscard]] std::optional<Error> reset_stream(std::uint32_t stream_id) noexcept {
        if (stream_id == 0) {
            return fail_connection(ErrorCode::protocol_error);
        }

        auto it = streams_.find(stream_id);
        if (it == streams_.end()) {
            return fail_connection(ErrorCode::protocol_error);
        }
        if (it->second.reset) {
            return std::nullopt;
        }

        it->second.reset = true;
        it->second.send_closed = true;
        it->second.pending = 0;
        return std::nullopt;
    }

    [[nodiscard]] std::optional<Error> receive_rst_stream(
        std::uint32_t stream_id) noexcept {
        return reset_stream(stream_id);
    }

    [[nodiscard]] std::optional<Error> end_send(std::uint32_t stream_id) noexcept {
        auto* stream = find_active(stream_id);
        if (stream == nullptr) {
            return Error{ErrorCode::stream_closed, ErrorScope::stream, stream_id};
        }

        stream->send_closed = true;
        stream->pending = 0;
        return std::nullopt;
    }

    [[nodiscard]] std::uint64_t sendable_bytes(std::uint32_t stream_id) const noexcept {
        auto it = streams_.find(stream_id);
        if (it == streams_.end() || it->second.reset || it->second.send_closed) {
            return 0;
        }
        if (connection_failed_ || connection_send_window_ <= 0 ||
            it->second.send_window <= 0) {
            return 0;
        }
        return static_cast<std::uint64_t>(
            std::min(connection_send_window_, it->second.send_window));
    }

    [[nodiscard]] std::uint64_t sendable(std::uint32_t stream_id) const noexcept {
        return sendable_bytes(stream_id);
    }

    [[nodiscard]] std::uint64_t connection_sendable() const noexcept {
        if (connection_failed_ || connection_send_window_ <= 0) {
            return 0;
        }
        return static_cast<std::uint64_t>(connection_send_window_);
    }

    [[nodiscard]] std::int64_t connection_send_window() const noexcept {
        return connection_send_window_;
    }

    [[nodiscard]] std::int64_t stream_send_window(std::uint32_t stream_id) const noexcept {
        auto it = streams_.find(stream_id);
        return it == streams_.end() ? 0 : it->second.send_window;
    }

    [[nodiscard]] std::uint32_t peer_initial_window_size() const noexcept {
        return peer_initial_window_size_;
    }

    [[nodiscard]] std::uint32_t peer_max_frame_size() const noexcept {
        return peer_max_frame_size_;
    }

    [[nodiscard]] std::uint64_t pending_bytes(std::uint32_t stream_id) const noexcept {
        auto it = streams_.find(stream_id);
        return it == streams_.end() ? 0 : it->second.pending;
    }

    [[nodiscard]] bool has_stream(std::uint32_t stream_id) const noexcept {
        return streams_.contains(stream_id);
    }

    [[nodiscard]] bool is_stream_reset(std::uint32_t stream_id) const noexcept {
        auto it = streams_.find(stream_id);
        return it != streams_.end() && it->second.reset;
    }

    [[nodiscard]] bool is_send_closed(std::uint32_t stream_id) const noexcept {
        auto it = streams_.find(stream_id);
        return it != streams_.end() && it->second.send_closed;
    }

    [[nodiscard]] bool connection_failed() const noexcept {
        return connection_failed_;
    }

private:
    struct Stream {
        std::int64_t send_window = kDefaultInitialWindowSize;
        std::uint64_t pending = 0;
        std::uint64_t finish = 0;
        std::uint32_t weight = 16;
        bool reset = false;
        bool send_closed = false;
    };

    [[nodiscard]] static std::uint32_t normalize_weight(std::uint32_t weight) noexcept {
        return std::clamp(weight, kMinPriorityWeight, kMaxPriorityWeight);
    }

    [[nodiscard]] Stream* find_active(std::uint32_t stream_id) noexcept {
        if (connection_failed_ || stream_id == 0) {
            return nullptr;
        }
        auto it = streams_.find(stream_id);
        if (it == streams_.end() || it->second.reset || it->second.send_closed) {
            return nullptr;
        }
        return &it->second;
    }

    [[nodiscard]] bool is_runnable(
        std::uint32_t stream_id,
        const Stream& stream) const noexcept {
        return stream_id != 0 && !stream.reset && !stream.send_closed &&
               stream.pending != 0 && stream.send_window > 0;
    }

    void consume(Stream& stream, std::uint32_t length) noexcept {
        connection_send_window_ -= length;
        stream.send_window -= length;

        const auto scaled =
            static_cast<std::uint64_t>(length) * kMaxPriorityWeight;
        const auto cost = (scaled + stream.weight - 1) / stream.weight;
        stream.finish = std::max(stream.finish, virtual_time_) + cost;
        refresh_virtual_time();
    }

    void refresh_virtual_time() noexcept {
        std::uint64_t next = std::numeric_limits<std::uint64_t>::max();
        bool found = false;
        for (const auto& [stream_id, stream] : streams_) {
            if (!stream.reset && !stream.send_closed && stream.pending != 0) {
                next = std::min(next, stream.finish);
                found = true;
            }
        }
        if (found) {
            virtual_time_ = next;
        }
    }

    [[nodiscard]] std::optional<Error> fail_connection(ErrorCode code) noexcept {
        connection_failed_ = true;
        return Error{code, ErrorScope::connection, 0};
    }

    [[nodiscard]] std::optional<Error> fail_stream(
        Stream& stream,
        std::uint32_t stream_id,
        ErrorCode code) noexcept {
        stream.reset = true;
        stream.send_closed = true;
        stream.pending = 0;
        return Error{code, ErrorScope::stream, stream_id};
    }

    std::map<std::uint32_t, Stream> streams_;
    std::int64_t connection_send_window_ = kDefaultInitialWindowSize;
    std::uint32_t peer_initial_window_size_ = kDefaultInitialWindowSize;
    std::uint32_t peer_max_frame_size_ = kDefaultMaxFrameSize;
    std::uint64_t virtual_time_ = 0;
    bool connection_failed_ = false;
};

} // namespace dlks_formal
