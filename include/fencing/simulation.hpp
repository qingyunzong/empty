#pragma once

#include "events.hpp"
#include "issuer.hpp"
#include "storage.hpp"
#include "types.hpp"

#include <optional>
#include <stdexcept>
#include <unordered_set>

namespace fencing {

// Drives issuer + storage under a logical clock, injecting bounded faults
// (lease expirations, holder crashes) and recording all evidence in a Trace.
class Simulation {
public:
  explicit Simulation(Duration lease_ttl) : ttl_(lease_ttl) {}

  std::optional<Token> try_grant_lease(HolderId holder) {
    return issuer_.grant(holder, now_, ttl_, trace_);
  }

  Token grant_lease(HolderId holder) {
    auto token = try_grant_lease(holder);
    if (!token) {
      throw std::logic_error("grant_lease: previous lease still valid");
    }
    return *token;
  }

  // A holder attempts a write. The environment rejects writes from crashed
  // holders, unknown tokens, and expired leases; storage itself enforces the
  // fencing rule (token >= accepted token).
  bool write(HolderId holder, Token token, Value value) {
    if (down_.contains(holder)) {
      trace_.record(WriteRejected{holder, token, value, now_, RejectReason::HolderDown});
      return false;
    }
    auto lease = issuer_.lease_of(token);
    if (!lease) {
      trace_.record(WriteRejected{holder, token, value, now_, RejectReason::NoSuchLease});
      return false;
    }
    if (token < storage_.accepted_token()) {
      // Late write from an old holder: the fencing rule rejects it.
      return storage_.write(holder, token, value, now_, trace_);
    }
    if (now_ >= lease->expires_at) {
      issuer_.expire_current(now_, trace_);
      trace_.record(WriteRejected{holder, token, value, now_, RejectReason::ExpiredLease});
      return false;
    }
    return storage_.write(holder, token, value, now_, trace_);
  }

  void advance(Duration dt) {
    now_ += dt;
    issuer_.expire_current(now_, trace_);
  }

  void crash(HolderId holder) {
    if (down_.insert(holder).second) {
      trace_.record(HolderCrashed{holder, now_});
    }
  }

  void recover(HolderId holder) {
    if (down_.erase(holder) > 0) {
      trace_.record(HolderRecovered{holder, now_});
    }
  }

  Time now() const { return now_; }
  const Trace& trace() const { return trace_; }
  const FencingStorage& storage() const { return storage_; }
  const TokenIssuer& issuer() const { return issuer_; }

private:
  Duration ttl_;
  Time now_ = 0;
  TokenIssuer issuer_;
  FencingStorage storage_;
  Trace trace_;
  std::unordered_set<HolderId> down_;
};

} // namespace fencing
