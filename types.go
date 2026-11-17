package formal

import (
	"errors"
	"fmt"
	"net/netip"
	"time"
)

var (
	// ErrInvalidKey reports a five-tuple with an invalid source or destination
	// address.
	ErrInvalidKey = errors.New("formal: invalid five-tuple")
	// ErrInvalidBackend reports an empty backend ID or a non-positive weight.
	ErrInvalidBackend = errors.New("formal: invalid backend")
	// ErrNoBackends reports that no eligible backend can accept a new flow.
	ErrNoBackends = errors.New("formal: no eligible backend")
	// ErrFlowActive reports NAT port reuse while the previous connection using
	// the same five-tuple is still active.
	ErrFlowActive = errors.New("formal: five-tuple already active")
	// ErrFlowClosed reports an operation that requires an active connection.
	ErrFlowClosed = errors.New("formal: connection is closed")
	// ErrUnknownFlow reports a five-tuple that is not present in the table.
	ErrUnknownFlow = errors.New("formal: unknown five-tuple")
	// ErrStaleGeneration reports a release or touch from an older connection
	// that reused the same five-tuple.
	ErrStaleGeneration = errors.New("formal: stale connection generation")
	// ErrUnknownBackend reports an operation on an unknown backend ID.
	ErrUnknownBackend = errors.New("formal: unknown backend")
)

// FiveTuple identifies one transport connection. Addresses are normalised to
// their unmapped form by the table, so an IPv4 address and its IPv4-mapped IPv6
// spelling refer to the same connection.
type FiveTuple struct {
	SrcAddr  netip.Addr
	SrcPort  uint16
	DstAddr  netip.Addr
	DstPort  uint16
	Protocol uint8
}

// Valid reports whether both addresses are valid IP addresses.
func (k FiveTuple) Valid() bool {
	return k.SrcAddr.IsValid() && k.DstAddr.IsValid()
}

// Normalized returns the canonical form used as the table key.
func (k FiveTuple) Normalized() FiveTuple {
	k.SrcAddr = k.SrcAddr.Unmap()
	k.DstAddr = k.DstAddr.Unmap()
	return k
}

func (k FiveTuple) String() string {
	return fmt.Sprintf("%s:%d->%s:%d/%d", k.SrcAddr, k.SrcPort, k.DstAddr, k.DstPort, k.Protocol)
}

// Backend is a weighted member of the load-balancing pool. Addr is opaque to
// the table and is returned with every binding; it may identify a socket,
// host:port pair, or an implementation-specific backend object.
type Backend struct {
	ID     string
	Addr   string
	Weight int
}

func (b Backend) validate() error {
	if b.ID == "" {
		return fmt.Errorf("%w: empty ID", ErrInvalidBackend)
	}
	if b.Weight <= 0 {
		return fmt.Errorf("%w: backend %q has weight %d", ErrInvalidBackend, b.ID, b.Weight)
	}
	return nil
}

// State is the lifecycle state of a table entry.
type State uint8

const (
	// StateClosed means the entry is a tombstone retained for five-tuple
	// affinity and stale-generation detection.
	StateClosed State = iota
	// StateActive means the connection is established and may carry traffic.
	StateActive
)

func (s State) String() string {
	switch s {
	case StateActive:
		return "active"
	case StateClosed:
		return "closed"
	default:
		return fmt.Sprintf("state(%d)", uint8(s))
	}
}

// Conn is an immutable snapshot of one table entry. Generation is unique and
// monotonically increasing across the table.
type Conn struct {
	Key        FiveTuple
	Generation uint64
	Backend    Backend
	State      State
	OpenedAt   time.Time
	LastSeen   time.Time
	ClosedAt   time.Time
}

// IsActive reports whether the connection may still carry traffic.
func (c Conn) IsActive() bool {
	return c.State == StateActive
}

// CloseResult describes a successful release.
type CloseResult struct {
	// Closed is true when this call performed the active-to-closed transition.
	// It is false for an idempotent repeat release of the same generation.
	Closed bool
	// Migrated is true when closing made the old backend ineligible and the
	// tombstone was moved to another backend.
	Migrated bool
	// Backend is the backend recorded after the release.
	Backend Backend
}

// DrainResult describes the immediate effect of draining a backend.
type DrainResult struct {
	// Active is the number of active connections still pinned to the backend.
	// They are deliberately not migrated.
	Active int
	// Migrated is the number of closed tombstones moved off the backend.
	Migrated int
}

// BackendStatus is a point-in-time snapshot of a configured backend.
type BackendStatus struct {
	Backend  Backend
	Draining bool
	VNodes   int
}

// Stats is a point-in-time table snapshot. Closes includes Expired.
type Stats struct {
	Active        int
	Closed        int
	Generations   uint64
	Opens         uint64
	Reopens       uint64
	Closes        uint64
	Expired       uint64
	Migrations    uint64
	StaleReleases uint64
	RejectedOpens uint64
}
