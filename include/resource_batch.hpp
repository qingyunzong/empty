#pragma once

#include <cstddef>
#include <exception>
#include <functional>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

namespace resource_batch {

// Thrown by acquire_batch when the k-th acquisition fails.
// `index` is the zero-based position of the failed acquisition;
// `release_errors` counts release callbacks that threw during rollback.
struct AcquireError : std::runtime_error {
    std::size_t index;
    std::size_t release_errors;
    AcquireError(std::size_t idx, std::size_t rel_errors, const char* what)
        : std::runtime_error(what), index(idx), release_errors(rel_errors) {}
};

// RAII handle for a single acquired resource.
// Movable, non-copyable; releases exactly once on destruction/reset.
// A throwing release callback never escapes the destructor.
class Handle {
public:
    using ReleaseFn = std::function<void(std::size_t)>;

    Handle() = default;
    Handle(std::size_t id, ReleaseFn release)
        : id_(id), release_(std::move(release)) {}

    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;

    Handle(Handle&& other) noexcept
        : id_(other.id_), release_(std::move(other.release_)) {
        other.id_.reset();
        other.release_ = nullptr;
    }

    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) {
            reset();
            id_ = other.id_;
            release_ = std::move(other.release_);
            other.id_.reset();
            other.release_ = nullptr;
        }
        return *this;
    }

    ~Handle() { reset(); }

    // Releases the held resource (if any). Swallows callback exceptions so
    // cleanup of a batch always continues; returns false if the callback threw.
    bool reset() noexcept {
        bool ok = true;
        if (id_ && release_) {
            try {
                release_(*id_);
            } catch (...) {
                ok = false;
            }
        }
        id_.reset();
        release_ = nullptr;
        return ok;
    }

    std::size_t id() const { return id_.value(); }
    bool valid() const { return id_.has_value(); }
    explicit operator bool() const { return valid(); }

private:
    std::optional<std::size_t> id_;
    ReleaseFn release_;
};

static_assert(!std::is_copy_constructible_v<Handle>);
static_assert(!std::is_copy_assignable_v<Handle>);
static_assert(std::is_move_constructible_v<Handle>);
static_assert(std::is_move_assignable_v<Handle>);
static_assert(std::is_nothrow_move_constructible_v<Handle>);

// Acquires `count` resources by calling acquire(i) for i in [0, count).
// Each acquired id is wrapped in a Handle bound to `release`.
// If the k-th acquisition throws, every already-acquired resource is released
// in reverse acquisition order (k-1 ... 0). Throwing release callbacks are
// contained so rollback always cleans up the remaining items; the original
// acquisition failure is then rethrown as AcquireError.
template <typename Acquire, typename Release>
[[nodiscard]] std::vector<Handle> acquire_batch(std::size_t count,
                                                Acquire&& acquire,
                                                Release&& release) {
    std::vector<Handle> handles;
    handles.reserve(count);
    std::size_t i = 0;
    try {
        for (; i < count; ++i) {
            handles.emplace_back(acquire(i), Handle::ReleaseFn(release));
        }
    } catch (const std::exception& e) {
        std::size_t release_errors = 0;
        for (auto it = handles.rbegin(); it != handles.rend(); ++it) {
            if (!it->reset()) {
                ++release_errors;
            }
        }
        handles.clear();
        throw AcquireError(i, release_errors, e.what());
    } catch (...) {
        for (auto it = handles.rbegin(); it != handles.rend(); ++it) {
            it->reset();
        }
        handles.clear();
        throw;
    }
    return handles;
}

} // namespace resource_batch
