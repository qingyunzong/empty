package formal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	// ErrResourceVersionConflict means the lease changed after the caller read
	// it. The operation had no effect and should be retried after a fresh read.
	ErrResourceVersionConflict = errors.New("formal: lease resource version conflict")

	// ErrLeaseNotFound means an update targeted a lease that does not exist.
	ErrLeaseNotFound = errors.New("formal: lease not found")

	// ErrClusterMismatch means a store returned a lease belonging to a
	// different cluster or lease name. Such a lease is never adopted.
	ErrClusterMismatch = errors.New("formal: lease belongs to another cluster")

	// ErrInvalidLease means a lease record failed validation.
	ErrInvalidLease = errors.New("formal: invalid lease")

	// ErrInvalidConfig means a Machine configuration is unusable.
	ErrInvalidConfig = errors.New("formal: invalid configuration")

	// ErrTermOverflow means a term cannot be incremented further.
	ErrTermOverflow = errors.New("formal: lease term overflow")

	// ErrResourceVersionOverflow means a store exhausted its resource version
	// counter.
	ErrResourceVersionOverflow = errors.New("formal: resource version overflow")
)

// LeaseKey identifies one lease inside one cluster. The cluster is part of the
// key, not merely a label, so identically named controllers in different
// clusters cannot contend with each other.
type LeaseKey struct {
	Cluster string
	Name    string
}

func (k LeaseKey) String() string {
	return k.Cluster + "/" + k.Name
}

// Lease is the value stored by a Store.
//
// RenewedAt and ExpiresAt are timestamps in the holder's local clock domain.
// An observer must allow for the configured clock skew before concluding that
// ExpiresAt has passed. ResourceVersion is assigned by the Store and is used
// as the compare-and-swap token.
type Lease struct {
	Cluster         string
	Name            string
	Holder          string
	Term            uint64
	RenewedAt       time.Time
	ExpiresAt       time.Time
	ResourceVersion uint64
}

// Key returns the lease's cluster-scoped identity.
func (l Lease) Key() LeaseKey {
	return LeaseKey{Cluster: l.Cluster, Name: l.Name}
}

// Validate checks the fields that every participant relies on.
func (l Lease) Validate() error {
	if strings.TrimSpace(l.Cluster) == "" {
		return fmt.Errorf("%w: empty cluster", ErrInvalidLease)
	}
	if strings.TrimSpace(l.Name) == "" {
		return fmt.Errorf("%w: empty lease name", ErrInvalidLease)
	}
	if strings.TrimSpace(l.Holder) == "" {
		return fmt.Errorf("%w: empty holder", ErrInvalidLease)
	}
	if l.Term == 0 {
		return fmt.Errorf("%w: zero term", ErrInvalidLease)
	}
	if l.RenewedAt.IsZero() || l.ExpiresAt.IsZero() {
		return fmt.Errorf("%w: zero timestamp", ErrInvalidLease)
	}
	if !l.ExpiresAt.After(l.RenewedAt) {
		return fmt.Errorf("%w: expiration is not after renewal", ErrInvalidLease)
	}
	return nil
}

// Store is the compare-and-swap lease storage used by a Machine. It is
// normally backed by etcd or a Kubernetes Lease, but the state machine only
// depends on these three operations.
//
// Create must fail with ErrResourceVersionConflict if the key already exists.
// Update must atomically compare the stored ResourceVersion with
// expectedResourceVersion and fail with ErrResourceVersionConflict when they
// differ. Implementations must assign a fresh non-zero ResourceVersion on every
// successful mutation.
type Store interface {
	Get(ctx context.Context, key LeaseKey) (Lease, bool, error)
	Create(ctx context.Context, lease Lease) (Lease, error)
	Update(ctx context.Context, lease Lease, expectedResourceVersion uint64) (Lease, error)
}
