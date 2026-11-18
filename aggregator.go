package formal

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrUnknownInstance is returned when a probe is reported for an instance
	// that has not been registered.
	ErrUnknownInstance = errors.New("formal: unknown instance")
	// ErrDuplicateInstance is returned when registering an existing ID.
	ErrDuplicateInstance = errors.New("formal: duplicate instance")
	// ErrInvalidInstanceID is returned for the empty instance ID.
	ErrInvalidInstanceID = errors.New("formal: invalid instance id")
	// ErrInvalidProbeKind is returned for an out-of-range ProbeKind.
	ErrInvalidProbeKind = errors.New("formal: invalid probe kind")
	// ErrInvalidProbeResult is returned for an out-of-range ProbeResult.
	ErrInvalidProbeResult = errors.New("formal: invalid probe result")
)

// Aggregator owns per-instance probe counters and derives the aggregate state.
// It is safe for concurrent use.
type Aggregator struct {
	cfg Config

	mu        sync.RWMutex
	instances map[InstanceID]*instance
	cursor    uint64
}

// New creates an aggregator. Zero-valued Config fields receive defaults.
// Optional instance IDs are registered before the aggregator is returned.
func New(cfg Config, ids ...InstanceID) (*Aggregator, error) {
	normalized, err := cfg.normalize()
	if err != nil {
		return nil, err
	}
	a := &Aggregator{
		cfg:       normalized,
		instances: make(map[InstanceID]*instance, len(ids)),
	}
	for _, id := range ids {
		if err := a.Register(id); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// Config returns the normalized configuration in use.
func (a *Aggregator) Config() Config { return a.cfg }

// Register adds an instance. Registering the same ID twice is an error.
func (a *Aggregator) Register(id InstanceID) error {
	if id == "" {
		return ErrInvalidInstanceID
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.instances[id]; ok {
		return fmt.Errorf("%w: %q", ErrDuplicateInstance, id)
	}
	a.instances[id] = newInstance(id)
	return nil
}

// Unregister removes an instance and all of its probe counters.
func (a *Aggregator) Unregister(id InstanceID) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.instances[id]; !ok {
		return false
	}
	delete(a.instances, id)
	return true
}

// Record applies one probe result to one instance and returns the resulting
// snapshot. Counters are updated before the state is derived, so the returned
// snapshot is exactly the state induced by the full probe history.
func (a *Aggregator) Record(id InstanceID, kind ProbeKind, result ProbeResult) (Snapshot, error) {
	if kind > ProbeLiveness {
		return Snapshot{}, fmt.Errorf("%w: %d", ErrInvalidProbeKind, kind)
	}
	if result > ProbeFail {
		return Snapshot{}, fmt.Errorf("%w: %d", ErrInvalidProbeResult, result)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	in, ok := a.instances[id]
	if !ok {
		return Snapshot{}, fmt.Errorf("%w: %q", ErrUnknownInstance, id)
	}
	in.record(a.cfg, kind, result)
	return in.snapshot(a.cfg), nil
}

// SnapshotFor returns the current snapshot for one instance.
func (a *Aggregator) SnapshotFor(id InstanceID) (Snapshot, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	in, ok := a.instances[id]
	if !ok {
		return Snapshot{}, false
	}
	return in.snapshot(a.cfg), true
}

// Snapshots returns all snapshots ordered by instance ID.
func (a *Aggregator) Snapshots() []Snapshot {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.snapshotsLocked()
}

func (a *Aggregator) snapshotsLocked() []Snapshot {
	out := make([]Snapshot, 0, len(a.instances))
	for _, in := range a.instances {
		out = append(out, in.snapshot(a.cfg))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ReadyInstances returns the IDs of all traffic-eligible instances in sorted
// order.
func (a *Aggregator) ReadyInstances() []InstanceID {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.readyLocked()
}

func (a *Aggregator) readyLocked() []InstanceID {
	ready := make([]InstanceID, 0, len(a.instances))
	for id, in := range a.instances {
		if in.state() == StateReady {
			ready = append(ready, id)
		}
	}
	sort.Slice(ready, func(i, j int) bool { return ready[i] < ready[j] })
	return ready
}

// TrafficMap reports, for every registered instance, whether it may currently
// receive traffic. Entries are true exactly when the instance is StateReady.
func (a *Aggregator) TrafficMap() map[InstanceID]bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make(map[InstanceID]bool, len(a.instances))
	for id, in := range a.instances {
		out[id] = in.state().TrafficEligible()
	}
	return out
}

// Select returns up to limit traffic-eligible instance IDs using a stable
// round-robin order. It never returns a non-ready instance, even when removal
// and recovery events interleave. A non-positive limit returns nil.
func (a *Aggregator) Select(limit int) []InstanceID {
	if limit <= 0 {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	ready := a.readyLocked()
	if len(ready) == 0 {
		return nil
	}
	n := limit
	if n > len(ready) {
		n = len(ready)
	}
	start := int(a.cursor % uint64(len(ready)))
	out := make([]InstanceID, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, ready[(start+i)%len(ready)])
	}
	a.cursor += uint64(n)
	return out
}
