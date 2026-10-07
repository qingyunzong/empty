#pragma once

#include <cstddef>
#include <memory>
#include <mutex>
#include <vector>

#include "spatial/snapshot.hpp"

namespace spatial {

// Reclaims retired snapshots at quiescent barriers.
//
// Retired snapshots stay allocated (and queryable) until reclaim_barrier()
// is called. The caller must invoke reclaim_barrier() only at a point where
// every participating thread is known to have passed a quiescent state
// (e.g. right after all threads rendezvous on a std::barrier), so no thread
// can still be acquiring references to anything retired before the barrier.
// Readers that already hold a shared_ptr keep their snapshot alive past
// reclamation; reclamation only drops the reclaimer's own reference.
class Reclaimer {
public:
    void retire(std::shared_ptr<const Snapshot> snap) {
        if (!snap) return;
        std::lock_guard lk(mu_);
        retired_.push_back(std::move(snap));
    }

    void reclaim_barrier() {
        std::vector<std::shared_ptr<const Snapshot>> dead;
        {
            std::lock_guard lk(mu_);
            dead.swap(retired_);
        }
        // `dead` destroyed here, outside the lock.
    }

    std::size_t retired_count() const {
        std::lock_guard lk(mu_);
        return retired_.size();
    }

private:
    mutable std::mutex mu_;
    std::vector<std::shared_ptr<const Snapshot>> retired_;
};

}  // namespace spatial
