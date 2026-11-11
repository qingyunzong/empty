#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace imgrecon {

// Reconstructs a target image from seven interlaced data streams.
//
// The streams sample the target image using the (startX, startY, stepX, stepY)
// grid: (0,0,8,8), (4,0,8,8), (0,4,4,8), (2,0,4,4), (0,2,2,4), (1,0,2,2),
// (0,1,1,2). Each stream is a sequence of sub-image rows; every row is
// prefixed by a one-byte filter number (0..4) followed by the filtered bytes
// of that row. Streams may be delivered interleaved and split across arbitrary
// chunk boundaries; per-stream parsing state is retained across feed() calls.
//
// A target row is handed to the caller only once every pixel it contains has
// been produced by the stream that owns it, and rows are delivered in order.
// Any malformed input (illegal filter number, stream too short or too long)
// invalidates the whole image: the decoder is torn down and no further rows
// are emitted.
class InterlacedReconstructor {
public:
    enum class Error {
        None,
        InvalidStreamId,
        IllegalFilter,
        StreamTooLong,
        StreamTruncated,
    };

    // Called once per completed target row, with its (top-to-bottom) index and
    // a pointer to exactly width() * bytesPerPixel() bytes.
    using RowCallback = std::function<void(std::size_t rowIndex, const std::uint8_t* row)>;

    // bytesPerPixel must be 1 or 4; width and height must be positive.
    InterlacedReconstructor(int width, int height, int bytesPerPixel, RowCallback onRow);

    // Appends bytes belonging to stream [0..6]. Returns true on success. On the
    // first error the decoder is torn down and all subsequent calls fail.
    bool feed(int streamId, const std::uint8_t* data, std::size_t size);
    bool feed(int streamId, const std::vector<std::uint8_t>& data);

    // Verifies every stream received exactly its expected byte count. A short
    // stream tears the decoder down.
    bool finish();

    bool failed() const { return error_ != Error::None; }
    Error error() const { return error_; }

    int width() const { return width_; }
    int height() const { return height_; }
    int bytesPerPixel() const { return bpp_; }

    // Returns the exact number of encoded bytes expected for a stream.
    std::size_t expectedStreamBytes(int streamId) const;

    // Number of sub-image columns/rows covered by a stream (0 for empty ones).
    int subImageWidth(int streamId) const;
    int subImageHeight(int streamId) const;

private:
    struct StreamState {
        std::vector<std::uint8_t> buffer;
        std::size_t consumed = 0;
        std::size_t received = 0;
        std::vector<std::uint8_t> previousRow;
        int rowIndex = 0;
        int subWidth = 0;
        int subHeight = 0;
        std::size_t rowBytes = 0;
        std::size_t expectedBytes = 0;
    };

    void pump(StreamState& state, int streamId);
    void emitReadyRows();
    void fail(Error error);

    int width_;
    int height_;
    int bpp_;
    RowCallback onRow_;

    std::vector<std::uint8_t> image_;
    std::vector<std::uint8_t> fillCount_;
    std::vector<std::uint8_t> expectedFill_;
    std::array<StreamState, 7> streams_{};

    std::size_t nextRow_;
    Error error_;
};

}  // namespace imgrecon
