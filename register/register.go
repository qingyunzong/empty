package register

import (
	"fmt"
	"sort"
	"strings"
)

// Value is a single versioned write kept by the register.
type Value struct {
	ReplicaID string
	Data      string
	Version   VersionVector
}

// MVRegister is a multi-value register. Concurrent writes are all retained;
// a write that causally follows another supersedes it.
type MVRegister struct {
	id     string
	values map[string]Value // keyed by replica ID of the last writer
}

// New creates a register hosted on the given replica ID.
func New(replicaID string) *MVRegister {
	return &MVRegister{id: replicaID, values: make(map[string]Value)}
}

// ID returns the replica ID hosting this register.
func (r *MVRegister) ID() string { return r.id }

// context returns the join of all currently visible versions, i.e. the
// causal context any new write must observe.
func (r *MVRegister) context() VersionVector {
	ctx := make(VersionVector)
	for _, v := range r.values {
		ctx = ctx.Merge(v.Version)
	}
	return ctx
}

// Write records data as a causally-new write. The new version observes all
// currently visible versions (the full causal context) and advances the
// local replica's clock, so it supersedes every write it observed.
func (r *MVRegister) Write(data string) {
	ctx := r.context()
	ctx[r.id]++
	r.values = map[string]Value{
		r.id: {ReplicaID: r.id, Data: data, Version: ctx},
	}
}

// Values returns all currently visible values, sorted by replica ID so
// concurrent writes are displayed deterministically by ID.
func (r *MVRegister) Values() []Value {
	out := make([]Value, 0, len(r.values))
	for _, v := range r.values {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ReplicaID < out[j].ReplicaID })
	return out
}

// Get returns the single visible value if there is exactly one, and false
// if zero or multiple (concurrent) values are visible.
func (r *MVRegister) Get() (string, bool) {
	if len(r.values) != 1 {
		return "", false
	}
	for _, v := range r.values {
		return v.Data, true
	}
	return "", false
}

// Merge joins another register's state into this one. For each incoming
// versioned value: drop it if a local version dominates it; drop local
// versions it dominates; keep it alongside locals it is concurrent with.
// Merge is commutative, associative, and idempotent.
func (r *MVRegister) Merge(other *MVRegister) {
	for _, in := range other.values {
		dominated := false
		for id, local := range r.values {
			switch in.Version.Compare(local.Version) {
			case Before, Equal:
				dominated = true
			case After:
				delete(r.values, id)
			}
		}
		if !dominated {
			r.values[in.ReplicaID] = Value{
				ReplicaID: in.ReplicaID,
				Data:      in.Data,
				Version:   in.Version.Clone(),
			}
		}
	}
}

// String renders visible values sorted by replica ID, e.g. "A=x; B=y".
func (r *MVRegister) String() string {
	parts := make([]string, 0, len(r.values))
	for _, v := range r.Values() {
		parts = append(parts, fmt.Sprintf("%s=%s", v.ReplicaID, v.Data))
	}
	return strings.Join(parts, "; ")
}
