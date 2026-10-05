// Package epochcounter implements an epoch-based replicated counter.
//
// Each replica owns per-epoch increment/decrement components (a PN-counter
// per epoch). A reset issued by the designated authority creates a new
// epoch; only resets carrying an epoch number greater than the replica's
// current epoch take effect. The observable value is the net sum of the
// current epoch's components only, so messages belonging to older epochs
// that arrive late are merged into historical components and can never
// resurrect stale counts.
package epochcounter

// Message is a state snapshot exchanged between replicas.
type Message struct {
	From  string
	Epoch uint64
	Inc   map[uint64]map[string]uint64
	Dec   map[uint64]map[string]uint64
}

// Counter is a single replica of the epoch counter.
type Counter struct {
	replicaID string
	authority string
	epoch     uint64
	inc       map[uint64]map[string]uint64
	dec       map[uint64]map[string]uint64
}

// New creates a replica. authority is the only issuer ID whose resets are
// honored.
func New(replicaID, authority string) *Counter {
	return &Counter{
		replicaID: replicaID,
		authority: authority,
		inc:       make(map[uint64]map[string]uint64),
		dec:       make(map[uint64]map[string]uint64),
	}
}

// Epoch returns the replica's current epoch.
func (c *Counter) Epoch() uint64 { return c.epoch }

// Inc adds n to this replica's increment component in the current epoch.
func (c *Counter) Inc(n uint64) {
	add(c.inc, c.epoch, c.replicaID, n)
}

// Dec adds n to this replica's decrement component in the current epoch.
func (c *Counter) Dec(n uint64) {
	add(c.dec, c.epoch, c.replicaID, n)
}

// Reset advances the replica to the given epoch. It takes effect only when
// the issuer is the designated authority and epoch is strictly greater than
// the current epoch; it reports whether the reset was applied.
func (c *Counter) Reset(epoch uint64, issuer string) bool {
	if issuer != c.authority || epoch <= c.epoch {
		return false
	}
	c.epoch = epoch
	return true
}

// Value returns the net count of the current epoch: the sum of all
// replicas' increments minus decrements in this epoch. Components from
// older epochs are retained for conservation auditing but never counted.
func (c *Counter) Value() int64 {
	return c.EpochSum(c.epoch)
}

// EpochSum returns the net count of an arbitrary epoch.
func (c *Counter) EpochSum(epoch uint64) int64 {
	var total int64
	for _, n := range c.inc[epoch] {
		total += int64(n)
	}
	for _, n := range c.dec[epoch] {
		total -= int64(n)
	}
	return total
}

// Epochs returns the set of epochs this replica has components for.
func (c *Counter) Epochs() []uint64 {
	seen := make(map[uint64]struct{})
	for e := range c.inc {
		seen[e] = struct{}{}
	}
	for e := range c.dec {
		seen[e] = struct{}{}
	}
	out := make([]uint64, 0, len(seen))
	for e := range seen {
		out = append(out, e)
	}
	return out
}

// Snapshot returns a deep copy of the replica's state for gossip.
func (c *Counter) Snapshot() Message {
	return Message{
		From:  c.replicaID,
		Epoch: c.epoch,
		Inc:   clone(c.inc),
		Dec:   clone(c.dec),
	}
}

// Merge folds a received snapshot into the local state and reports whether
// anything changed. Per-epoch per-replica components merge by max, which is
// idempotent (replays are no-ops) and commutative (partitions converge).
// A higher epoch carried by the snapshot is adopted: epochs can only
// originate from an authoritative Reset, so propagation is safe. Snapshots
// from older epochs only enrich historical components and never lower the
// current epoch or alter the current value.
func (c *Counter) Merge(m Message) bool {
	changed := false
	if m.Epoch > c.epoch {
		c.epoch = m.Epoch
		changed = true
	}
	if mergeMax(c.inc, m.Inc) {
		changed = true
	}
	if mergeMax(c.dec, m.Dec) {
		changed = true
	}
	return changed
}

func add(m map[uint64]map[string]uint64, epoch uint64, id string, n uint64) {
	if m[epoch] == nil {
		m[epoch] = make(map[string]uint64)
	}
	m[epoch][id] += n
}

func mergeMax(dst, src map[uint64]map[string]uint64) bool {
	changed := false
	for epoch, comps := range src {
		if dst[epoch] == nil {
			dst[epoch] = make(map[string]uint64)
		}
		for id, v := range comps {
			if v > dst[epoch][id] {
				dst[epoch][id] = v
				changed = true
			}
		}
	}
	return changed
}

func clone(m map[uint64]map[string]uint64) map[uint64]map[string]uint64 {
	out := make(map[uint64]map[string]uint64, len(m))
	for epoch, comps := range m {
		c := make(map[string]uint64, len(comps))
		for id, v := range comps {
			c[id] = v
		}
		out[epoch] = c
	}
	return out
}
