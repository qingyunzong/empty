#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace dataeng {

// Thrift TBinaryProtocol message type (wire value of the high byte of the
// type-id field).
enum class MessageType : uint8_t {
    Call = 1,
    Reply = 2,
    Exception = 3,
    Oneway = 4,
};

// Error codes reported by FramedMerger. Fatal errors put the stream into a
// failed state; the caller must reset() before feeding more bytes.
enum class MergerError {
    None = 0,
    FrameTooLarge,        // frame length exceeds max_frame_bytes (fatal)
    MalformedFrame,       // not a valid TBinaryProtocol message (fatal)
    SeqIdInFlight,        // wrap-around: seqid still used by another call
    UnknownSeqId,         // response does not match any registered call
    MethodMismatch,       // seqid matches but method name differs
    TypeMismatch,         // seqid/method match but message type is unexpected
    StreamFailed,         // feed() called after an unrecoverable stream error
};

const char* toString(MergerError error);

// A fully reassembled, matched response frame.
struct MergedFrame {
    int32_t seqid = 0;
    MessageType type = MessageType::Reply;
    std::string method;
    // Complete framed bytes, including the leading 4-byte length prefix.
    std::vector<uint8_t> frame;
    // Message body (payload after the length prefix and the binary-protocol
    // message header), i.e. the reply/exception arguments.
    std::vector<uint8_t> body;
};

using FrameCallback = std::function<void(const MergedFrame&)>;

struct MergerConfig {
    // Maximum accepted frame length (bytes inside the length prefix).
    std::uint32_t max_frame_bytes = 16u * 1024u * 1024u;
    // Largest seqid handed out before wrapping back to 0. INT32_MAX mirrors
    // a full 32-bit positive range; tests may shrink it.
    std::int32_t seqid_ceiling = 2147483647;
};

// Embeddable multiplexing/merging layer for Thrift framed transport
// responses.
//
// Responses are correlated to outstanding calls by the tuple
// (seqid, method, message type). oneway calls consume a seqid but never
// wait for a response. An exception response terminates only its own call;
// other in-flight calls are untouched. When the seqid counter wraps while a
// candidate seqid is still in flight, the new call is rejected.
//
// feed() accepts arbitrary byte chunks (fragmented frames, multiple glued
// frames) and never mixes bytes across frame boundaries.
//
// The class is single-threaded: external synchronization is required if it
// is shared between threads.
class FramedMerger {
public:
    explicit FramedMerger(FrameCallback callback,
                          MergerConfig config = {});

    // Registers an outgoing call and assigns its seqid.
    // For oneway requests no entry is kept (nothing is awaited); every call
    // still consumes a seqid so wrap-around cannot alias an older request.
    // Returns MergerError::None on success and fills out_seqid.
    MergerError registerCall(const std::string& method,
                             MessageType type,
                             std::int32_t& out_seqid);

    // Feeds a chunk of framed bytes. Dispatches every complete, matched
    // response through the callback. Returns the first error encountered
    // (MergerError::None when the chunk was consumed cleanly). Partial data
    // is retained until the rest of its frame arrives.
    MergerError feed(const uint8_t* data, std::size_t size);
    MergerError feed(const std::vector<uint8_t>& data);

    // Drops every in-flight call and buffered byte; clears the failed flag.
    void reset();

    std::size_t inFlightCount() const;
    std::size_t bufferedBytes() const;
    bool failed() const;
    MergerError lastError() const;

    // --- wire helpers -------------------------------------------------
    // Builds one framed TBinaryProtocol message (length prefix + header +
    // body). Useful for embedding code that needs to emit/parse frames.
    static std::vector<uint8_t> buildFrame(int32_t seqid,
                                           MessageType type,
                                           const std::string& method,
                                           const std::vector<uint8_t>& body);

    // Encodes/decodes big-endian integers used by the framed prefix and the
    // binary protocol.
    static void writeBE32(std::vector<uint8_t>& out, std::uint32_t value);
    static std::uint32_t readBE32(const uint8_t* p);

private:
    struct Pending {
        std::string method;
        MessageType request_type;
    };

    MergerError fail(MergerError error);
    MergerError dispatchFrame(const uint8_t* frame, std::size_t frame_size);
    MergerError allocateSeqid(std::int32_t& out_seqid);

    FrameCallback callback_;
    MergerConfig config_;

    std::vector<std::uint8_t> rx_;   // reassembly buffer
    std::size_t rx_offset_ = 0;      // consumed prefix of rx_

    std::int32_t next_seqid_ = 0;
    bool failed_ = false;
    MergerError last_error_ = MergerError::None;

    // seqid -> outstanding request
    std::unordered_map<std::int32_t, Pending> pending_;
};

}  // namespace dataeng
