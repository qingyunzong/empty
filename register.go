package mvregister

import "sort"

// Version is one causally-visible write retained by the register.
type Version struct {
	Replica string
	Value   string
	Clock   VectorClock
}

// Register is a multi-value register: causally-later writes overwrite the
// versions they observed, while concurrent writes are all preserved.
type Register struct {
	versions []Version
}

// New returns an empty register.
func New() *Register { return &Register{} }

// Write records value for replica. The new write observes every version
// currently held (its clock dominates them all), so it resolves any
// outstanding conflict and becomes the register's only version.
func (r *Register) Write(replica, value string) {
	clock := VectorClock{}
	for _, v := range r.versions {
		clock = clock.Merge(v.Clock)
	}
	clock[replica]++
	kept := r.versions[:0]
	for _, v := range r.versions {
		if Compare(v.Clock, clock) == Concurrent {
			kept = append(kept, v)
		}
	}
	r.versions = append(kept, Version{Replica: replica, Value: value, Clock: clock})
}

// Merge combines another register into r, keeping exactly the versions that
// are not causally dominated by any other version. Concurrent versions from
// both sides are preserved. The operation is commutative, associative and
// idempotent.
func (r *Register) Merge(other *Register) {
	all := make([]Version, 0, len(r.versions)+len(other.versions))
	all = append(all, r.versions...)
	all = append(all, other.versions...)
	kept := make([]Version, 0, len(all))
	for i, v := range all {
		dominated := false
		duplicate := false
		for j, u := range all {
			if i == j {
				continue
			}
			switch Compare(u.Clock, v.Clock) {
			case After:
				dominated = true
			case Equal:
				if j < i {
					duplicate = true
				}
			}
		}
		if !dominated && !duplicate {
			kept = append(kept, v)
		}
	}
	r.versions = kept
}

// Copy returns an independent deep copy of the register.
func (r *Register) Copy() *Register {
	out := New()
	for _, v := range r.versions {
		out.versions = append(out.versions, Version{Replica: v.Replica, Value: v.Value, Clock: v.Clock.Copy()})
	}
	return out
}

// Versions returns the current versions sorted by replica ID for display.
func (r *Register) Versions() []Version {
	out := make([]Version, len(r.versions))
	copy(out, r.versions)
	sort.Slice(out, func(i, j int) bool { return out[i].Replica < out[j].Replica })
	return out
}

// Values returns the current values sorted by their writer's replica ID.
func (r *Register) Values() []string {
	vs := r.Versions()
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.Value
	}
	return out
}
