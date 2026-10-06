#include "graph/adjacency_intersection.hpp"

#include <algorithm>

namespace graph {
namespace {

// Counts input IDs currently held by the algorithm (cursor heads plus the
// candidate being assembled) and enforces the configured budget.
class ResidentTracker {
public:
    explicit ResidentTracker(MemoryBudget budget) : budget_(budget) {}

    bool acquire() {
        if (resident_ + 1 > budget_.max_resident_ids) {
            return false;
        }
        ++resident_;
        peak_ = std::max(peak_, resident_);
        return true;
    }

    void release() {
        if (resident_ > 0) {
            --resident_;
        }
    }

    std::size_t peak() const { return peak_; }

private:
    MemoryBudget budget_;
    std::size_t resident_ = 0;
    std::size_t peak_ = 0;
};

// Holds the current head entry of one cursor plus its dedup state.
struct CursorHead {
    AdjacencyCursor* cursor;
    std::optional<AdjacencyEntry> head;
    NodeId last_yielded = 0;
    bool yielded_any = false;
    bool exhausted = false;
};

IntersectionError make_error(IntersectionErrorCode code, std::string message,
                             std::size_t cursor_index) {
    return IntersectionError{code, std::move(message), cursor_index};
}

using StepResult = Expected<bool, IntersectionError>;  // ok(true): entry loaded

// Advances the cursor past exactly one entry, refreshing `head`.
// Releases the previous head's resident slot before acquiring the next.
StepResult refill(CursorHead& ch, ResidentTracker& tracker, std::size_t index) {
    if (ch.head.has_value()) {
        tracker.release();
        ch.head.reset();
    }
    if (ch.exhausted) {
        return StepResult::ok(false);
    }
    auto step = ch.cursor->next();
    if (!step.has_value()) {
        return StepResult::err(make_error(IntersectionErrorCode::kCursorFailure,
                                          step.error().message, index));
    }
    if (!step.value().has_value()) {
        ch.exhausted = true;
        return StepResult::ok(false);
    }
    AdjacencyEntry entry = *step.value();
    if (ch.yielded_any && entry.node < ch.last_yielded) {
        return StepResult::err(make_error(
            IntersectionErrorCode::kUnsortedInput,
            "cursor yielded nodes out of non-decreasing order", index));
    }
    ch.yielded_any = true;
    ch.last_yielded = entry.node;
    if (!tracker.acquire()) {
        return StepResult::err(make_error(IntersectionErrorCode::kBudgetExceeded,
                                          "resident ID budget exceeded", index));
    }
    ch.head = entry;
    return StepResult::ok(true);
}

}  // namespace

Expected<IntersectionResult, IntersectionError> intersect_adjacency(
    const std::vector<std::shared_ptr<AdjacencyCursor>>& cursors,
    MemoryBudget budget) {
    using Result = Expected<IntersectionResult, IntersectionError>;

    ResidentTracker tracker(budget);

    std::vector<CursorHead> heads;
    heads.reserve(cursors.size());
    for (const auto& cursor : cursors) {
        heads.push_back(CursorHead{cursor.get(), std::nullopt, 0, false, false});
    }

    // Prime every cursor with its first entry.
    for (std::size_t i = 0; i < heads.size(); ++i) {
        auto step = refill(heads[i], tracker, i);
        if (!step.has_value()) {
            return Result::err(std::move(step).error());
        }
    }

    // Accumulated privately; only moved into the return value on success, so
    // a mid-stream failure can never publish a partial result.
    IntersectionResult result;

    while (true) {
        NodeId lo = 0;
        NodeId hi = 0;
        bool any = false;
        std::size_t active = 0;
        for (const auto& ch : heads) {
            if (!ch.head.has_value()) {
                continue;
            }
            ++active;
            if (!any) {
                lo = hi = ch.head->node;
                any = true;
            } else {
                lo = std::min(lo, ch.head->node);
                hi = std::max(hi, ch.head->node);
            }
        }
        // Intersection is empty as soon as any cursor is exhausted.
        if (!any || active < heads.size()) {
            break;
        }

        if (lo == hi) {
            // Common node in every set: merge edge sources from all cursors,
            // skipping intra-set duplicates. One extra resident slot accounts
            // for the candidate being assembled.
            if (!tracker.acquire()) {
                return Result::err(make_error(
                    IntersectionErrorCode::kBudgetExceeded,
                    "resident ID budget exceeded while assembling candidate",
                    heads.size()));
            }
            IntersectionHit hit;
            hit.node = lo;
            for (std::size_t i = 0; i < heads.size(); ++i) {
                while (heads[i].head.has_value() && heads[i].head->node == lo) {
                    SourceId source = heads[i].head->source;
                    if (std::find(hit.sources.begin(), hit.sources.end(),
                                  source) == hit.sources.end()) {
                        hit.sources.push_back(source);
                    }
                    auto step = refill(heads[i], tracker, i);
                    if (!step.has_value()) {
                        tracker.release();
                        return Result::err(std::move(step).error());
                    }
                }
            }
            tracker.release();
            std::sort(hit.sources.begin(), hit.sources.end());
            result.hits.push_back(std::move(hit));
        } else {
            // `lo` cannot appear in the cursor currently at `hi`, so every
            // cursor sitting at `lo` can skip the node entirely.
            for (std::size_t i = 0; i < heads.size(); ++i) {
                while (heads[i].head.has_value() && heads[i].head->node == lo) {
                    auto step = refill(heads[i], tracker, i);
                    if (!step.has_value()) {
                        return Result::err(std::move(step).error());
                    }
                }
            }
        }
    }

    result.peak_resident_ids = tracker.peak();
    return Result::ok(std::move(result));
}

}  // namespace graph
