#pragma once

#include <cstddef>
#include <map>
#include <unordered_map>

namespace cosched {

// Counts coroutine-frame allocations/releases, grouped by event-loop frame.
class FrameStats {
public:
    void begin_frame(std::size_t index) { current_frame_ = index; }

    void record_alloc(void* p) {
        releases_[p] += 0; // ensure entry exists
        ++total_allocs_;
    }

    void record_release(void* p) {
        ++releases_[p];
        ++per_frame_[current_frame_];
        ++total_releases_;
    }

    // Every coroutine frame must be released exactly once.
    bool all_released_once() const {
        for (const auto& [p, n] : releases_)
            if (n != 1) return false;
        return true;
    }

    std::size_t total_allocs() const { return total_allocs_; }
    std::size_t total_releases() const { return total_releases_; }
    const std::map<std::size_t, std::size_t>& per_frame() const { return per_frame_; }

private:
    std::size_t current_frame_ = 0;
    std::size_t total_allocs_ = 0;
    std::size_t total_releases_ = 0;
    std::unordered_map<void*, int> releases_;
    std::map<std::size_t, std::size_t> per_frame_;
};

inline FrameStats& stats() {
    static FrameStats s;
    return s;
}

inline void reset_stats() { stats() = FrameStats{}; }

} // namespace cosched
