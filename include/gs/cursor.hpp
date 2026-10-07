#pragma once

#include <concepts>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace gs {

using NodeId = std::int64_t;

enum class ErrorCode {
    CursorFailure,   // an input cursor reported a failure or violated its contract
    BudgetExceeded,  // resident-id memory budget cannot hold the required cursors
};

struct Error {
    ErrorCode code;
    std::string message;
};

// Minimal expected-like type (std::expected is C++23; we target C++20).
template <typename T>
class Expected {
public:
    Expected(const T& value) : data_(value) {}
    Expected(T&& value) : data_(std::move(value)) {}
    Expected(Error error) : data_(std::move(error)) {}

    bool has_value() const { return std::holds_alternative<T>(data_); }
    explicit operator bool() const { return has_value(); }

    const T& value() const { return std::get<T>(data_); }
    T& value() { return std::get<T>(data_); }
    const T& operator*() const { return value(); }
    T& operator*() { return value(); }
    const T* operator->() const { return &value(); }
    T* operator->() { return &value(); }

    const Error& error() const { return std::get<Error>(data_); }

private:
    std::variant<T, Error> data_;
};

// A node cursor streams a sorted (non-decreasing) sequence of node ids.
// Duplicates are allowed. next() returns:
//   - Expected holding a NodeId        -> next element
//   - Expected holding std::nullopt    -> end of stream
//   - Expected holding an Error        -> stream failure
template <typename C>
concept NodeCursor = requires(C& c) {
    { c.next() } -> std::same_as<Expected<std::optional<NodeId>>>;
};

// Type-erased cursor so heterogeneous cursor implementations can be
// collected into a single std::vector.
class Cursor {
public:
    template <NodeCursor C>
        requires(!std::same_as<std::remove_cvref_t<C>, Cursor>)
    Cursor(C&& cursor) : impl_(std::make_unique<Model<std::decay_t<C>>>(std::forward<C>(cursor))) {}

    Expected<std::optional<NodeId>> next() { return impl_->next(); }

private:
    struct Base {
        virtual ~Base() = default;
        virtual Expected<std::optional<NodeId>> next() = 0;
    };
    template <NodeCursor C>
    struct Model final : Base {
        explicit Model(C cursor) : cursor_(std::move(cursor)) {}
        Expected<std::optional<NodeId>> next() override { return cursor_.next(); }
        C cursor_;
    };
    std::unique_ptr<Base> impl_;
};

// Non-owning cursor over an already materialized, sorted id range.
// Iterates by index; never copies the underlying list.
class SpanCursor {
public:
    explicit SpanCursor(const std::vector<NodeId>& ids) : ids_(&ids) {}

    Expected<std::optional<NodeId>> next() {
        if (pos_ >= ids_->size()) return std::optional<NodeId>{std::nullopt};
        return std::optional<NodeId>{(*ids_)[pos_++]};
    }

private:
    const std::vector<NodeId>* ids_;
    std::size_t pos_ = 0;
};

// Owning cursor over a sorted id list (handy for tests and adapters).
class VectorCursor {
public:
    explicit VectorCursor(std::vector<NodeId> ids) : ids_(std::move(ids)) {}

    Expected<std::optional<NodeId>> next() {
        if (pos_ >= ids_.size()) return std::optional<NodeId>{std::nullopt};
        return std::optional<NodeId>{ids_[pos_++]};
    }

private:
    std::vector<NodeId> ids_;
    std::size_t pos_ = 0;
};

}  // namespace gs
