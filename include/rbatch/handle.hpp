#pragma once

#include <functional>
#include <utility>

namespace rbatch {

// Release callback: receives the resource id. May throw; see Handle::release.
using ReleaseFn = std::function<void(int)>;

// RAII handle for a single acquired resource.
// Movable, not copyable. The resource is released exactly once.
class Handle {
public:
    Handle(int id, ReleaseFn release) noexcept
        : id_(id), release_(std::move(release)) {}

    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;

    Handle(Handle&& other) noexcept
        : id_(std::exchange(other.id_, kInvalid)),
          release_(std::move(other.release_)) {}

    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) {
            release_quiet();
            id_ = std::exchange(other.id_, kInvalid);
            release_ = std::move(other.release_);
        }
        return *this;
    }

    // Never throws: a throwing release callback is swallowed here so that
    // stack unwinding and batch cleanup can proceed with the remaining items.
    ~Handle() { release_quiet(); }

    [[nodiscard]] int id() const noexcept { return id_; }
    [[nodiscard]] bool valid() const noexcept { return id_ != kInvalid; }
    explicit operator bool() const noexcept { return valid(); }

    // Releases the resource now. The handle is left empty even if the
    // callback throws (the exception propagates to the caller), so the
    // resource is never released twice.
    void release() {
        if (!valid()) {
            return;
        }
        const int id = std::exchange(id_, kInvalid);
        if (release_) {
            release_(id);
        }
    }

private:
    static constexpr int kInvalid = -1;

    void release_quiet() noexcept {
        try {
            release();
        } catch (...) {
            // Destructor must not throw; the resource is still released.
        }
    }

    int id_ = kInvalid;
    ReleaseFn release_;
};

} // namespace rbatch
