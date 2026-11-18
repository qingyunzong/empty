#pragma once

// Embeddable extendible-hashing directory for storage engines.
//
// Layout: a directory of 2^global_depth slots, each slot referencing a bucket.
// A key is routed by the low `global_depth` bits of its hash (the addressing
// prefix). When a bucket overflows it is split: its local depth grows by one
// and its entries are re-partitioned -- disjointly and exhaustively -- by the
// next hash bit. If the bucket's local depth equals the global depth, the
// directory doubles first. The global depth never decreases. Once the local
// depth reaches the configured cap, collisions are absorbed by per-bucket
// overflow pages instead of further growth.
//
// Every bucket tracks a reference count: the number of directory slots that
// point to it, always equal to 2^(global_depth - local_depth).

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

namespace dlks_formal {

template <typename Key, typename Value, typename Hash = std::hash<Key>>
class extendible_hash_directory {
    struct page {
        std::vector<std::pair<Key, Value>> entries;
    };

    struct bucket {
        std::size_t id = 0;
        std::size_t local_depth = 0;
        std::size_t refcount = 0; // directory slots pointing at this bucket
        page primary;
        std::vector<page> overflow; // only used at the depth cap
    };

public:
    struct options {
        std::size_t bucket_capacity = 4; // entries per page
        std::size_t max_depth = 20;      // addressing-prefix cap
    };

    struct split_event {
        std::size_t bucket_id;
        std::size_t new_bucket_id;
        std::size_t local_depth;  // of both buckets, after the split
        std::size_t global_depth; // directory depth after the split
        std::size_t kept;         // entries left in the original bucket
        std::size_t moved;        // entries moved to the new bucket
        bool directory_doubled;
    };

    // Witness of the most recent lookup: which slot and bucket were touched.
    struct probe {
        std::size_t dir_index = 0;
        std::size_t bucket_id = 0;
    };

    struct bucket_stats {
        std::size_t id;
        std::size_t local_depth;
        std::size_t refcount;
        std::size_t load;           // entries in primary + overflow pages
        std::size_t overflow_pages; // pages beyond the primary page
    };

    explicit extendible_hash_directory(options opts = {}, Hash hash = Hash{})
        : opts_(opts), hash_(std::move(hash)) {
        if (opts_.bucket_capacity == 0)
            opts_.bucket_capacity = 1;
        const std::size_t depth_limit = 8 * sizeof(std::size_t) - 1;
        if (opts_.max_depth == 0 || opts_.max_depth > depth_limit)
            opts_.max_depth = depth_limit;
        bucket* root = make_bucket(0);
        root->refcount = 1; // the single slot of a depth-0 directory
        directory_.push_back(root);
    }

    extendible_hash_directory(const extendible_hash_directory&) = delete;
    extendible_hash_directory& operator=(const extendible_hash_directory&) = delete;

    // Returns false (leaving state untouched) when the key already exists.
    bool insert(const Key& key, const Value& value) {
        if (find(key) != nullptr)
            return false;
        for (;;) {
            bucket* b = directory_[address_of(key)];
            if (b->primary.entries.size() < opts_.bucket_capacity) {
                b->primary.entries.emplace_back(key, value);
                ++size_;
                return true;
            }
            if (b->local_depth < opts_.max_depth) {
                split(*b);
                continue; // re-route: the key may belong to the twin bucket
            }
            // Depth cap reached: absorb into the overflow chain.
            if (b->overflow.empty() ||
                b->overflow.back().entries.size() >= opts_.bucket_capacity)
                b->overflow.emplace_back();
            b->overflow.back().entries.emplace_back(key, value);
            ++size_;
            return true;
        }
    }

    const Value* find(const Key& key) const {
        const std::size_t idx = address_of(key);
        const bucket* b = directory_[idx];
        last_probe_ = probe{idx, b->id};
        if (const Value* v = find_in(b->primary, key))
            return v;
        for (const page& p : b->overflow)
            if (const Value* v = find_in(p, key))
                return v;
        return nullptr;
    }

    Value* find(const Key& key) {
        return const_cast<Value*>(std::as_const(*this).find(key));
    }

    bool contains(const Key& key) const { return find(key) != nullptr; }

    // ---- introspection (also the verification surface for tests) ----

    const options& config() const { return opts_; }
    std::size_t size() const { return size_; }
    std::size_t global_depth() const { return global_depth_; }
    std::size_t directory_size() const { return directory_.size(); }
    std::size_t bucket_count() const { return buckets_.size(); }

    // Directory slot the key routes to: hash mod 2^global_depth.
    std::size_t directory_index(const Key& key) const { return address_of(key); }
    std::size_t slot_owner(std::size_t slot) const { return directory_.at(slot)->id; }
    probe last_probe() const { return last_probe_; }
    const std::vector<split_event>& split_history() const { return history_; }

    std::vector<bucket_stats> stats() const {
        std::vector<bucket_stats> out;
        out.reserve(buckets_.size());
        for (const auto& b : buckets_) {
            std::size_t load = b->primary.entries.size();
            for (const page& p : b->overflow)
                load += p.entries.size();
            out.push_back(bucket_stats{b->id, b->local_depth, b->refcount, load,
                                       b->overflow.size()});
        }
        return out;
    }

    // All keys physically stored in a bucket (primary page, then overflow).
    std::vector<Key> bucket_keys(std::size_t bucket_id) const {
        const bucket* b = buckets_.at(bucket_id).get();
        std::vector<Key> out;
        for (const auto& [k, v] : b->primary.entries)
            out.push_back(k);
        for (const page& p : b->overflow)
            for (const auto& [k, v] : p.entries)
                out.push_back(k);
        return out;
    }

private:
    bucket* make_bucket(std::size_t local_depth) {
        auto b = std::make_unique<bucket>();
        b->id = buckets_.size();
        b->local_depth = local_depth;
        bucket* raw = b.get();
        buckets_.push_back(std::move(b));
        return raw;
    }

    std::size_t address_of(const Key& key) const {
        return static_cast<std::size_t>(hash_(key)) & (directory_.size() - 1);
    }

    const Value* find_in(const page& p, const Key& key) const {
        for (const auto& [k, v] : p.entries)
            if (k == key)
                return &v;
        return nullptr;
    }

    void double_directory() {
        const std::size_t old = directory_.size();
        directory_.resize(old * 2);
        for (std::size_t i = 0; i < old; ++i) {
            directory_[old + i] = directory_[i];
            ++directory_[i]->refcount; // every bucket gains a mirror slot
        }
        ++global_depth_;
    }

    // Splits `b` (local depth d -> d+1). Exactly the slots whose bit d is set
    // are re-pointed to the new twin; entries are re-partitioned by hash bit d
    // so the two children form a disjoint, exhaustive cover of the parent.
    void split(bucket& b) {
        const bool doubled = (b.local_depth == global_depth_);
        if (doubled)
            double_directory();

        const std::size_t split_bit = b.local_depth;
        const std::size_t mask = std::size_t{1} << split_bit;

        bucket* twin = make_bucket(split_bit + 1);
        b.local_depth = split_bit + 1;

        std::size_t moved_slots = 0;
        for (std::size_t i = 0; i < directory_.size(); ++i) {
            if (directory_[i] == &b && (i & mask) != 0) {
                directory_[i] = twin;
                ++moved_slots;
            }
        }
        twin->refcount = moved_slots;
        b.refcount -= moved_slots;

        // A bucket only splits before the depth cap, so it has no overflow
        // pages and its whole content fits in the primary page.
        auto entries = std::move(b.primary.entries);
        b.primary.entries.clear();
        std::size_t kept = 0;
        std::size_t moved = 0;
        for (auto& e : entries) {
            if ((static_cast<std::size_t>(hash_(e.first)) & mask) != 0) {
                twin->primary.entries.push_back(std::move(e));
                ++moved;
            } else {
                b.primary.entries.push_back(std::move(e));
                ++kept;
            }
        }
        history_.push_back(split_event{b.id, twin->id, b.local_depth,
                                       global_depth_, kept, moved, doubled});
    }

    options opts_;
    Hash hash_;
    std::size_t global_depth_ = 0;
    std::size_t size_ = 0;
    std::vector<bucket*> directory_;
    std::vector<std::unique_ptr<bucket>> buckets_;
    std::vector<split_event> history_;
    mutable probe last_probe_;
};

} // namespace dlks_formal
