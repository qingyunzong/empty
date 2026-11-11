#include "dlks/frame_compositor.hpp"

#include <algorithm>
#include <array>
#include <iostream>
#include <random>
#include <string>
#include <vector>

using namespace dlks;

namespace {

constexpr int kGeneratorCanvasWidth = 8;
constexpr int kGeneratorCanvasHeight = 8;

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string& message) {
    ++g_checks;
    if (!condition) {
        ++g_failures;
        std::cerr << "FAIL: " << message << '\n';
    }
}

// Naive independent reference implementation: every rendered frame is rebuilt
// from the blank canvas with no checkpointing, encoding the disposal semantics
// separately from the production compositor.
class ReferenceCompositor {
public:
    ReferenceCompositor(int width, int height, Rgba background,
                        std::vector<IndexedFrame> frames)
        : width_(width),
          height_(height),
          background_(background),
          frames_(std::move(frames)) {}

    std::vector<Rgba> render(std::size_t target) {
        std::vector<Rgba> canvas(
            static_cast<std::size_t>(width_) * height_, background_);

        struct Pending {
            DisposalMode mode = DisposalMode::none;
            Rect rect{};
            std::vector<Rgba> saved;
        } pending;
        bool has_pending = false;

        for (std::size_t k = 0; k <= target; ++k) {
            const IndexedFrame& frame = frames_[k];
            if (has_pending) {
                if (pending.mode == DisposalMode::restore_bg) {
                    fill_rect(canvas, pending.rect, background_);
                } else if (pending.mode == DisposalMode::restore_prev) {
                    put_rect(canvas, pending.rect, pending.saved);
                }
            }

            Pending next;
            next.mode = frame.disposal;
            next.rect = frame.rect;
            if (frame.disposal == DisposalMode::restore_prev) {
                next.saved = get_rect(canvas, frame.rect);
            }

            draw(canvas, frame);
            pending = std::move(next);
            has_pending = true;
        }
        return canvas;
    }

private:
    std::vector<Rgba> get_rect(const std::vector<Rgba>& canvas, const Rect& rect) {
        std::vector<Rgba> pixels(
            static_cast<std::size_t>(rect.width) * rect.height);
        std::size_t out = 0;
        for (int row = 0; row < rect.height; ++row) {
            const Rgba* line = canvas.data() +
                               static_cast<std::size_t>(rect.y + row) * width_ +
                               rect.x;
            for (int col = 0; col < rect.width; ++col) {
                pixels[out++] = line[col];
            }
        }
        return pixels;
    }

    void put_rect(std::vector<Rgba>& canvas, const Rect& rect,
                  const std::vector<Rgba>& pixels) {
        std::size_t in = 0;
        for (int row = 0; row < rect.height; ++row) {
            Rgba* line = canvas.data() +
                         static_cast<std::size_t>(rect.y + row) * width_ + rect.x;
            for (int col = 0; col < rect.width; ++col) {
                line[col] = pixels[in++];
            }
        }
    }

    void fill_rect(std::vector<Rgba>& canvas, const Rect& rect, Rgba color) {
        for (int row = 0; row < rect.height; ++row) {
            Rgba* line = canvas.data() +
                         static_cast<std::size_t>(rect.y + row) * width_ + rect.x;
            for (int col = 0; col < rect.width; ++col) {
                line[col] = color;
            }
        }
    }

    void draw(std::vector<Rgba>& canvas, const IndexedFrame& frame) {
        std::size_t cell = 0;
        for (int row = 0; row < frame.rect.height; ++row) {
            Rgba* line = canvas.data() +
                         static_cast<std::size_t>(frame.rect.y + row) * width_ +
                         frame.rect.x;
            for (int col = 0; col < frame.rect.width; ++col, ++cell) {
                const std::uint16_t index = frame.indices[cell];
                if (frame.transparent_index >= 0 &&
                    index == static_cast<std::uint16_t>(frame.transparent_index)) {
                    continue;
                }
                line[col] = frame.palette[index];
            }
        }
    }

    int width_;
    int height_;
    Rgba background_;
    std::vector<IndexedFrame> frames_;
};

std::vector<Rgba> make_palette(std::mt19937& rng) {
    static const std::array<Rgba, 8> colors = {{
        {255, 0, 0, 255},   {0, 255, 0, 255},   {0, 0, 255, 255},
        {255, 255, 0, 255}, {255, 0, 255, 255}, {0, 255, 255, 255},
        {64, 64, 64, 255},  {200, 128, 32, 255},
    }};
    const std::size_t size = 3 + rng() % 4;
    std::vector<Rgba> palette(size);
    for (Rgba& color : palette) {
        color = colors[rng() % colors.size()];
    }
    return palette;
}

// Frames overlap in a central band, mixing transparency and cycling through
// all three disposal modes.
std::vector<IndexedFrame> make_frames(std::size_t count, std::mt19937& rng) {
    std::vector<IndexedFrame> frames;
    const DisposalMode modes[3] = {DisposalMode::none, DisposalMode::restore_bg,
                                   DisposalMode::restore_prev};
    for (std::size_t i = 0; i < count; ++i) {
        IndexedFrame frame;
        frame.palette = make_palette(rng);
        frame.rect.width = 4 + rng() % 4;
        frame.rect.height = 3 + rng() % 3;
        frame.rect.x = rng() % (kGeneratorCanvasWidth - frame.rect.width + 1);
        frame.rect.y = rng() % (kGeneratorCanvasHeight - frame.rect.height + 1);
        frame.transparent_index = (rng() % 2 == 0)
                                      ? static_cast<int>(rng() % frame.palette.size())
                                      : -1;
        frame.disposal = modes[i % 3];
        frame.indices.resize(
            static_cast<std::size_t>(frame.rect.width) * frame.rect.height);
        for (std::uint16_t& index : frame.indices) {
            index = static_cast<std::uint16_t>(rng() % frame.palette.size());
        }
        frames.push_back(std::move(frame));
    }
    return frames;
}

void test_sequential_and_seek_consistency(std::size_t max_checkpoints,
                                          std::size_t frame_count,
                                          std::mt19937& rng) {
    constexpr int kWidth = 12;
    constexpr int kHeight = 10;
    const Rgba background{10, 20, 30, 255};
    std::vector<IndexedFrame> frames = make_frames(frame_count, rng);
    ReferenceCompositor reference(kWidth, kHeight, background, frames);

    FrameCompositor compositor(kWidth, kHeight, background, max_checkpoints);
    for (const IndexedFrame& frame : frames) {
        check(compositor.append_frame(frame), "all generated frames are valid");
    }
    check(compositor.size() == frame_count, "compositor stores every frame");

    // Sequential playback matches the reference for every displayed frame.
    for (std::size_t i = 0; i < frame_count; ++i) {
        check(compositor.render_next(), "sequential playback advances");
        const std::vector<Rgba> expected = reference.render(i);
        check(compositor.current_canvas() == expected,
              "sequential frame " + std::to_string(i) + " matches reference");
    }
    check(!compositor.render_next(), "playback stops at end of stream");
    check(compositor.checkpoint_count() <= max_checkpoints + 1,
          "checkpoint count stays bounded");

    // Random seeks, including repeats and backwards seeks, return the same
    // pixels as rebuilding from scratch.
    FrameCompositor seeker(kWidth, kHeight, background, max_checkpoints);
    for (const IndexedFrame& frame : frames) {
        seeker.append_frame(frame);
    }
    for (int round = 0; round < 200; ++round) {
        const std::size_t target = rng() % frame_count;
        const std::vector<Rgba>& actual = seeker.render_frame(target);
        const std::vector<Rgba> expected = reference.render(target);
        check(actual == expected,
              "seek to frame " + std::to_string(target) + " (round " +
                  std::to_string(round) + ", max_checkpoints=" +
                  std::to_string(max_checkpoints) + ") matches reference");
        check(seeker.cursor() == target + 1, "cursor follows seek target");
    }
}

void test_transparent_index_preserves_background() {
    FrameCompositor compositor(6, 4, Rgba{1, 2, 3, 255}, 2);

    IndexedFrame base;
    base.rect = Rect{1, 1, 4, 2};
    base.palette = {Rgba{10, 10, 10, 255}};
    base.indices.assign(8, 0);
    check(compositor.append_frame(base), "base frame accepted");

    IndexedFrame overlay;
    overlay.rect = Rect{2, 1, 3, 2};
    overlay.palette = {Rgba{90, 90, 90, 255}, Rgba{7, 8, 9, 255}};
    overlay.transparent_index = 1;
    overlay.indices = {0, 1, 0, 1, 0, 1};
    check(compositor.append_frame(overlay), "overlay frame accepted");

    const std::vector<Rgba>& first = compositor.render_frame(0);
    check(first[1 * 6 + 1] == Rgba(10, 10, 10, 255),
          "base frame paints its rectangle");

    const std::vector<Rgba>& second = compositor.render_frame(1);
    check(second[1 * 6 + 2] == Rgba(90, 90, 90, 255), "opaque index paints");
    check(second[1 * 6 + 3] == Rgba(10, 10, 10, 255),
          "transparent index keeps the previous frame");
    check(second[2 * 6 + 2] == Rgba(10, 10, 10, 255),
          "transparent index keeps the previous frame on second row");
    check(second[0] == Rgba(1, 2, 3, 255), "untouched pixels keep the background");
}

void test_restore_background_disposal() {
    FrameCompositor compositor(5, 5, Rgba{0, 0, 0, 255}, 2);

    IndexedFrame first;
    first.rect = Rect{1, 1, 2, 2};
    first.palette = {Rgba{255, 255, 255, 255}};
    first.indices.assign(4, 0);
    first.disposal = DisposalMode::restore_bg;
    check(compositor.append_frame(first), "restore_bg frame accepted");

    IndexedFrame second;
    second.rect = Rect{3, 3, 1, 1};
    second.palette = {Rgba{50, 60, 70, 255}};
    second.indices = {0};
    check(compositor.append_frame(second), "second frame accepted");

    compositor.render_frame(0);
    check(compositor.current_canvas()[1 * 5 + 1] == Rgba(255, 255, 255, 255),
          "restore_bg frame stays visible while displayed");

    compositor.render_frame(1);
    check(compositor.current_canvas()[2 * 5 + 2] == Rgba(0, 0, 0, 255),
          "restore_bg region returns to background before next draw");
    check(compositor.current_canvas()[3 * 5 + 3] == Rgba(50, 60, 70, 255),
          "next frame is drawn after disposal");

    // Re-seeking the first frame shows its pixels again, proving the disposed
    // canvas was not cached as a displayed frame.
    compositor.render_frame(0);
    check(compositor.current_canvas()[1 * 5 + 1] == Rgba(255, 255, 255, 255),
          "seek re-displays the restore_bg frame correctly");
}

void test_restore_previous_disposal() {
    FrameCompositor compositor(6, 6, Rgba{0, 0, 0, 255}, 3);

    IndexedFrame base;
    base.rect = Rect{1, 1, 4, 4};
    base.palette = {Rgba{30, 30, 30, 255}};
    base.indices.assign(16, 0);
    check(compositor.append_frame(base), "base frame accepted");

    IndexedFrame overlay;
    overlay.rect = Rect{2, 2, 3, 3};
    overlay.palette = {Rgba{200, 200, 200, 255}};
    overlay.indices.assign(9, 0);
    overlay.disposal = DisposalMode::restore_prev;
    check(compositor.append_frame(overlay), "restore_prev frame accepted");

    IndexedFrame after;
    after.rect = Rect{0, 0, 1, 1};
    after.palette = {Rgba{9, 9, 9, 255}};
    after.indices = {0};
    check(compositor.append_frame(after), "tail frame accepted");

    compositor.render_frame(0);
    compositor.render_frame(1);
    check(compositor.current_canvas()[3 * 6 + 3] == Rgba(200, 200, 200, 255),
          "restore_prev overlay is visible while displayed");

    compositor.render_frame(2);
    check(compositor.current_canvas()[3 * 6 + 3] == Rgba(30, 30, 30, 255),
          "overlay region restores pre-draw base content");
    check(compositor.current_canvas()[2 * 6 + 2] == Rgba(30, 30, 30, 255),
          "overlay corner restores pre-draw base content");
    check(compositor.current_canvas()[0] == Rgba(9, 9, 9, 255),
          "tail frame still paints outside the restored region");

    // Seek back to the overlay: the saved pre-draw region must be reconstructed
    // from checkpoints, not taken from the post-disposal canvas.
    compositor.render_frame(1);
    check(compositor.current_canvas()[3 * 6 + 3] == Rgba(200, 200, 200, 255),
          "seeking re-displays the restore_prev overlay");
    compositor.render_frame(2);
    check(compositor.current_canvas()[3 * 6 + 3] == Rgba(30, 30, 30, 255),
          "seek after restore_prev overlay restores base content again");
}

void test_out_of_bounds_frames_are_rejected() {
    FrameCompositor compositor(4, 4, Rgba{0, 0, 0, 255}, 2);

    IndexedFrame good;
    good.rect = Rect{0, 0, 4, 4};
    good.palette = {Rgba{1, 1, 1, 255}};
    good.indices.assign(16, 0);
    check(compositor.append_frame(good), "full-canvas frame accepted");
    check(compositor.size() == 1, "valid frame is stored");

    const Rect bad_rects[] = {
        Rect{1, 0, 4, 4},   // extends past right edge
        Rect{0, 1, 4, 4},   // extends past bottom edge
        Rect{-1, 0, 2, 2},  // negative x
        Rect{0, -1, 2, 2},  // negative y
        Rect{0, 0, 0, 2},   // zero width
        Rect{0, 0, 2, 0},   // zero height
        Rect{3, 3, 2, 2},   // starts inside, ends outside
    };
    for (const Rect& rect : bad_rects) {
        IndexedFrame bad;
        bad.rect = rect;
        bad.palette = {Rgba{2, 2, 2, 255}};
        const std::size_t cells =
            static_cast<std::size_t>(std::max(rect.width, 0)) *
            static_cast<std::size_t>(std::max(rect.height, 0));
        bad.indices.assign(cells, 0);
        check(!compositor.append_frame(bad),
              "out-of-bounds rectangle is rejected");
    }
    check(compositor.size() == 1, "rejected frames are not stored");

    // Malformed frame data is rejected as a whole as well.
    IndexedFrame mismatched;
    mismatched.rect = Rect{0, 0, 2, 2};
    mismatched.palette = {Rgba{1, 2, 3, 255}};
    mismatched.indices = {0, 0, 0};
    check(!compositor.append_frame(mismatched),
          "index buffer size mismatch is rejected");

    IndexedFrame bad_transparent;
    bad_transparent.rect = Rect{0, 0, 1, 1};
    bad_transparent.palette = {Rgba{1, 2, 3, 255}};
    bad_transparent.indices = {0};
    bad_transparent.transparent_index = 2;
    check(!compositor.append_frame(bad_transparent),
          "transparent index outside palette is rejected");

    IndexedFrame bad_index;
    bad_index.rect = Rect{0, 0, 1, 1};
    bad_index.palette = {Rgba{1, 2, 3, 255}};
    bad_index.indices = {1};
    check(!compositor.append_frame(bad_index),
          "index outside palette is rejected");
}

void test_reset_and_single_checkpoint_seek() {
    std::mt19937 rng(20261111);
    constexpr int kWidth = 8;
    constexpr int kHeight = 8;
    const Rgba background{5, 5, 5, 255};
    std::vector<IndexedFrame> frames = make_frames(12, rng);
    ReferenceCompositor reference(kWidth, kHeight, background, frames);

    FrameCompositor compositor(kWidth, kHeight, background, 1);
    for (const IndexedFrame& frame : frames) {
        compositor.append_frame(frame);
    }

    compositor.render_frame(11);
    check(compositor.checkpoint_count() <= 2,
          "single retained checkpoint plus blank canvas");

    compositor.reset();
    check(compositor.cursor() == 0, "reset rewinds the cursor");
    check(compositor.current_canvas() ==
              std::vector<Rgba>(kWidth * kHeight, background),
          "reset restores the blank background canvas");

    for (std::size_t target : {std::size_t{0}, std::size_t{11}, std::size_t{3},
                               std::size_t{7}, std::size_t{0}}) {
        const std::vector<Rgba>& actual = compositor.render_frame(target);
        check(actual == reference.render(target),
              "post-reset seek to frame " + std::to_string(target) +
                  " matches reference with one checkpoint");
    }
}

}  // namespace

int main() {
    test_transparent_index_preserves_background();
    test_restore_background_disposal();
    test_restore_previous_disposal();
    test_out_of_bounds_frames_are_rejected();
    test_reset_and_single_checkpoint_seek();

    std::mt19937 rng(42);
    for (std::size_t max_checkpoints : {std::size_t{1}, std::size_t{2},
                                         std::size_t{3}, std::size_t{8}}) {
        test_sequential_and_seek_consistency(max_checkpoints, 24, rng);
    }

    std::cout << g_checks << " checks, " << g_failures << " failures\n";
    return g_failures == 0 ? 0 : 1;
}
