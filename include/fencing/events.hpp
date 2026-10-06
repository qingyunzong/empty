#pragma once

#include "types.hpp"

#include <string>
#include <variant>
#include <vector>

namespace fencing {

enum class RejectReason {
  StaleToken,   // token lower than the storage's accepted fence number
  ExpiredLease, // the lease backing the token had already expired
  NoSuchLease,  // token was never granted by the issuer
  HolderDown,   // holder crashed before the write reached storage
};

struct LeaseGranted {
  HolderId holder;
  Token token;
  Time granted_at;
  Time expires_at;
};

struct LeaseExpired {
  HolderId holder;
  Token token;
  Time at;
};

struct WriteAccepted {
  HolderId holder;
  Token token;
  Value value;
  Time at;
};

struct WriteRejected {
  HolderId holder;
  Token token;
  Value value;
  Time at;
  RejectReason reason;
};

struct HolderCrashed {
  HolderId holder;
  Time at;
};

struct HolderRecovered {
  HolderId holder;
  Time at;
};

using Event = std::variant<LeaseGranted, LeaseExpired, WriteAccepted, WriteRejected,
                           HolderCrashed, HolderRecovered>;

// Append-only evidence log of everything the simulation observed.
struct Trace {
  std::vector<Event> events;

  void record(Event e) { events.push_back(std::move(e)); }

  template <typename T> std::vector<T> select() const {
    std::vector<T> out;
    for (const auto& e : events) {
      if (const auto* p = std::get_if<T>(&e)) out.push_back(*p);
    }
    return out;
  }
};

inline std::string to_string(RejectReason r) {
  switch (r) {
  case RejectReason::StaleToken: return "StaleToken";
  case RejectReason::ExpiredLease: return "ExpiredLease";
  case RejectReason::NoSuchLease: return "NoSuchLease";
  case RejectReason::HolderDown: return "HolderDown";
  }
  return "?";
}

inline std::string to_string(const Event& e) {
  return std::visit(
      [](const auto& v) -> std::string {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, LeaseGranted>) {
          return "LeaseGranted(holder=" + std::to_string(v.holder) +
                 ", token=" + std::to_string(v.token) +
                 ", expires_at=" + std::to_string(v.expires_at) + ")";
        } else if constexpr (std::is_same_v<T, LeaseExpired>) {
          return "LeaseExpired(holder=" + std::to_string(v.holder) +
                 ", token=" + std::to_string(v.token) + ")";
        } else if constexpr (std::is_same_v<T, WriteAccepted>) {
          return "WriteAccepted(holder=" + std::to_string(v.holder) +
                 ", token=" + std::to_string(v.token) +
                 ", value=" + std::to_string(v.value) + ")";
        } else if constexpr (std::is_same_v<T, WriteRejected>) {
          return "WriteRejected(holder=" + std::to_string(v.holder) +
                 ", token=" + std::to_string(v.token) +
                 ", reason=" + to_string(v.reason) + ")";
        } else if constexpr (std::is_same_v<T, HolderCrashed>) {
          return "HolderCrashed(holder=" + std::to_string(v.holder) + ")";
        } else {
          return "HolderRecovered(holder=" + std::to_string(v.holder) + ")";
        }
      },
      e);
}

} // namespace fencing
