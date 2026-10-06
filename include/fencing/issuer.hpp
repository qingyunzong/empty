#pragma once

#include "events.hpp"
#include "types.hpp"

#include <optional>
#include <unordered_map>

namespace fencing {

// Grants monotonically increasing fence tokens, one active lease at a time.
// A new lease is only granted once the previous one has expired; expiry is
// recorded as evidence but never revokes already-accepted storage writes.
class TokenIssuer {
public:
  struct LeaseInfo {
    HolderId holder;
    Time granted_at;
    Time expires_at;
  };

  // Returns the new token, or std::nullopt if the current lease is still valid.
  std::optional<Token> grant(HolderId holder, Time now, Duration ttl, Trace& trace) {
    if (current_ && now < current_->expires_at) {
      return std::nullopt;
    }
    if (current_ && !expiry_recorded_) {
      trace.record(LeaseExpired{current_->holder, last_token_, current_->expires_at});
      expiry_recorded_ = true;
    }
    const Token token = ++last_token_;
    current_ = LeaseInfo{holder, now, now + ttl};
    leases_.emplace(token, *current_);
    expiry_recorded_ = false;
    trace.record(LeaseGranted{holder, token, now, current_->expires_at});
    return token;
  }

  // Explicitly record expiry of the current lease once now >= expires_at.
  bool expire_current(Time now, Trace& trace) {
    if (!current_ || now < current_->expires_at || expiry_recorded_) {
      return false;
    }
    trace.record(LeaseExpired{current_->holder, last_token_, current_->expires_at});
    expiry_recorded_ = true;
    return true;
  }

  std::optional<LeaseInfo> lease_of(Token token) const {
    auto it = leases_.find(token);
    if (it == leases_.end()) return std::nullopt;
    return it->second;
  }

  bool lease_valid_at(Token token, Time now) const {
    auto lease = lease_of(token);
    return lease && now < lease->expires_at;
  }

  Token last_token() const { return last_token_; }

private:
  Token last_token_ = kNoToken;
  std::optional<LeaseInfo> current_;
  std::unordered_map<Token, LeaseInfo> leases_;
  bool expiry_recorded_ = true;
};

} // namespace fencing
