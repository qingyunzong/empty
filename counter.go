// Package epochcounter implements an epoch-based PN-Counter CRDT.
//
// Each replica maintains per-replica increment (P) and decrement (N)
// components. A reset, issued by an authority with a strictly larger
// epoch sequence number, discards all counts and starts a new epoch.
// Messages (state snapshots) carrying an older epoch are ignored, so
// late-arriving pre-reset traffic can never resurrect stale counts.
package epochcounter

// Epoch identifies a counting generation. Seq is an authoritative,
// monotonically increasing sequence number; Issuer records which
// authority issued the reset (informational, for observability).
type Epoch struct {
	Seq    uint64
	Issuer string
}

// State is a serializable snapshot of a counter, suitable for
// transmission between replicas.
type State struct {
	Epoch Epoch
	P     map[string]uint64 // per-replica increment components
	N     map[string]uint64 // per-replica decrement components
}

// Counter is a single replica of the epoch-based PN-Counter.
type Counter struct {
	replicaID string
	epoch     Epoch
	p         map[string]uint64
	n         map[string]uint64
}

// New creates a replica starting in epoch 0.
func New(replicaID string) *Counter {
	return &Counter{
		replicaID: replicaID,
		p:         make(map[string]uint64),
		n:         make(map[string]uint64),
	}
}

// Epoch returns the replica's current epoch.
func (c *Counter) Epoch() Epoch { return c.epoch }

// Increment adds delta to this replica's P component in the current epoch.
func (c *Counter) Increment(delta uint64) { c.p[c.replicaID] += delta }

// Decrement adds delta to this replica's N component in the current epoch.
func (c *Counter) Decrement(delta uint64) { c.n[c.replicaID] += delta }

// Value is sum(P) - sum(N) over all known replicas in the current epoch.
func (c *Counter) Value() int64 {
	return valueOf(State{P: c.p, N: c.n})
}

func valueOf(s State) int64 {
	var v int64
	for _, x := range s.P {
		v += int64(x)
	}
	for _, x := range s.N {
		v -= int64(x)
	}
	return v
}

// Reset moves the replica into a new epoch, discarding all counts.
// It takes effect only when the issued epoch's sequence number is
// strictly larger than the current one; resets with a stale or equal
// sequence are rejected. Returns true if the reset was applied.
func (c *Counter) Reset(e Epoch) bool {
	if e.Seq <= c.epoch.Seq {
		return false
	}
	c.epoch = e
	c.p = make(map[string]uint64)
	c.n = make(map[string]uint64)
	return true
}

// Snapshot returns a deep copy of the replica's state for gossip.
func (c *Counter) Snapshot() State {
	return State{Epoch: c.epoch, P: cloneMap(c.p), N: cloneMap(c.n)}
}

// Merge incorporates a received snapshot.
//
//   - Higher epoch: the snapshot supersedes local state entirely.
//   - Lower epoch: the message is stale and dropped, so late messages
//     from before a reset can never resurrect discarded counts.
//   - Same epoch: per-replica component-wise max (PN-Counter merge),
//     which is idempotent and safe under replay.
//
// Returns true if local state changed.
func (c *Counter) Merge(s State) bool {
	switch {
	case s.Epoch.Seq > c.epoch.Seq:
		c.epoch = s.Epoch
		c.p = cloneMap(s.P)
		c.n = cloneMap(s.N)
		return true
	case s.Epoch.Seq < c.epoch.Seq:
		return false
	}
	changed := false
	mergeMax(c.p, s.P, &changed)
	mergeMax(c.n, s.N, &changed)
	return changed
}

func mergeMax(dst, src map[string]uint64, changed *bool) {
	for id, v := range src {
		if v > dst[id] {
			dst[id] = v
			*changed = true
		}
	}
}

func cloneMap(m map[string]uint64) map[string]uint64 {
	out := make(map[string]uint64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
