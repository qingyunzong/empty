#pragma once

// Fencing-token task simulation core.
//
// Model:
//  - FenceService grants strictly monotonic tokens, each carrying a lease
//    that expires at a logical tick.
//  - Storage accepts a write iff its token is not smaller than the highest
//    token it has already accepted (token >= highest_accepted).
//  - Lease expiry never touches Storage: an expired lease does not revoke or
//    alter previously stored results, and Storage has no reference to the
//    service. Safety against stale holders comes purely from token order.
//  - Every grant and every write attempt is recorded as evidence.

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace fencesim {

using Token = std::uint64_t;
using Tick = std::uint64_t;
using HolderId = int;

struct GrantRecord {
    Token token;
    HolderId holder;
    Tick granted_at;
    Tick lease_until;
};

struct WriteRecord {
    Token token;
    HolderId holder;
    Tick at;
    std::string value;
    bool accepted;
};

class FenceService {
public:
    explicit FenceService(Tick lease_duration) : lease_duration_(lease_duration) {}

    // Grant a fresh lease. Tokens are strictly monotonic across all holders.
    Token grant(HolderId holder, Tick now) {
        Token token = ++next_;
        grants_.push_back(GrantRecord{token, holder, now, now + lease_duration_});
        return token;
    }

    // Holder-side lease validity check. Purely advisory: Storage never calls
    // this, so an expired lease cannot roll back stored state.
    bool lease_valid(Token token, Tick now) const {
        for (const auto& g : grants_) {
            if (g.token == token) return now < g.lease_until;
        }
        return false;
    }

    const std::vector<GrantRecord>& grants() const { return grants_; }

private:
    Tick lease_duration_;
    Token next_ = 0;
    std::vector<GrantRecord> grants_;
};

class Storage {
public:
    // Accept iff token >= highest token accepted so far. Rejections are
    // recorded too: they are the evidence that late writes from stale
    // holders were fenced out.
    bool write(Token token, HolderId holder, Tick at, std::string value) {
        const bool accepted = !has_ || token >= highest_;
        log_.push_back(WriteRecord{token, holder, at, value, accepted});
        if (accepted) {
            has_ = true;
            highest_ = token;
            value_ = std::move(value);
        }
        return accepted;
    }

    bool empty() const { return !has_; }
    Token highest_token() const { return highest_; }
    const std::string& value() const { return value_; }
    const std::vector<WriteRecord>& log() const { return log_; }

private:
    bool has_ = false;
    Token highest_ = 0;
    std::string value_;
    std::vector<WriteRecord> log_;
};

} // namespace fencesim
