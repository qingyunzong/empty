#include "dataeng.hpp"

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <optional>
#include <random>
#include <set>
#include <vector>

using dataeng::JoinConfig;
using dataeng::JoinPair;
using dataeng::JoinStats;
using dataeng::JoinType;
using dataeng::Row;
using dataeng::SkewStrategy;

using Bag = std::multiset<std::pair<std::optional<std::size_t>,
                                    std::optional<std::size_t>>>;

static Bag runGrace(const std::vector<Row>& left,
                    const std::vector<Row>& right,
                    JoinType type,
                    const JoinConfig& config,
                    JoinStats* stats = nullptr) {
    Bag out;
    dataeng::graceHashJoin(left, right, type, config,
                           [&](const JoinPair& p) {
                               out.insert({p.leftIndex, p.rightIndex});
                           },
                           stats);
    return out;
}

static Bag runNested(const std::vector<Row>& left,
                     const std::vector<Row>& right,
                     JoinType type) {
    Bag out;
    dataeng::nestedLoopJoin(left, right, type,
                            [&](const JoinPair& p) {
                                out.insert({p.leftIndex, p.rightIndex});
                            });
    return out;
}

static const JoinType kAllTypes[] = {
    JoinType::Inner,     JoinType::LeftOuter, JoinType::RightOuter,
    JoinType::FullOuter, JoinType::LeftSemi,  JoinType::LeftAnti,
};

static void assertEqual(const Bag& got, const Bag& want, const char* label) {
    if (got != want) {
        std::cerr << "MISMATCH in " << label << "\n  got " << got.size()
                  << " rows, want " << want.size() << " rows\n";
        for (const auto& p : want) {
            if (got.find(p) == got.end()) {
                std::cerr << "  missing pair ("
                          << (p.first ? std::to_string(*p.first) : "null")
                          << ","
                          << (p.second ? std::to_string(*p.second) : "null")
                          << ")\n";
            }
        }
        std::abort();
    }
}

static void testFixedSemantics() {
    // Duplicates on both sides plus unmatched and null rows.
    std::vector<Row> left = {
        {1, 0}, {1, 1}, {2, 2}, {std::nullopt, 3}, {7, 4},
    };
    std::vector<Row> right = {
        {1, 5}, {1, 6}, {3, 7}, {std::nullopt, 8}, {2, 9},
    };
    JoinConfig config;
    for (JoinType t : kAllTypes) {
        assertEqual(runGrace(left, right, t, config),
                    runNested(left, right, t), "fixed semantics");
    }

    // Null-only relations.
    std::vector<Row> nulls = {{std::nullopt, 0}, {std::nullopt, 1}};
    for (JoinType t : kAllTypes) {
        assertEqual(runGrace(nulls, nulls, t, config),
                    runNested(nulls, nulls, t), "all-null");
        assertEqual(runGrace({}, nulls, t, config),
                    runNested({}, nulls, t), "empty left");
        assertEqual(runGrace(nulls, {}, t, config),
                    runNested(nulls, {}, t), "empty right");
    }
}

static void testSkewFallback() {
    // One dominant key (40 copies) dwarfs the small budget -> heavy key.
    std::vector<Row> left;
    std::vector<Row> right;
    for (int k = 0; k < 40; ++k) {
        left.push_back({99, k});
        right.push_back({99, 100 + k});
    }
    for (int k = 0; k < 8; ++k) {
        left.push_back({k, 200 + k});
        right.push_back({k + 1, 300 + k});  // mostly non-matching tails
    }

    for (SkewStrategy strategy :
         {SkewStrategy::SortMerge, SkewStrategy::SingleKeyStream}) {
        JoinConfig config;
        config.buildBudget = 8;
        config.heavyKeyThreshold = 16;
        config.partitionFanout = 4;
        config.skewStrategy = strategy;
        JoinStats stats;
        for (JoinType t : kAllTypes) {
            assertEqual(runGrace(left, right, t, config, &stats),
                        runNested(left, right, t), "skew fallback");
        }
        assert(stats.skewFallbacks > 0);
        assert(stats.heavyKeys >= 1);
    }
}

static void testRecursivePartitioning() {
    // Many distinct keys, tiny budget: must recurse without declaring skew.
    std::vector<Row> left;
    std::vector<Row> right;
    std::mt19937 rng(42);
    for (int i = 0; i < 400; ++i) {
        std::int64_t k = rng() % 200;
        left.push_back({k, i});
        if (rng() % 2 == 0) right.push_back({k, 1000 + i});
    }
    JoinConfig config;
    config.buildBudget = 12;
    config.heavyKeyThreshold = 10000;  // effectively disable skew detection
    config.partitionFanout = 4;
    JoinStats stats;
    for (JoinType t : kAllTypes) {
        assertEqual(runGrace(left, right, t, config, &stats),
                    runNested(left, right, t), "recursive partitioning");
    }
    assert(stats.recursionDepth >= 2);
    assert(stats.skewFallbacks == 0);
}

static void testDepthLimitFallback() {
    // All rows share one key and the threshold is unreachable; the recursion
    // guard must still terminate with a correct result.
    std::vector<Row> left;
    std::vector<Row> right;
    for (int i = 0; i < 60; ++i) {
        left.push_back({5, i});
        right.push_back({5, 60 + i});
    }
    JoinConfig config;
    config.buildBudget = 8;
    config.heavyKeyThreshold = 100000;
    config.maxRecursionDepth = 3;
    config.partitionFanout = 2;
    JoinStats stats;
    for (JoinType t : kAllTypes) {
        assertEqual(runGrace(left, right, t, config, &stats),
                    runNested(left, right, t), "depth limit fallback");
    }
    assert(stats.depthLimitFallbacks > 0);
}

static void testRandomDifferential() {
    std::mt19937 rng(7);
    for (int iter = 0; iter < 200; ++iter) {
        std::size_t ln = rng() % 80;
        std::size_t rn = rng() % 80;
        std::vector<Row> left;
        std::vector<Row> right;
        for (std::size_t i = 0; i < ln; ++i) {
            if (rng() % 7 == 0) {
                left.push_back({std::nullopt, static_cast<std::int64_t>(i)});
            } else {
                left.push_back({static_cast<std::int64_t>(rng() % 12),
                                static_cast<std::int64_t>(i)});
            }
        }
        for (std::size_t j = 0; j < rn; ++j) {
            if (rng() % 7 == 0) {
                right.push_back({std::nullopt, static_cast<std::int64_t>(j)});
            } else {
                right.push_back({static_cast<std::int64_t>(rng() % 12),
                                 static_cast<std::int64_t>(j)});
            }
        }

        JoinConfig config;
        config.buildBudget = 1 + rng() % 24;
        config.partitionFanout = 2 + rng() % 6;
        config.heavyKeyThreshold = 1 + rng() % 40;
        config.maxRecursionDepth = 1 + rng() % 8;
        config.skewStrategy =
            (rng() % 2) ? SkewStrategy::SortMerge
                        : SkewStrategy::SingleKeyStream;

        for (JoinType t : kAllTypes) {
            assertEqual(runGrace(left, right, t, config),
                        runNested(left, right, t), "random differential");
        }
    }
}

// Embeddability check with a foreign row type and a custom key extractor.
struct OrderRow {
    int orderId;
    int customerFk;  // negative means SQL NULL
};

static void testCustomRowType() {
    std::vector<OrderRow> orders = {{1, 10}, {2, -1}, {3, 11}};
    std::vector<OrderRow> customers = {{10, 10}, {11, 11}, {12, 12}};

    auto keyOf = [](const OrderRow& row) -> std::optional<std::int64_t> {
        if (row.customerFk < 0) return std::nullopt;
        return row.customerFk;
    };

    Bag got;
    dataeng::graceHashJoin(
        orders, customers, keyOf, keyOf, JoinType::LeftOuter,
        JoinConfig{},
        [&](const JoinPair& p) { got.insert({p.leftIndex, p.rightIndex}); });

    Bag want;
    dataeng::nestedLoopJoin(
        orders, customers, keyOf, keyOf, JoinType::LeftOuter,
        [&](const JoinPair& p) { want.insert({p.leftIndex, p.rightIndex}); });

    assertEqual(got, want, "custom row type");
    assert(got.size() == 3);  // two matches plus the unmatched null order
}

int main() {
    testFixedSemantics();
    testSkewFallback();
    testRecursivePartitioning();
    testDepthLimitFallback();
    testRandomDifferential();
    testCustomRowType();
    std::cout << "all dataeng join tests passed\n";
    return 0;
}
