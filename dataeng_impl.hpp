#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {
namespace detail {

template <class T>
struct Ref {
    const T* row;
    std::size_t idx;
};

// Finalization mixer so that arbitrary user hashers still spread keys well
// across partitions, and different recursion levels split differently.
inline std::uint64_t mixHash(std::uint64_t h, std::size_t depth) {
    h ^= 0x9e3779b97f4a7c15ULL * static_cast<std::uint64_t>(depth + 1);
    h += 0x9e3779b97f4a7c15ULL;
    h = (h ^ (h >> 30)) * 0xbf58476d1ce4e5b9ULL;
    h = (h ^ (h >> 27)) * 0x94d049bb133111ebULL;
    return h ^ (h >> 31);
}

// Emit one equal-key group with consistent multiset semantics for every join
// type. An empty group means the key exists only on the other side.
template <class VecL, class VecR>
void emitGroup(const VecL& leftIdx, const VecR& rightIdx,
               JoinType type, const JoinSink& sink) {
    const bool hasL = leftIdx.size() > 0;
    const bool hasR = rightIdx.size() > 0;

    if (hasL && hasR) {
        switch (type) {
            case JoinType::LeftSemi:
                for (std::size_t i = 0; i < leftIdx.size(); ++i) {
                    sink(JoinPair{leftIdx[i], std::nullopt});
                }
                return;
            case JoinType::LeftAnti:
                return;  // every left row has a match
            default:
                break;  // Cartesian product of the matching groups
        }
        for (std::size_t i = 0; i < leftIdx.size(); ++i) {
            for (std::size_t j = 0; j < rightIdx.size(); ++j) {
                sink(JoinPair{leftIdx[i], rightIdx[j]});
            }
        }
        return;
    }

    if (hasL) {
        if (type == JoinType::LeftOuter || type == JoinType::FullOuter ||
            type == JoinType::LeftAnti) {
            for (std::size_t i = 0; i < leftIdx.size(); ++i) {
                sink(JoinPair{leftIdx[i], std::nullopt});
            }
        }
        return;
    }

    if (hasR) {
        if (type == JoinType::RightOuter || type == JoinType::FullOuter) {
            for (std::size_t j = 0; j < rightIdx.size(); ++j) {
                sink(JoinPair{std::nullopt, rightIdx[j]});
            }
        }
    }
}

// In-memory hash join over one partition that fits the build budget.
template <class L, class R, class KeyOfL, class KeyOfR, class Hasher>
void inMemoryHashJoin(const std::vector<Ref<L>>& ls,
                      const std::vector<Ref<R>>& rs,
                      KeyOfL keyOfL, KeyOfR keyOfR,
                      JoinType type, const JoinSink& sink,
                      const Hasher& hasher) {
    std::unordered_map<std::int64_t, std::vector<std::size_t>> table;
    table.reserve(rs.size() * 2 + 1);
    for (std::size_t j = 0; j < rs.size(); ++j) {
        table[*keyOfR(*rs[j].row)].push_back(j);
    }

    std::vector<char> rightMatched(rs.size(), 0);
    std::vector<std::size_t> singleL;
    singleL.reserve(1);

    for (std::size_t i = 0; i < ls.size(); ++i) {
        auto it = table.find(*keyOfL(*ls[i].row));
        singleL.clear();
        singleL.push_back(ls[i].idx);
        if (it == table.end()) {
            emitGroup(singleL, std::vector<std::size_t>{}, type, sink);
            continue;
        }
        std::vector<std::size_t> rightOriginal;
        rightOriginal.reserve(it->second.size());
        for (std::size_t local : it->second) {
            rightMatched[local] = 1;
            rightOriginal.push_back(rs[local].idx);
        }
        emitGroup(singleL, rightOriginal, type, sink);
    }

    if (type == JoinType::RightOuter || type == JoinType::FullOuter) {
        std::vector<std::size_t> emptyLeft;
        for (std::size_t j = 0; j < rs.size(); ++j) {
            if (!rightMatched[j]) {
                std::vector<std::size_t> singleR{rs[j].idx};
                emitGroup(emptyLeft, singleR, type, sink);
            }
        }
    }
    (void)hasher;
}

// Sort-merge fallback: sort both sides by key and merge equal-key groups.
template <class L, class R, class KeyOfL, class KeyOfR>
void sortMergeJoin(const std::vector<Ref<L>>& ls,
                   const std::vector<Ref<R>>& rs,
                   KeyOfL keyOfL, KeyOfR keyOfR,
                   JoinType type, const JoinSink& sink) {
    std::vector<std::pair<std::int64_t, std::size_t>> la;
    std::vector<std::pair<std::int64_t, std::size_t>> ra;
    la.reserve(ls.size());
    ra.reserve(rs.size());
    for (const auto& ref : ls) la.push_back({*keyOfL(*ref.row), ref.idx});
    for (const auto& ref : rs) ra.push_back({*keyOfR(*ref.row), ref.idx});
    std::sort(la.begin(), la.end());
    std::sort(ra.begin(), ra.end());

    std::size_t i = 0;
    std::size_t j = 0;
    while (i < la.size() || j < ra.size()) {
        std::int64_t key;
        if (j == ra.size() || (i < la.size() && la[i].first < ra[j].first)) {
            key = la[i].first;
        } else {
            key = ra[j].first;
        }
        std::vector<std::size_t> lg;
        std::vector<std::size_t> rg;
        while (i < la.size() && la[i].first == key) {
            lg.push_back(la[i].second);
            ++i;
        }
        while (j < ra.size() && ra[j].first == key) {
            rg.push_back(ra[j].second);
            ++j;
        }
        emitGroup(lg, rg, type, sink);
    }
}

template <class L, class R, class KeyOfL, class KeyOfR, class Hasher>
void graceRecurse(std::vector<Ref<L>> ls, std::vector<Ref<R>> rs,
                  std::size_t depth, const JoinConfig& config,
                  KeyOfL keyOfL, KeyOfR keyOfR, JoinType type,
                  const JoinSink& sink, JoinStats& stats,
                  const Hasher& hasher) {
    stats.recursionDepth = std::max(stats.recursionDepth, depth);

    // Partition fits in memory (an empty build side always fits).
    if (rs.size() <= config.buildBudget) {
        ++stats.inMemoryJoins;
        inMemoryHashJoin(ls, rs, keyOfL, keyOfR, type, sink, hasher);
        return;
    }

    // Recursion guard: pathological hashing cannot split forever.
    if (depth >= config.maxRecursionDepth) {
        ++stats.depthLimitFallbacks;
        sortMergeJoin(ls, rs, keyOfL, keyOfR, type, sink);
        return;
    }

    // Build-side key frequencies drive skew detection.
    std::unordered_map<std::int64_t, std::size_t> frequency;
    frequency.reserve(rs.size() * 2 + 1);
    for (const auto& ref : rs) ++frequency[*keyOfR(*ref.row)];

    std::vector<std::int64_t> heavyKeys;
    for (const auto& kv : frequency) {
        if (kv.second >= config.heavyKeyThreshold) heavyKeys.push_back(kv.first);
    }

    if (!heavyKeys.empty()) {
        ++stats.skewFallbacks;
        stats.heavyKeys += heavyKeys.size();

        if (config.skewStrategy == SkewStrategy::SortMerge) {
            sortMergeJoin(ls, rs, keyOfL, keyOfR, type, sink);
            return;
        }

        // Single-key streaming: peel each heavy key off and stream it, then
        // recursively join the now-smaller remainder.
        std::sort(heavyKeys.begin(), heavyKeys.end());
        std::unordered_map<std::int64_t, std::vector<Ref<L>>> heavyL;
        std::unordered_map<std::int64_t, std::vector<Ref<R>>> heavyR;
        std::vector<Ref<L>> restL;
        std::vector<Ref<R>> restR;
        restL.reserve(ls.size());
        restR.reserve(rs.size());

        for (const auto& ref : rs) {
            std::int64_t key = *keyOfR(*ref.row);
            if (frequency[key] >= config.heavyKeyThreshold) {
                heavyR[key].push_back(ref);
            } else {
                restR.push_back(ref);
            }
        }
        for (const auto& ref : ls) {
            std::int64_t key = *keyOfL(*ref.row);
            auto hit = frequency.find(key);
            if (hit != frequency.end() &&
                hit->second >= config.heavyKeyThreshold) {
                heavyL[key].push_back(ref);
            } else {
                restL.push_back(ref);
            }
        }

        for (std::int64_t key : heavyKeys) {
            auto lit = heavyL.find(key);
            std::vector<std::size_t> lg;
            std::vector<std::size_t> rg;
            if (lit != heavyL.end()) {
                lg.reserve(lit->second.size());
                for (const auto& ref : lit->second) lg.push_back(ref.idx);
            }
            rg.reserve(heavyR[key].size());
            for (const auto& ref : heavyR[key]) rg.push_back(ref.idx);
            emitGroup(lg, rg, type, sink);
        }

        graceRecurse(std::move(restL), std::move(restR), depth + 1,
                     config, keyOfL, keyOfR, type, sink, stats, hasher);
        return;
    }

    // No skew: grace-style recursive partitioning on a mixed hash level.
    std::size_t fanout = std::max<std::size_t>(2, config.partitionFanout);
    std::vector<std::vector<Ref<L>>> partsL(fanout);
    std::vector<std::vector<Ref<R>>> partsR(fanout);
    stats.partitionsCreated += fanout;

    for (const auto& ref : rs) {
        std::uint64_t h = mixHash(
            static_cast<std::uint64_t>(hasher(*keyOfR(*ref.row))), depth);
        partsR[h % fanout].push_back(ref);
    }
    for (const auto& ref : ls) {
        std::uint64_t h = mixHash(
            static_cast<std::uint64_t>(hasher(*keyOfL(*ref.row))), depth);
        partsL[h % fanout].push_back(ref);
    }

    for (std::size_t p = 0; p < fanout; ++p) {
        graceRecurse(std::move(partsL[p]), std::move(partsR[p]), depth + 1,
                     config, keyOfL, keyOfR, type, sink, stats, hasher);
    }
}

}  // namespace detail

template <class L, class R, class KeyOfL, class KeyOfR, class Hasher>
void graceHashJoin(const std::vector<L>& left,
                   const std::vector<R>& right,
                   KeyOfL keyOfL,
                   KeyOfR keyOfR,
                   JoinType type,
                   const JoinConfig& config,
                   JoinSink sink,
                   JoinStats* stats,
                   const Hasher& hasher) {
    JoinStats local;
    JoinStats& out = stats ? *stats : local;

    std::vector<detail::Ref<L>> nonNullL;
    std::vector<detail::Ref<R>> nonNullR;
    nonNullL.reserve(left.size());
    nonNullR.reserve(right.size());

    // SQL 3VL: NULL never equals NULL, so null-key rows can never match.
    for (std::size_t i = 0; i < left.size(); ++i) {
        auto key = keyOfL(left[i]);
        if (!key.has_value()) {
            if (type == JoinType::LeftOuter ||
                type == JoinType::FullOuter ||
                type == JoinType::LeftAnti) {
                sink(JoinPair{i, std::nullopt});
            }
        } else {
            nonNullL.push_back({&left[i], i});
        }
    }
    for (std::size_t j = 0; j < right.size(); ++j) {
        auto key = keyOfR(right[j]);
        if (!key.has_value()) {
            if (type == JoinType::RightOuter ||
                type == JoinType::FullOuter) {
                sink(JoinPair{std::nullopt, j});
            }
        } else {
            nonNullR.push_back({&right[j], j});
        }
    }

    detail::graceRecurse(std::move(nonNullL), std::move(nonNullR), 0,
                         config, keyOfL, keyOfR, type, sink, out, hasher);
}

// O(n*m) null-aware reference implementation (the correctness oracle).
template <class L, class R, class KeyOfL, class KeyOfR>
void nestedLoopJoin(const std::vector<L>& left,
                    const std::vector<R>& right,
                    KeyOfL keyOfL,
                    KeyOfR keyOfR,
                    JoinType type,
                    JoinSink sink) {
    std::vector<char> rightMatched(right.size(), 0);

    for (std::size_t i = 0; i < left.size(); ++i) {
        auto lk = keyOfL(left[i]);
        std::size_t matches = 0;
        if (lk.has_value()) {
            for (std::size_t j = 0; j < right.size(); ++j) {
                auto rk = keyOfR(right[j]);
                if (rk.has_value() && *lk == *rk) {
                    ++matches;
                    rightMatched[j] = 1;
                    if (type != JoinType::LeftSemi &&
                        type != JoinType::LeftAnti) {
                        sink(JoinPair{i, j});
                    }
                }
            }
        }
        if (matches > 0) {
            if (type == JoinType::LeftSemi) {
                sink(JoinPair{i, std::nullopt});
            }
        } else if (type == JoinType::LeftOuter ||
                   type == JoinType::FullOuter ||
                   type == JoinType::LeftAnti) {
            sink(JoinPair{i, std::nullopt});
        }
    }

    if (type == JoinType::RightOuter || type == JoinType::FullOuter) {
        for (std::size_t j = 0; j < right.size(); ++j) {
            if (!rightMatched[j]) {
                sink(JoinPair{std::nullopt, j});
            }
        }
    }
}

}  // namespace dataeng
