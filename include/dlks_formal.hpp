#pragma once

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <utility>
#include <vector>

namespace dlks {

// Wall-clock time used by the scheduler, in nanoseconds.
using SchedulerTime = std::int64_t;

using PacketBytes = std::uint32_t;
using Weight = std::uint32_t;

struct Packet {
    std::uint64_t id{};
    PacketBytes bytes{};
};

// A classic byte token bucket.  rate_bytes_per_sec is the steady-state rate
// and burst_bytes is the maximum number of bytes that may be released at once.
struct TokenBucketConfig {
    std::uint64_t rate_bytes_per_sec{};
    std::uint64_t burst_bytes{};
};

// Hierarchical virtual-finish-time fair queueing (H-WFQ) scheduler.
//
// The tree is:
//
//     root (port)
//       +-- group (class) -> queue (flow) -> FIFO packets
//       +-- group (class) -> queue (flow) -> FIFO packets
//
// Siblings are selected by virtual finish time.  A packet's virtual service
// cost is its length divided by the node weight, so packet length participates
// in the ordering.  Every node may additionally have a token bucket.
//
// A shaped node first chooses its WFQ head, then checks its own bucket against
// that whole packet.  If the packet does not fit, the node blocks as a unit and
// its parent may choose another sibling.  Blocking as a unit (instead of
// letting smaller packets in the same subtree steal the tokens) prevents a
// large-packet flow from being starved by a continuous stream of small packets.
//
// Two properties are intentional:
//   * An empty (or otherwise ineligible) subtree is clamped to the parent's
//     current virtual time when it becomes selectable again.  It therefore
//     cannot spend credit accumulated while it was idle.
//   * Tags are assigned lazily to the current head packet.  A weight change
//     invalidates only the pending head tag and applies to the next packet
//     immediately, without resetting the node's virtual history.
//
// Equal finish tags are resolved by the packet's enqueue sequence, then by
// node id.  This gives deterministic FIFO ordering for ties.
//
// The class is not internally synchronised.  Callers must serialise access.
class HierarchicalScheduler {
public:
    using NodeId = std::uint32_t;

    static constexpr NodeId kRoot = 0;
    static constexpr NodeId kInvalid = std::numeric_limits<NodeId>::max();

    struct SelectedPacket {
        Packet packet{};
        NodeId queue{kInvalid};
    };

    HierarchicalScheduler() {
        Node root;
        root.parent = kInvalid;
        root.is_leaf = false;
        nodes_.push_back(std::move(root));
    }

    HierarchicalScheduler(const HierarchicalScheduler&) = delete;
    HierarchicalScheduler& operator=(const HierarchicalScheduler&) = delete;
    HierarchicalScheduler(HierarchicalScheduler&&) = default;
    HierarchicalScheduler& operator=(HierarchicalScheduler&&) = default;

    // Reserve storage for node ids.  Useful for allocation-free steady state.
    void reserve_nodes(std::size_t count) {
        nodes_.reserve(count + 1);
    }

    NodeId add_group(NodeId parent, Weight weight,
                     std::optional<TokenBucketConfig> shaper = std::nullopt) {
        return add_node(parent, false, weight, shaper);
    }

    NodeId add_queue(NodeId parent, Weight weight,
                     std::optional<TokenBucketConfig> shaper = std::nullopt) {
        return add_node(parent, true, weight, shaper);
    }

    // A weight change is applied to the pending head packet and all later
    // packets.  The node's accumulated virtual finish position is preserved.
    bool set_weight(NodeId id, Weight weight) {
        if (!valid_node(id) || id == kRoot || weight == 0) {
            return false;
        }
        Node& node = nodes_[id];
        node.weight = weight;
        node.tag_valid = false;
        return true;
    }

    // Installing/replacing a shaper starts a full bucket.  Passing nullopt
    // removes shaping.  Re-applying an identical configuration is a no-op so
    // that it does not accidentally refill a running bucket.
    bool set_shaper(NodeId id, std::optional<TokenBucketConfig> shaper) {
        if (!valid_node(id)) {
            return false;
        }
        Node& node = nodes_[id];
        if (!shaper) {
            node.shaper.reset();
            return true;
        }
        if (!valid_shaper(*shaper)) {
            return false;
        }
        if (node.shaper && node.shaper->rate_bytes_per_sec == shaper->rate_bytes_per_sec &&
            node.shaper->burst_bytes == shaper->burst_bytes) {
            return true;
        }
        node.shaper = TokenBucket(*shaper);
        return true;
    }

    // now is part of the API so callers can use one monotonic clock for both
    // arrival and release events.  Tags themselves are based on service order,
    // not on wall-clock arrival spacing.
    bool enqueue(NodeId queue, Packet packet, SchedulerTime now) {
        (void)now;
        if (!valid_node(queue) || !nodes_[queue].is_leaf || packet.bytes == 0) {
            return false;
        }

        Node& leaf = nodes_[queue];
        const bool was_empty = leaf.backlog == 0;
        leaf.packets.push_back(QueuedPacket{packet, next_sequence_++});
        ++leaf.backlog;
        if (was_empty) {
            leaf.activation_pending = true;
        }

        bool propagating = was_empty;
        NodeId child = queue;
        while (nodes_[child].parent != kInvalid) {
            Node& parent = nodes_[nodes_[child].parent];
            const bool parent_was_empty = parent.backlog == 0;
            ++parent.backlog;
            if (propagating && parent_was_empty) {
                parent.activation_pending = true;
            } else {
                propagating = false;
            }
            child = nodes_[child].parent;
        }
        return true;
    }

    std::optional<Packet> dequeue(SchedulerTime now) {
        auto selected = dequeue_selected(now);
        if (!selected) {
            return std::nullopt;
        }
        return selected->packet;
    }

    std::optional<SelectedPacket> dequeue_selected(SchedulerTime now) {
        Selection selection;
        if (!select_node(kRoot, now, selection)) {
            return std::nullopt;
        }
        QueuedPacket packet = selection.packet;
        commit_selection(selection, now);
        return SelectedPacket{packet.packet, selection.leaf};
    }

    // Inspect the packet that dequeue(now) would return, without consuming a
    // packet or tokens.  This may refresh time-based token counters and tag
    // caches.
    std::optional<SelectedPacket> peek(SchedulerTime now) {
        Selection selection;
        if (!select_node(kRoot, now, selection)) {
            return std::nullopt;
        }
        return SelectedPacket{selection.packet.packet, selection.leaf};
    }

    // Earliest time at which dequeue(t) can return a packet for the current
    // backlog, accounting for WFQ order and every token bucket.  Returns
    // nullopt if there is no packet, or if the WFQ head is larger than a
    // bucket's burst capacity (it can never pass).  This lets a discrete-event
    // driver jump directly to the next shaping event instead of polling.
    std::optional<SchedulerTime> next_ready_time(SchedulerTime now) {
        std::vector<SchedulerTime>& candidates = ready_candidates_;
        candidates.clear();
        candidates.push_back(now);
        bool have_packet = false;
        for (std::size_t index = 0; index < nodes_.size(); ++index) {
            const NodeId id = static_cast<NodeId>(index);
            const Node& leaf = nodes_[id];
            if (!leaf.is_leaf || leaf.packets.empty()) {
                continue;
            }
            have_packet = true;
            const PacketBytes bytes = leaf.packets.front().packet.bytes;
            NodeId current = id;
            while (current != kInvalid) {
                const Node& node = nodes_[current];
                if (node.shaper) {
                    const auto ready = node.shaper->ready_at(now, bytes);
                    if (ready) {
                        candidates.push_back(std::max(now, *ready));
                    }
                }
                current = node.parent;
            }
        }
        if (!have_packet) {
            return std::nullopt;
        }

        std::sort(candidates.begin(), candidates.end());
        candidates.erase(std::unique(candidates.begin(), candidates.end()),
                         candidates.end());
        for (const SchedulerTime candidate : candidates) {
            Selection selection;
            if (select_node(kRoot, candidate, selection)) {
                return candidate;
            }
        }
        return std::nullopt;
    }

    bool empty() const { return nodes_[kRoot].backlog == 0; }

    std::uint64_t backlog_packets() const { return nodes_[kRoot].backlog; }

    std::uint64_t backlog_packets(NodeId id) const {
        return valid_node(id) ? nodes_[id].backlog : 0;
    }

    bool is_leaf(NodeId id) const {
        return valid_node(id) && nodes_[id].is_leaf;
    }

    bool valid_node_id(NodeId id) const { return valid_node(id); }

private:
    static constexpr std::uint64_t kTokenScale = 1'000'000'000ULL;
    static constexpr std::uint64_t kTagScale = 1'000'000ULL;

    struct QueuedPacket {
        Packet packet{};
        std::uint64_t sequence{};
    };

    struct TokenBucket {
        std::uint64_t rate_bytes_per_sec{};
        std::uint64_t burst_bytes{};
        std::uint64_t tokens{};
        SchedulerTime last{};
        bool initialized{};

        explicit TokenBucket(TokenBucketConfig config)
            : rate_bytes_per_sec(config.rate_bytes_per_sec),
              burst_bytes(config.burst_bytes) {}

        std::uint64_t capacity() const {
            return burst_bytes * kTokenScale;
        }

        void initialize(SchedulerTime now) {
            if (!initialized) {
                tokens = capacity();
                last = now;
                initialized = true;
            }
        }

        void refill(SchedulerTime now) {
            initialize(now);
            if (now <= last) {
                return;
            }
            const std::uint64_t elapsed = static_cast<std::uint64_t>(now - last);
            const std::uint64_t room = capacity() - tokens;
            if (room == 0) {
                last = now;
                return;
            }
            const std::uint64_t needed_elapsed = ceil_div(room, rate_bytes_per_sec);
            if (elapsed >= needed_elapsed) {
                tokens = capacity();
            } else {
                tokens += rate_bytes_per_sec * elapsed;
            }
            last = now;
        }

        std::uint64_t available(SchedulerTime now) const {
            if (!initialized) {
                return capacity();
            }
            if (now <= last) {
                return tokens;
            }
            const std::uint64_t elapsed = static_cast<std::uint64_t>(now - last);
            const std::uint64_t room = capacity() - tokens;
            if (room == 0) {
                return tokens;
            }
            const std::uint64_t needed_elapsed = ceil_div(room, rate_bytes_per_sec);
            if (elapsed >= needed_elapsed) {
                return capacity();
            }
            return tokens + rate_bytes_per_sec * elapsed;
        }

        bool can_cover(SchedulerTime now, PacketBytes bytes) const {
            return available(now) >= need_tokens(bytes);
        }

        bool consume(SchedulerTime now, PacketBytes bytes) {
            refill(now);
            const std::uint64_t need = need_tokens(bytes);
            if (tokens < need) {
                return false;
            }
            tokens -= need;
            return true;
        }

        std::optional<SchedulerTime> ready_at(SchedulerTime now, PacketBytes bytes) const {
            const std::uint64_t need = need_tokens(bytes);
            const std::uint64_t available_now = available(now);
            if (need <= available_now) {
                return now;
            }
            if (bytes > burst_bytes) {
                return std::nullopt;
            }
            const std::uint64_t deficit = need - available_now;
            const std::uint64_t wait = ceil_div(deficit, rate_bytes_per_sec);
            const SchedulerTime base = std::max(now, last);
            const SchedulerTime max_time = std::numeric_limits<SchedulerTime>::max();
            if (wait > static_cast<std::uint64_t>(max_time - base)) {
                return std::nullopt;
            }
            return base + static_cast<SchedulerTime>(wait);
        }

        static std::uint64_t need_tokens(PacketBytes bytes) {
            return static_cast<std::uint64_t>(bytes) * kTokenScale;
        }

        static std::uint64_t ceil_div(std::uint64_t value, std::uint64_t divisor) {
            return value / divisor + (value % divisor != 0 ? 1 : 0);
        }
    };

    struct Node {
        NodeId parent{kInvalid};
        bool is_leaf{false};
        Weight weight{1};
        std::optional<TokenBucket> shaper;
        std::vector<NodeId> children;
        std::deque<QueuedPacket> packets;
        std::uint64_t backlog{};

        // Virtual clock of this group as a parent.
        std::int64_t virtual_time{};

        // State of this node as a child of parent.
        std::int64_t last_finish{};
        std::int64_t tag_start{};
        std::int64_t tag_finish{};
        std::uint64_t tag_sequence{};
        Weight tag_weight{};
        bool tag_valid{};
        bool activation_pending{};
    };

    struct Selection {
        NodeId leaf{kInvalid};
        QueuedPacket packet{};
    };

    struct Candidate {
        NodeId child{kInvalid};
        Selection selection{};
        std::int64_t finish{};
        std::uint64_t sequence{};
    };

    struct Tag {
        std::int64_t start{};
        std::int64_t finish{};
    };

    std::vector<Node> nodes_;
    std::vector<SchedulerTime> ready_candidates_;
    std::uint64_t next_sequence_{};

    bool valid_node(NodeId id) const { return id < nodes_.size(); }

    static bool valid_shaper(const TokenBucketConfig& config) {
        if (config.rate_bytes_per_sec == 0 || config.burst_bytes == 0) {
            return false;
        }
        constexpr std::uint64_t max_burst =
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) /
            kTokenScale;
        return config.burst_bytes <= max_burst;
    }

    NodeId add_node(NodeId parent, bool leaf, Weight weight,
                    std::optional<TokenBucketConfig> shaper) {
        if (!valid_node(parent) || nodes_[parent].is_leaf || weight == 0) {
            return kInvalid;
        }
        if (nodes_.size() >= static_cast<std::size_t>(kInvalid)) {
            return kInvalid;
        }
        if (shaper && !valid_shaper(*shaper)) {
            return kInvalid;
        }

        Node node;
        node.parent = parent;
        node.is_leaf = leaf;
        node.weight = weight;
        if (shaper) {
            node.shaper = TokenBucket(*shaper);
        }
        nodes_.push_back(std::move(node));
        const NodeId id = static_cast<NodeId>(nodes_.size() - 1);
        nodes_[parent].children.push_back(id);
        return id;
    }

    static std::int64_t virtual_delta(PacketBytes bytes, Weight weight) {
        const std::uint64_t scaled = static_cast<std::uint64_t>(bytes) * kTagScale;
        const std::uint64_t delta = scaled / weight + (scaled % weight != 0 ? 1 : 0);
        return static_cast<std::int64_t>(std::max<std::uint64_t>(delta, 1));
    }

    Tag ensure_tag(NodeId id, const QueuedPacket& head) {
        Node& node = nodes_[id];
        assert(node.parent != kInvalid);
        Node& parent = nodes_[node.parent];

        if (node.activation_pending) {
            // The crucial idle-recovery clamp.  last_finish may be stale from
            // before the node emptied; it may never be behind the parent's
            // virtual time on reactivation.
            node.last_finish = std::max(node.last_finish, parent.virtual_time);
            node.activation_pending = false;
            node.tag_valid = false;
        }

        if (!node.tag_valid || node.tag_sequence != head.sequence ||
            node.tag_weight != node.weight) {
            node.tag_start = node.last_finish;
            const std::int64_t delta = virtual_delta(head.packet.bytes, node.weight);
            const std::int64_t max_tag = std::numeric_limits<std::int64_t>::max();
            if (delta > 0 && node.tag_start > max_tag - delta) {
                node.tag_finish = max_tag;
            } else {
                node.tag_finish = node.tag_start + delta;
            }
            node.tag_sequence = head.sequence;
            node.tag_weight = node.weight;
            node.tag_valid = true;
        }
        return Tag{node.tag_start, node.tag_finish};
    }

    bool select_node(NodeId id, SchedulerTime now, Selection& out) {
        Node& node = nodes_[id];
        if (node.is_leaf) {
            if (node.packets.empty()) {
                return false;
            }
            const QueuedPacket& head = node.packets.front();
            if (node.shaper && !node.shaper->can_cover(now, head.packet.bytes)) {
                return false;
            }
            out = Selection{id, head};
            return true;
        }

        if (node.backlog == 0) {
            return false;
        }

        std::optional<Candidate> best;
        for (const NodeId child_id : node.children) {
            Selection child_selection;
            if (!select_node(child_id, now, child_selection)) {
                continue;
            }
            const Tag tag = ensure_tag(child_id, child_selection.packet);
            Candidate candidate{child_id, child_selection, tag.finish,
                                child_selection.packet.sequence};
            if (!best || better(candidate, *best)) {
                best = candidate;
            }
        }
        if (!best) {
            return false;
        }
        if (node.shaper &&
            !node.shaper->can_cover(now, best->selection.packet.packet.bytes)) {
            return false;
        }
        out = best->selection;
        return true;
    }

    static bool better(const Candidate& lhs, const Candidate& rhs) {
        if (lhs.finish != rhs.finish) {
            return lhs.finish < rhs.finish;
        }
        if (lhs.sequence != rhs.sequence) {
            return lhs.sequence < rhs.sequence;
        }
        return lhs.child < rhs.child;
    }

    void commit_selection(const Selection& selection, SchedulerTime now) {
        const QueuedPacket packet = selection.packet;
        NodeId current = selection.leaf;

        while (true) {
            Node& node = nodes_[current];
            if (node.shaper) {
                const bool consumed = node.shaper->consume(now, packet.packet.bytes);
                assert(consumed);
                (void)consumed;
            }
            if (node.parent == kInvalid) {
                break;
            }
            assert(node.tag_valid && node.tag_sequence == packet.sequence);
            node.last_finish = node.tag_finish;
            Node& parent = nodes_[node.parent];
            parent.virtual_time = std::max(parent.virtual_time, node.tag_start);
            node.tag_valid = false;
            current = node.parent;
        }

        Node& leaf = nodes_[selection.leaf];
        assert(!leaf.packets.empty() && leaf.packets.front().sequence == packet.sequence);
        leaf.packets.pop_front();

        current = selection.leaf;
        while (current != kInvalid) {
            Node& node = nodes_[current];
            assert(node.backlog > 0);
            --node.backlog;
            current = node.parent;
        }
    }
};

using Scheduler = HierarchicalScheduler;

}  // namespace dlks

// Compatibility namespace used by the original embedding stub.
namespace dlks_formal {
using dlks::HierarchicalScheduler;
using dlks::Packet;
using dlks::PacketBytes;
using dlks::Scheduler;
using dlks::SchedulerTime;
using dlks::TokenBucketConfig;
using dlks::Weight;
}  // namespace dlks_formal
