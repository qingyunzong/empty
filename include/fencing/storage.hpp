#pragma once

#include "events.hpp"
#include "types.hpp"

#include <optional>

namespace fencing {

// Replicated register guarded by fencing tokens: a write is accepted iff its
// token is not less than the highest token already accepted. Lease expiry
// never rolls back an accepted value.
class FencingStorage {
public:
  bool write(HolderId holder, Token token, Value value, Time now, Trace& trace) {
    if (token < accepted_token_) {
      trace.record(WriteRejected{holder, token, value, now, RejectReason::StaleToken});
      return false;
    }
    accepted_token_ = token;
    value_ = value;
    trace.record(WriteAccepted{holder, token, value, now});
    return true;
  }

  std::optional<Value> read() const { return value_; }
  Token accepted_token() const { return accepted_token_; }

private:
  Token accepted_token_ = kNoToken;
  std::optional<Value> value_;
};

} // namespace fencing
