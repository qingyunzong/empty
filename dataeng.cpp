#include "dataeng.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace dataeng {

namespace {

constexpr std::size_t kPrefixSize = 4;  // framed length prefix
constexpr std::size_t kBinaryHeaderMin =
    4 + 4 + 1;  // version+type, name length, name (empty)

constexpr std::uint32_t kBinaryVersion1 = 0x80010000u;

}  // namespace

const char* toString(MergerError error) {
    switch (error) {
        case MergerError::None:
            return "None";
        case MergerError::FrameTooLarge:
            return "FrameTooLarge";
        case MergerError::MalformedFrame:
            return "MalformedFrame";
        case MergerError::SeqIdInFlight:
            return "SeqIdInFlight";
        case MergerError::UnknownSeqId:
            return "UnknownSeqId";
        case MergerError::MethodMismatch:
            return "MethodMismatch";
        case MergerError::TypeMismatch:
            return "TypeMismatch";
        case MergerError::StreamFailed:
            return "StreamFailed";
    }
    return "Unknown";
}

void FramedMerger::writeBE32(std::vector<uint8_t>& out,
                             std::uint32_t value) {
    out.push_back(static_cast<uint8_t>((value >> 24) & 0xFFu));
    out.push_back(static_cast<uint8_t>((value >> 16) & 0xFFu));
    out.push_back(static_cast<uint8_t>((value >> 8) & 0xFFu));
    out.push_back(static_cast<uint8_t>(value & 0xFFu));
}

std::uint32_t FramedMerger::readBE32(const uint8_t* p) {
    return (static_cast<std::uint32_t>(p[0]) << 24) |
           (static_cast<std::uint32_t>(p[1]) << 16) |
           (static_cast<std::uint32_t>(p[2]) << 8) |
           static_cast<std::uint32_t>(p[3]);
}

std::vector<uint8_t> FramedMerger::buildFrame(
    int32_t seqid,
    MessageType type,
    const std::string& method,
    const std::vector<uint8_t>& body) {
    std::vector<uint8_t> message;

    // TBinaryProtocol strict header: version (uint32) | type, name (string),
    // seqid (int32).
    writeBE32(message, kBinaryVersion1 |
                          static_cast<std::uint32_t>(
                              static_cast<std::uint8_t>(type)));
    writeBE32(message, static_cast<std::uint32_t>(method.size()));
    message.insert(message.end(), method.begin(), method.end());
    writeBE32(message, static_cast<std::uint32_t>(seqid));
    message.insert(message.end(), body.begin(), body.end());

    std::vector<uint8_t> frame;
    frame.reserve(kPrefixSize + message.size());
    writeBE32(frame, static_cast<std::uint32_t>(message.size()));
    frame.insert(frame.end(), message.begin(), message.end());
    return frame;
}

FramedMerger::FramedMerger(FrameCallback callback, MergerConfig config)
    : callback_(std::move(callback)), config_(config) {
    if (config_.max_frame_bytes == 0) {
        config_.max_frame_bytes = 1;
    }
    if (config_.seqid_ceiling <= 0) {
        config_.seqid_ceiling = (std::numeric_limits<std::int32_t>::max)();
    }
}

MergerError FramedMerger::allocateSeqid(std::int32_t& out_seqid) {
    std::int32_t candidate = next_seqid_;
    if (pending_.find(candidate) != pending_.end()) {
        // The counter has wrapped into a seqid that is still referenced by
        // an in-flight call: reject the new call rather than alias it. This
        // also covers the degenerate case where every seqid is in use.
        return MergerError::SeqIdInFlight;
    }
    out_seqid = candidate;
    next_seqid_ = (candidate >= config_.seqid_ceiling)
                      ? 0
                      : static_cast<std::int32_t>(candidate + 1);
    return MergerError::None;
}

MergerError FramedMerger::registerCall(const std::string& method,
                                       MessageType type,
                                       std::int32_t& out_seqid) {
    if (failed_) {
        last_error_ = MergerError::StreamFailed;
        return last_error_;
    }
    if (type != MessageType::Call && type != MessageType::Oneway) {
        last_error_ = MergerError::TypeMismatch;
        return last_error_;
    }

    MergerError error = allocateSeqid(out_seqid);
    if (error != MergerError::None) {
        last_error_ = error;
        return error;
    }

    // oneway calls never receive a response, so they are not awaited. Their
    // seqid remains consumed until the counter wraps and is skipped above.
    if (type == MessageType::Call) {
        pending_.emplace(out_seqid, Pending{method, type});
    }
    last_error_ = MergerError::None;
    return MergerError::None;
}

MergerError FramedMerger::fail(MergerError error) {
    failed_ = true;
    last_error_ = error;
    return error;
}

MergerError FramedMerger::dispatchFrame(const uint8_t* frame,
                                        std::size_t frame_size) {
    // frame points at the length prefix; the binary message starts 4 bytes
    // later and is frame_size - 4 bytes long.
    const uint8_t* message = frame + kPrefixSize;
    const std::size_t message_size = frame_size - kPrefixSize;

    if (message_size < kBinaryHeaderMin) {
        return fail(MergerError::MalformedFrame);
    }

    std::uint32_t version_type = readBE32(message);
    if ((version_type & 0xFFFF0000u) != kBinaryVersion1) {
        return fail(MergerError::MalformedFrame);
    }
    MessageType type =
        static_cast<MessageType>(version_type & 0x000000FFu);
    if (type != MessageType::Reply && type != MessageType::Exception) {
        return fail(MergerError::MalformedFrame);
    }

    std::uint32_t name_len = readBE32(message + 4);
    std::size_t header_size = 4 + 4 + name_len + 4;
    if (name_len > message_size || header_size > message_size) {
        return fail(MergerError::MalformedFrame);
    }

    std::string method(reinterpret_cast<const char*>(message + 8),
                       name_len);
    std::int32_t seqid =
        static_cast<std::int32_t>(readBE32(message + 8 + name_len));

    auto it = pending_.find(seqid);
    if (it == pending_.end()) {
        // No registered call: do not poison the stream, ignore this frame.
        last_error_ = MergerError::UnknownSeqId;
        return MergerError::UnknownSeqId;
    }

    const Pending& pending = it->second;
    if (pending.method != method) {
        last_error_ = MergerError::MethodMismatch;
        return MergerError::MethodMismatch;
    }
    if (pending.request_type != MessageType::Call) {
        last_error_ = MergerError::TypeMismatch;
        return MergerError::TypeMismatch;
    }

    MergedFrame merged;
    merged.seqid = seqid;
    merged.type = type;
    merged.method = method;
    merged.frame.assign(frame, frame + frame_size);
    const uint8_t* body = message + header_size;
    merged.body.assign(body, message + message_size);

    // Both a normal reply and an exception complete this call only; other
    // in-flight calls stay registered.
    pending_.erase(it);

    if (callback_) {
        callback_(merged);
    }
    last_error_ = MergerError::None;
    return MergerError::None;
}

MergerError FramedMerger::feed(const uint8_t* data, std::size_t size) {
    if (failed_) {
        last_error_ = MergerError::StreamFailed;
        return last_error_;
    }
    if (data == nullptr || size == 0) {
        return MergerError::None;
    }

    rx_.insert(rx_.end(), data, data + size);

    MergerError result = MergerError::None;
    while (rx_.size() - rx_offset_ >= kPrefixSize) {
        const uint8_t* base = rx_.data() + rx_offset_;
        std::uint32_t length = readBE32(base);

        if (length > config_.max_frame_bytes) {
            return fail(MergerError::FrameTooLarge);
        }

        std::size_t frame_size = kPrefixSize + static_cast<std::size_t>(length);
        if (rx_.size() - rx_offset_ < frame_size) {
            break;  // wait for the remaining fragments
        }

        MergerError error = dispatchFrame(base, frame_size);
        rx_offset_ += frame_size;
        if (error != MergerError::None) {
            if (failed_) {
                return error;  // fatal: framing/header is untrustworthy
            }
            // Non-fatal correlation error; keep merging subsequent frames.
            result = error;
        }
    }

    // Compact consumed prefix so adjacent frames cannot be mis-assembled.
    if (rx_offset_ > 0) {
        rx_.erase(rx_.begin(),
                  rx_.begin() + static_cast<std::ptrdiff_t>(rx_offset_));
        rx_offset_ = 0;
    }
    return result;
}

MergerError FramedMerger::feed(const std::vector<uint8_t>& data) {
    return feed(data.data(), data.size());
}

void FramedMerger::reset() {
    rx_.clear();
    rx_offset_ = 0;
    pending_.clear();
    next_seqid_ = 0;
    failed_ = false;
    last_error_ = MergerError::None;
}

std::size_t FramedMerger::inFlightCount() const {
    return pending_.size();
}

std::size_t FramedMerger::bufferedBytes() const {
    return rx_.size() - rx_offset_;
}

bool FramedMerger::failed() const {
    return failed_;
}

MergerError FramedMerger::lastError() const {
    return last_error_;
}

}  // namespace dataeng
