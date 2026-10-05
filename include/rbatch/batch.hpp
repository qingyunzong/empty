#pragma once

#include "rbatch/handle.hpp"

#include <cstddef>
#include <utility>
#include <vector>

namespace rbatch {

// A batch of acquired resource handles.
// Movable, not copyable. On destruction the remaining handles are released
// in reverse acquisition order; a throwing release callback does not stop
// the remaining handles from being released.
class ResourceBatch {
public:
    ResourceBatch() = default;
    explicit ResourceBatch(std::vector<Handle> handles) noexcept
        : handles_(std::move(handles)) {}

    ResourceBatch(const ResourceBatch&) = delete;
    ResourceBatch& operator=(const ResourceBatch&) = delete;
    ResourceBatch(ResourceBatch&&) noexcept = default;
    ResourceBatch& operator=(ResourceBatch&&) noexcept = default;

    ~ResourceBatch() { release_all(); }

    // Releases all remaining handles, newest first. Each release is
    // attempted even if an earlier callback throws.
    void release_all() noexcept {
        while (!handles_.empty()) {
            Handle h = std::move(handles_.back());
            handles_.pop_back();
            try {
                h.release();
            } catch (...) {
                // Keep releasing the remaining handles.
            }
        }
    }

    [[nodiscard]] std::size_t size() const noexcept { return handles_.size(); }
    [[nodiscard]] bool empty() const noexcept { return handles_.empty(); }
    [[nodiscard]] const Handle& at(std::size_t i) const { return handles_.at(i); }

private:
    std::vector<Handle> handles_;
};

// Acquires count resources by calling factory(0..count-1), which must
// return a Handle. If the factory throws for the k-th item, every handle
// acquired so far is released in reverse order (tolerating throwing release
// callbacks) and the original exception is rethrown.
template <typename Factory>
ResourceBatch acquire_batch(std::size_t count, Factory&& factory) {
    std::vector<Handle> handles;
    handles.reserve(count);
    try {
        for (std::size_t i = 0; i < count; ++i) {
            handles.push_back(factory(i));
        }
    } catch (...) {
        ResourceBatch rollback(std::move(handles));
        rollback.release_all();
        throw;
    }
    return ResourceBatch(std::move(handles));
}

} // namespace rbatch
