#pragma once

#include "events.hpp"
#include "types.hpp"

#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

namespace fencing {

struct VerificationResult {
  std::vector<std::string> violations;
  std::size_t fault_count = 0;

  bool ok() const { return violations.empty(); }
};

// Replays a trace and checks the fencing safety invariants under a bounded
// fault model: the number of faults (lease expirations + holder crashes)
// must not exceed max_faults.
//
// Invariants checked:
//  1. Granted tokens are strictly monotonic and leases are well-formed.
//  2. Every accepted write carries a token granted to that same holder.
//  3. Accepted tokens never decrease (storage fencing rule) — a late write
//     from an old holder must appear as WriteRejected, never WriteAccepted.
//  4. No write is accepted after its lease expired (expiry does not revoke
//     earlier accepted writes, but blocks new ones from that lease).
//  5. StaleToken rejections are genuine: the token is below the max accepted.
//  6. Total faults stay within the bound.
inline VerificationResult verify_bounded_faults(const Trace& trace, std::size_t max_faults) {
  VerificationResult result;
  Token last_granted = kNoToken;
  Token max_accepted = kNoToken;
  std::unordered_map<Token, LeaseGranted> grants;

  auto fail = [&result](std::string msg) { result.violations.push_back(std::move(msg)); };

  for (const auto& event : trace.events) {
    std::visit(
        [&](const auto& e) {
          using T = std::decay_t<decltype(e)>;
          if constexpr (std::is_same_v<T, LeaseGranted>) {
            if (e.token <= last_granted) {
              fail("non-monotonic grant: token " + std::to_string(e.token) +
                   " after " + std::to_string(last_granted));
            }
            if (e.granted_at >= e.expires_at) {
              fail("malformed lease: token " + std::to_string(e.token) +
                   " expires before it is granted");
            }
            last_granted = e.token;
            grants.emplace(e.token, e);
          } else if constexpr (std::is_same_v<T, LeaseExpired>) {
            ++result.fault_count;
            auto it = grants.find(e.token);
            if (it == grants.end()) {
              fail("expiry of never-granted token " + std::to_string(e.token));
            } else if (e.at < it->second.expires_at) {
              fail("token " + std::to_string(e.token) + " expired before its deadline");
            }
          } else if constexpr (std::is_same_v<T, HolderCrashed>) {
            ++result.fault_count;
          } else if constexpr (std::is_same_v<T, WriteAccepted>) {
            auto it = grants.find(e.token);
            if (it == grants.end()) {
              fail("accepted write with ungranted token " + std::to_string(e.token));
            } else {
              if (it->second.holder != e.holder) {
                fail("accepted write from holder " + std::to_string(e.holder) +
                     " with token " + std::to_string(e.token) + " granted to holder " +
                     std::to_string(it->second.holder));
              }
              if (e.at >= it->second.expires_at) {
                fail("accepted write under expired lease, token " +
                     std::to_string(e.token));
              }
            }
            if (e.token < max_accepted) {
              fail("accepted stale token " + std::to_string(e.token) +
                   " below accepted fence " + std::to_string(max_accepted));
            }
            if (e.token > max_accepted) {
              max_accepted = e.token;
            }
          } else if constexpr (std::is_same_v<T, WriteRejected>) {
            if (e.reason == RejectReason::StaleToken && e.token >= max_accepted) {
              fail("token " + std::to_string(e.token) +
                   " rejected as stale though fence is " + std::to_string(max_accepted));
            }
          }
        },
        event);
  }

  if (result.fault_count > max_faults) {
    fail("fault count " + std::to_string(result.fault_count) + " exceeds bound " +
         std::to_string(max_faults));
  }
  return result;
}

} // namespace fencing
