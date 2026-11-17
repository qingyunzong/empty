#include "dlks_formal.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using dlks_formal::DataFrame;
using dlks_formal::Error;
using dlks_formal::ErrorCode;
using dlks_formal::ErrorScope;
using dlks_formal::FlowController;
using dlks_formal::Priority;
using dlks_formal::Settings;

Settings initial_window(std::uint32_t size) {
    Settings settings;
    settings.initial_window_size = size;
    return settings;
}

Settings max_frame(std::uint32_t size) {
    Settings settings;
    settings.max_frame_size = size;
    return settings;
}

int failures = 0;

void check(bool condition, std::string_view expression, int line) {
    if (!condition) {
        ++failures;
        std::cerr << "FAIL line " << line << ": " << expression << '\n';
    }
}

#define CHECK(...) check((__VA_ARGS__), #__VA_ARGS__, __LINE__)

std::string error_text(const std::optional<Error>& error) {
    if (!error.has_value()) {
        return "ok";
    }
    std::ostringstream out;
    out << dlks_formal::to_string(error->code) << '/'
        << dlks_formal::to_string(error->scope) << '/' << error->stream_id;
    return out.str();
}

void expect_error(
    const std::optional<Error>& error,
    ErrorCode code,
    ErrorScope scope,
    std::uint32_t stream_id,
    int line) {
    const Error expected{code, scope, stream_id};
    if (error != expected) {
        ++failures;
        std::cerr << "FAIL line " << line << ": expected "
                  << error_text(expected) << ", got " << error_text(error) << '\n';
    }
}

#define EXPECT_ERROR(value, code, scope, stream) \
    expect_error((value), (code), (scope), (stream), __LINE__)

struct ReferenceStream {
    std::int64_t send_window = dlks_formal::kDefaultInitialWindowSize;
    std::uint64_t pending = 0;
    bool reset = false;
    bool send_closed = false;
};

struct ReferenceModel {
    std::int64_t connection_send_window = dlks_formal::kDefaultInitialWindowSize;
    std::uint32_t peer_initial_window_size = dlks_formal::kDefaultInitialWindowSize;
    std::uint32_t peer_max_frame_size = dlks_formal::kDefaultMaxFrameSize;
    bool connection_failed = false;
    std::map<std::uint32_t, ReferenceStream> streams;

    std::optional<Error> open_stream(std::uint32_t stream_id) {
        if (stream_id == 0 || stream_id > dlks_formal::kMaxStreamId ||
            streams.contains(stream_id)) {
            return Error{ErrorCode::protocol_error, ErrorScope::stream, stream_id};
        }
        ReferenceStream stream;
        stream.send_window = peer_initial_window_size;
        streams.emplace(stream_id, stream);
        return std::nullopt;
    }

    ReferenceStream* active(std::uint32_t stream_id) {
        if (connection_failed || stream_id == 0) {
            return nullptr;
        }
        auto it = streams.find(stream_id);
        if (it == streams.end() || it->second.reset || it->second.send_closed) {
            return nullptr;
        }
        return &it->second;
    }

    const ReferenceStream* active(std::uint32_t stream_id) const {
        if (connection_failed || stream_id == 0) {
            return nullptr;
        }
        auto it = streams.find(stream_id);
        if (it == streams.end() || it->second.reset || it->second.send_closed) {
            return nullptr;
        }
        return &it->second;
    }

    std::optional<Error> enqueue_data(std::uint32_t stream_id, std::uint64_t bytes) {
        auto* stream = active(stream_id);
        if (stream == nullptr) {
            return Error{ErrorCode::stream_closed, ErrorScope::stream, stream_id};
        }
        const auto room = std::numeric_limits<std::uint64_t>::max() - stream->pending;
        stream->pending += std::min(bytes, room);
        return std::nullopt;
    }

    std::optional<DataFrame> reserve_data(
        std::uint32_t stream_id,
        std::uint64_t wanted,
        std::uint32_t max_frame_size) {
        if (connection_failed || wanted == 0) {
            return std::nullopt;
        }
        auto* stream = active(stream_id);
        if (stream == nullptr || stream->send_window <= 0 ||
            connection_send_window <= 0) {
            return std::nullopt;
        }
        const auto frame_cap =
            std::min<std::uint64_t>(max_frame_size, peer_max_frame_size);
        const auto available = static_cast<std::uint64_t>(
            std::min(connection_send_window, stream->send_window));
        const auto length = static_cast<std::uint32_t>(
            std::min({wanted, available, frame_cap}));
        if (length == 0) {
            return std::nullopt;
        }
        if (stream->pending != 0) {
            stream->pending -= std::min<std::uint64_t>(stream->pending, length);
        }
        connection_send_window -= length;
        stream->send_window -= length;
        return DataFrame{stream_id, length};
    }

    std::optional<Error> receive_window_update(
        std::uint32_t stream_id,
        std::uint32_t increment) {
        if (connection_failed) {
            return std::nullopt;
        }
        if (stream_id == 0) {
            if (increment == 0) {
                connection_failed = true;
                return Error{ErrorCode::protocol_error, ErrorScope::connection, 0};
            }
            if (connection_send_window + static_cast<std::int64_t>(increment) >
                static_cast<std::int64_t>(dlks_formal::kMaxWindowSize)) {
                connection_failed = true;
                return Error{ErrorCode::flow_control_error, ErrorScope::connection, 0};
            }
            connection_send_window += increment;
            return std::nullopt;
        }
        auto it = streams.find(stream_id);
        if (it == streams.end()) {
            connection_failed = true;
            return Error{ErrorCode::protocol_error, ErrorScope::connection, 0};
        }
        if (it->second.reset || it->second.send_closed) {
            return std::nullopt;
        }
        if (increment == 0) {
            it->second.reset = true;
            it->second.send_closed = true;
            it->second.pending = 0;
            return Error{ErrorCode::protocol_error, ErrorScope::stream, stream_id};
        }
        if (it->second.send_window + static_cast<std::int64_t>(increment) >
            static_cast<std::int64_t>(dlks_formal::kMaxWindowSize)) {
            it->second.reset = true;
            it->second.send_closed = true;
            it->second.pending = 0;
            return Error{ErrorCode::flow_control_error, ErrorScope::stream, stream_id};
        }
        it->second.send_window += increment;
        return std::nullopt;
    }

    std::optional<Error> apply_settings(const Settings& settings) {
        if (connection_failed) {
            return std::nullopt;
        }
        if (settings.max_frame_size.has_value() &&
            (*settings.max_frame_size < dlks_formal::kDefaultMaxFrameSize ||
             *settings.max_frame_size > dlks_formal::kMaxMaxFrameSize)) {
            connection_failed = true;
            return Error{ErrorCode::protocol_error, ErrorScope::connection, 0};
        }
        if (settings.initial_window_size.has_value() &&
            *settings.initial_window_size > dlks_formal::kMaxWindowSize) {
            connection_failed = true;
            return Error{ErrorCode::flow_control_error, ErrorScope::connection, 0};
        }

        if (settings.initial_window_size.has_value()) {
            const auto delta =
                static_cast<std::int64_t>(*settings.initial_window_size) -
                static_cast<std::int64_t>(peer_initial_window_size);
            for (const auto& [stream_id, stream] : streams) {
                if (!stream.reset &&
                    stream.send_window + delta >
                        static_cast<std::int64_t>(dlks_formal::kMaxWindowSize)) {
                    connection_failed = true;
                    return Error{ErrorCode::flow_control_error, ErrorScope::connection, 0};
                }
            }
            for (auto& [stream_id, stream] : streams) {
                if (!stream.reset) {
                    stream.send_window += delta;
                }
            }
            peer_initial_window_size = *settings.initial_window_size;
        }
        if (settings.max_frame_size.has_value()) {
            peer_max_frame_size = *settings.max_frame_size;
        }
        return std::nullopt;
    }

    std::optional<Error> reset_stream(std::uint32_t stream_id) {
        if (stream_id == 0) {
            connection_failed = true;
            return Error{ErrorCode::protocol_error, ErrorScope::connection, 0};
        }
        auto it = streams.find(stream_id);
        if (it == streams.end()) {
            connection_failed = true;
            return Error{ErrorCode::protocol_error, ErrorScope::connection, 0};
        }
        if (!it->second.reset) {
            it->second.reset = true;
            it->second.send_closed = true;
            it->second.pending = 0;
        }
        return std::nullopt;
    }

    std::optional<Error> end_send(std::uint32_t stream_id) {
        auto* stream = active(stream_id);
        if (stream == nullptr) {
            return Error{ErrorCode::stream_closed, ErrorScope::stream, stream_id};
        }
        stream->send_closed = true;
        stream->pending = 0;
        return std::nullopt;
    }

    std::uint64_t sendable_bytes(std::uint32_t stream_id) const {
        auto it = streams.find(stream_id);
        if (it == streams.end() || it->second.reset || it->second.send_closed ||
            connection_failed || connection_send_window <= 0 ||
            it->second.send_window <= 0) {
            return 0;
        }
        return static_cast<std::uint64_t>(
            std::min(connection_send_window, it->second.send_window));
    }

    bool scheduler_can_send(std::uint32_t max_frame_size) const {
        if (connection_failed || connection_send_window <= 0 || max_frame_size == 0) {
            return false;
        }
        for (const auto& [stream_id, stream] : streams) {
            if (!stream.reset && !stream.send_closed && stream.pending != 0 &&
                stream.send_window > 0) {
                return true;
            }
        }
        return false;
    }
};

enum class StepKind : std::uint8_t {
    open_stream,
    queue_data,
    reserve_data,
    next_frame,
    window_update,
    settings,
    reset_stream,
    end_send,
    set_priority,
};

struct Step {
    StepKind kind = StepKind::open_stream;
    std::uint32_t stream_id = 0;
    std::uint64_t amount = 0;
    std::uint32_t max_frame_size = 0;
    std::uint32_t weight = 0;
    std::optional<std::uint32_t> initial_window_size;
    std::optional<std::uint32_t> setting_max_frame_size;

    Step() = default;

    Step(
        StepKind kind_,
        std::uint32_t stream_id_ = 0,
        std::uint64_t amount_ = 0,
        std::uint32_t max_frame_size_ = 0,
        std::uint32_t weight_ = 0,
        std::optional<std::uint32_t> initial_window_size_ = std::nullopt,
        std::optional<std::uint32_t> setting_max_frame_size_ = std::nullopt)
        : kind(kind_),
          stream_id(stream_id_),
          amount(amount_),
          max_frame_size(max_frame_size_),
          weight(weight_),
          initial_window_size(initial_window_size_),
          setting_max_frame_size(setting_max_frame_size_) {}
};

std::string_view step_name(StepKind kind) {
    switch (kind) {
    case StepKind::open_stream: return "OPEN";
    case StepKind::queue_data: return "QUEUE";
    case StepKind::reserve_data: return "RESERVE";
    case StepKind::next_frame: return "NEXT";
    case StepKind::window_update: return "WINDOW_UPDATE";
    case StepKind::settings: return "SETTINGS";
    case StepKind::reset_stream: return "RST_STREAM";
    case StepKind::end_send: return "END_STREAM";
    case StepKind::set_priority: return "PRIORITY";
    }
    return "UNKNOWN";
}

class FrameSequenceGenerator {
public:
    explicit FrameSequenceGenerator(std::uint64_t seed, bool adversarial = false)
        : rng_(seed), adversarial_(adversarial) {}

    Step next() {
        if (known_.empty()) {
            return open_step();
        }
        const auto choice = static_cast<unsigned>(rng_() % 100);
        if (choice < 14) {
            return open_step();
        }
        if (choice < 33) {
            return Step{StepKind::queue_data, pick_any_stream(), pick_payload_size()};
        }
        if (choice < 49) {
            return Step{
                StepKind::reserve_data,
                pick_any_stream(),
                pick_payload_size(),
                pick_frame_size(),
            };
        }
        if (choice < 62) {
            return Step{
                StepKind::next_frame,
                0,
                0,
                pick_frame_size(),
            };
        }
        if (choice < 78) {
            return window_update_step();
        }
        if (choice < 85) {
            return settings_step();
        }
        if (choice < 91) {
            return Step{StepKind::reset_stream, pick_any_stream()};
        }
        if (choice < 96) {
            return Step{StepKind::end_send, pick_any_stream()};
        }
        return Step{
            StepKind::set_priority,
            pick_any_stream(),
            0,
            0,
            static_cast<std::uint32_t>(rng_() % 300),
        };
    }

private:
    Step open_step() {
        const auto max_streams = adversarial_ ? 32U : 24U;
        if (known_.size() >= max_streams) {
            if (adversarial_) {
                return Step{StepKind::open_stream, pick_known()};
            }
            return Step{
                StepKind::queue_data,
                pick_known(),
                pick_payload_size(),
            };
        }
        if (adversarial_ && !known_.empty() && rng_() % 3 == 0) {
            return Step{StepKind::open_stream, pick_known()};
        }
        const auto id = fresh_id();
        known_.push_back(id);
        return Step{
            StepKind::open_stream,
            id,
            0,
            0,
            static_cast<std::uint32_t>(1 + rng_() % dlks_formal::kMaxPriorityWeight),
        };
    }

    Step window_update_step() {
        const bool connection_window = rng_() % 2 == 0;
        static constexpr std::uint32_t edges[] = {
            0,
            1,
            65'535,
            1U << 20,
            dlks_formal::kMaxWindowSize,
        };
        std::uint32_t increment = 0;
        if (!adversarial_) {
            increment = static_cast<std::uint32_t>(1 + rng_() % 8'192);
        } else if (rng_() % 10 < 7) {
            increment = static_cast<std::uint32_t>(1 + rng_() % 65'535);
        } else {
            increment = edges[rng_() % (sizeof(edges) / sizeof(edges[0]))];
        }
        return Step{
            StepKind::window_update,
            connection_window ? 0U : pick_any_stream(),
            increment,
        };
    }

    Step settings_step() {
        static constexpr std::uint32_t adversarial_initial_values[] = {
            0,
            1,
            16'384,
            65'535,
            100'000,
            dlks_formal::kMaxWindowSize,
            dlks_formal::kMaxWindowSize + 1,
        };
        static constexpr std::uint32_t valid_initial_values[] = {
            0,
            1'024,
            16'384,
            65'535,
            100'000,
        };
        static constexpr std::uint32_t adversarial_frame_values[] = {
            0,
            dlks_formal::kDefaultMaxFrameSize - 1,
            dlks_formal::kDefaultMaxFrameSize,
            32'768,
            65'536,
            dlks_formal::kMaxMaxFrameSize,
            dlks_formal::kMaxMaxFrameSize + 1,
        };
        static constexpr std::uint32_t valid_frame_values[] = {
            dlks_formal::kDefaultMaxFrameSize,
            32'768,
            65'536,
            dlks_formal::kMaxMaxFrameSize,
        };
        Step step{StepKind::settings};
        if (rng_() % 4 != 0) {
            step.initial_window_size = adversarial_
                ? adversarial_initial_values[
                      rng_() % (sizeof(adversarial_initial_values) /
                                sizeof(adversarial_initial_values[0]))]
                : valid_initial_values[
                      rng_() % (sizeof(valid_initial_values) /
                                sizeof(valid_initial_values[0]))];
        }
        if (rng_() % 3 != 0) {
            step.setting_max_frame_size = adversarial_
                ? adversarial_frame_values[
                      rng_() % (sizeof(adversarial_frame_values) /
                                sizeof(adversarial_frame_values[0]))]
                : valid_frame_values[
                      rng_() % (sizeof(valid_frame_values) /
                                sizeof(valid_frame_values[0]))];
        }
        if (!step.initial_window_size.has_value() &&
            !step.setting_max_frame_size.has_value()) {
            step.initial_window_size = 65'535;
        }
        return step;
    }

    std::uint32_t fresh_id() {
        const auto id = next_id_;
        next_id_ += 2;
        return id;
    }

    std::uint32_t pick_known() {
        return known_[rng_() % known_.size()];
    }

    std::uint32_t pick_any_stream() {
        if (!adversarial_) {
            return pick_known();
        }
        if (!known_.empty() && rng_() % 4 != 0) {
            return pick_known();
        }
        return fresh_id();
    }

    std::uint64_t pick_payload_size() {
        static constexpr std::uint64_t values[] = {
            0,
            1,
            1'024,
            16'384,
            65'535,
            200'000,
            1'000'000,
        };
        if (rng_() % 3 != 0) {
            return values[rng_() % (sizeof(values) / sizeof(values[0]))];
        }
        return 1 + rng_() % 500'000;
    }

    std::uint32_t pick_frame_size() {
        static constexpr std::uint32_t values[] = {
            0,
            1,
            1'024,
            16'384,
            32'768,
            dlks_formal::kMaxMaxFrameSize,
        };
        return values[rng_() % (sizeof(values) / sizeof(values[0]))];
    }

    std::mt19937_64 rng_;
    std::vector<std::uint32_t> known_;
    std::uint32_t next_id_ = 1;
    bool adversarial_ = false;
};

bool compare_state(
    const FlowController& controller,
    const ReferenceModel& model,
    std::uint64_t seed,
    std::size_t step_index,
    StepKind kind) {
    bool ok = true;
    const auto report = [&](std::string_view what) {
        ++failures;
        ok = false;
        std::cerr << "FAIL seed " << seed << " step " << step_index << " ("
                  << step_name(kind) << "): " << what << '\n';
    };

    if (controller.connection_send_window() != model.connection_send_window) {
        report("connection send window mismatch");
    }
    if (controller.peer_initial_window_size() != model.peer_initial_window_size) {
        report("peer initial window mismatch");
    }
    if (controller.peer_max_frame_size() != model.peer_max_frame_size) {
        report("peer max frame size mismatch");
    }
    if (controller.connection_failed() != model.connection_failed) {
        report("connection failure state mismatch");
    }

    for (const auto& [stream_id, stream] : model.streams) {
        if (!controller.has_stream(stream_id)) {
            report("missing stream");
            continue;
        }
        if (controller.stream_send_window(stream_id) != stream.send_window) {
            report("stream send window mismatch");
        }
        if (controller.sendable_bytes(stream_id) != model.sendable_bytes(stream_id)) {
            report("sendable byte count mismatch");
        }
        if (controller.pending_bytes(stream_id) != stream.pending) {
            report("pending byte count mismatch");
        }
        if (controller.is_stream_reset(stream_id) != stream.reset) {
            report("stream reset state mismatch");
        }
        if (controller.is_send_closed(stream_id) != stream.send_closed) {
            report("send closed state mismatch");
        }
    }
    return ok;
}

void run_generated_sequence(
    std::uint64_t seed,
    int step_count,
    bool adversarial = false) {
    FlowController controller;
    ReferenceModel model;
    FrameSequenceGenerator generator(seed, adversarial);

    for (int index = 0; index < step_count; ++index) {
        const auto step = generator.next();
        std::optional<Error> actual_error;
        std::optional<Error> expected_error;

        switch (step.kind) {
        case StepKind::open_stream:
            actual_error = controller.open_stream(step.stream_id, Priority{step.weight});
            expected_error = model.open_stream(step.stream_id);
            break;
        case StepKind::queue_data:
            actual_error = controller.enqueue_data(step.stream_id, step.amount);
            expected_error = model.enqueue_data(step.stream_id, step.amount);
            break;
        case StepKind::reserve_data: {
            const auto actual =
                controller.reserve_data(step.stream_id, step.amount, step.max_frame_size);
            const auto expected =
                model.reserve_data(step.stream_id, step.amount, step.max_frame_size);
            if (actual != expected) {
                ++failures;
                std::cerr << "FAIL seed " << seed << " step " << index
                          << " (RESERVE): grant mismatch\n";
                return;
            }
            break;
        }
        case StepKind::next_frame: {
            const bool could_send = model.scheduler_can_send(step.max_frame_size);
            const auto actual = controller.next_frame(step.max_frame_size);
            if (!actual.has_value()) {
                if (could_send) {
                    ++failures;
                    std::cerr << "FAIL seed " << seed << " step " << index
                              << " (NEXT): missing grant\n";
                    return;
                }
            } else {
                auto* stream = model.active(actual->stream_id);
                if (stream == nullptr) {
                    ++failures;
                    std::cerr << "FAIL seed " << seed << " step " << index
                              << " (NEXT): grant for inactive stream\n";
                    return;
                }
                const auto frame_cap = std::min<std::uint64_t>(
                    step.max_frame_size, model.peer_max_frame_size);
                const auto available = static_cast<std::uint64_t>(
                    std::min(model.connection_send_window, stream->send_window));
                const auto expected_length = static_cast<std::uint32_t>(std::min({
                    stream->pending,
                    available,
                    frame_cap,
                }));
                if (actual->length != expected_length ||
                    actual->length > model.sendable_bytes(actual->stream_id)) {
                    ++failures;
                    std::cerr << "FAIL seed " << seed << " step " << index
                              << " (NEXT): grant overdraws windows\n";
                    return;
                }
                stream->pending -= actual->length;
                model.connection_send_window -= actual->length;
                stream->send_window -= actual->length;
            }
            break;
        }
        case StepKind::window_update:
            actual_error = controller.receive_window_update(
                step.stream_id, static_cast<std::uint32_t>(step.amount));
            expected_error = model.receive_window_update(
                step.stream_id, static_cast<std::uint32_t>(step.amount));
            break;
        case StepKind::settings: {
            Settings settings;
            settings.initial_window_size = step.initial_window_size;
            settings.max_frame_size = step.setting_max_frame_size;
            actual_error = controller.apply_settings(settings);
            expected_error = model.apply_settings(settings);
            break;
        }
        case StepKind::reset_stream:
            actual_error = controller.receive_rst_stream(step.stream_id);
            expected_error = model.reset_stream(step.stream_id);
            break;
        case StepKind::end_send:
            actual_error = controller.end_send(step.stream_id);
            expected_error = model.end_send(step.stream_id);
            break;
        case StepKind::set_priority:
            actual_error = controller.set_priority(
                step.stream_id, Priority{step.weight});
            expected_error =
                model.active(step.stream_id) == nullptr
                    ? std::optional<Error>(Error{
                          ErrorCode::stream_closed, ErrorScope::stream, step.stream_id})
                    : std::nullopt;
            break;
        }

        if (actual_error != expected_error) {
            ++failures;
            std::cerr << "FAIL seed " << seed << " step " << index << " ("
                      << step_name(step.kind) << "): expected "
                      << error_text(expected_error) << ", got "
                      << error_text(actual_error) << '\n';
            return;
        }

        if (!compare_state(controller, model, seed, index, step.kind)) {
            return;
        }
        if (model.connection_failed) {
            break;
        }
    }
}

void test_initial_window_and_frame_split() {
    FlowController controller;
    CHECK(!controller.open_stream(1));
    CHECK(controller.sendable_bytes(1) == 65'535);
    CHECK(!controller.enqueue_data(1, 100'000));

    const auto first = controller.next_frame(16'384);
    CHECK(first == DataFrame{1, 16'384});
    CHECK(controller.connection_send_window() == 49'151);
    CHECK(controller.stream_send_window(1) == 49'151);
    CHECK(controller.sendable_bytes(1) == 49'151);

    const auto second = controller.next_frame(100'000);
    CHECK(second == DataFrame{1, 16'384});
    CHECK(controller.connection_send_window() == 32'767);
}

void test_two_level_window_never_overdrawn() {
    FlowController controller;
    CHECK(!controller.open_stream(1));
    CHECK(!controller.open_stream(3));
    CHECK(!controller.enqueue_data(1, 1'000'000));
    CHECK(!controller.enqueue_data(3, 1'000'000));

    std::uint64_t total = 0;
    while (true) {
        const auto stream_one_before = controller.sendable_bytes(1);
        const auto stream_three_before = controller.sendable_bytes(3);
        const auto connection_before = controller.connection_sendable();
        const auto frame = controller.next_frame(10'000);
        if (!frame.has_value()) {
            break;
        }
        CHECK(frame->length <= (frame->stream_id == 1 ? stream_one_before
                                                      : stream_three_before));
        CHECK(frame->length <= connection_before);
        CHECK(controller.connection_send_window() >= 0);
        CHECK(controller.stream_send_window(frame->stream_id) >= 0);
        total += frame->length;
    }

    CHECK(total == 65'535);
    CHECK(controller.connection_send_window() == 0);
    CHECK(controller.sendable_bytes(1) == 0);
    CHECK(controller.sendable_bytes(3) == 0);
    CHECK(!controller.next_frame().has_value());

    CHECK(!controller.receive_window_update(0, 1));
    const auto one_byte = controller.next_frame(16'384);
    CHECK(one_byte.has_value());
    CHECK(one_byte->length == 1);
    CHECK(controller.connection_send_window() == 0);
}

void test_settings_initial_window_size() {
    FlowController controller;
    EXPECT_ERROR(
        controller.open_stream(0),
        ErrorCode::protocol_error,
        ErrorScope::stream,
        0);
    EXPECT_ERROR(
        controller.open_stream(dlks_formal::kMaxStreamId + 1),
        ErrorCode::protocol_error,
        ErrorScope::stream,
        dlks_formal::kMaxStreamId + 1);
    CHECK(!controller.open_stream(1));
    CHECK(controller.reserve_data(1, 16'384, 16'384) == DataFrame{1, 16'384});
    CHECK(controller.stream_send_window(1) == 49'151);
    CHECK(controller.connection_send_window() == 49'151);

    CHECK(!controller.apply_settings(initial_window(0)));
    CHECK(controller.stream_send_window(1) == -16'384);
    CHECK(controller.connection_send_window() == 49'151);
    CHECK(controller.sendable_bytes(1) == 0);

    CHECK(!controller.apply_settings(initial_window(65'535)));
    CHECK(controller.stream_send_window(1) == 49'151);
    CHECK(controller.connection_send_window() == 49'151);
    CHECK(!controller.open_stream(3));
    CHECK(controller.stream_send_window(3) == 65'535);

    CHECK(!controller.apply_settings(initial_window(0)));
    CHECK(controller.stream_send_window(1) == -16'384);
    CHECK(controller.stream_send_window(3) == 0);
    CHECK(controller.connection_send_window() == 49'151);

    FlowController negative;
    CHECK(!negative.open_stream(1));
    CHECK(!negative.apply_settings(max_frame(65'535)));
    CHECK(negative.reserve_data(1, 65'535, 65'535) == DataFrame{1, 65'535});
    CHECK(negative.stream_send_window(1) == 0);
    CHECK(!negative.apply_settings(initial_window(0)));
    CHECK(negative.stream_send_window(1) == -65'535);
    CHECK(negative.sendable_bytes(1) == 0);
    CHECK(!negative.apply_settings(initial_window(65'535)));
    CHECK(negative.stream_send_window(1) == 0);

    FlowController overflow;
    CHECK(!overflow.open_stream(1));
    CHECK(!overflow.open_stream(3));
    CHECK(!overflow.receive_window_update(
        1, dlks_formal::kMaxWindowSize - 65'535));
    CHECK(overflow.stream_send_window(1) == dlks_formal::kMaxWindowSize);
    EXPECT_ERROR(
        overflow.apply_settings(initial_window(65'536)),
        ErrorCode::flow_control_error,
        ErrorScope::connection,
        0);
    CHECK(overflow.connection_failed());
    CHECK(overflow.stream_send_window(1) == dlks_formal::kMaxWindowSize);
    CHECK(overflow.stream_send_window(3) == 65'535);
    CHECK(overflow.connection_send_window() == 65'535);

    FlowController invalid_initial;
    EXPECT_ERROR(
        invalid_initial.apply_settings(
            initial_window(dlks_formal::kMaxWindowSize + 1)),
        ErrorCode::flow_control_error,
        ErrorScope::connection,
        0);
    CHECK(invalid_initial.connection_failed());

    FlowController invalid_frame;
    EXPECT_ERROR(
        invalid_frame.apply_settings(max_frame(16'383)),
        ErrorCode::protocol_error,
        ErrorScope::connection,
        0);
    CHECK(invalid_frame.connection_failed());

    FlowController frame_limit;
    CHECK(!frame_limit.open_stream(1));
    CHECK(!frame_limit.apply_settings(max_frame(32'768)));
    CHECK(!frame_limit.enqueue_data(1, 100'000));
    const auto frame = frame_limit.next_frame(65'536);
    CHECK(frame == DataFrame{1, 32'768});
}

void test_window_update_errors() {
    FlowController connection_zero;
    CHECK(!connection_zero.open_stream(1));
    EXPECT_ERROR(
        connection_zero.receive_window_update(0, 0),
        ErrorCode::protocol_error,
        ErrorScope::connection,
        0);
    CHECK(connection_zero.connection_failed());

    FlowController stream_zero;
    CHECK(!stream_zero.open_stream(1));
    CHECK(stream_zero.reserve_data(1, 100) == DataFrame{1, 100});
    EXPECT_ERROR(
        stream_zero.receive_window_update(1, 0),
        ErrorCode::protocol_error,
        ErrorScope::stream,
        1);
    CHECK(!stream_zero.connection_failed());
    CHECK(stream_zero.is_stream_reset(1));
    CHECK(stream_zero.stream_send_window(1) == 65'435);
    CHECK(stream_zero.sendable_bytes(1) == 0);

    FlowController connection_overflow;
    CHECK(!connection_overflow.receive_window_update(
        0, dlks_formal::kMaxWindowSize - 65'535));
    CHECK(connection_overflow.connection_send_window() == dlks_formal::kMaxWindowSize);
    EXPECT_ERROR(
        connection_overflow.receive_window_update(0, 1),
        ErrorCode::flow_control_error,
        ErrorScope::connection,
        0);
    CHECK(connection_overflow.connection_send_window() == dlks_formal::kMaxWindowSize);
    CHECK(connection_overflow.connection_failed());

    FlowController stream_overflow;
    CHECK(!stream_overflow.open_stream(1));
    CHECK(!stream_overflow.open_stream(3));
    CHECK(!stream_overflow.receive_window_update(
        1, dlks_formal::kMaxWindowSize - 65'535));
    CHECK(stream_overflow.stream_send_window(1) == dlks_formal::kMaxWindowSize);
    EXPECT_ERROR(
        stream_overflow.receive_window_update(1, 1),
        ErrorCode::flow_control_error,
        ErrorScope::stream,
        1);
    CHECK(!stream_overflow.connection_failed());
    CHECK(stream_overflow.is_stream_reset(1));
    CHECK(stream_overflow.stream_send_window(1) == dlks_formal::kMaxWindowSize);
    CHECK(stream_overflow.sendable_bytes(3) == 65'535);
    CHECK(stream_overflow.connection_send_window() == 65'535);

    FlowController zero_from_zero;
    CHECK(!zero_from_zero.open_stream(1));
    CHECK(!zero_from_zero.apply_settings(max_frame(65'535)));
    CHECK(zero_from_zero.reserve_data(1, 65'535, 65'535) ==
          DataFrame{1, 65'535});
    CHECK(zero_from_zero.connection_send_window() == 0);
    CHECK(!zero_from_zero.receive_window_update(0, dlks_formal::kMaxWindowSize));
    CHECK(zero_from_zero.connection_send_window() == dlks_formal::kMaxWindowSize);

    FlowController unknown;
    EXPECT_ERROR(
        unknown.receive_window_update(11, 1),
        ErrorCode::protocol_error,
        ErrorScope::connection,
        0);
    CHECK(unknown.connection_failed());
}

void test_reset_and_priority() {
    FlowController reset;
    CHECK(!reset.open_stream(1));
    CHECK(!reset.open_stream(3));
    CHECK(!reset.enqueue_data(1, 10'000));
    CHECK(!reset.enqueue_data(3, 10'000));
    CHECK(!reset.receive_rst_stream(1));
    CHECK(reset.pending_bytes(1) == 0);
    CHECK(reset.sendable_bytes(1) == 0);
    CHECK(!reset.receive_window_update(1, 1'000));
    CHECK(!reset.connection_failed());
    const auto after_reset = reset.next_frame(16'384);
    CHECK(after_reset.has_value());
    CHECK(after_reset->stream_id == 3);
    EXPECT_ERROR(
        reset.enqueue_data(1, 1),
        ErrorCode::stream_closed,
        ErrorScope::stream,
        1);

    FlowController priority;
    CHECK(!priority.open_stream(1, Priority{1}));
    CHECK(!priority.open_stream(3, Priority{256}));
    CHECK(!priority.enqueue_data(1, 1'000'000));
    CHECK(!priority.enqueue_data(3, 1'000'000));

    std::uint64_t low_bytes = 0;
    std::uint64_t high_bytes = 0;
    std::uint32_t first_stream = 0;
    for (int index = 0; index < 512; ++index) {
        const auto frame = priority.next_frame(1'024);
        if (!frame.has_value()) {
            break;
        }
        if (index == 0) {
            first_stream = frame->stream_id;
        }
        if (frame->stream_id == 1) {
            low_bytes += frame->length;
        } else if (frame->stream_id == 3) {
            high_bytes += frame->length;
        }
    }
    CHECK(first_stream == 3);
    CHECK(high_bytes > low_bytes * 10);
    CHECK(low_bytes > 0);

    FlowController switched_priority;
    CHECK(!switched_priority.open_stream(1, Priority{1}));
    CHECK(!switched_priority.open_stream(3, Priority{256}));
    CHECK(!switched_priority.set_priority(3, Priority{1}));
    CHECK(!switched_priority.set_priority(1, Priority{256}));
    CHECK(!switched_priority.enqueue_data(1, 100'000));
    CHECK(!switched_priority.enqueue_data(3, 100'000));
    const auto switched = switched_priority.next_frame(1'024);
    CHECK(switched.has_value());
    CHECK(switched->stream_id == 1);
}

void test_generated_sequences() {
    for (std::uint64_t seed = 1; seed <= 24; ++seed) {
        run_generated_sequence(seed, 1'500);
    }
    for (std::uint64_t seed = 1'001; seed <= 1'024; ++seed) {
        run_generated_sequence(seed, 800, true);
    }
}

} // namespace

int main() {
    test_initial_window_and_frame_split();
    test_two_level_window_never_overdrawn();
    test_settings_initial_window_size();
    test_window_update_errors();
    test_reset_and_priority();
    test_generated_sequences();

    if (failures != 0) {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "all flow-control tests passed\n";
    return 0;
}
