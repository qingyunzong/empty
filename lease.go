package dataeng

import (
	"fmt"
	"time"
)

// Lease is a scheduler-facing capability to process one shard. Generation is
// monotonically increasing per shard and changes whenever a new owner acquires
// the lease. A token with an older generation must never be accepted for a
// state-changing operation.
type Lease struct {
	ShardID    ShardID
	Owner      string
	Generation uint64
	ExpiresAt  time.Time
}

// Zero reports whether the lease has no owner.
func (l Lease) Zero() bool {
	return l.Owner == "" || l.ShardID == ""
}

// Expired reports whether the lease is unusable at now. A zero lease is
// expired by definition.
func (l Lease) Expired(now time.Time) bool {
	return l.Zero() || !now.Before(l.ExpiresAt)
}

func (l Lease) String() string {
	return fmt.Sprintf("shard=%s owner=%s generation=%d expires=%s",
		l.ShardID, l.Owner, l.Generation, l.ExpiresAt.Format(timeFormat))
}

// validate checks the token's intrinsic fields. The authoritative expiry,
// owner, and generation live in the durable shard record and are checked by
// the coordinator while holding a compare-and-swap snapshot.
func (l Lease) validate(shard ShardID) error {
	if l.Zero() {
		return fmt.Errorf("%w: zero lease", ErrInvalidLease)
	}
	if l.ShardID != shard {
		return fmt.Errorf("%w: lease is for shard %q, not %q",
			ErrInvalidLease, l.ShardID, shard)
	}
	if l.Generation == 0 {
		return fmt.Errorf("%w: generation must be positive", ErrInvalidLease)
	}
	return nil
}
