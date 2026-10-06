#pragma once

// Bounded fault-trace explorer.
//
// Each holder runs a two-step program: Acquire a lease, then Write with the
// acquired token. Faults are modeled as scheduling delays: the logical clock
// may tick between any two steps, so a holder's write can land after its
// lease expired and after another holder acquired a newer token and wrote.
// The explorer enumerates all interleavings of holder steps and clock ticks
// up to a time bound, and checks the fencing invariant on every state.

#include "fence.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fencesim {

struct ExploreConfig {
    Tick lease_duration = 5;
    Tick max_time = 12;
    int holders = 2;
};

struct ExploreResult {
    std::uint64_t traces = 0;           // completed schedules (all holders done)
    std::uint64_t states = 0;           // visited states
    std::uint64_t accepted_writes = 0;  // accepted write events across all traces
    std::uint64_t rejected_writes = 0;  // rejected write events across all traces
    std::uint64_t stale_rejections = 0; // rejected writes whose lease had expired
    bool invariant_ok = true;
    std::string first_violation;
};

struct SimState {
    Tick now = 0;
    FenceService service;
    Storage storage;
    std::vector<int> pc;     // 0 = must acquire, 1 = must write, 2 = done
    std::vector<Token> held; // token held by each holder (valid once pc >= 1)

    explicit SimState(const ExploreConfig& cfg)
        : service(cfg.lease_duration), pc(cfg.holders, 0), held(cfg.holders, 0) {}
};

// Fencing invariant over the storage evidence log:
//  1. accepted tokens are non-decreasing (a stale token is never accepted
//     after a newer one);
//  2. a write is rejected only when its token is below the highest accepted;
//  3. the final stored value is the payload of the last accepted write;
//  4. every write token was actually granted to the writing holder.
inline bool check_invariant(const FenceService& service, const Storage& storage,
                            std::string& why) {
    Token highest = 0;
    bool has = false;
    const WriteRecord* last_accepted = nullptr;
    for (const auto& r : storage.log()) {
        bool granted_to_holder = false;
        for (const auto& g : service.grants()) {
            if (g.token == r.token && g.holder == r.holder) granted_to_holder = true;
        }
        if (!granted_to_holder) {
            why = "write with token never granted to that holder";
            return false;
        }
        if (r.accepted) {
            if (has && r.token < highest) {
                why = "accepted token decreased below previously accepted token";
                return false;
            }
            highest = r.token;
            has = true;
            last_accepted = &r;
        } else if (has && r.token >= highest) {
            why = "write rejected although token >= highest accepted token";
            return false;
        }
    }
    if (has && storage.value() != last_accepted->value) {
        why = "stored value does not match the highest-token accepted write";
        return false;
    }
    return true;
}

namespace detail {

inline void dfs(SimState state, const ExploreConfig& cfg, ExploreResult& res) {
    ++res.states;
    std::string why;
    if (!check_invariant(state.service, state.storage, why)) {
        res.invariant_ok = false;
        if (res.first_violation.empty()) res.first_violation = why;
        return;
    }

    bool any_pending = false;
    for (int h = 0; h < cfg.holders; ++h) {
        if (state.pc[h] >= 2) continue;
        any_pending = true;
        if (state.pc[h] == 0) {
            SimState next = state;
            next.held[h] = next.service.grant(h, next.now);
            next.pc[h] = 1;
            dfs(std::move(next), cfg, res);
        } else {
            SimState next = state;
            std::string payload =
                "h" + std::to_string(h) + "/t" + std::to_string(next.held[h]);
            bool accepted = next.storage.write(next.held[h], h, next.now, payload);
            if (accepted) {
                ++res.accepted_writes;
            } else {
                ++res.rejected_writes;
                if (!next.service.lease_valid(next.held[h], next.now))
                    ++res.stale_rejections;
            }
            next.pc[h] = 2;
            dfs(std::move(next), cfg, res);
        }
    }

    // Fault injection: let the clock advance while holders are still pending,
    // so leases can expire mid-schedule.
    if (any_pending && state.now < cfg.max_time) {
        SimState next = state;
        ++next.now;
        dfs(std::move(next), cfg, res);
    }

    if (!any_pending) ++res.traces;
}

} // namespace detail

inline ExploreResult explore(const ExploreConfig& cfg) {
    ExploreResult res;
    detail::dfs(SimState(cfg), cfg, res);
    return res;
}

} // namespace fencesim
