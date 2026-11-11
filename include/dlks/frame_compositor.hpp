#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace dlks {

// Disposal method associated with an indexed frame. The semantics follow the
// classic animated-image model:
//   none            - the frame remains on the canvas after display
//   restore_bg      - after display the frame rectangle is filled with the
//                     canvas background color
//   restore_prev    - after display the frame rectangle is restored to the
//                     canvas contents that were present immediately before
//                     the frame was drawn
enum class DisposalMode : std::uint8_t {
    none = 0,
    restore_bg = 1,
    restore_prev = 2,
};

struct Rgba {
    std::uint8_t r = 0;
    std::uint8_t g = 0;
    std::uint8_t b = 0;
    std::uint8_t a = 255;

    bool operator==(const Rgba& other) const = default;
};

struct Rect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;

    bool operator==(const Rect& other) const = default;
};

// A decoded indexed frame. `indices` is row-major with `rect.width` columns
// and `rect.height` rows. Each index selects an entry of `palette`. When an
// index equals `transparent_index` the underlying canvas pixel is preserved.
// `transparent_index < 0` disables transparency for the frame.
struct IndexedFrame {
    std::vector<Rgba> palette;
    std::vector<std::uint16_t> indices;
    int transparent_index = -1;
    Rect rect;
    DisposalMode disposal = DisposalMode::none;
};

// Checkpoint captured after a frame has been displayed: it holds the visible
// canvas together with the pending disposal of that frame (including the
// saved pre-draw region for restore_prev), so a rebuild can apply the
// disposal before drawing any later frame. Checkpoints describe displayed
// frames only; the post-disposal canvas is never persisted as a displayed
// frame. The blank canvas checkpoint uses frame_index == static_cast<size_t>(-1).
struct Checkpoint {
    std::size_t frame_index = 0;
    std::vector<Rgba> canvas;
    DisposalMode pending_mode = DisposalMode::none;
    Rect pending_rect{};
    std::vector<Rgba> pending_pixels;
};

class FrameCompositor {
public:
    FrameCompositor(int canvas_width, int canvas_height, Rgba background,
                    std::size_t max_checkpoints = 4);

    int width() const noexcept { return width_; }
    int height() const noexcept { return height_; }
    std::size_t size() const noexcept { return frames_.size(); }
    std::size_t cursor() const noexcept { return cursor_; }
    std::size_t checkpoint_count() const noexcept { return checkpoints_.size(); }

    // Appends a decoded frame. The frame is rejected as a whole (returning
    // false and leaving the compositor unchanged) when the target rectangle is
    // not fully inside the canvas, when the index/palette data is malformed,
    // or when a non-negative transparent index is out of palette range.
    bool append_frame(const IndexedFrame& frame);
    bool append_frame(IndexedFrame&& frame);

    // Renders frame `frame_index` and returns the displayed canvas (row-major,
    // width() * height() pixels). Seeks rebuild from the nearest preceding
    // checkpoint or from the blank canvas. Throws std::out_of_range when the
    // frame index does not exist.
    const std::vector<Rgba>& render_frame(std::size_t frame_index);

    // Sequential playback: applies the pending disposal of the previously
    // displayed frame, then draws the next frame. Returns false at end of
    // stream instead of wrapping around.
    bool render_next();

    // Returns the most recently displayed frame's canvas without rendering.
    const std::vector<Rgba>& current_canvas() const noexcept { return canvas_; }

    // Rewinds to the blank canvas. Stored checkpoints are kept so a later seek
    // can still rebuild efficiently.
    void reset();

    const std::string& last_error() const noexcept { return last_error_; }

private:
    struct PendingDisposal {
        DisposalMode mode = DisposalMode::none;
        Rect rect{};
        std::vector<Rgba> saved_pixels;
    };

    bool validate(const IndexedFrame& frame);
    void apply_pending_disposal();
    void draw_frame(const IndexedFrame& frame);
    void capture_checkpoint(std::size_t frame_index, const PendingDisposal& pending);
    void load_checkpoint(const Checkpoint& checkpoint);
    void blank_checkpoint();

    int width_;
    int height_;
    Rgba background_;
    std::size_t max_checkpoints_;
    std::vector<IndexedFrame> frames_;
    std::vector<Rgba> canvas_;
    PendingDisposal pending_;
    bool has_pending_ = false;
    std::size_t cursor_ = 0;
    // Frame index -> checkpoint. The blank canvas is keyed at -1.
    std::map<std::int64_t, Checkpoint> checkpoints_;
    std::string last_error_;
};

}  // namespace dlks
