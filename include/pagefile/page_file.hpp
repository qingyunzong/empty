#pragma once

#include "pagefile/mapper.hpp"

#include <cstddef>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>

namespace pagefile {

// A growable page file handing out read-only views of its current mapping.
//
// Lifetime and concurrency guarantees:
//  - A View keeps its underlying mapping alive: expand() and close() never
//    invalidate or unmap memory that an outstanding View still references.
//  - close() rejects subsequent acquire() calls (they return std::nullopt);
//    the mapping is unmapped only when the last outstanding View is released.
//  - expand() installs a fresh mapping (old content is copied over); Views
//    acquired earlier keep observing the previous mapping, unchanged.
//  - acquire()/expand()/close()/is_closed()/size() are safe to call
//    concurrently from multiple threads. View destruction is thread-safe.
//  - write()/fill() mutate the current mapping and must be externally
//    synchronized against concurrent readers of that same generation.
class PageFile {
public:
    // Read-only handle to one generation of the mapping. Copyable and
    // movable; every copy extends the lifetime of the mapping it refers to.
    class View {
    public:
        View() = default;

        const std::byte* data() const noexcept {
            return holder_ ? holder_->mapping.data : nullptr;
        }
        std::size_t size() const noexcept {
            return holder_ ? holder_->mapping.size : 0;
        }
        explicit operator bool() const noexcept { return static_cast<bool>(holder_); }

        const std::byte& operator[](std::size_t index) const noexcept {
            return holder_->mapping.data[index];
        }
        const std::byte* begin() const noexcept { return data(); }
        const std::byte* end() const noexcept { return data() + size(); }

    private:
        friend class PageFile;

        // Shared ownership of one mapping generation. The last View (or the
        // PageFile itself, via `current`) to release the Holder unmaps it.
        struct Holder {
            std::shared_ptr<IMapper> mapper;
            Mapping mapping{};
            ~Holder() {
                if (mapping.data != nullptr) {
                    mapper->unmap(mapping);
                }
            }
        };

        explicit View(std::shared_ptr<Holder> holder) : holder_(std::move(holder)) {}

        std::shared_ptr<Holder> holder_;
    };

    explicit PageFile(std::size_t initial_size)
        : PageFile(std::make_shared<HeapMapper>(), initial_size) {}

    PageFile(std::shared_ptr<IMapper> mapper, std::size_t initial_size)
        : state_(std::make_shared<State>(std::move(mapper))) {
        auto holder = std::make_shared<View::Holder>();
        holder->mapper = state_->mapper;
        holder->mapping = state_->mapper->map(initial_size);
        state_->current = std::move(holder);
    }

    ~PageFile() { close(); }

    PageFile(PageFile&& other) noexcept : state_(std::move(other.state_)) {}
    PageFile& operator=(PageFile&& other) noexcept {
        if (this != &other) {
            close();
            state_ = std::move(other.state_);
        }
        return *this;
    }
    PageFile(const PageFile&) = delete;
    PageFile& operator=(const PageFile&) = delete;

    // Returns a view of the current mapping, or std::nullopt once closed
    // (including on a moved-from object).
    std::optional<View> acquire() const {
        const auto state = state_;
        if (!state) {
            return std::nullopt;
        }
        std::lock_guard lock(state->mu);
        if (state->closed) {
            return std::nullopt;
        }
        return View(state->current);
    }

    // Grows the file to `new_size` bytes, preserving existing content.
    // Outstanding views keep their previous mapping; new views see this one.
    // Throws std::logic_error if closed/moved-from, std::invalid_argument on
    // shrink, and propagates mapper failures with the state left unchanged.
    void expand(std::size_t new_size) {
        const auto state = require_state();
        std::lock_guard lock(state->mu);
        if (state->closed) {
            throw std::logic_error("pagefile: expand on a closed file");
        }
        const std::size_t old_size = state->current->mapping.size;
        if (new_size < old_size) {
            throw std::invalid_argument("pagefile: shrink is not supported");
        }
        if (new_size == old_size) {
            return;
        }
        auto holder = std::make_shared<View::Holder>();
        holder->mapper = state->mapper;
        holder->mapping = state->mapper->map(new_size);
        std::memcpy(holder->mapping.data, state->current->mapping.data, old_size);
        state->current = std::move(holder);
    }

    // Rejects future acquire() calls and drops the file's own reference to the
    // current mapping. The mapping is unmapped immediately if no views are
    // outstanding, otherwise when the last view is released. Idempotent.
    void close() noexcept {
        const auto state = state_;
        if (!state) {
            return;
        }
        std::lock_guard lock(state->mu);
        state->closed = true;
        state->current.reset();
    }

    bool is_closed() const {
        const auto state = state_;
        if (!state) {
            return true;
        }
        std::lock_guard lock(state->mu);
        return state->closed;
    }

    // Size of the current mapping generation; 0 when closed or moved-from.
    std::size_t size() const {
        const auto state = state_;
        if (!state) {
            return 0;
        }
        std::lock_guard lock(state->mu);
        return state->closed ? 0 : state->current->mapping.size;
    }

    // Writes `n` bytes into the current mapping at `offset`.
    void write(std::size_t offset, const void* src, std::size_t n) {
        const auto state = require_state();
        std::lock_guard lock(state->mu);
        if (state->closed) {
            throw std::logic_error("pagefile: write on a closed file");
        }
        if (offset > state->current->mapping.size ||
            n > state->current->mapping.size - offset) {
            throw std::out_of_range("pagefile: write past end of mapping");
        }
        std::memcpy(state->current->mapping.data + offset, src, n);
    }

    // Fills the whole current mapping with `value`.
    void fill(std::byte value) {
        const auto state = require_state();
        std::lock_guard lock(state->mu);
        if (state->closed) {
            throw std::logic_error("pagefile: fill on a closed file");
        }
        std::memset(state->current->mapping.data, static_cast<int>(value),
                    state->current->mapping.size);
    }

private:
    struct State {
        explicit State(std::shared_ptr<IMapper> m) : mapper(std::move(m)) {}
        std::shared_ptr<IMapper> mapper;
        std::mutex mu;
        std::shared_ptr<View::Holder> current;
        bool closed = false;
    };

    std::shared_ptr<State> require_state() const {
        if (!state_) {
            throw std::logic_error("pagefile: moved-from object");
        }
        return state_;
    }

    std::shared_ptr<State> state_;
};

} // namespace pagefile
