#include "dlks/frame_compositor.hpp"

#include <algorithm>
#include <stdexcept>

namespace dlks {

namespace {

bool inside_canvas(const Rect& rect, int width, int height) {
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }
    if (rect.x < 0 || rect.y < 0) {
        return false;
    }
    const long long right = static_cast<long long>(rect.x) + rect.width;
    const long long bottom = static_cast<long long>(rect.y) + rect.height;
    return right <= width && bottom <= height;
}

}  // namespace

FrameCompositor::FrameCompositor(int canvas_width, int canvas_height,
                                 Rgba background, std::size_t max_checkpoints)
    : width_(canvas_width),
      height_(canvas_height),
      background_(background),
      max_checkpoints_(max_checkpoints == 0 ? 1 : max_checkpoints) {
    if (canvas_width <= 0 || canvas_height <= 0) {
        throw std::invalid_argument("canvas dimensions must be positive");
    }
    canvas_.assign(static_cast<std::size_t>(canvas_width) * canvas_height, background_);
    blank_checkpoint();
}

bool FrameCompositor::validate(const IndexedFrame& frame) {
    if (!inside_canvas(frame.rect, width_, height_)) {
        last_error_ = "frame target rectangle is outside the canvas";
        return false;
    }
    if (frame.palette.empty() || frame.palette.size() > 256) {
        last_error_ = "frame palette must contain 1..256 entries";
        return false;
    }
    const std::size_t expected =
        static_cast<std::size_t>(frame.rect.width) * frame.rect.height;
    if (frame.indices.size() != expected) {
        last_error_ = "index buffer size does not match the target rectangle";
        return false;
    }
    if (frame.transparent_index >= 0 &&
        static_cast<std::size_t>(frame.transparent_index) >= frame.palette.size()) {
        last_error_ = "transparent index is outside the palette";
        return false;
    }
    for (std::uint16_t index : frame.indices) {
        if (static_cast<std::size_t>(index) >= frame.palette.size()) {
            last_error_ = "frame index references a missing palette entry";
            return false;
        }
    }
    return true;
}

bool FrameCompositor::append_frame(const IndexedFrame& frame) {
    if (!validate(frame)) {
        return false;
    }
    frames_.push_back(frame);
    return true;
}

bool FrameCompositor::append_frame(IndexedFrame&& frame) {
    if (!validate(frame)) {
        return false;
    }
    frames_.push_back(std::move(frame));
    return true;
}

void FrameCompositor::apply_pending_disposal() {
    if (!has_pending_) {
        return;
    }
    const Rect& rect = pending_.rect;
    if (pending_.mode == DisposalMode::restore_bg) {
        for (int row = 0; row < rect.height; ++row) {
            Rgba* line = canvas_.data() +
                         static_cast<std::size_t>(rect.y + row) * width_ + rect.x;
            std::fill(line, line + rect.width, background_);
        }
    } else if (pending_.mode == DisposalMode::restore_prev) {
        std::size_t offset = 0;
        for (int row = 0; row < rect.height; ++row) {
            Rgba* line = canvas_.data() +
                         static_cast<std::size_t>(rect.y + row) * width_ + rect.x;
            std::copy_n(pending_.saved_pixels.begin() + offset, rect.width, line);
            offset += static_cast<std::size_t>(rect.width);
        }
    }
    has_pending_ = false;
    pending_ = PendingDisposal{};
}

void FrameCompositor::draw_frame(const IndexedFrame& frame) {
    const Rect& rect = frame.rect;
    std::size_t cell = 0;
    for (int row = 0; row < rect.height; ++row) {
        Rgba* line = canvas_.data() +
                     static_cast<std::size_t>(rect.y + row) * width_ + rect.x;
        for (int col = 0; col < rect.width; ++col, ++cell) {
            const std::uint16_t index = frame.indices[cell];
            if (frame.transparent_index >= 0 &&
                index == static_cast<std::uint16_t>(frame.transparent_index)) {
                continue;
            }
            line[col] = frame.palette[index];
        }
    }
}

void FrameCompositor::capture_checkpoint(std::size_t frame_index,
                                         const PendingDisposal& pending) {
    Checkpoint checkpoint;
    checkpoint.frame_index = frame_index;
    checkpoint.canvas = canvas_;
    checkpoint.pending_mode = pending.mode;
    checkpoint.pending_rect = pending.rect;
    checkpoint.pending_pixels = pending.saved_pixels;

    checkpoints_[static_cast<std::int64_t>(frame_index)] = std::move(checkpoint);

    // Keep at most max_checkpoints_ displayed-frame checkpoints in addition to
    // the blank canvas checkpoint keyed at -1.
    while (checkpoints_.size() > max_checkpoints_ + 1) {
        auto oldest = checkpoints_.begin();
        if (oldest->first < 0) {
            ++oldest;
        }
        if (oldest == checkpoints_.end()) {
            break;
        }
        checkpoints_.erase(oldest);
    }
}

void FrameCompositor::load_checkpoint(const Checkpoint& checkpoint) {
    canvas_ = checkpoint.canvas;
    pending_.mode = checkpoint.pending_mode;
    pending_.rect = checkpoint.pending_rect;
    pending_.saved_pixels = checkpoint.pending_pixels;
    has_pending_ = checkpoint.pending_mode != DisposalMode::none;
    cursor_ = (checkpoint.frame_index == static_cast<std::size_t>(-1))
                  ? 0
                  : checkpoint.frame_index + 1;
}

void FrameCompositor::blank_checkpoint() {
    Checkpoint blank;
    blank.frame_index = static_cast<std::size_t>(-1);
    blank.canvas.assign(static_cast<std::size_t>(width_) * height_, background_);
    checkpoints_.emplace(static_cast<std::int64_t>(-1), std::move(blank));
}

const std::vector<Rgba>& FrameCompositor::render_frame(std::size_t frame_index) {
    if (frame_index >= frames_.size()) {
        throw std::out_of_range("frame index out of range");
    }

    auto nearest = checkpoints_.upper_bound(static_cast<std::int64_t>(frame_index));
    --nearest;
    // nearest is the blank canvas (key -1) when every retained checkpoint
    // describes a frame later than the target.
    load_checkpoint(nearest->second);

    while (cursor_ <= frame_index) {
        apply_pending_disposal();

        const IndexedFrame& frame = frames_[cursor_];
        PendingDisposal pending;
        pending.mode = frame.disposal;
        pending.rect = frame.rect;
        if (frame.disposal == DisposalMode::restore_prev) {
            pending.saved_pixels.resize(
                static_cast<std::size_t>(frame.rect.width) * frame.rect.height);
            std::size_t offset = 0;
            for (int row = 0; row < frame.rect.height; ++row) {
                const Rgba* line = canvas_.data() +
                                   static_cast<std::size_t>(frame.rect.y + row) *
                                       width_ +
                                   frame.rect.x;
                std::copy_n(line, frame.rect.width,
                            pending.saved_pixels.begin() + offset);
                offset += static_cast<std::size_t>(frame.rect.width);
            }
        }

        draw_frame(frame);
        capture_checkpoint(cursor_, pending);
        pending_ = std::move(pending);
        has_pending_ = true;
        ++cursor_;
    }

    return canvas_;
}

bool FrameCompositor::render_next() {
    if (cursor_ >= frames_.size() || frames_.empty()) {
        return false;
    }
    render_frame(cursor_);
    return true;
}

void FrameCompositor::reset() {
    canvas_.assign(static_cast<std::size_t>(width_) * height_, background_);
    has_pending_ = false;
    pending_ = PendingDisposal{};
    cursor_ = 0;
}

}  // namespace dlks
