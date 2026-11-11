package batchresp

import (
	"fmt"
	"sort"
	"sync"
)

// OnGroupClosed is invoked once a transaction group becomes closed, i.e.
// every Content-ID referenced by any of its segments has arrived. A
// failed segment arriving late closes previously pending groups and
// delivers their failure result through this callback.
type OnGroupClosed func(result Result)

// Resolver is the concurrency-safe streaming entry point. Segments for
// many transaction groups can be fed in arbitrary order; each group is
// delivered exactly once through the callback when its dependency set
// closes.
type Resolver struct {
	mu       sync.Mutex
	groups   map[string]*Group
	opts     []Option
	onClosed OnGroupClosed
	closed   map[string]struct{}
}

// NewResolver creates a streaming resolver.
func NewResolver(onClosed OnGroupClosed, opts ...Option) *Resolver {
	return &Resolver{
		groups:   make(map[string]*Group),
		closed:   make(map[string]struct{}),
		opts:     opts,
		onClosed: onClosed,
	}
}

// Add ingests a segment into its group. When the group becomes closed the
// callback runs before Add returns, while still holding the resolver
// lock; callbacks must not re-enter the resolver.
//
// A duplicated Content-ID is returned as an error and does not mutate the
// existing group.
func (r *Resolver) Add(groupID string, seg Segment) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, delivered := r.closed[groupID]; delivered {
		return fmt.Errorf("%w: %q", ErrGroupClosed, groupID)
	}

	group, ok := r.groups[groupID]
	if !ok {
		group = NewGroup(groupID, r.opts...)
		r.groups[groupID] = group
	}
	if err := group.Add(seg); err != nil {
		return err
	}

	if len(group.Pending()) == 0 {
		r.closed[groupID] = struct{}{}
		r.onClosed(group.Resolve())
	}
	return nil
}

// PendingGroups reports the group IDs that have not yet closed, in
// deterministic order.
func (r *Resolver) PendingGroups() []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	ids := make([]string, 0, len(r.groups))
	for id := range r.groups {
		if _, done := r.closed[id]; !done {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Group returns a snapshot handle for inspection. Callers should not
// mutate the returned group; it remains owned by the resolver.
func (r *Resolver) Group(groupID string) (*Group, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	group, ok := r.groups[groupID]
	return group, ok
}
