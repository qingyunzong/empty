#pragma once

#include "tilelib/tile.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <optional>
#include <unordered_map>
#include <vector>

namespace tilelib {

struct CacheStats {
    std::uint64_t current_generation = 0;
    std::size_t current_bytes = 0;   // live bytes, current-generation pool
    std::size_t stale_bytes = 0;     // live bytes, stale (same-version) pool
    std::size_t current_count = 0;
    std::size_t stale_count = 0;
    std::uint64_t admitted_bytes = 0; // cumulative admitted
    std::uint64_t evicted_bytes = 0;  // cumulative evicted
    std::uint64_t evicted_count = 0;
    std::uint64_t rejected_count = 0;

    // Byte-budget conservation: every admitted byte is either still live in
    // one of the two pools or has been evicted. Nothing leaks, nothing
    // double-counts.
    bool conserved() const {
        return admitted_bytes ==
               static_cast<std::uint64_t>(current_bytes + stale_bytes) + evicted_bytes;
    }
};

class TileCache {
public:
    using EvictCallback = std::function<void(const Tile&)>;

    TileCache(std::size_t current_budget, std::size_t stale_budget)
        : current_budget_(current_budget), stale_budget_(stale_budget) {}

    std::uint64_t generation() const { return stats_.current_generation; }
    std::size_t current_budget() const { return current_budget_; }
    std::size_t stale_budget() const { return stale_budget_; }

    // Advance to a new viewport generation. Live tiles of the old generation
    // are demoted into the stale (same-version) pool, which is then trimmed
    // to its own budget. The new generation's required capacity starts empty
    // and is never charged for old-generation bytes.
    void set_generation(std::uint64_t gen) {
        if (gen == stats_.current_generation && current_.map.empty() && stale_.map.empty())
            return;
        for (auto& t : current_.lru) stale_.lru.push_front(std::move(t));
        stale_.bytes += current_.bytes;
        stale_.count += current_.count;
        current_.lru.clear();
        current_.map.clear();
        current_.bytes = 0;
        current_.count = 0;
        stale_.rebuild_index();
        trim(stale_, stale_budget_);
        stats_.current_generation = gen;
        sync_stats();
    }

    // Insert routes by the tile's own generation stamp: current-generation
    // tiles occupy the required capacity; late tiles from an older viewport
    // generation fall into the same-version stale pool only.
    bool insert(Tile t) {
        const bool late = t.generation != stats_.current_generation;
        Pool& pool = late ? stale_ : current_;
        const std::size_t budget = late ? stale_budget_ : current_budget_;
        const std::size_t bytes = t.bytes.size();
        if (bytes > budget) {
            ++stats_.rejected_count;
            evidence_.push_back({EvidenceKind::Reject, t.id, t.generation, bytes,
                                 "tile exceeds pool budget"});
            return false;
        }
        if (auto it = pool.map.find(t.id); it != pool.map.end()) {
            pool.bytes -= it->second->bytes.size();
            stats_.evicted_bytes += it->second->bytes.size();
            ++stats_.evicted_count;
            evidence_.push_back({EvidenceKind::Evict, it->second->id,
                                 it->second->generation, it->second->bytes.size(),
                                 "superseded by re-insert"});
            notify(*it->second);
            pool.lru.erase(it->second);
            pool.map.erase(it);
            --pool.count;
        }
        trim(pool, budget - bytes);
        pool.lru.push_front(std::move(t));
        pool.map[pool.lru.front().id] = pool.lru.begin();
        pool.bytes += bytes;
        ++pool.count;
        stats_.admitted_bytes += bytes;
        evidence_.push_back({late ? EvidenceKind::LateAdmit : EvidenceKind::Admit,
                             pool.lru.front().id, pool.lru.front().generation, bytes,
                             late ? "late result confined to same-version cache"
                                  : "admitted to required capacity"});
        sync_stats();
        return true;
    }

    const Tile* peek(TileId id) const {
        if (auto it = current_.map.find(id); it != current_.map.end()) return &*it->second;
        if (auto it = stale_.map.find(id); it != stale_.map.end()) return &*it->second;
        return nullptr;
    }

    // Resolve each wanted tile. Exact hits serve directly; a missing tile may
    // be temporarily substituted by its nearest cached ancestor, in which case
    // the slot is flagged approximate (precision-deficient).
    struct RenderSlot {
        TileId wanted;
        TileId used;
        Source source = Source::Network;
        bool approximate = false; // true => precision-deficient substitution
    };

    std::vector<RenderSlot> render_set(const std::vector<TileId>& wanted) const {
        std::vector<RenderSlot> out;
        out.reserve(wanted.size());
        for (const TileId& w : wanted) {
            RenderSlot slot;
            slot.wanted = w;
            if (const Tile* exact = peek(w)) {
                slot.used = w;
                slot.source = exact->source;
                slot.approximate = false;
            } else {
                slot.used = w;
                slot.source = Source::ParentSubstitute;
                slot.approximate = true;
                for (auto p = w.parent(); p; p = p->parent()) {
                    if (peek(*p)) { slot.used = *p; break; }
                }
            }
            out.push_back(slot);
        }
        return out;
    }

    const CacheStats& stats() const { return stats_; }
    const std::vector<Evidence>& evidence() const { return evidence_; }

    void set_evict_callback(EvictCallback cb) { on_evict_ = std::move(cb); }

private:
    struct Pool {
        std::list<Tile> lru; // front = most recently admitted
        std::unordered_map<TileId, typename std::list<Tile>::iterator, TileIdHash> map;
        std::size_t bytes = 0;
        std::size_t count = 0;

        void rebuild_index() {
            map.clear();
            for (auto it = lru.begin(); it != lru.end(); ++it) map[it->id] = it;
        }
    };

    void trim(Pool& pool, std::size_t budget) {
        while (pool.bytes > budget && !pool.lru.empty()) {
            Tile& victim = pool.lru.back();
            stats_.evicted_bytes += victim.bytes.size();
            ++stats_.evicted_count;
            evidence_.push_back({EvidenceKind::Evict, victim.id, victim.generation,
                                 victim.bytes.size(), "lru trim to budget"});
            notify(victim);
            pool.bytes -= victim.bytes.size();
            pool.map.erase(victim.id);
            pool.lru.pop_back();
            --pool.count;
        }
    }

    void notify(const Tile& t) {
        if (on_evict_) on_evict_(t);
    }

    void sync_stats() {
        stats_.current_bytes = current_.bytes;
        stats_.stale_bytes = stale_.bytes;
        stats_.current_count = current_.count;
        stats_.stale_count = stale_.count;
    }

    std::size_t current_budget_;
    std::size_t stale_budget_;
    Pool current_;
    Pool stale_;
    CacheStats stats_;
    std::vector<Evidence> evidence_;
    EvictCallback on_evict_;
};

} // namespace tilelib
