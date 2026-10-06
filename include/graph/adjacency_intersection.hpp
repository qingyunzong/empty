#pragma once

// Streaming k-way intersection of adjacency sets.
//
// Design notes:
//  * Inputs are pulled lazily through AdjacencyCursor, one entry at a time,
//    so arbitrarily large adjacency lists are never materialized in memory.
//  * Cursors must yield entries in non-decreasing NodeId order; violations
//    are detected and reported as IntersectionErrorCode::kUnsortedInput.
//  * Duplicate entries inside one input (same node, possibly different edge
//    sources) are merged; every emitted IntersectionHit has a unique node.
//  * Memory usage is bounded by a budget on resident input IDs: at most
//    (number of cursors) + 1 entries are held at any time. Exceeding the
//    budget aborts with IntersectionErrorCode::kBudgetExceeded.
//  * Publication is atomic: the result is accumulated privately and only
//    handed out on full success. If any cursor fails, no partial result is
//    ever exposed to the caller.

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace graph {

using NodeId = std::uint64_t;
using SourceId = std::uint32_t;

// One adjacency record: an edge to `node` contributed by edge source `source`.
struct AdjacencyEntry {
    NodeId node{};
    SourceId source{};

    friend bool operator==(const AdjacencyEntry&, const AdjacencyEntry&) = default;
};

struct CursorError {
    std::string message;
};

// Minimal expected-like result type (C++20 has no std::expected).
template <typename T, typename E>
class Expected {
public:
    static Expected ok(T value) { return Expected(std::move(value)); }
    static Expected err(E error) { return Expected(std::move(error)); }

    bool has_value() const { return std::holds_alternative<T>(data_); }
    explicit operator bool() const { return has_value(); }

    const T& value() const& { return std::get<T>(data_); }
    T& value() & { return std::get<T>(data_); }
    T&& value() && { return std::move(std::get<T>(data_)); }

    const E& error() const& { return std::get<E>(data_); }

private:
    explicit Expected(T value) : data_(std::move(value)) {}
    explicit Expected(E error) : data_(std::move(error)) {}

    std::variant<T, E> data_;
};

// Pull-based cursor over one adjacency set.
// next() returns:
//   ok(entry)   - next entry (nodes must be non-decreasing across calls)
//   ok(nullopt) - input exhausted
//   err(...)    - input failure; intersection aborts without publishing
class AdjacencyCursor {
public:
    virtual ~AdjacencyCursor() = default;
    virtual Expected<std::optional<AdjacencyEntry>, CursorError> next() = 0;
};

// One intersected node plus the deduplicated, sorted edge sources that
// contributed edges to it across ALL input sets.
struct IntersectionHit {
    NodeId node{};
    std::vector<SourceId> sources;

    friend bool operator==(const IntersectionHit&, const IntersectionHit&) = default;
};

// Hard cap on simultaneously resident input IDs (cursor heads + the one
// candidate node currently being assembled).
struct MemoryBudget {
    std::size_t max_resident_ids;
};

enum class IntersectionErrorCode {
    kCursorFailure,
    kBudgetExceeded,
    kUnsortedInput,
};

struct IntersectionError {
    IntersectionErrorCode code;
    std::string message;
    std::size_t cursor_index = 0;
};

struct IntersectionResult {
    std::vector<IntersectionHit> hits;
    std::size_t peak_resident_ids = 0;  // observed high-water mark, for auditing
};

// Intersects the adjacency sets exposed by `cursors`.
//
// On success returns the unique, node-sorted hits with merged edge sources.
// On any failure (cursor error, unsorted input, budget exceeded) returns an
// IntersectionError and publishes nothing.
Expected<IntersectionResult, IntersectionError> intersect_adjacency(
    const std::vector<std::shared_ptr<AdjacencyCursor>>& cursors,
    MemoryBudget budget);

}  // namespace graph
