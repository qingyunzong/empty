#pragma once

#include "gs/cursor.hpp"

#include <cstddef>
#include <utility>
#include <vector>

namespace gs {

// Budget on the number of node ids that may be resident in memory at once.
// The intersection algorithm holds exactly one current id per input cursor,
// so it needs (and uses) only k slots for k inputs.
class MemoryBudget {
public:
    explicit MemoryBudget(std::size_t max_resident_ids) : limit_(max_resident_ids) {}

    [[nodiscard]] bool try_acquire() {
        if (resident_ >= limit_) return false;
        ++resident_;
        if (resident_ > max_resident_) max_resident_ = resident_;
        return true;
    }
    void release() { --resident_; }

    std::size_t resident() const { return resident_; }
    std::size_t max_resident() const { return max_resident_; }
    std::size_t limit() const { return limit_; }

private:
    std::size_t limit_;
    std::size_t resident_ = 0;
    std::size_t max_resident_ = 0;
};

// Provenance of one edge contributing to a common neighbor.
struct EdgeSource {
    std::size_t list_index;  // which input adjacency set
    NodeId from;             // owner of that adjacency set
    NodeId to;               // the common neighbor
};

struct CommonNeighbor {
    NodeId node;
    std::vector<EdgeSource> sources;  // one entry per input set
};

struct IntersectionResult {
    std::vector<CommonNeighbor> entries;  // unique nodes, ascending
};

struct AdjacencyInput {
    NodeId owner;
    Cursor cursor;
};

namespace detail {

enum class Step { Value, End };

// Pull the next distinct value from a cursor, skipping in-stream duplicates
// and rejecting unsorted input (contract violation -> CursorFailure).
template <NodeCursor C>
Expected<Step> next_distinct(C& cursor, NodeId& last, NodeId& out) {
    for (;;) {
        auto item = cursor.next();
        if (!item) return item.error();
        if (!item->has_value()) return Step::End;
        const NodeId v = **item;
        if (v < last) {
            return Error{ErrorCode::CursorFailure, "cursor produced unsorted ids"};
        }
        if (v == last) continue;  // duplicate inside one set: skip
        last = v;
        out = v;
        return Step::Value;
    }
}

}  // namespace detail

// Streaming k-way intersection of sorted adjacency sets.
//
// - Reads at most one id per cursor at any time (k resident ids for k
//   inputs); never materializes a whole input list.
// - Duplicates inside an input set are tolerated; the result is unique.
// - Every result entry records the contributing edge of every input set.
// - If any cursor fails (or violates the sorted contract), an Error is
//   returned and no result is published.
inline Expected<IntersectionResult> intersectAdjacency(std::vector<AdjacencyInput>& inputs,
                                                       MemoryBudget& budget) {
    const std::size_t k = inputs.size();
    IntersectionResult result;
    if (k == 0) return result;

    struct SlotGuard {
        MemoryBudget& budget;
        std::size_t held = 0;
        ~SlotGuard() {
            while (held > 0) {
                budget.release();
                --held;
            }
        }
    } guard{budget};

    for (std::size_t i = 0; i < k; ++i) {
        if (!budget.try_acquire()) {
            return Error{ErrorCode::BudgetExceeded,
                         "memory budget too small: need one resident id per input cursor"};
        }
        ++guard.held;
    }

    std::vector<NodeId> last(k, 0), head(k, 0);
    std::vector<bool> started(k, false);

    auto pull = [&](std::size_t i) -> Expected<detail::Step> {
        if (!started[i]) {
            // First pull per cursor: no "last" value to dedupe against yet.
            for (;;) {
                auto item = inputs[i].cursor.next();
                if (!item) return item.error();
                if (!item->has_value()) return detail::Step::End;
                started[i] = true;
                last[i] = **item;
                head[i] = **item;
                return detail::Step::Value;
            }
        }
        return detail::next_distinct(inputs[i].cursor, last[i], head[i]);
    };

    for (std::size_t i = 0; i < k; ++i) {
        auto step = pull(i);
        if (!step) return step.error();
        if (*step == detail::Step::End) return result;  // empty set -> empty intersection
    }

    for (;;) {
        NodeId mn = head[0], mx = head[0];
        for (std::size_t i = 1; i < k; ++i) {
            if (head[i] < mn) mn = head[i];
            if (head[i] > mx) mx = head[i];
        }

        if (mn == mx) {
            CommonNeighbor entry;
            entry.node = mn;
            entry.sources.reserve(k);
            for (std::size_t i = 0; i < k; ++i) {
                entry.sources.push_back(EdgeSource{i, inputs[i].owner, mn});
            }
            result.entries.push_back(std::move(entry));
            for (std::size_t i = 0; i < k; ++i) {
                auto step = pull(i);
                if (!step) return step.error();
                if (*step == detail::Step::End) return result;
            }
        } else {
            for (std::size_t i = 0; i < k; ++i) {
                if (head[i] != mn) continue;
                auto step = pull(i);
                if (!step) return step.error();
                if (*step == detail::Step::End) return result;
            }
        }
    }
}

}  // namespace gs
