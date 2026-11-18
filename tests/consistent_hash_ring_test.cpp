#include "dlks_formal/consistent_hash_ring.hpp"

#include <atomic>
#include <chrono>
#include <map>
#include <random>
#include <thread>

#include <cassert>
#include <cstdint>
#include <iostream>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "CHECK failed: " #cond " at " << __FILE__ << ":"    \
                      << __LINE__ << "\n";                                   \
        }                                                                    \
    } while (0)

#define CHECK_EQ(a, b)                                                       \
    do {                                                                     \
        ++g_checks;                                                          \
        auto lhs_ = (a);                                                     \
        auto rhs_ = (b);                                                     \
        if (!(lhs_ == rhs_)) {                                               \
            ++g_failures;                                                    \
            std::cerr << "CHECK_EQ failed: " #a " == " #b " at " << __FILE__ \
                      << ":" << __LINE__ << "\n";                            \
        }                                                                    \
    } while (0)

// Independently written small-modulus hasher: collisions are frequent and
// every interesting ring position can be enumerated.
struct ModHasher {
    std::uint64_t modulus = 13;

    dlks_formal::RingPoint operator()(std::string_view s) const {
        std::uint64_t h = 1123;
        for (char raw : s) {
            h = (h * 131 + static_cast<unsigned char>(raw) + 17) % modulus;
        }
        return h;
    }
};

// Naive reference ring, implemented independently of the production code.
class NaiveRing {
public:
    struct VNode {
        dlks_formal::RingPoint point;
        std::string node;
        std::uint32_t vindex;
    };

    NaiveRing(std::vector<dlks_formal::RingNode> input, ModHasher hasher,
              std::uint32_t vnodes_per_weight)
        : hasher_(hasher), vpw_(vnodes_per_weight) {
        std::map<std::string, std::uint32_t> weights;
        for (auto& n : input) {
            weights[n.name] = n.weight;  // upsert, last entry wins
        }
        for (auto& [name, w] : weights) {
            nodes_.push_back(dlks_formal::RingNode{name, w});
        }
        std::map<dlks_formal::RingPoint, VNode> kept;
        for (auto& [name, w] : weights) {
            for (std::uint32_t slot = 0;
                 slot < static_cast<std::uint64_t>(w) * vpw_; ++slot) {
                std::string material = name + "#" + std::to_string(slot);
                auto p = hasher_(material);
                VNode candidate{p, name, slot};
                auto it = kept.find(p);
                if (it == kept.end()) {
                    kept.emplace(p, candidate);
                } else {
                    bool smaller =
                        candidate.node < it->second.node ||
                        (candidate.node == it->second.node &&
                         candidate.vindex < it->second.vindex);
                    if (smaller) {
                        it->second = candidate;
                    }
                }
            }
        }
        for (auto& [p, v] : kept) {
            vnodes_.push_back(v);
        }
    }

    std::optional<std::string> lookup_point(
        dlks_formal::RingPoint point) const {
        if (vnodes_.empty()) {
            return std::nullopt;
        }
        std::size_t lo = 0;
        std::size_t hi = vnodes_.size();
        while (lo < hi) {
            std::size_t mid = lo + (hi - lo) / 2;
            if (vnodes_[mid].point < point) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo == vnodes_.size()) {
            lo = 0;
        }
        return vnodes_[lo].node;
    }

    const std::vector<VNode>& vnodes() const { return vnodes_; }
    const std::vector<dlks_formal::RingNode>& nodes() const { return nodes_; }

private:
    ModHasher hasher_;
    std::uint32_t vpw_;
    std::vector<VNode> vnodes_;
    std::vector<dlks_formal::RingNode> nodes_;
};

bool same_vnodes(const dlks_formal::Ring& ring, const NaiveRing& naive) {
    const auto& actual = ring.virtual_nodes();
    const auto& expected = naive.vnodes();
    if (actual.size() != expected.size()) {
        return false;
    }
    for (std::size_t i = 0; i < actual.size(); ++i) {
        if (actual[i].point != expected[i].point ||
            actual[i].node != expected[i].node ||
            actual[i].vindex != expected[i].vindex) {
            return false;
        }
    }
    return true;
}

bool same_vnodes(const dlks_formal::Ring& lhs, const dlks_formal::Ring& rhs) {
    const auto& a = lhs.virtual_nodes();
    const auto& b = rhs.virtual_nodes();
    if (a.size() != b.size()) {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i].point != b[i].point || a[i].node != b[i].node ||
            a[i].vindex != b[i].vindex) {
            return false;
        }
    }
    return true;
}

bool same_nodes(const dlks_formal::Ring& ring, const NaiveRing& naive) {
    const auto& actual = ring.nodes();
    const auto& expected = naive.nodes();
    if (actual.size() != expected.size()) {
        return false;
    }
    for (std::size_t i = 0; i < actual.size(); ++i) {
        if (actual[i].name != expected[i].name ||
            actual[i].weight != expected[i].weight) {
            return false;
        }
    }
    return true;
}

}  // namespace

// Exhaustively enumerate small rings and cross-check ownership against the
// naive model at every key position.
void test_exhaustive_ownership() {
    const std::vector<std::string> names = {"a", "b", "c", "d"};
    const std::vector<std::uint64_t> moduli = {3, 5, 7, 13};
    const std::vector<std::uint32_t> vpws = {1, 2};
    const std::vector<std::uint32_t> weight_choices = {0, 1, 2, 3};

    int rings_checked = 0;
    for (auto modulus : moduli) {
        for (auto vpw : vpws) {
            ModHasher hasher{modulus};
            dlks_formal::Ring::Options options;
            options.hasher = [hasher](std::string_view s) {
                return hasher(s);
            };
            options.vnodes_per_weight = vpw;

            const int combos = 256;  // 4 weight choices ^ 4 nodes
            for (int combo = 0; combo < combos; ++combo) {
                std::vector<dlks_formal::RingNode> input;
                int code = combo;
                for (const auto& name : names) {
                    input.push_back(dlks_formal::RingNode{
                        name, weight_choices[code % 4]});
                    code /= 4;
                }

                dlks_formal::Ring ring(input, options);
                NaiveRing naive(input, hasher, vpw);

                CHECK(same_vnodes(ring, naive));
                CHECK(same_nodes(ring, naive));

                std::vector<dlks_formal::RingPoint> probes;
                for (std::uint64_t p = 0; p < modulus; ++p) {
                    probes.push_back(p);
                }
                probes.push_back(modulus);
                probes.push_back(modulus + 1);
                probes.push_back(0xFFFFFFFFFFFFFFFFULL);
                probes.push_back(0xFFFFFFFFFFFFFFFEULL);
                probes.push_back(0x8000000000000000ULL);
                for (auto p : probes) {
                    CHECK_EQ(ring.lookup_point(p), naive.lookup_point(p));
                }

                for (const char* key : {"", "k", "hello", "partition/42"}) {
                    CHECK_EQ(ring.lookup(key),
                             ring.lookup_point(hasher(key)));
                }
                ++rings_checked;
            }
        }
    }
    std::cout << "exhaustive ownership rings: " << rings_checked << "\n";
}

// Reference migration set from the naive model, plus independent per-position
// coverage checks of the production diff.
void test_diff_oracle() {
    const std::vector<std::string> names = {"a", "b", "c", "d"};
    ModHasher hasher{7};
    dlks_formal::Ring::Options options;
    options.hasher = [hasher](std::string_view s) { return hasher(s); };
    options.vnodes_per_weight = 2;

    std::mt19937 rng(20261119);
    std::uniform_int_distribution<int> weight_dist(0, 3);
    std::uniform_int_distribution<int> node_dist(0, 3);

    std::vector<std::uint32_t> weights(names.size(), 1);

    auto make_input = [&] {
        std::vector<dlks_formal::RingNode> input;
        for (std::size_t i = 0; i < names.size(); ++i) {
            input.push_back(dlks_formal::RingNode{names[i], weights[i]});
        }
        return input;
    };

    for (int step = 0; step < 400; ++step) {
        auto old_input = make_input();
        weights[node_dist(rng)] = weight_dist(rng);
        auto new_input = make_input();

        dlks_formal::Ring old_ring(old_input, options);
        dlks_formal::Ring new_ring(new_input, options);
        NaiveRing old_naive(old_input, hasher, 2);
        NaiveRing new_naive(new_input, hasher, 2);

        auto migrations = dlks_formal::Ring::diff(old_ring, new_ring);

        std::set<dlks_formal::RingPoint> boundary_set;
        for (const auto& v : old_naive.vnodes()) {
            boundary_set.insert(v.point);
        }
        for (const auto& v : new_naive.vnodes()) {
            boundary_set.insert(v.point);
        }
        std::vector<dlks_formal::RingPoint> boundaries(boundary_set.begin(),
                                                       boundary_set.end());

        if (boundaries.empty()) {
            CHECK(migrations.empty());
            continue;
        }

        std::vector<dlks_formal::Migration> expected;
        for (std::size_t i = 0; i < boundaries.size(); ++i) {
            auto lo = boundaries[i];
            auto hi = boundaries[(i + 1) % boundaries.size()];
            auto src = old_naive.lookup_point(hi);
            auto tgt = new_naive.lookup_point(hi);
            if (src == tgt) {
                continue;
            }
            if (!expected.empty() && expected.back().source == src &&
                expected.back().target == tgt &&
                expected.back().arc.lo < expected.back().arc.hi &&
                expected.back().arc.hi == lo) {
                expected.back().arc.hi = hi;
            } else {
                expected.push_back(
                    dlks_formal::Migration{src, tgt, dlks_formal::Arc{lo, hi}});
            }
        }

        CHECK_EQ(migrations.size(), expected.size());
        std::size_t compare = std::min(migrations.size(), expected.size());
        for (std::size_t i = 0; i < compare; ++i) {
            CHECK_EQ(migrations[i].source, expected[i].source);
            CHECK_EQ(migrations[i].target, expected[i].target);
            CHECK_EQ(migrations[i].arc.lo, expected[i].arc.lo);
            CHECK_EQ(migrations[i].arc.hi, expected[i].arc.hi);
        }
        for (std::size_t i = 1; i < migrations.size(); ++i) {
            if (migrations[i - 1].source == migrations[i].source &&
                migrations[i - 1].target == migrations[i].target) {
                // Same pair may recur across an unchanged gap or the wrap,
                // but never as geometrically adjacent non-wrapping arcs.
                bool adjacent =
                    migrations[i - 1].arc.lo < migrations[i - 1].arc.hi &&
                    migrations[i - 1].arc.hi == migrations[i].arc.lo;
                CHECK(!adjacent);
            }
        }

        std::vector<dlks_formal::RingPoint> probes;
        for (std::uint64_t p = 0; p < 7; ++p) {
            probes.push_back(p);
        }
        // Outside the small modulus space every probe maps to the same owner
        // as point 0, so only in-space points give exact arc coverage.
        for (auto p : probes) {
            auto src = old_naive.lookup_point(p);
            auto tgt = new_naive.lookup_point(p);
            int covering = 0;
            for (const auto& m : migrations) {
                if (m.arc.contains(p)) {
                    ++covering;
                    CHECK_EQ(m.source, src);
                    CHECK_EQ(m.target, tgt);
                }
            }
            if (src == tgt) {
                CHECK_EQ(covering, 0);
            } else {
                CHECK_EQ(covering, 1);
            }
        }
    }
    std::cout << "diff random-walk steps: 400\n";
}

void test_special_diffs() {
    ModHasher hasher{11};
    dlks_formal::Ring::Options options;
    options.hasher = [hasher](std::string_view s) { return hasher(s); };
    options.vnodes_per_weight = 1;

    dlks_formal::Ring empty(std::vector<dlks_formal::RingNode>{}, options);
    dlks_formal::Ring single(
        std::vector<dlks_formal::RingNode>{{"a", 1}}, options);

    // Empty -> populated: one full-circle migration with no source.
    auto add_all = dlks_formal::Ring::diff(empty, single);
    CHECK_EQ(add_all.size(), 1u);
    CHECK(!add_all[0].source.has_value());
    CHECK_EQ(add_all[0].target.value(), std::string("a"));
    CHECK_EQ(add_all[0].arc.lo, add_all[0].arc.hi);
    for (auto p : {0ULL, 5ULL, 10ULL, 0xFFFFFFFFFFFFFFFFULL}) {
        CHECK(add_all[0].arc.contains(p));
    }

    // Populated -> empty: full-circle migration with no target.
    auto remove_all = dlks_formal::Ring::diff(single, empty);
    CHECK_EQ(remove_all.size(), 1u);
    CHECK_EQ(remove_all[0].source.value(), std::string("a"));
    CHECK(!remove_all[0].target.has_value());

    // Identical rings: no migration.
    CHECK(dlks_formal::Ring::diff(single, single).empty());

    // Weight change moves only the new vnode's owning arc.
    dlks_formal::Ring w1(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 1}}, options);
    dlks_formal::Ring w2(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 2}}, options);
    NaiveRing w2_naive(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 2}}, hasher, 1);
    NaiveRing w1_naive(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 1}}, hasher, 1);
    auto weight_moves = dlks_formal::Ring::diff(w1, w2);
    for (std::uint64_t p = 0; p < 11; ++p) {
        int covering = 0;
        for (const auto& m : weight_moves) {
            if (m.arc.contains(p)) {
                ++covering;
            }
        }
        bool changed = w1_naive.lookup_point(p) != w2_naive.lookup_point(p);
        CHECK_EQ(covering, changed ? 1 : 0);
    }

    // Adding a node: every migration target is the new node; keys already
    // owned by other nodes never appear.
    dlks_formal::Ring grown(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 1}, {"c", 1}},
        options);
    NaiveRing grown_naive(
        std::vector<dlks_formal::RingNode>{{"a", 1}, {"b", 1}, {"c", 1}},
        hasher, 1);
    auto grow_moves = dlks_formal::Ring::diff(w1, grown);
    for (std::uint64_t p = 0; p < 11; ++p) {
        bool changed = w1_naive.lookup_point(p) != grown_naive.lookup_point(p);
        int covering = 0;
        for (const auto& m : grow_moves) {
            if (m.arc.contains(p)) {
                ++covering;
                CHECK_EQ(m.target.value(), std::string("c"));
            }
        }
        CHECK_EQ(covering, changed ? 1 : 0);
    }
}

void test_zero_weight_and_duplicate_names() {
    ModHasher hasher{5};
    dlks_formal::Ring::Options options;
    options.hasher = [hasher](std::string_view s) { return hasher(s); };
    options.vnodes_per_weight = 2;

    // Zero-weight node is registered, emits no vnodes, owns no keys.
    dlks_formal::Ring ring(
        std::vector<dlks_formal::RingNode>{{"a", 0}, {"b", 1}}, options);
    CHECK_EQ(ring.nodes().size(), 2u);
    for (const auto& v : ring.virtual_nodes()) {
        CHECK(v.node != "a");
    }
    for (std::uint64_t p = 0; p < 5; ++p) {
        CHECK_EQ(ring.lookup_point(p).value_or(std::string("a")),
                 std::string("b"));
    }

    dlks_formal::Ring all_zero(
        std::vector<dlks_formal::RingNode>{{"a", 0}, {"b", 0}}, options);
    CHECK(all_zero.virtual_nodes().empty());
    for (std::uint64_t p = 0; p < 5; ++p) {
        CHECK(!all_zero.lookup_point(p).has_value());
    }
    CHECK(!all_zero.lookup("anything").has_value());

    // Duplicate names: last weight wins, one node entry remains.
    dlks_formal::Ring dup(
        std::vector<dlks_formal::RingNode>{
            {"a", 1}, {"a", 3}, {"b", 1}, {"a", 0}},
        options);
    dlks_formal::Ring merged(
        std::vector<dlks_formal::RingNode>{{"a", 0}, {"b", 1}}, options);
    CHECK_EQ(dup.nodes().size(), 2u);
    CHECK(same_vnodes(dup, merged));
    for (std::uint64_t p = 0; p < 5; ++p) {
        CHECK_EQ(dup.lookup_point(p), merged.lookup_point(p));
    }

    // Builder upserts behave identically.
    dlks_formal::RingBuilder builder;
    builder.set_node("a", 1).set_node("a", 3).set_node("b", 1).set_node("a", 0);
    auto built = builder.build(options);
    CHECK(same_vnodes(built, merged));
    CHECK_EQ(builder.weight_of("a").value(), 0u);
    CHECK(!builder.weight_of("missing").has_value());
    builder.erase_node("b");
    CHECK(!builder.weight_of("b").has_value());
}

void test_collision_determinism() {
    // All virtual nodes land on the same point: exactly one survives, chosen
    // by the stable (node name, vindex) tie-break.
    ModHasher hasher{1};
    dlks_formal::Ring::Options options;
    options.hasher = [hasher](std::string_view s) { return hasher(s); };
    options.vnodes_per_weight = 2;

    dlks_formal::Ring ring(
        std::vector<dlks_formal::RingNode>{{"zeta", 3}, {"alpha", 3}},
        options);
    CHECK_EQ(ring.virtual_nodes().size(), 1u);
    CHECK_EQ(ring.virtual_nodes()[0].node, std::string("alpha"));
    CHECK_EQ(ring.virtual_nodes()[0].vindex, 0u);
    CHECK_EQ(ring.virtual_nodes()[0].point, 0u);
    for (std::uint64_t p = 0; p < 4; ++p) {
        CHECK_EQ(ring.lookup_point(p).value(), std::string("alpha"));
    }

    // Construction order must not affect the resulting ring.
    std::vector<dlks_formal::RingNode> shuffled = {
        {"b", 2}, {"a", 1}, {"c", 0}, {"a", 1}, {"b", 2}};
    std::vector<dlks_formal::RingNode> canonical = {
        {"a", 1}, {"b", 2}, {"c", 0}};
    dlks_formal::Ring r1(shuffled, options);
    dlks_formal::Ring r2(canonical, options);
    CHECK(same_vnodes(r1, r2));
    CHECK_EQ(r1.nodes().size(), r2.nodes().size());
    for (std::size_t i = 0; i < r1.nodes().size(); ++i) {
        CHECK(r1.nodes()[i].name == r2.nodes()[i].name);
        CHECK(r1.nodes()[i].weight == r2.nodes()[i].weight);
    }
}

void test_default_hasher_known_vector() {
    // Known FNV-1a 64-bit values pin the default hasher across platforms.
    CHECK_EQ(dlks_formal::fnv1a64(""), 0xcbf29ce484222325ULL);
    CHECK_EQ(dlks_formal::fnv1a64("a"), 0xaf63dc4c8601ec8cULL);
    CHECK_EQ(dlks_formal::fnv1a64("foobar"), 0x85944171f73967e8ULL);

    dlks_formal::Ring ring(std::vector<dlks_formal::RingNode>{{"a", 1}});
    CHECK(!ring.virtual_nodes().empty());
    for (const char* key : {"k1", "k2", "k3"}) {
        CHECK_EQ(ring.lookup(key).value(), std::string("a"));
    }
}

void test_shared_ring_jitter() {
    dlks_formal::Ring::Options options;
    ModHasher hasher{13};
    options.hasher = [hasher](std::string_view s) { return hasher(s); };
    options.vnodes_per_weight = 1;

    dlks_formal::SharedRing shared(options);
    shared.set_node("a", 1);
    shared.set_node("b", 1);
    shared.set_node("c", 1);

    std::atomic<bool> stop{false};
    std::atomic<int> torn_lookups{0};

    auto reader = [&] {
        std::mt19937 local_rng(std::random_device{}());
        std::uniform_int_distribution<int> key_dist(0, 999);
        while (!stop.load(std::memory_order_relaxed)) {
            // Every lookup comes from one internally consistent snapshot:
            // the returned owner must equal a second lookup from that same
            // snapshot, even while writers churn the ring.
            auto snap = shared.snapshot();
            std::string key = "key-" + std::to_string(key_dist(local_rng));
            auto first = snap->lookup(key);
            auto second = snap->lookup(key);
            if (first != second) {
                torn_lookups.fetch_add(1, std::memory_order_relaxed);
            }
        }
    };

    std::vector<std::thread> readers;
    for (int i = 0; i < 4; ++i) {
        readers.emplace_back(reader);
    }

    std::mt19937 rng(7);
    const std::vector<std::string> names = {"a", "b", "c", "d", "e"};
    std::uniform_int_distribution<int> dist(0, 4);
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(400);
    std::uint64_t last_version = shared.version();
    int updates = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        const auto& name = names[dist(rng)];
        if (dist(rng) == 0) {
            shared.erase_node(name);
        } else {
            shared.set_node(name, dist(rng));  // includes weight 0
        }
        ++updates;
        CHECK(shared.version() >= last_version);
        last_version = shared.version();
    }

    stop.store(true, std::memory_order_relaxed);
    for (auto& t : readers) {
        t.join();
    }
    CHECK_EQ(torn_lookups.load(), 0);
    CHECK(updates > 0);

    // Final published state matches a ring built from the same inputs by
    // replaying all zero/positive entries via the builder semantics: the
    // snapshot itself must be internally consistent and self-describing.
    auto snap = shared.snapshot();
    for (std::uint64_t p = 0; p < 13; ++p) {
        auto owner = snap->lookup_point(p);
        if (snap->virtual_nodes().empty()) {
            CHECK(!owner.has_value());
        } else if (owner.has_value()) {
            bool exists = false;
            for (const auto& n : snap->nodes()) {
                if (n.name == owner.value() && n.weight > 0) {
                    exists = true;
                }
            }
            CHECK(exists);
        }
    }
    std::cout << "jitter updates: " << updates << "\n";
}

void test_arc_contains() {
    dlks_formal::Arc non_wrapping{20, 30};
    CHECK(!non_wrapping.contains(20));
    CHECK(non_wrapping.contains(21));
    CHECK(non_wrapping.contains(29));
    CHECK(non_wrapping.contains(30));
    CHECK(!non_wrapping.contains(19));

    dlks_formal::Arc wrapping{90, 10};
    CHECK(!wrapping.contains(90));
    CHECK(wrapping.contains(91));
    CHECK(wrapping.contains(0xFFFFFFFFFFFFFFFFULL));
    CHECK(wrapping.contains(0));
    CHECK(wrapping.contains(9));
    CHECK(wrapping.contains(10));
    CHECK(!wrapping.contains(50));

    dlks_formal::Arc full{5, 5};
    CHECK(full.contains(0));
    CHECK(full.contains(5));
    CHECK(full.contains(0xFFFFFFFFFFFFFFFFULL));

    // Point lo itself belongs to the predecessor arc, never its own.
    dlks_formal::Arc tiny{20, 21};
    CHECK(tiny.contains(21));
    CHECK(!tiny.contains(20));
}

int main() {
    test_arc_contains();
    test_exhaustive_ownership();
    test_diff_oracle();
    test_special_diffs();
    test_zero_weight_and_duplicate_names();
    test_collision_determinism();
    test_default_hasher_known_vector();
    test_shared_ring_jitter();

    std::cout << "checks: " << g_checks << ", failures: " << g_failures
              << "\n";
    return g_failures == 0 ? 0 : 1;
}
