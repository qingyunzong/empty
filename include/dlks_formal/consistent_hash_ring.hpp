#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dlks_formal {

// Position on the hash ring, interpreted modulo 2^64.
using RingPoint = std::uint64_t;

// A node entry. Weight zero means the node is registered but owns no keys.
struct RingNode {
    std::string name;
    std::uint32_t weight = 0;
};

// A placed virtual node. `vindex` is the per-node virtual slot in
// [0, weight * vnodes_per_weight).
struct VirtualNode {
    RingPoint point = 0;
    std::string node;
    std::uint32_t vindex = 0;
};

// Clockwise arc of key space delimited by two consecutive ring points.
// Under the lower_bound ownership rule a virtual node at point p owns
// (predecessor(p), p], hence the arc between lo and hi covers (lo, hi]:
//   lo < hi  -> (lo, hi]
//   lo >= hi -> the arc wraps: (lo, 2^64) union [0, hi]
// lo == hi denotes the full circle (a ring with a single virtual node).
struct Arc {
    RingPoint lo = 0;
    RingPoint hi = 0;

    bool contains(RingPoint p) const noexcept {
        if (lo < hi) {
            return p > lo && p <= hi;
        }
        return p > lo || p <= hi;
    }
};

// A minimal set of keys whose ownership changed between two rings.
// source/target is nullopt when the keys were / became unowned.
struct Migration {
    std::optional<std::string> source;
    std::optional<std::string> target;
    Arc arc;
};

using RingHasher = std::function<RingPoint(std::string_view)>;

// Deterministic 64-bit FNV-1a, so ring layouts are stable across platforms.
inline RingPoint fnv1a64(std::string_view data) noexcept {
    RingPoint hash = 14695981039346656037ULL;
    for (unsigned char c : data) {
        hash ^= static_cast<RingPoint>(c);
        hash *= 1099511628211ULL;
    }
    return hash;
}

// Immutable consistent-hash ring snapshot.
//
// Construction rules:
//   * Each positive-weight node emits weight * vnodes_per_weight virtual
//     nodes, placed at hasher(name + "#" + vindex).
//   * Zero-weight nodes emit no virtual nodes and therefore own no keys.
//   * Duplicate node names are upserts: the last entry determines the weight.
//   * When two virtual nodes hash to the same point, the stable tie-break
//     keeps the entry with the lexicographically smallest node name, then
//     the smallest vindex; all colliding entries are dropped.
// Lookup returns the virtual node at the first point clockwise from the key
// (lower_bound, wrapping to the ring start), or nullopt on an empty ring.
class Ring {
public:
    struct Options {
        RingHasher hasher = fnv1a64;
        std::uint32_t vnodes_per_weight = 160;
    };

    Ring() = default;

    explicit Ring(std::vector<RingNode> nodes) : Ring(std::move(nodes), Options{}) {}

    Ring(std::vector<RingNode> nodes, Options options) : options_(std::move(options)) {
        if (!options_.hasher) {
            options_.hasher = fnv1a64;
        }
        if (options_.vnodes_per_weight == 0) {
            options_.vnodes_per_weight = 1;
        }

        std::map<std::string, std::uint32_t> weights;
        for (auto& entry : nodes) {
            weights[entry.name] = entry.weight;  // upsert, last write wins
        }

        nodes_.reserve(weights.size());
        for (const auto& [name, weight] : weights) {
            nodes_.push_back(RingNode{name, weight});
        }

        std::map<RingPoint, VirtualNode> placed;
        for (const auto& [name, weight] : weights) {
            if (weight == 0) {
                continue;
            }
            const std::uint64_t count =
                static_cast<std::uint64_t>(weight) * options_.vnodes_per_weight;
            for (std::uint64_t slot = 0; slot < count; ++slot) {
                const auto vindex = static_cast<std::uint32_t>(slot);
                const std::string material = name + "#" + std::to_string(vindex);
                const RingPoint point = options_.hasher(material);
                VirtualNode candidate{point, name, vindex};
                auto [it, inserted] = placed.emplace(point, candidate);
                if (!inserted && lex_less(candidate, it->second)) {
                    it->second = std::move(candidate);
                }
            }
        }

        points_.reserve(placed.size());
        for (auto& [point, vnode] : placed) {
            points_.push_back(std::move(vnode));
        }
    }

    // Owner of a key, hashed through the configured hasher.
    [[nodiscard]] std::optional<std::string> lookup(std::string_view key) const {
        return lookup_point(options_.hasher(key));
    }

    // Owner of an already-hashed key position: first point clockwise.
    [[nodiscard]] std::optional<std::string> lookup_point(RingPoint point) const {
        if (points_.empty()) {
            return std::nullopt;
        }
        auto it = std::lower_bound(
            points_.begin(), points_.end(), point,
            [](const VirtualNode& vnode, RingPoint value) {
                return vnode.point < value;
            });
        if (it == points_.end()) {
            it = points_.begin();
        }
        return it->node;
    }

    [[nodiscard]] const std::vector<VirtualNode>& virtual_nodes() const noexcept {
        return points_;
    }

    [[nodiscard]] const std::vector<RingNode>& nodes() const noexcept {
        return nodes_;
    }

    [[nodiscard]] const Options& options() const noexcept {
        return options_;
    }

    // Minimal migration set between two ring snapshots.
    //
    // The union of both rings' virtual-node points partitions the circle into
    // arcs whose ownership is constant; an arc is emitted only when its owner
    // differs, so weight changes move exactly the affected key intervals.
    [[nodiscard]] static std::vector<Migration> diff(const Ring& old_ring,
                                                     const Ring& new_ring) {
        std::vector<RingPoint> boundaries;
        boundaries.reserve(old_ring.points_.size() + new_ring.points_.size());
        for (const auto& vnode : old_ring.points_) {
            boundaries.push_back(vnode.point);
        }
        for (const auto& vnode : new_ring.points_) {
            boundaries.push_back(vnode.point);
        }
        if (boundaries.empty()) {
            return {};
        }
        std::sort(boundaries.begin(), boundaries.end());
        boundaries.erase(std::unique(boundaries.begin(), boundaries.end()),
                         boundaries.end());

        std::vector<Migration> migrations;
        const std::size_t count = boundaries.size();
        for (std::size_t i = 0; i < count; ++i) {
            const RingPoint lo = boundaries[i];
            const RingPoint hi = boundaries[(i + 1) % count];
            // A virtual node at p owns (predecessor(p), p]. The arc [lo, hi)
            // has no interior boundary, so its owner is the node at hi; when
            // hi is absent from one ring that ring resolves it clockwise.
            auto source = old_ring.lookup_point(hi);
            auto target = new_ring.lookup_point(hi);
            if (source == target) {
                continue;
            }
            if (!migrations.empty() &&
                migrations.back().source == source &&
                migrations.back().target == target &&
                migrations.back().arc.lo < migrations.back().arc.hi &&
                migrations.back().arc.hi == lo) {
                // Geometrically adjacent, non-wrapping arcs with the same
                // pair of owners merge into one migration interval.
                migrations.back().arc.hi = hi;
            } else {
                migrations.push_back(Migration{std::move(source), std::move(target),
                                               Arc{lo, hi}});
            }
        }
        return migrations;
    }

private:
    static bool lex_less(const VirtualNode& lhs, const VirtualNode& rhs) {
        if (lhs.node != rhs.node) {
            return lhs.node < rhs.node;
        }
        return lhs.vindex < rhs.vindex;
    }

    Options options_;
    std::vector<RingNode> nodes_;
    std::vector<VirtualNode> points_;  // sorted by point, unique points
};

// Convenience builder: upsert semantics for repeated names.
class RingBuilder {
public:
    RingBuilder& set_node(std::string name, std::uint32_t weight) {
        weights_[std::move(name)] = weight;
        return *this;
    }

    RingBuilder& erase_node(std::string_view name) {
        weights_.erase(std::string(name));
        return *this;
    }

    [[nodiscard]] std::optional<std::uint32_t> weight_of(
        std::string_view name) const {
        auto it = weights_.find(std::string(name));
        if (it == weights_.end()) {
            return std::nullopt;
        }
        return it->second;
    }

    [[nodiscard]] Ring build() const { return build(Ring::Options{}); }

    [[nodiscard]] Ring build(Ring::Options options) const {
        std::vector<RingNode> nodes;
        nodes.reserve(weights_.size());
        for (const auto& [name, weight] : weights_) {
            nodes.push_back(RingNode{name, weight});
        }
        return Ring(std::move(nodes), std::move(options));
    }

private:
    std::map<std::string, std::uint32_t> weights_;
};

// Thread-safe wrapper for node churn interleaved with lookups.
// Updates rebuild an immutable Ring and atomically publish it; readers always
// observe one consistent snapshot, so allocations never tear across updates.
class SharedRing {
public:
    SharedRing() : SharedRing(Ring::Options{}) {}

    explicit SharedRing(Ring::Options options) : options_(std::move(options)) {
        ring_.store(std::make_shared<Ring>(std::vector<RingNode>{}, options_));
    }

    void set_node(const std::string& name, std::uint32_t weight) {
        std::lock_guard lock(mutex_);
        weights_[name] = weight;
        publish();
    }

    void erase_node(std::string_view name) {
        std::lock_guard lock(mutex_);
        weights_.erase(std::string(name));
        publish();
    }

    [[nodiscard]] std::optional<std::string> lookup(std::string_view key) const {
        return ring_.load(std::memory_order_acquire)->lookup(key);
    }

    [[nodiscard]] std::shared_ptr<const Ring> snapshot() const {
        return ring_.load(std::memory_order_acquire);
    }

    [[nodiscard]] std::uint64_t version() const noexcept {
        return version_.load(std::memory_order_acquire);
    }

private:
    void publish() {
        std::vector<RingNode> nodes;
        nodes.reserve(weights_.size());
        for (const auto& [name, weight] : weights_) {
            nodes.push_back(RingNode{name, weight});
        }
        ring_.store(std::make_shared<Ring>(std::move(nodes), options_),
                    std::memory_order_release);
        version_.fetch_add(1, std::memory_order_acq_rel);
    }

    Ring::Options options_;
    std::mutex mutex_;
    std::map<std::string, std::uint32_t> weights_;
    std::atomic<std::shared_ptr<Ring>> ring_;
    std::atomic<std::uint64_t> version_{0};
};

}  // namespace dlks_formal
