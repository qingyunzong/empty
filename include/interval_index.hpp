#pragma once

// interval_index: single-writer / multi-reader interval index.
//
// Design:
//  - Immutable treap of disjoint, coalesced segments [lo, hi) -> Val.
//  - All updates are persistent (path-copying): old versions keep their nodes.
//  - The root is published atomically (std::atomic<std::shared_ptr<const node>>).
//  - Reclamation is plain shared_ptr refcounting: a node is destroyed only when
//    neither the current root nor any reader snapshot references it. Readers
//    holding a snapshot are therefore never affected by node reclamation.
//
// Combination order (explicit):
//  - Ops inside one batch apply sequentially in submission order.
//  - assign [l,r) v: overwrites whatever is there (including earlier adds).
//  - add    [l,r) d: accumulates onto the current value; absent == Val{} (zero),
//    so add materializes segments over gaps.
//  - erase  [l,r)  : removes coverage.
//  - Batches are published atomically: readers see either the whole old batch
//    or the whole new batch, never a mix.

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>
#include <vector>

namespace iix {

template <typename Key, typename Val>
class interval_index {
    static_assert(std::is_integral_v<Key>, "Key must be an integral type");

public:
    struct node {
        Key lo, hi;  // half-open [lo, hi)
        Val val;
        std::uint64_t prio;
        std::shared_ptr<const node> left;
        std::shared_ptr<const node> right;
    };
    using node_ptr = std::shared_ptr<const node>;
    // Factory lets tests install instrumented (e.g. poisoning) deleters.
    using node_factory = std::function<node_ptr(node)>;

    enum class op_kind { assign, add, erase };
    struct op {
        op_kind kind;
        Key lo, hi;
        Val val{};
        static op assign(Key lo, Key hi, Val v) { return {op_kind::assign, lo, hi, std::move(v)}; }
        static op add(Key lo, Key hi, Val v) { return {op_kind::add, lo, hi, std::move(v)}; }
        static op erase(Key lo, Key hi) { return {op_kind::erase, lo, hi, Val{}}; }
    };

    class snapshot {
    public:
        struct segment {
            Key lo, hi;
            Val val;
            bool operator==(const segment&) const = default;
        };

        snapshot() = default;

        std::optional<Val> query(Key p) const {
            const node* cur = root_.get();
            while (cur) {
                if (p < cur->lo) {
                    cur = cur->left.get();
                } else if (p >= cur->hi) {
                    cur = cur->right.get();
                } else {
                    return cur->val;
                }
            }
            return std::nullopt;
        }

        // In-order visit: segments are sorted, disjoint, and adjacent segments
        // never carry equal values (canonical form).
        template <typename F>
        void for_each(F&& f) const {
            visit(root_, f);
        }

        std::vector<segment> segments() const {
            std::vector<segment> out;
            for_each([&](Key lo, Key hi, const Val& v) { out.push_back({lo, hi, v}); });
            return out;
        }

        std::size_t node_count() const {
            std::size_t n = 0;
            for_each([&](Key, Key, const Val&) { ++n; });
            return n;
        }

    private:
        friend class interval_index;
        explicit snapshot(node_ptr root) : root_(std::move(root)) {}

        template <typename F>
        static void visit(const node_ptr& t, F& f) {
            if (!t) return;
            visit(t->left, f);
            f(t->lo, t->hi, t->val);
            visit(t->right, f);
        }

        node_ptr root_;
    };

    interval_index() : factory_(default_factory) {}
    explicit interval_index(node_factory factory) : factory_(std::move(factory)) {}

    // Reader side: atomic load of the published root. The returned snapshot
    // keeps every node of its version alive for as long as it exists.
    snapshot get_snapshot() const { return snapshot(root_.load()); }

    // Writer side (single writer; a mutex only guards against accidental
    // concurrent writers). Applies ops in order, then publishes the new root
    // with one atomic store.
    void apply_batch(const std::vector<op>& ops) {
        std::lock_guard<std::mutex> lk(write_mu_);
        node_ptr cur = root_.load();
        for (const op& o : ops) {
            if (o.lo >= o.hi) continue;  // empty range: no-op
            switch (o.kind) {
                case op_kind::assign: cur = set_range(std::move(cur), o.lo, o.hi, o.val); break;
                case op_kind::add: cur = add_range(std::move(cur), o.lo, o.hi, o.val); break;
                case op_kind::erase: cur = set_range(std::move(cur), o.lo, o.hi, std::nullopt); break;
            }
        }
        root_.store(std::move(cur));  // atomic publication of the batch
    }

    std::size_t node_count() const { return get_snapshot().node_count(); }

private:
    static node_ptr default_factory(node n) { return std::make_shared<const node>(std::move(n)); }

    std::uint64_t next_prio() {  // splitmix64; writer thread only
        std::uint64_t z = (rng_ += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
        return z ^ (z >> 31);
    }

    node_ptr make(Key lo, Key hi, const Val& v) {
        return factory_(node{lo, hi, v, next_prio(), nullptr, nullptr});
    }
    node_ptr clone_with(const node& t, node_ptr l, node_ptr r) {
        return factory_(node{t.lo, t.hi, t.val, t.prio, std::move(l), std::move(r)});
    }

    // Persistent split: keys with lo < key go left. Shares untouched subtrees.
    std::pair<node_ptr, node_ptr> split(const node_ptr& t, Key key) {
        if (!t) return {nullptr, nullptr};
        if (key <= t->lo) {
            auto [l, r] = split(t->left, key);
            return {l, clone_with(*t, r, t->right)};
        }
        auto [l, r] = split(t->right, key);
        return {clone_with(*t, t->left, l), r};
    }

    // Persistent merge: all keys in a precede all keys in b.
    node_ptr merge(const node_ptr& a, const node_ptr& b) {
        if (!a) return b;
        if (!b) return a;
        if (a->prio < b->prio) return clone_with(*a, a->left, merge(a->right, b));
        return clone_with(*b, merge(a, b->left), b->right);
    }

    static const node* leftmost(const node_ptr& t) {
        const node* cur = t.get();
        while (cur && cur->left) cur = cur->left.get();
        return cur;
    }
    static const node* rightmost(const node_ptr& t) {
        const node* cur = t.get();
        while (cur && cur->right) cur = cur->right.get();
        return cur;
    }

    // Merge two ordered trees, coalescing the boundary if the adjacent
    // segments touch and carry equal values (keeps canonical form).
    node_ptr merge_coalesced(const node_ptr& a, const node_ptr& b) {
        if (!a || !b) return a ? a : b;
        const node* rm = rightmost(a);
        const node* lf = leftmost(b);
        if (rm->hi == lf->lo && rm->val == lf->val) {
            auto [a1, rm_t] = split(a, rm->lo);        // rm_t holds only rm
            auto [lf_t, b1] = split(b, lf->lo + 1);    // lf_t holds only lf
            (void)rm_t;
            (void)lf_t;
            node_ptr joined = make(rm->lo, lf->hi, rm->val);
            return merge(merge(a1, joined), b1);
        }
        return merge(a, b);
    }

    // Ensure no segment straddles `key`; split the straddler into two.
    node_ptr cut(const node_ptr& t, Key key) {
        auto [a, b] = split(t, key);
        if (!a) return merge(a, b);
        const node* rm = rightmost(a);
        if (rm->hi <= key) return merge(a, b);  // no straddler
        auto [a1, rm_t] = split(a, rm->lo);     // detach rm
        (void)rm_t;
        node_ptr left_part = make(rm->lo, key, rm->val);
        node_ptr right_part = make(key, rm->hi, rm->val);
        return merge(merge(a1, left_part), merge(right_part, b));
    }

    template <typename F>
    static void collect(const node_ptr& t, F& f) {
        if (!t) return;
        collect(t->left, f);
        f(t);
        collect(t->right, f);
    }

    // assign (v has value) or erase (v nullopt) over [l, r).
    node_ptr set_range(node_ptr t, Key l, Key r, std::optional<Val> v) {
        t = cut(t, l);
        t = cut(t, r);
        auto [a, bc] = split(t, l);
        auto [b, c] = split(bc, r);  // b: fully covered by [l, r) -> dropped
        (void)b;
        node_ptr mid = v ? make(l, r, *v) : nullptr;
        return merge_coalesced(merge_coalesced(a, mid), c);
    }

    // add delta over [l, r); absent regions count as Val{} (zero).
    node_ptr add_range(node_ptr t, Key l, Key r, const Val& delta) {
        t = cut(t, l);
        t = cut(t, r);
        auto [a, bc] = split(t, l);
        auto [b, c] = split(bc, r);

        std::vector<const node*> inner;
        auto push = [&](const node_ptr& n) { inner.push_back(n.get()); };
        collect(b, push);

        // Rebuild [l, r) contiguously: existing segments += delta, gaps = delta.
        std::vector<node_ptr> parts;
        Key cur = l;
        auto emit = [&](Key lo, Key hi, const Val& v) {
            if (lo >= hi) return;
            if (!parts.empty()) {
                // coalesce within the rebuilt middle
                const node* prev = parts.back().get();
                // parts.back() is a single node only while size grew by singles;
                // check the true rightmost segment instead.
                prev = rightmost(parts.back());
                if (prev->hi == lo && prev->val == v) {
                    node_ptr joined = make(prev->lo, hi, v);
                    // replace the rightmost segment of the last part
                    auto [keep, dropped] = split(parts.back(), prev->lo);
                    (void)dropped;
                    parts.back() = merge(keep, joined);
                    return;
                }
            }
            parts.push_back(make(lo, hi, v));
        };
        for (const node* n : inner) {
            emit(cur, n->lo, delta);
            emit(n->lo, n->hi, n->val + delta);
            cur = n->hi;
        }
        emit(cur, r, delta);

        node_ptr mid;
        for (const node_ptr& p : parts) mid = merge(mid, p);
        return merge_coalesced(merge_coalesced(a, mid), c);
    }

    std::atomic<node_ptr> root_{nullptr};
    std::mutex write_mu_;
    node_factory factory_;
    std::uint64_t rng_ = 0x243f6a8885a308d3ULL;
};

}  // namespace iix
