#include "interlaced_reconstructor.h"

#include <algorithm>
#include <stdexcept>

namespace imgrecon {

namespace {

struct PassSpec {
    int startX;
    int startY;
    int stepX;
    int stepY;
};

constexpr PassSpec kPasses[7] = {
    {0, 0, 8, 8},
    {4, 0, 8, 8},
    {0, 4, 4, 8},
    {2, 0, 4, 4},
    {0, 2, 2, 4},
    {1, 0, 2, 2},
    {0, 1, 1, 2},
};

int subCount(int start, int step, int extent) {
    if (start >= extent) {
        return 0;
    }
    return (extent - start - 1) / step + 1;
}

// PNG Paeth predictor: pick a, b or c by closeness to a + b - c, breaking
// ties in the order a, then b, then c.
std::uint8_t paeth(int a, int b, int c) {
    const int p = a + b - c;
    const int pa = std::abs(p - a);
    const int pb = std::abs(p - b);
    const int pc = std::abs(p - c);
    if (pa <= pb && pa <= pc) {
        return static_cast<std::uint8_t>(a);
    }
    if (pb <= pc) {
        return static_cast<std::uint8_t>(b);
    }
    return static_cast<std::uint8_t>(c);
}

}  // namespace

InterlacedReconstructor::InterlacedReconstructor(int width, int height, int bytesPerPixel,
                                                 RowCallback onRow)
    : width_(width),
      height_(height),
      bpp_(bytesPerPixel),
      onRow_(std::move(onRow)),
      nextRow_(0),
      error_(Error::None) {
    if (width <= 0 || height <= 0) {
        throw std::invalid_argument("width and height must be positive");
    }
    if (bytesPerPixel != 1 && bytesPerPixel != 4) {
        throw std::invalid_argument("bytesPerPixel must be 1 or 4");
    }

    const std::size_t rowSize = static_cast<std::size_t>(width) * bytesPerPixel;
    image_.assign(rowSize * static_cast<std::size_t>(height), 0);
    fillCount_.assign(static_cast<std::size_t>(height), 0);
    expectedFill_.assign(static_cast<std::size_t>(height), 0);
    // Count how many streams contribute at least one pixel to each target row.
    for (int pass = 0; pass < 7; ++pass) {
        const int columns = subCount(kPasses[pass].startX, kPasses[pass].stepX, width);
        if (columns == 0) {
            continue;
        }
        const int rows = subCount(kPasses[pass].startY, kPasses[pass].stepY, height);
        for (int row = 0; row < rows; ++row) {
            const int targetY = kPasses[pass].startY + row * kPasses[pass].stepY;
            ++expectedFill_[static_cast<std::size_t>(targetY)];
        }
    }

    for (int pass = 0; pass < 7; ++pass) {
        StreamState& state = streams_[pass];
        state.subWidth = subImageWidth(pass);
        state.subHeight = state.subWidth == 0 ? 0 : subImageHeight(pass);
        state.rowBytes = static_cast<std::size_t>(state.subWidth) * bytesPerPixel;
        state.previousRow.assign(state.rowBytes, 0);
        state.expectedBytes = expectedStreamBytes(pass);
    }
}

int InterlacedReconstructor::subImageWidth(int streamId) const {
    return subCount(kPasses[streamId].startX, kPasses[streamId].stepX, width_);
}

int InterlacedReconstructor::subImageHeight(int streamId) const {
    return subCount(kPasses[streamId].startY, kPasses[streamId].stepY, height_);
}

std::size_t InterlacedReconstructor::expectedStreamBytes(int streamId) const {
    const int rows = subImageHeight(streamId);
    const int columns = subImageWidth(streamId);
    if (rows == 0 || columns == 0) {
        return 0;
    }
    const std::size_t rowBytes =
        static_cast<std::size_t>(columns) * bpp_;
    return static_cast<std::size_t>(rows) * (rowBytes + 1);
}

bool InterlacedReconstructor::feed(int streamId, const std::uint8_t* data,
                                   std::size_t size) {
    if (error_ != Error::None) {
        return false;
    }
    if (streamId < 0 || streamId >= 7) {
        fail(Error::InvalidStreamId);
        return false;
    }
    StreamState& state = streams_[streamId];
    if (state.received + size > state.expectedBytes) {
        fail(Error::StreamTooLong);
        return false;
    }
    state.received += size;
    if (size != 0) {
        state.buffer.insert(state.buffer.end(), data, data + size);
        pump(state, streamId);
    }
    return error_ == Error::None;
}

bool InterlacedReconstructor::feed(int streamId, const std::vector<std::uint8_t>& data) {
    return feed(streamId, data.data(), data.size());
}

void InterlacedReconstructor::pump(StreamState& state, int streamId) {
    if (state.subWidth == 0 || state.subHeight == 0) {
        return;
    }
    const PassSpec& spec = kPasses[streamId];
    std::vector<std::uint8_t> reconstructed(state.rowBytes);

    // Compact once at the end; consumed stays relative to buffer's start for
    // the whole call so partial-row tails survive across feed() boundaries.
    while (true) {
        const std::size_t available = state.buffer.size() - state.consumed;
        // A complete row needs its filter byte plus the filtered row payload.
        if (available < state.rowBytes + 1) {
            break;
        }
        if (state.rowIndex >= state.subHeight) {
            fail(Error::StreamTooLong);
            return;
        }

        const std::uint8_t filterType = state.buffer[state.consumed];
        if (filterType > 4) {
            fail(Error::IllegalFilter);
            return;
        }

        const std::uint8_t* encoded = state.buffer.data() + state.consumed + 1;

        for (std::size_t i = 0; i < state.rowBytes; ++i) {
            const int a = (i >= static_cast<std::size_t>(bpp_))
                              ? reconstructed[i - bpp_]
                              : 0;
            const int b = state.previousRow[i];
            const int c = (i >= static_cast<std::size_t>(bpp_))
                              ? state.previousRow[i - bpp_]
                              : 0;

            int value = encoded[i];
            switch (filterType) {
                case 0:
                    break;
                case 1:
                    value += a;
                    break;
                case 2:
                    value += b;
                    break;
                case 3:
                    value += (a + b) / 2;
                    break;
                case 4:
                    value += paeth(a, b, c);
                    break;
            }
            reconstructed[i] = static_cast<std::uint8_t>(value & 0xFF);
        }

        // Scatter the sub-image row into the target image pixels owned by this
        // stream. Every (x, y) belongs to exactly one stream.
        const int targetY = spec.startY + state.rowIndex * spec.stepY;
        for (int column = 0; column < state.subWidth; ++column) {
            const int targetX = spec.startX + column * spec.stepX;
            const std::size_t dst =
                (static_cast<std::size_t>(targetY) * width_ + targetX) * bpp_;
            const std::size_t src = static_cast<std::size_t>(column) * bpp_;
            for (int byte = 0; byte < bpp_; ++byte) {
                image_[dst + byte] = reconstructed[src + byte];
            }
        }

        ++fillCount_[static_cast<std::size_t>(targetY)];
        state.previousRow = reconstructed;
        state.consumed += state.rowBytes + 1;
        ++state.rowIndex;

        emitReadyRows();
        if (error_ != Error::None) {
            return;
        }
    }
    if (state.consumed != 0) {
        state.buffer.erase(
            state.buffer.begin(),
            state.buffer.begin() + static_cast<std::ptrdiff_t>(state.consumed));
        state.consumed = 0;
    }
}

void InterlacedReconstructor::emitReadyRows() {
    const std::size_t rowSize = static_cast<std::size_t>(width_) * bpp_;
    while (nextRow_ < static_cast<std::size_t>(height_) &&
           fillCount_[nextRow_] == expectedFill_[nextRow_]) {
        if (onRow_) {
            onRow_(nextRow_, image_.data() + nextRow_ * rowSize);
        }
        ++nextRow_;
    }
}

bool InterlacedReconstructor::finish() {
    if (error_ != Error::None) {
        return false;
    }
    for (int pass = 0; pass < 7; ++pass) {
        const StreamState& state = streams_[pass];
        if (state.received != state.expectedBytes ||
            state.rowIndex != state.subHeight || !state.buffer.empty()) {
            fail(Error::StreamTruncated);
            return false;
        }
    }
    if (nextRow_ != static_cast<std::size_t>(height_)) {
        fail(Error::StreamTruncated);
        return false;
    }
    return true;
}

void InterlacedReconstructor::fail(Error error) {
    error_ = error;
    // Tear the whole image down: buffered data and partially built pixels must
    // not be handed to the caller after a failure.
    for (StreamState& state : streams_) {
        state.buffer.clear();
        state.buffer.shrink_to_fit();
        state.previousRow.clear();
        state.consumed = 0;
        state.received = 0;
        state.rowIndex = 0;
    }
    image_.clear();
    image_.shrink_to_fit();
    fillCount_.clear();
    expectedFill_.clear();
    nextRow_ = 0;
}

}  // namespace imgrecon
