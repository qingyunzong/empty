#include "dlks_formal.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <random>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

using dlks::Nanos;

int g_failures = 0;
long g_checks = 0;

void check_impl(bool ok, const char* expression, const char* file, int line) {
    ++g_checks;
    if (!ok) {
        ++g_failures;
        std::cerr << file << ":" << line << ": check failed: " << expression
                  << "\n";
    }
}

template <class A, class B>
void check_eq_impl(const A& a,
                   const B& b,
                   const char* a_expression,
                   const char* b_expression,
                   const char* file,
                   int line) {
    ++g_checks;
    if (!(a == b)) {
        ++g_failures;
        std::cerr << file << ":" << line << ": check failed: " << a_expression
                  << " == " << b_expression << "\n";
    }
}

#define CHECK(expression) \
    check_impl((expression), #expression, __FILE__, __LINE__)
#define CHECK_EQ(a, b) \
    check_eq_impl((a), (b), #a, #b, __FILE__, __LINE__)

using Labels = std::vector<dlks::Label>;

Labels make_labels(
    std::initializer_list<std::pair<std::string, std::string>> items) {
    Labels labels;
    labels.reserve(items.size());
    for (const auto& [key, value] : items) {
        labels.push_back(dlks::Label{key, value});
    }
    return labels;
}

using RefKey = std::vector<std::pair<std::string, std::string>>;

RefKey canonical(std::span<const dlks::Label> labels) {
    RefKey key;
    key.reserve(labels.size());
    for (const dlks::Label& label : labels) {
        key.emplace_back(label.key, label.value);
    }
    std::sort(key.begin(), key.end());
    return key;
}

RefKey canonical(const Labels& labels) {
    return canonical(std::span<const dlks::Label>(labels));
}

struct Model {
    std::map<RefKey, std::uint64_t> counts;
    std::uint64_t total = 0;

    void add(const RefKey& key, std::uint64_t delta) {
        if (delta == 0) {
            return;
        }
        counts[key] += delta;
        total += delta;
    }
};

const dlks::SeriesPoint* find_series(const dlks::MetricSnapshot& snapshot,
                                     const RefKey& key) {
    for (const dlks::SeriesPoint& point : snapshot.series) {
        if (canonical(point.labels) == key) {
            return &point;
        }
    }
    return nullptr;
}

void check_snapshot(const dlks::MetricSnapshot& snapshot,
                    const Model& model,
                    const dlks::MetricConfig& config) {
    CHECK_EQ(snapshot.total_count(), model.total);
    CHECK(snapshot.overflow.overflow);
    CHECK(snapshot.overflow.labels.empty());
    CHECK_EQ(snapshot.live_series, snapshot.series.size());
    CHECK(snapshot.live_series <= snapshot.max_series);
    CHECK(snapshot.accounted_bytes <= config.memory_budget_bytes);
    CHECK(snapshot.reserved_bytes <= config.memory_budget_bytes);
    CHECK(snapshot.accounted_bytes <= snapshot.reserved_bytes);
    CHECK_EQ(snapshot.accounted_bytes,
             snapshot.live_series * snapshot.series_slot_bytes);
    CHECK_EQ(snapshot.reserved_bytes % snapshot.series_slot_bytes, 0u);

    std::set<RefKey> seen;
    std::uint64_t retained_total = 0;
    for (const dlks::SeriesPoint& point : snapshot.series) {
        const RefKey key = canonical(point.labels);
        CHECK(!point.overflow);
        CHECK(seen.insert(key).second);
        const auto it = model.counts.find(key);
        CHECK(it != model.counts.end());
        if (it != model.counts.end()) {
            CHECK(point.count <= it->second);
        }
        retained_total += point.count;
    }
    CHECK_EQ(retained_total + snapshot.overflow.count, model.total);
}

void test_basic_counting() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    static_assert(Agg::max_series_for(0) == 0);
    static_assert(Agg::max_series_for(slot - 1) == 0);
    static_assert(Agg::max_series_for(slot) == 0);
    static_assert(Agg::max_series_for(2 * slot) == 1);
    static_assert(Agg::max_series_for(5 * slot) == 4);

    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 5 * slot;
    CHECK(agg.define_metric("http_requests", config));
    CHECK(!agg.define_metric("http_requests", config));

    const Labels first = make_labels({{"job", "api"}, {"code", "200"}});
    const Labels reordered = make_labels({{"code", "200"}, {"job", "api"}});
    CHECK(agg.observe("http_requests", first, 3, 10) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("http_requests", reordered, 4, 11) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("http_requests", first, 0, 12) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("missing", first, 1, 12) ==
          dlks::ObserveStatus::UnknownMetric);

    const auto snapshot = agg.metric_snapshot("http_requests");
    CHECK(snapshot.has_value());
    if (!snapshot) {
        return;
    }
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK_EQ(snapshot->series[0].count, 7u);
    CHECK_EQ(snapshot->series[0].last_seen, 12u);
    CHECK_EQ(snapshot->overflow.count, 0u);
    CHECK_EQ(snapshot->total_count(), 7u);
    CHECK_EQ(snapshot->max_series, 4u);
    CHECK_EQ(snapshot->accounted_bytes, slot);
    CHECK_EQ(snapshot->reserved_bytes, 5 * slot);
    CHECK(!agg.metric_snapshot("missing").has_value());
    CHECK(agg.metric_config("http_requests") != nullptr);
    if (agg.metric_config("http_requests") != nullptr) {
        CHECK_EQ(agg.metric_config("http_requests")->memory_budget_bytes,
                 5 * slot);
    }
    CHECK(agg.metric_config("missing") == nullptr);
}

void test_overflow_conservation() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;  // two retained series
    CHECK(agg.define_metric("m", config));

    Model model;
    Nanos now = 0;
    for (int i = 0; i < 8; ++i) {
        const Labels labels = make_labels({{"k", std::to_string(i)}});
        const auto key = canonical(labels);
        const auto delta = static_cast<std::uint64_t>(i + 1);
        CHECK(agg.observe("m", labels, delta, now) ==
              dlks::ObserveStatus::Retained);
        model.add(key, delta);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK(snapshot.has_value());
        if (snapshot) {
            check_snapshot(*snapshot, model, config);
            CHECK(snapshot->series.size() <= 2);
        }
        ++now;
    }

    const auto snapshot = agg.metric_snapshot("m");
    CHECK(snapshot.has_value());
    CHECK_EQ(snapshot->series.size(), 2u);
    CHECK(snapshot->overflow.count > 0);
    CHECK_EQ(snapshot->evictions, 6u);
    CHECK_EQ(snapshot->total_count(), 36u);
}

void test_heavy_hitter_retention() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;
    CHECK(agg.define_metric("m", config));

    const Labels hot = make_labels({{"id", "hot"}});
    for (int i = 0; i < 100; ++i) {
        CHECK(agg.observe("m", hot, 1, static_cast<Nanos>(i)) ==
              dlks::ObserveStatus::Retained);
    }
    for (int i = 0; i < 200; ++i) {
        const Labels cold = make_labels({{"id", "cold-" + std::to_string(i)}});
        agg.observe("m", cold, 1, static_cast<Nanos>(1000 + i));
    }

    const auto snapshot = agg.metric_snapshot("m");
    CHECK(snapshot.has_value());
    const dlks::SeriesPoint* hot_point =
        find_series(*snapshot, canonical(hot));
    CHECK(hot_point != nullptr);
    if (hot_point) {
        CHECK_EQ(hot_point->count, 100u);
    }
    CHECK_EQ(snapshot->total_count(), 300u);
    CHECK_EQ(snapshot->series.size(), 2u);
}

void test_protect_residents_policy() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    const Labels a = make_labels({{"id", "a"}});
    const Labels b = make_labels({{"id", "b"}});
    const Labels c = make_labels({{"id", "c"}});

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 4 * slot;
        config.retention = dlks::RetentionPolicy::ProtectResidents;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 100, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", b, 90, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", c, 80, 0) == dlks::ObserveStatus::Retained);
        for (int i = 0; i < 50; ++i) {
            const Labels cold =
                make_labels({{"id", "cold-" + std::to_string(i)}});
            CHECK(agg.observe("m", cold, 1, static_cast<Nanos>(i + 1)) ==
                  dlks::ObserveStatus::MergedIntoOverflow);
        }
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 3u);
        CHECK(find_series(*snapshot, canonical(a)) != nullptr);
        CHECK(find_series(*snapshot, canonical(b)) != nullptr);
        CHECK(find_series(*snapshot, canonical(c)) != nullptr);
        CHECK_EQ(snapshot->overflow.count, 50u);
        CHECK_EQ(snapshot->total_count(), 320u);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 4 * slot;
        config.retention = dlks::RetentionPolicy::EvictLeastFrequent;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 100, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", b, 90, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", c, 80, 0) == dlks::ObserveStatus::Retained);
        for (int i = 0; i < 50; ++i) {
            const Labels cold =
                make_labels({{"id", "cold-" + std::to_string(i)}});
            agg.observe("m", cold, 1, static_cast<Nanos>(i + 1));
        }
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 3u);
        CHECK(find_series(*snapshot, canonical(a)) != nullptr);
        CHECK(find_series(*snapshot, canonical(b)) != nullptr);
        CHECK(find_series(*snapshot, canonical(c)) == nullptr);
        CHECK_EQ(snapshot->overflow.count, 129u);
        CHECK_EQ(snapshot->total_count(), 320u);
    }
}

void test_protect_residents_ties_admit() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;
    config.retention = dlks::RetentionPolicy::ProtectResidents;
    CHECK(agg.define_metric("m", config));

    const Labels first = make_labels({{"id", "first"}});
    const Labels second = make_labels({{"id", "second"}});
    const Labels newcomer = make_labels({{"id", "newcomer"}});
    const Labels other = make_labels({{"id", "other"}});
    CHECK(agg.observe("m", first, 1, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", second, 1, 0) == dlks::ObserveStatus::Retained);
    // The minimum is 1 and the newcomer also has delta 1: a tie admits it.
    CHECK(agg.observe("m", newcomer, 1, 1) ==
          dlks::ObserveStatus::Retained);
    // The newcomer is resident now and can accumulate.
    CHECK(agg.observe("m", newcomer, 1, 2) ==
          dlks::ObserveStatus::Retained);
    // A later one-off can only displace the remaining count-1 resident.
    CHECK(agg.observe("m", other, 1, 3) == dlks::ObserveStatus::Retained);

    const auto snapshot = agg.metric_snapshot("m");
    const dlks::SeriesPoint* point =
        find_series(*snapshot, canonical(newcomer));
    CHECK(point != nullptr);
    if (point) {
        CHECK_EQ(point->count, 2u);
    }
    CHECK_EQ(snapshot->overflow.count, 2u);
    CHECK_EQ(snapshot->total_count(), 5u);
}

void test_expiry() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;
    config.label_ttl_ns = 10;
    CHECK(agg.define_metric("m", config));

    const Labels a = make_labels({{"id", "a"}});
    const Labels b = make_labels({{"id", "b"}});
    const Labels c = make_labels({{"id", "c"}});
    CHECK(agg.observe("m", a, 5, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", b, 7, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", a, 1, 5) == dlks::ObserveStatus::Retained);

    // b was last seen at 0 and has been idle for exactly the TTL.
    CHECK_EQ(agg.expire(10), 1u);
    auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK_EQ(snapshot->overflow.count, 7u);
    CHECK_EQ(snapshot->total_count(), 13u);
    CHECK_EQ(snapshot->expirations, 1u);
    CHECK(find_series(*snapshot, canonical(a)) != nullptr);
    CHECK(find_series(*snapshot, canonical(b)) == nullptr);

    // a was last seen at 5, so it is expired at 16.
    CHECK_EQ(agg.expire(16), 1u);
    snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 0u);
    CHECK_EQ(snapshot->overflow.count, 13u);
    CHECK_EQ(snapshot->total_count(), 13u);
    CHECK_EQ(snapshot->accounted_bytes, 0u);

    CHECK(agg.observe("m", c, 2, 16) == dlks::ObserveStatus::Retained);
    snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK_EQ(snapshot->total_count(), 15u);
}

void test_expiry_boundaries() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    const Labels a = make_labels({{"id", "a"}});

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 2 * slot;
        // TTL zero disables expiry.
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 3, 0) == dlks::ObserveStatus::Retained);
        CHECK_EQ(agg.expire(1000000), 0u);
        CHECK_EQ(agg.metric_snapshot("m")->series.size(), 1u);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 2 * slot;
        config.label_ttl_ns = 10;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 3, 100) == dlks::ObserveStatus::Retained);
        // Time moving backwards must not expire the series.
        CHECK_EQ(agg.expire(50), 0u);
        CHECK_EQ(agg.metric_snapshot("m")->series.size(), 1u);
        CHECK(agg.observe("m", a, 1, 50) == dlks::ObserveStatus::Retained);
        CHECK_EQ(agg.metric_snapshot("m")->series[0].last_seen, 100u);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 2 * slot;
        config.label_ttl_ns = 10;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 5, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", a, 1, 5) == dlks::ObserveStatus::Retained);
        // The sample at 20 is after the idle TTL.  The old count is folded
        // into overflow and a fresh series starts at 2.
        CHECK(agg.observe("m", a, 2, 20) == dlks::ObserveStatus::Retained);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 1u);
        CHECK_EQ(snapshot->series[0].count, 2u);
        CHECK_EQ(snapshot->overflow.count, 6u);
        CHECK_EQ(snapshot->total_count(), 8u);
        CHECK_EQ(snapshot->expirations, 1u);
    }
}

void test_key_capacity() {
    using Agg = dlks::Aggregator<32>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 4 * slot;
    CHECK(agg.define_metric("m", config));

    const Labels too_long =
        make_labels({{"k", std::string(40, 'x')}});
    CHECK(agg.observe("m", too_long, 3, 0) ==
          dlks::ObserveStatus::KeyTooLong);
    auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 0u);
    CHECK_EQ(snapshot->overflow.count, 3u);
    CHECK_EQ(snapshot->total_count(), 3u);

    const Labels fits = make_labels({{"k", "v"}});
    CHECK(agg.observe("m", fits, 2, 1) == dlks::ObserveStatus::Retained);
    snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK_EQ(snapshot->overflow.count, 3u);
    CHECK_EQ(snapshot->total_count(), 5u);

    // {"a", "b"} encodes to 4 + 1 + 4 + 1 == 10 bytes.  A 10-byte slot is an
    // exact fit; an 11th byte would overflow.
    using Tight = dlks::Aggregator<10>;
    Tight tight;
    dlks::MetricConfig tight_config;
    tight_config.memory_budget_bytes = 2 * Tight::slot_bytes();
    CHECK(tight.define_metric("m", tight_config));
    CHECK(tight.observe("m", make_labels({{"a", "b"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);
    CHECK(tight.observe("m", make_labels({{"a", "bb"}}), 1, 0) ==
          dlks::ObserveStatus::KeyTooLong);
}

struct ConstantHasher {
    std::uint64_t operator()(std::string_view) const noexcept { return 0; }
};

void test_hash_collisions_do_not_mix_keys() {
    using Agg = dlks::BasicAggregator<64, ConstantHasher>;
    constexpr std::size_t slot = Agg::slot_bytes();

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 9 * slot;
        CHECK(agg.define_metric("m", config));

        const Labels a = make_labels({{"id", "a"}});
        const Labels b = make_labels({{"id", "b"}});
        const Labels c = make_labels({{"id", "c"}});
        CHECK(agg.observe("m", a, 1, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", b, 2, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", a, 3, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", c, 4, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", b, 5, 0) == dlks::ObserveStatus::Retained);

        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 3u);
        CHECK_EQ(snapshot->overflow.count, 0u);
        CHECK_EQ(snapshot->total_count(), 15u);
        const dlks::SeriesPoint* pa = find_series(*snapshot, canonical(a));
        const dlks::SeriesPoint* pb = find_series(*snapshot, canonical(b));
        const dlks::SeriesPoint* pc = find_series(*snapshot, canonical(c));
        CHECK(pa != nullptr);
        CHECK(pb != nullptr);
        CHECK(pc != nullptr);
        if (pa) CHECK_EQ(pa->count, 4u);
        if (pb) CHECK_EQ(pb->count, 7u);
        if (pc) CHECK_EQ(pc->count, 4u);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 3 * slot;  // two retained series
        CHECK(agg.define_metric("m", config));

        const char* names[] = {"a", "b", "c", "d", "e", "f"};
        for (int i = 0; i < 6; ++i) {
            const Labels labels = make_labels({{"id", names[i]}});
            CHECK(agg.observe("m", labels, static_cast<std::uint64_t>(i + 1),
                              0) == dlks::ObserveStatus::Retained);
        }
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 2u);
        CHECK_EQ(snapshot->overflow.count, 10u);
        CHECK_EQ(snapshot->total_count(), 21u);
        const dlks::SeriesPoint* pe =
            find_series(*snapshot, canonical(make_labels({{"id", "e"}})));
        const dlks::SeriesPoint* pf =
            find_series(*snapshot, canonical(make_labels({{"id", "f"}})));
        CHECK(pe != nullptr);
        CHECK(pf != nullptr);
        if (pe) CHECK_EQ(pe->count, 5u);
        if (pf) CHECK_EQ(pf->count, 6u);
    }

    {
        // Length prefixes make these two keys unambiguous even with one shared
        // hash bucket: "ab"+"c" and "a"+"bc" encode to different bytes.
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 5 * slot;
        CHECK(agg.define_metric("m", config));
        const Labels first = make_labels({{"ab", "c"}});
        const Labels second = make_labels({{"a", "bc"}});
        const Labels third = make_labels({{"a", "c"}});
        CHECK(agg.observe("m", first, 1, 0) ==
              dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", second, 2, 0) ==
              dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", third, 3, 0) ==
              dlks::ObserveStatus::Retained);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 3u);
        CHECK_EQ(snapshot->overflow.count, 0u);
        CHECK_EQ(snapshot->total_count(), 6u);
    }
}

void test_label_canonicalization() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 5 * slot;
    CHECK(agg.define_metric("m", config));

    const Labels one = make_labels({{"a", "1"}, {"a", "2"}});
    const Labels two = make_labels({{"a", "2"}, {"a", "1"}});
    const Labels three = make_labels({{"a", "1"}});
    const Labels four = make_labels({{"a", "1"}, {"a", "2"}, {"a", "2"}});
    CHECK(agg.observe("m", one, 1, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", two, 2, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", three, 4, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", four, 8, 0) == dlks::ObserveStatus::Retained);

    const auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 3u);
    CHECK_EQ(snapshot->total_count(), 15u);
    const dlks::SeriesPoint* p1 = find_series(*snapshot, canonical(one));
    const dlks::SeriesPoint* p3 = find_series(*snapshot, canonical(three));
    const dlks::SeriesPoint* p4 = find_series(*snapshot, canonical(four));
    CHECK(p1 != nullptr);
    CHECK(p3 != nullptr);
    CHECK(p4 != nullptr);
    if (p1) CHECK_EQ(p1->count, 3u);
    if (p3) CHECK_EQ(p3->count, 4u);
    if (p4) CHECK_EQ(p4->count, 8u);
}

void test_unlabeled_series() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;
    CHECK(agg.define_metric("m", config));

    const Labels empty;
    CHECK(agg.observe("m", empty, 5, 0) == dlks::ObserveStatus::Retained);
    auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK(snapshot->series[0].labels.empty());
    CHECK(!snapshot->series[0].overflow);
    CHECK_EQ(snapshot->series[0].count, 5u);
    CHECK_EQ(snapshot->overflow.count, 0u);

    CHECK(agg.observe("m", make_labels({{"a", "1"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", make_labels({{"a", "2"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);
    snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 2u);
    CHECK(snapshot->overflow.overflow);
    CHECK(snapshot->overflow.labels.empty());
    CHECK(snapshot->overflow.count > 0);
    const dlks::SeriesPoint* unlabeled =
        find_series(*snapshot, RefKey{});
    CHECK(unlabeled != nullptr);
    if (unlabeled) {
        CHECK(!unlabeled->overflow);
        CHECK_EQ(unlabeled->count, 5u);
    }
}

void test_many_labels_heap_path() {
    using Agg = dlks::Aggregator<512>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 2 * slot;
    CHECK(agg.define_metric("m", config));

    Labels labels;
    for (int i = 0; i < 20; ++i) {
        labels.push_back(dlks::Label{"k" + std::to_string(i),
                                     "v" + std::to_string(i)});
    }
    std::reverse(labels.begin(), labels.end());
    CHECK(agg.observe("m", labels, 7, 0) == dlks::ObserveStatus::Retained);

    const auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 1u);
    CHECK_EQ(snapshot->series[0].labels.size(), 20u);
    std::vector<std::string> expected_keys;
    for (int i = 0; i < 20; ++i) {
        expected_keys.push_back("k" + std::to_string(i));
    }
    std::sort(expected_keys.begin(), expected_keys.end());
    for (int i = 0; i < 20; ++i) {
        CHECK_EQ(snapshot->series[0].labels[static_cast<std::size_t>(i)].key,
                 expected_keys[static_cast<std::size_t>(i)]);
    }
    CHECK_EQ(snapshot->total_count(), 7u);
}

void test_zero_and_tiny_budgets() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    const Labels a = make_labels({{"id", "a"}});
    const Labels b = make_labels({{"id", "b"}});

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 0;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 3, 1) == dlks::ObserveStatus::NoCapacity);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 0u);
        CHECK_EQ(snapshot->overflow.count, 3u);
        CHECK_EQ(snapshot->total_count(), 3u);
        CHECK_EQ(snapshot->max_series, 0u);
        CHECK_EQ(snapshot->reserved_bytes, 0u);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = slot;  // one physical slot, no live series
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 4, 1) == dlks::ObserveStatus::NoCapacity);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 0u);
        CHECK_EQ(snapshot->overflow.count, 4u);
        CHECK_EQ(snapshot->max_series, 0u);
        CHECK_EQ(snapshot->reserved_bytes, slot);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 2 * slot;  // exactly one live series
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, 4, 1) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", b, 6, 2) == dlks::ObserveStatus::Retained);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series.size(), 1u);
        CHECK_EQ(snapshot->overflow.count, 4u);
        CHECK_EQ(snapshot->total_count(), 10u);
    }
}

void test_multi_metric_isolation() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;

    dlks::MetricConfig config_a;
    config_a.memory_budget_bytes = 3 * slot;  // two series
    dlks::MetricConfig config_b;
    config_b.memory_budget_bytes = 3 * slot;
    config_b.label_ttl_ns = 5;
    CHECK(agg.define_metric("a", config_a));
    CHECK(agg.define_metric("b", config_b));
    CHECK_EQ(agg.metric_count(), 2u);

    const Labels x = make_labels({{"id", "x"}});
    const Labels y = make_labels({{"id", "y"}});
    CHECK(agg.observe("a", x, 10, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("b", x, 20, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("a", y, 30, 1) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("b", y, 40, 1) == dlks::ObserveStatus::Retained);

    auto snapshot = agg.snapshot();
    CHECK_EQ(snapshot.metrics.size(), 2u);
    CHECK_EQ(snapshot.total_count(), 100u);
    const dlks::MetricSnapshot* sa = snapshot.find("a");
    const dlks::MetricSnapshot* sb = snapshot.find("b");
    CHECK(sa != nullptr);
    CHECK(sb != nullptr);
    CHECK(snapshot.find("missing") == nullptr);
    if (sa) CHECK_EQ(sa->total_count(), 40u);
    if (sb) CHECK_EQ(sb->total_count(), 60u);

    // Only metric b has a TTL; both of its series expire at t=6.
    CHECK_EQ(agg.expire(6), 2u);
    snapshot = agg.snapshot();
    sa = snapshot.find("a");
    sb = snapshot.find("b");
    CHECK_EQ(sa->series.size(), 2u);
    CHECK_EQ(sa->overflow.count, 0u);
    CHECK_EQ(sa->total_count(), 40u);
    CHECK_EQ(sb->series.size(), 0u);
    CHECK_EQ(sb->overflow.count, 60u);
    CHECK_EQ(sb->total_count(), 60u);

    CHECK(agg.erase_metric("a"));
    CHECK(!agg.has_metric("a"));
    CHECK(agg.observe("a", x, 1, 7) == dlks::ObserveStatus::UnknownMetric);
    CHECK_EQ(agg.metric_count(), 1u);
    CHECK(agg.erase_metric("b"));
    CHECK(!agg.erase_metric("b"));
    CHECK_EQ(agg.metric_count(), 0u);
}

void test_expire_metric_api() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config_a;
    config_a.memory_budget_bytes = 2 * slot;
    config_a.label_ttl_ns = 2;
    dlks::MetricConfig config_b;
    config_b.memory_budget_bytes = 2 * slot;
    config_b.label_ttl_ns = 10;
    CHECK(agg.define_metric("a", config_a));
    CHECK(agg.define_metric("b", config_b));

    const Labels x = make_labels({{"id", "x"}});
    const Labels y = make_labels({{"id", "y"}});
    CHECK(agg.observe("a", x, 5, 0) == dlks::ObserveStatus::Retained);
    CHECK(agg.observe("b", y, 7, 0) == dlks::ObserveStatus::Retained);

    CHECK_EQ(agg.expire_metric("a", 2), 1u);
    CHECK_EQ(agg.metric_snapshot("a")->overflow.count, 5u);
    CHECK_EQ(agg.metric_snapshot("a")->series.size(), 0u);
    CHECK_EQ(agg.metric_snapshot("b")->series.size(), 1u);
    CHECK_EQ(agg.expire_metric("missing", 2), 0u);
}

void test_reset_and_clear() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 3 * slot;
    CHECK(agg.define_metric("m", config));

    const Labels a = make_labels({{"id", "a"}});
    CHECK(agg.observe("m", a, 9, 0) == dlks::ObserveStatus::Retained);
    CHECK_EQ(agg.metric_snapshot("m")->total_count(), 9u);

    CHECK(agg.reset_metric("m"));
    CHECK(!agg.reset_metric("missing"));
    const auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 0u);
    CHECK_EQ(snapshot->overflow.count, 0u);
    CHECK_EQ(snapshot->total_count(), 0u);
    CHECK_EQ(snapshot->max_series, 2u);

    agg.clear();
    CHECK_EQ(agg.metric_count(), 0u);
    CHECK(agg.snapshot().metrics.empty());
}

void test_snapshot_ordering() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 4 * slot;
    CHECK(agg.define_metric("m", config));

    CHECK(agg.observe("m", make_labels({{"b", "2"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", make_labels({{"a", "2"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);
    CHECK(agg.observe("m", make_labels({{"a", "1"}}), 1, 0) ==
          dlks::ObserveStatus::Retained);

    const auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 3u);
    CHECK_EQ(snapshot->series[0].labels[0].key, std::string("a"));
    CHECK_EQ(snapshot->series[0].labels[0].value, std::string("1"));
    CHECK_EQ(snapshot->series[1].labels[0].value, std::string("2"));
    CHECK_EQ(snapshot->series[2].labels[0].key, std::string("b"));
}

void test_saturation() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    const auto max = std::numeric_limits<std::uint64_t>::max();
    const Labels a = make_labels({{"id", "a"}});

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 2 * slot;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, max, 0) == dlks::ObserveStatus::Retained);
        CHECK(agg.observe("m", a, 10, 1) == dlks::ObserveStatus::Retained);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->series[0].count, max);
        CHECK_EQ(snapshot->total_count(), max);
    }

    {
        Agg agg;
        dlks::MetricConfig config;
        config.memory_budget_bytes = 0;
        CHECK(agg.define_metric("m", config));
        CHECK(agg.observe("m", a, max, 0) == dlks::ObserveStatus::NoCapacity);
        CHECK(agg.observe("m", a, max, 1) == dlks::ObserveStatus::NoCapacity);
        const auto snapshot = agg.metric_snapshot("m");
        CHECK_EQ(snapshot->overflow.count, max);
        CHECK_EQ(snapshot->total_count(), max);
    }
}

// ---------------------------------------------------------------------------
// Exact small-domain model
// ---------------------------------------------------------------------------

struct Variant {
    std::size_t capacity;
    Nanos ttl;
    dlks::RetentionPolicy policy;
};

enum class OpKind { Observe, Advance, Expire };

struct Op {
    OpKind kind;
    int key;
    std::uint64_t value;
};

const std::vector<Op>& alphabet() {
    static const std::vector<Op> ops = {
        {OpKind::Observe, 0, 1}, {OpKind::Observe, 1, 1},
        {OpKind::Observe, 2, 1}, {OpKind::Observe, 0, 2},
        {OpKind::Observe, 1, 3}, {OpKind::Observe, 2, 2},
        {OpKind::Advance, 0, 3}, {OpKind::Expire, 0, 0},
    };
    return ops;
}

std::size_t budget_for(std::size_t capacity) {
    using Agg = dlks::Aggregator<64>;
    return capacity == 0 ? 0 : (capacity + 1) * Agg::slot_bytes();
}

void run_sequence(const std::vector<Op>& sequence, const Variant& variant) {
    using Agg = dlks::Aggregator<64>;
    dlks::MetricConfig config;
    config.memory_budget_bytes = budget_for(variant.capacity);
    config.label_ttl_ns = variant.ttl;
    config.retention = variant.policy;

    Agg agg;
    CHECK(agg.define_metric("m", config));
    Model model;
    Nanos now = 0;

    for (const Op& op : sequence) {
        switch (op.kind) {
            case OpKind::Observe: {
                const Labels labels =
                    make_labels({{"k", std::to_string(op.key)}});
                const RefKey key = canonical(labels);
                agg.observe("m", labels, op.value, now);
                model.add(key, op.value);
                break;
            }
            case OpKind::Advance:
                now += op.value;
                break;
            case OpKind::Expire:
                agg.expire(now);
                break;
        }

        const auto snapshot = agg.metric_snapshot("m");
        CHECK(snapshot.has_value());
        if (snapshot) {
            check_snapshot(*snapshot, model, config);
        }
    }
}

void enumerate(std::vector<Op>& sequence,
               std::size_t depth,
               std::size_t max_depth,
               const Variant& variant,
               std::size_t& leaves) {
    if (depth == max_depth) {
        run_sequence(sequence, variant);
        ++leaves;
        return;
    }
    for (const Op& op : alphabet()) {
        sequence.push_back(op);
        enumerate(sequence, depth + 1, max_depth, variant, leaves);
        sequence.pop_back();
    }
}

void test_exact_small_domain() {
    const std::vector<Variant> shallow_variants = {
        {0, 0, dlks::RetentionPolicy::EvictLeastFrequent},
        {1, 0, dlks::RetentionPolicy::EvictLeastFrequent},
        {2, 2, dlks::RetentionPolicy::EvictLeastFrequent},
        {3, 3, dlks::RetentionPolicy::ProtectResidents},
    };
    std::size_t leaves = 0;
    std::vector<Op> sequence;
    for (const Variant& variant : shallow_variants) {
        enumerate(sequence, 0, 4, variant, leaves);
    }

    const std::vector<Variant> deep_variants = {
        {2, 3, dlks::RetentionPolicy::EvictLeastFrequent},
        {3, 2, dlks::RetentionPolicy::ProtectResidents},
    };
    for (const Variant& variant : deep_variants) {
        enumerate(sequence, 0, 5, variant, leaves);
    }

    std::cout << "  exhaustive sequences: " << leaves << "\n";
    CHECK(leaves > 0);
}

void test_random_model() {
    using Agg = dlks::Aggregator<64>;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 9 * Agg::slot_bytes();
    config.label_ttl_ns = 5;
    config.retention = dlks::RetentionPolicy::EvictLeastFrequent;

    Agg agg;
    CHECK(agg.define_metric("m", config));
    Model model;
    std::mt19937_64 rng(0x9e3779b97f4a7c15ULL);
    Nanos now = 0;
    std::uint64_t evictions = 0;
    std::uint64_t expirations = 0;

    for (int step = 0; step < 20000; ++step) {
        const std::uint64_t roll = rng() % 100;
        if (roll < 5) {
            agg.expire(now);
        } else if (roll < 20) {
            now += 1 + (rng() % 4);
        } else {
            const int key = static_cast<int>(rng() % 64);
            const Labels labels =
                make_labels({{"k", std::to_string(key)}});
            const std::uint64_t delta = rng() % 5;
            const auto status = agg.observe("m", labels, delta, now);
            CHECK(status == dlks::ObserveStatus::Retained ||
                  status == dlks::ObserveStatus::Ignored ||
                  status == dlks::ObserveStatus::MergedIntoOverflow);
            model.add(canonical(labels), delta);
            if ((rng() % 10) == 0) {
                ++now;
            }
        }

        const auto snapshot = agg.metric_snapshot("m");
        CHECK(snapshot.has_value());
        if (snapshot) {
            check_snapshot(*snapshot, model, config);
            evictions = snapshot->evictions;
            expirations = snapshot->expirations;
        }
    }

    CHECK(evictions > 0);
    CHECK(expirations > 0);
}

void test_random_collisions() {
    using Agg = dlks::BasicAggregator<32, ConstantHasher>;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 7 * Agg::slot_bytes();
    config.label_ttl_ns = 4;
    config.retention = dlks::RetentionPolicy::EvictLeastFrequent;

    Agg agg;
    CHECK(agg.define_metric("m", config));
    Model model;
    std::mt19937_64 rng(0x123456789abcdefULL);
    Nanos now = 0;

    for (int step = 0; step < 5000; ++step) {
        if ((rng() % 20) == 0) {
            agg.expire(now);
        } else {
            const int key = static_cast<int>(rng() % 40);
            const Labels labels =
                make_labels({{"k", std::to_string(key)}});
            const std::uint64_t delta = 1 + (rng() % 3);
            agg.observe("m", labels, delta, now);
            model.add(canonical(labels), delta);
            if ((rng() % 3) == 0) {
                ++now;
            }
        }
        const auto snapshot = agg.metric_snapshot("m");
        CHECK(snapshot.has_value());
        if (snapshot) {
            check_snapshot(*snapshot, model, config);
        }
    }
}

// A direct reference implementation of the shard policy.  It is deliberately
// simple (std::map, linear victim search) so that it can be audited against the
// optimised component.
std::string encode_ref_key(const RefKey& key) {
    std::string out;
    const auto push_u32 = [&out](std::uint32_t value) {
        out.push_back(static_cast<char>(value & 0xFFu));
        out.push_back(static_cast<char>((value >> 8) & 0xFFu));
        out.push_back(static_cast<char>((value >> 16) & 0xFFu));
        out.push_back(static_cast<char>((value >> 24) & 0xFFu));
    };
    for (const auto& [name, value] : key) {
        push_u32(static_cast<std::uint32_t>(name.size()));
        out += name;
        push_u32(static_cast<std::uint32_t>(value.size()));
        out += value;
    }
    return out;
}

struct RefEntry {
    std::uint64_t count = 0;
    Nanos last_seen = 0;
};

class RefShard {
public:
    RefShard(std::size_t capacity,
             Nanos ttl,
             dlks::RetentionPolicy policy)
        : capacity_(capacity), ttl_(ttl), policy_(policy) {}

    void observe(const RefKey& key, std::uint64_t delta, Nanos now) {
        const auto found = retained_.find(key);
        if (found != retained_.end()) {
            RefEntry& entry = found->second;
            if (delta != 0 && expired(entry, now)) {
                overflow_ = sat(overflow_, entry.count);
                overflow_last_seen_ =
                    std::max(overflow_last_seen_, entry.last_seen);
                ++expirations_;
                entry.count = 0;
            }
            entry.count = sat(entry.count, delta);
            entry.last_seen = std::max(entry.last_seen, now);
            return;
        }

        if (delta == 0) {
            return;
        }
        if (capacity_ == 0) {
            overflow_ = sat(overflow_, delta);
            overflow_last_seen_ = std::max(overflow_last_seen_, now);
            return;
        }
        if (retained_.size() < capacity_) {
            retained_.emplace(key, RefEntry{delta, now});
            return;
        }

        auto victim = retained_.begin();
        for (auto it = std::next(retained_.begin()); it != retained_.end();
             ++it) {
            if (victim_less(it->first, it->second, victim->first,
                            victim->second)) {
                victim = it;
            }
        }
        if (policy_ == dlks::RetentionPolicy::ProtectResidents &&
            victim->second.count > delta) {
            overflow_ = sat(overflow_, delta);
            overflow_last_seen_ = std::max(overflow_last_seen_, now);
            return;
        }
        overflow_ = sat(overflow_, victim->second.count);
        overflow_last_seen_ =
            std::max(overflow_last_seen_, victim->second.last_seen);
        retained_.erase(victim);
        ++evictions_;
        retained_.emplace(key, RefEntry{delta, now});
    }

    void expire(Nanos now) {
        if (ttl_ == 0) {
            return;
        }
        for (auto it = retained_.begin(); it != retained_.end();) {
            if (expired(it->second, now)) {
                overflow_ = sat(overflow_, it->second.count);
                overflow_last_seen_ =
                    std::max(overflow_last_seen_, it->second.last_seen);
                ++expirations_;
                it = retained_.erase(it);
            } else {
                ++it;
            }
        }
    }

    std::size_t size() const noexcept { return retained_.size(); }
    std::uint64_t overflow() const noexcept { return overflow_; }
    Nanos overflow_last_seen() const noexcept { return overflow_last_seen_; }
    std::uint64_t evictions() const noexcept { return evictions_; }
    std::uint64_t expirations() const noexcept { return expirations_; }
    const std::map<RefKey, RefEntry>& retained() const noexcept {
        return retained_;
    }

private:
    static std::uint64_t sat(std::uint64_t a, std::uint64_t b) noexcept {
        const std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
        return a > max - b ? max : a + b;
    }

    bool expired(const RefEntry& entry, Nanos now) const noexcept {
        return ttl_ != 0 && now > entry.last_seen &&
               now - entry.last_seen >= ttl_;
    }

    static bool victim_less(const RefKey& a_key,
                            const RefEntry& a,
                            const RefKey& b_key,
                            const RefEntry& b) {
        if (a.count != b.count) {
            return a.count < b.count;
        }
        if (a.last_seen != b.last_seen) {
            return a.last_seen < b.last_seen;
        }
        return encode_ref_key(a_key) < encode_ref_key(b_key);
    }

    std::size_t capacity_;
    Nanos ttl_;
    dlks::RetentionPolicy policy_;
    std::map<RefKey, RefEntry> retained_;
    std::uint64_t overflow_ = 0;
    Nanos overflow_last_seen_ = 0;
    std::uint64_t evictions_ = 0;
    std::uint64_t expirations_ = 0;
};

void compare_with_reference(const dlks::MetricSnapshot& snapshot,
                            const RefShard& reference) {
    CHECK_EQ(snapshot.series.size(), reference.size());
    CHECK_EQ(snapshot.overflow.count, reference.overflow());
    CHECK_EQ(snapshot.overflow.last_seen, reference.overflow_last_seen());
    CHECK_EQ(snapshot.evictions, reference.evictions());
    CHECK_EQ(snapshot.expirations, reference.expirations());

    for (const auto& [key, entry] : reference.retained()) {
        const dlks::SeriesPoint* point = find_series(snapshot, key);
        CHECK(point != nullptr);
        if (point != nullptr) {
            CHECK_EQ(point->count, entry.count);
            CHECK_EQ(point->last_seen, entry.last_seen);
        }
    }
}

template <class Agg>
void differential_case(std::size_t capacity,
                       Nanos ttl,
                       dlks::RetentionPolicy policy,
                       std::uint64_t seed) {
    dlks::MetricConfig config;
    config.memory_budget_bytes = budget_for(capacity);
    config.label_ttl_ns = ttl;
    config.retention = policy;

    Agg agg;
    CHECK(agg.define_metric("m", config));
    RefShard reference(capacity, ttl, policy);
    Model model;
    std::mt19937_64 rng(seed);
    Nanos now = 0;

    for (int step = 0; step < 6000; ++step) {
        const std::uint64_t roll = rng() % 100;
        if (roll < 5) {
            agg.expire(now);
            reference.expire(now);
        } else if (roll < 15) {
            now += rng() % 4;
        } else {
            const int key = static_cast<int>(rng() % 24);
            const Labels labels =
                make_labels({{"k", std::to_string(key)}});
            const std::uint64_t delta = rng() % 6;
            agg.observe("m", labels, delta, now);
            reference.observe(canonical(labels), delta, now);
            model.add(canonical(labels), delta);
            if ((rng() % 5) == 0) {
                ++now;
            }
        }

        const auto snapshot = agg.metric_snapshot("m");
        CHECK(snapshot.has_value());
        if (snapshot) {
            compare_with_reference(*snapshot, reference);
            check_snapshot(*snapshot, model, config);
        }
    }
}

void test_policy_differential() {
    using Agg = dlks::Aggregator<64>;
    using CAgg = dlks::BasicAggregator<64, ConstantHasher>;
    for (const auto policy : {dlks::RetentionPolicy::EvictLeastFrequent,
                              dlks::RetentionPolicy::ProtectResidents}) {
        differential_case<Agg>(0, 0, policy, 0x1111ULL);
        differential_case<Agg>(1, 0, policy, 0x2222ULL);
        differential_case<Agg>(3, 4, policy, 0x3333ULL);
        differential_case<Agg>(6, 0, policy, 0x4444ULL);
        differential_case<Agg>(6, 3, policy, 0x5555ULL);
        differential_case<CAgg>(5, 3, policy, 0x6666ULL);
    }

    // A tie-heavy run: all deltas and timestamps are equal, so the deterministic
    // encoded-key tie-break is exercised.
    dlks::MetricConfig config;
    config.memory_budget_bytes = budget_for(4);
    Agg agg;
    CHECK(agg.define_metric("m", config));
    RefShard reference(4, 0, dlks::RetentionPolicy::EvictLeastFrequent);
    for (int i = 0; i < 100; ++i) {
        const Labels labels = make_labels({{"k", std::to_string(i)}});
        agg.observe("m", labels, 1, 0);
        reference.observe(canonical(labels), 1, 0);
        const auto snapshot = agg.metric_snapshot("m");
        compare_with_reference(*snapshot, reference);
    }
}

void test_expiry_releases_capacity() {
    using Agg = dlks::Aggregator<64>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 5 * slot;  // four retained series
    config.label_ttl_ns = 1;
    CHECK(agg.define_metric("m", config));

    Model model;
    for (int i = 0; i < 4; ++i) {
        const Labels labels = make_labels({{"id", std::to_string(i)}});
        CHECK(agg.observe("m", labels, static_cast<std::uint64_t>(i + 1),
                          0) == dlks::ObserveStatus::Retained);
        model.add(canonical(labels), static_cast<std::uint64_t>(i + 1));
    }
    CHECK_EQ(agg.metric_snapshot("m")->series.size(), 4u);
    CHECK_EQ(agg.metric_snapshot("m")->accounted_bytes, 4 * slot);

    CHECK_EQ(agg.expire(1), 4u);
    auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 0u);
    CHECK_EQ(snapshot->accounted_bytes, 0u);
    CHECK_EQ(snapshot->overflow.count, 10u);
    CHECK_EQ(snapshot->total_count(), 10u);

    for (int i = 0; i < 4; ++i) {
        const Labels labels = make_labels({{"new", std::to_string(i)}});
        CHECK(agg.observe("m", labels, 1, 1) ==
              dlks::ObserveStatus::Retained);
    }
    snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 4u);
    CHECK_EQ(snapshot->total_count(), 14u);
}

void test_constant_hash_expiry_shift() {
    using Agg = dlks::BasicAggregator<64, ConstantHasher>;
    constexpr std::size_t slot = Agg::slot_bytes();
    Agg agg;
    dlks::MetricConfig config;
    config.memory_budget_bytes = 5 * slot;
    config.label_ttl_ns = 2;
    CHECK(agg.define_metric("m", config));

    for (int i = 0; i < 4; ++i) {
        const Labels labels = make_labels({{"id", std::to_string(i)}});
        CHECK(agg.observe("m", labels, 1, 0) ==
              dlks::ObserveStatus::Retained);
    }
    CHECK_EQ(agg.expire(2), 4u);
    CHECK_EQ(agg.metric_snapshot("m")->series.size(), 0u);
    CHECK_EQ(agg.metric_snapshot("m")->overflow.count, 4u);

    for (int i = 0; i < 4; ++i) {
        const Labels labels = make_labels({{"next", std::to_string(i)}});
        CHECK(agg.observe("m", labels, 1, 2) ==
              dlks::ObserveStatus::Retained);
    }
    const auto snapshot = agg.metric_snapshot("m");
    CHECK_EQ(snapshot->series.size(), 4u);
    CHECK_EQ(snapshot->total_count(), 8u);
}

}  // namespace

int main() {
    struct Test {
        const char* name;
        void (*run)();
    };
    const Test tests[] = {
        {"basic_counting", test_basic_counting},
        {"overflow_conservation", test_overflow_conservation},
        {"heavy_hitter_retention", test_heavy_hitter_retention},
        {"protect_residents_policy", test_protect_residents_policy},
        {"protect_residents_ties_admit", test_protect_residents_ties_admit},
        {"expiry", test_expiry},
        {"expiry_boundaries", test_expiry_boundaries},
        {"key_capacity", test_key_capacity},
        {"hash_collisions_do_not_mix_keys",
         test_hash_collisions_do_not_mix_keys},
        {"label_canonicalization", test_label_canonicalization},
        {"unlabeled_series", test_unlabeled_series},
        {"many_labels_heap_path", test_many_labels_heap_path},
        {"zero_and_tiny_budgets", test_zero_and_tiny_budgets},
        {"multi_metric_isolation", test_multi_metric_isolation},
        {"expire_metric_api", test_expire_metric_api},
        {"reset_and_clear", test_reset_and_clear},
        {"snapshot_ordering", test_snapshot_ordering},
        {"saturation", test_saturation},
        {"exact_small_domain", test_exact_small_domain},
        {"random_model", test_random_model},
        {"random_collisions", test_random_collisions},
        {"policy_differential", test_policy_differential},
        {"expiry_releases_capacity", test_expiry_releases_capacity},
        {"constant_hash_expiry_shift", test_constant_hash_expiry_shift},
    };

    for (const Test& test : tests) {
        const int before = g_failures;
        std::cout << "[ RUN      ] " << test.name << "\n";
        test.run();
        if (g_failures == before) {
            std::cout << "[       OK ] " << test.name << "\n";
        } else {
            std::cout << "[  FAILED  ] " << test.name << "\n";
        }
    }

    std::cout << "\n" << g_checks << " checks, " << g_failures
              << " failures\n";
    return g_failures == 0 ? 0 : 1;
}
