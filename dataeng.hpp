#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

namespace dataeng {

// Join operator semantics. The "left" relation is the probe side and the
// "right" relation is the build (hashed) side of the grace hash join.
enum class JoinType {
    Inner,
    LeftOuter,
    RightOuter,
    FullOuter,
    LeftSemi,
    LeftAnti,
};

// Fallback strategy applied to a partition whose build side exceeds the
// in-memory budget and is dominated by a small number of heavy keys.
enum class SkewStrategy {
    // Sort both sides of the partition and merge equal-key groups.
    SortMerge,
    // Stream every heavy key one at a time; recursively join the remainder.
    SingleKeyStream,
};

struct JoinConfig {
    // Maximum number of build-side rows kept in one in-memory hash table.
    std::size_t buildBudget = 1024;
    // Fan-out used when recursively partitioning an over-budget partition.
    std::size_t partitionFanout = 4;
    // A key is "heavy" once its build-side frequency reaches this value.
    std::size_t heavyKeyThreshold = 32;
    // Upper bound on recursive partitioning depth before a forced fallback.
    std::size_t maxRecursionDepth = 32;
    // Strategy used for skew-dominated partitions.
    SkewStrategy skewStrategy = SkewStrategy::SortMerge;
};

struct JoinStats {
    std::size_t partitionsCreated = 0;
    std::size_t recursionDepth = 0;
    std::size_t inMemoryJoins = 0;
    std::size_t skewFallbacks = 0;
    std::size_t depthLimitFallbacks = 0;
    std::size_t heavyKeys = 0;
};

// A produced pair. A missing index means the side is unmatched (outer joins).
// Semi joins only populate leftIndex; anti joins only populate leftIndex.
struct JoinPair {
    std::optional<std::size_t> leftIndex;
    std::optional<std::size_t> rightIndex;
};

using JoinSink = std::function<void(const JoinPair&)>;

// Generic embeddable grace hash join.
//
// Left/right rows may be of any type. keyOf extracts the join key; a
// std::nullopt key represents SQL NULL. Hashing is pluggable through hasher.
// Output is streamed through sink, so the operator never materializes the
// full result multiset internally.
template <class L, class R, class KeyOfL, class KeyOfR,
          class Hasher = std::hash<std::int64_t>>
void graceHashJoin(const std::vector<L>& left,
                   const std::vector<R>& right,
                   KeyOfL keyOfL,
                   KeyOfR keyOfR,
                   JoinType type,
                   const JoinConfig& config,
                   JoinSink sink,
                   JoinStats* stats = nullptr,
                   const Hasher& hasher = Hasher{});

// O(n*m) null-aware nested-loop reference implementation. Its emitted
// multiset is the correctness oracle for the grace hash join.
template <class L, class R, class KeyOfL, class KeyOfR>
void nestedLoopJoin(const std::vector<L>& left,
                    const std::vector<R>& right,
                    KeyOfL keyOfL,
                    KeyOfR keyOfR,
                    JoinType type,
                    JoinSink sink);

// Convenience overload for rows whose key is a nullable 64-bit value.
struct Row {
    std::optional<std::int64_t> key;
    std::int64_t payload = 0;
};

void graceHashJoin(const std::vector<Row>& left,
                   const std::vector<Row>& right,
                   JoinType type,
                   const JoinConfig& config,
                   JoinSink sink,
                   JoinStats* stats = nullptr);

void nestedLoopJoin(const std::vector<Row>& left,
                    const std::vector<Row>& right,
                    JoinType type,
                    JoinSink sink);

}  // namespace dataeng

#define DATAENG_GRACE_HASH_JOIN_IMPL
#include "dataeng_impl.hpp"
