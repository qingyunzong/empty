#pragma once

#include "tilelib/cache.hpp"
#include "tilelib/viewport.hpp"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <unordered_set>
#include <vector>

namespace tilelib {

// Controllable loader: requests are queued per viewport generation and
// completed only when the caller pumps or delivers. The loader acknowledges
// cache evictions and honours explicit cancellation; late completions keep
// their original generation stamp so the cache confines them to the
// same-version pool.
class TileLoader {
public:
    using FetchFn = std::function<std::vector<std::byte>(TileId)>;

    TileLoader(TileCache& cache, FetchFn fetch) : cache_(cache), fetch_(std::move(fetch)) {
        cache_.set_evict_callback([this](const Tile& t) {
            evicted_.push_back(t.id);
            evidence_.push_back({EvidenceKind::Evict, t.id, t.generation,
                                 t.bytes.size(), "loader acknowledged eviction"});
        });
    }

    void set_viewport(const Viewport& v) {
        cache_.set_generation(v.generation);
        generation_ = v.generation;
        for (const TileId& id : required_tiles(v)) {
            if (cache_.peek(id)) continue;
            if (queued_.insert(id).second)
                pending_.push_back({id, v.generation});
        }
    }

    // Cancel a queued request. Cancellation is byte-neutral: nothing was
    // admitted, so the budget conservation invariant is untouched.
    bool cancel(TileId id) {
        for (auto it = pending_.begin(); it != pending_.end(); ++it) {
            if (it->id == id) {
                evidence_.push_back({EvidenceKind::Cancel, id, it->generation, 0,
                                     "cancelled before completion"});
                pending_.erase(it);
                queued_.erase(id);
                ++cancelled_;
                return true;
            }
        }
        return false;
    }

    // Complete up to `max` queued requests, oldest first. Each completion
    // keeps the generation of the viewport that issued it, so a request
    // overtaken by a newer viewport lands in the same-version cache.
    std::size_t pump(std::size_t max = static_cast<std::size_t>(-1)) {
        std::size_t done = 0;
        while (!pending_.empty() && done < max) {
            Request req = pending_.front();
            pending_.pop_front();
            queued_.erase(req.id);
            cache_.insert(Tile{req.id, req.generation, Source::Network, fetch_(req.id)});
            ++done;
        }
        return done;
    }

    // Simulate an asynchronous late arrival from a source (e.g. a reply that
    // raced a viewport switch or arrived after cancellation).
    void deliver_late(TileId id, std::uint64_t generation, std::vector<std::byte> bytes,
                      Source source = Source::Network) {
        if (generation == generation_ && !queued_.contains(id) && !cache_.peek(id)) {
            // Cancelled or never requested in this generation: drop it.
            evidence_.push_back({EvidenceKind::Cancel, id, generation, bytes.size(),
                                 "late delivery dropped (not outstanding)"});
            return;
        }
        cache_.insert(Tile{id, generation, source, std::move(bytes)});
    }

    std::size_t pending_count() const { return pending_.size(); }
    std::uint64_t cancelled_count() const { return cancelled_; }
    const std::vector<TileId>& evicted() const { return evicted_; }
    const std::vector<Evidence>& evidence() const { return evidence_; }

private:
    struct Request {
        TileId id;
        std::uint64_t generation;
    };

    TileCache& cache_;
    FetchFn fetch_;
    std::uint64_t generation_ = 0;
    std::deque<Request> pending_;
    std::unordered_set<TileId, TileIdHash> queued_;
    std::uint64_t cancelled_ = 0;
    std::vector<TileId> evicted_;
    std::vector<Evidence> evidence_;
};

} // namespace tilelib
