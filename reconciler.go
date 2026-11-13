package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Reconciler merges webhook events per resource into an ordered, deduplicated
// outbound stream. It tolerates duplicates (by event ID), out-of-order
// delivery and version gaps (by resource version), resolves same-version
// conflicts by issue time, and never lets a late update resurrect a delete
// tombstone. All accepted inputs go through the Store WAL first, so crash
// recovery reproduces the same final state and outbound sequence.
type Reconciler struct {
	mu        sync.Mutex
	store     Store
	sink      func(OutboundRecord)
	resources map[string]*resourceState
	seen      map[string]struct{}
	outbox    []OutboundRecord
	seq       uint64
	backfills chan BackfillRequest
	replaying bool
}

type resourceState struct {
	lastVersion     uint64
	lastIssuedAt    time.Time
	tombstone       bool
	tombVersion     uint64
	buffered        map[uint64]Event
	backfillPending bool
	backfillTo      uint64
}

// ResourceStatus is a point-in-time view of one resource's merge state.
type ResourceStatus struct {
	LastVersion     uint64
	LastIssuedAt    time.Time
	Tombstoned      bool
	TombVersion     uint64
	Buffered        []uint64
	BackfillPending bool
	BackfillTo      uint64
}

type Option func(*Reconciler)

// WithSink registers a callback invoked for every new outbound record
// (not invoked for records rebuilt during recovery replay).
func WithSink(sink func(OutboundRecord)) Option {
	return func(r *Reconciler) { r.sink = sink }
}

// WithBackfillBuffer sets the buffer size of the backfill request channel.
func WithBackfillBuffer(n int) Option {
	return func(r *Reconciler) { r.backfills = make(chan BackfillRequest, n) }
}

// NewReconciler creates a Reconciler on top of store (nil for purely
// in-memory operation) and replays any persisted log. After recovery, one
// backfill request is re-emitted for every resource whose gap is still open.
func NewReconciler(store Store, opts ...Option) (*Reconciler, error) {
	r := &Reconciler{
		store:     store,
		resources: make(map[string]*resourceState),
		seen:      make(map[string]struct{}),
		backfills: make(chan BackfillRequest, 64),
		replaying: true,
	}
	for _, o := range opts {
		o(r)
	}
	if store != nil {
		err := store.Replay(func(rec LogRecord) error {
			switch rec.Kind {
			case KindEvent:
				r.seen[rec.Event.ID] = struct{}{}
				r.applyEvent(*rec.Event)
			case KindSnapshot:
				r.applySnapshot(*rec.Snapshot)
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("replay wal: %w", err)
		}
	}
	r.replaying = false
	for id, rs := range r.resources {
		if rs.backfillPending {
			r.emitBackfill(id, rs)
		}
	}
	return r, nil
}

// HandleEvent ingests one webhook event. Duplicate event IDs are dropped.
// The event is persisted before its effects are applied.
func (r *Reconciler) HandleEvent(e Event) error {
	if e.ID == "" {
		return errors.New("event id is required")
	}
	if e.ResourceID == "" {
		return errors.New("resource id is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.seen[e.ID]; dup {
		return nil
	}
	if r.store != nil {
		ev := e
		if err := r.store.Append(LogRecord{Kind: KindEvent, Event: &ev}); err != nil {
			return err
		}
	}
	r.seen[e.ID] = struct{}{}
	r.applyEvent(e)
	return nil
}

// HandleSnapshot ingests a backfill snapshot and merges it with buffered
// events by version: buffered events at or below the snapshot version are
// superseded, higher ones are applied in order.
func (r *Reconciler) HandleSnapshot(s Snapshot) error {
	if s.ResourceID == "" {
		return errors.New("resource id is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.store != nil {
		snap := s
		if err := r.store.Append(LogRecord{Kind: KindSnapshot, Snapshot: &snap}); err != nil {
			return err
		}
	}
	r.applySnapshot(s)
	return nil
}

// Backfills returns the channel on which backfill requests are emitted.
// Exactly one request is emitted per gap episode per resource.
func (r *Reconciler) Backfills() <-chan BackfillRequest { return r.backfills }

// Outbound returns the merged outbound records in sequence order.
func (r *Reconciler) Outbound() []OutboundRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]OutboundRecord, len(r.outbox))
	copy(out, r.outbox)
	return out
}

// Status returns the merge state of one resource.
func (r *Reconciler) Status(resourceID string) ResourceStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	rs, ok := r.resources[resourceID]
	if !ok {
		return ResourceStatus{}
	}
	st := ResourceStatus{
		LastVersion:     rs.lastVersion,
		LastIssuedAt:    rs.lastIssuedAt,
		Tombstoned:      rs.tombstone,
		TombVersion:     rs.tombVersion,
		BackfillPending: rs.backfillPending,
		BackfillTo:      rs.backfillTo,
	}
	for v := range rs.buffered {
		st.Buffered = append(st.Buffered, v)
	}
	sort.Slice(st.Buffered, func(i, j int) bool { return st.Buffered[i] < st.Buffered[j] })
	return st
}

func (r *Reconciler) resource(id string) *resourceState {
	rs, ok := r.resources[id]
	if !ok {
		rs = &resourceState{buffered: make(map[uint64]Event)}
		r.resources[id] = rs
	}
	return rs
}

func (r *Reconciler) applyEvent(e Event) {
	rs := r.resource(e.ResourceID)
	switch {
	case e.Version <= rs.lastVersion:
		// Stale or already covered. This also drops late upserts at or
		// below a delete tombstone, so deletes are never resurrected.
	case e.Version == rs.lastVersion+1:
		r.applyNow(rs, e)
		r.drain(rs)
	default:
		if old, ok := rs.buffered[e.Version]; ok {
			// Same-version conflict: keep the later-issued copy.
			if e.IssuedAt.After(old.IssuedAt) {
				rs.buffered[e.Version] = e
			}
		} else {
			rs.buffered[e.Version] = e
		}
		if !rs.backfillPending {
			rs.backfillPending = true
			rs.backfillTo = e.Version
			r.emitBackfill(e.ResourceID, rs)
		} else if e.Version > rs.backfillTo {
			rs.backfillTo = e.Version
		}
	}
}

func (r *Reconciler) applySnapshot(s Snapshot) {
	rs := r.resource(s.ResourceID)
	if s.Version <= rs.lastVersion {
		return // stale snapshot; gap already resolved
	}
	rs.lastVersion = s.Version
	rs.lastIssuedAt = time.Time{}
	if s.Type == EventDelete {
		rs.tombstone = true
		rs.tombVersion = s.Version
	} else {
		rs.tombstone = false
	}
	r.publish(OutboundRecord{
		ResourceID: s.ResourceID,
		Version:    s.Version,
		Type:       s.Type,
		Payload:    s.Payload,
		Snapshot:   true,
	})
	for v := range rs.buffered {
		if v <= s.Version {
			delete(rs.buffered, v)
		}
	}
	rs.backfillPending = false
	r.drain(rs)
	if len(rs.buffered) > 0 && !rs.backfillPending {
		// The snapshot did not reach the buffered events: open a new
		// gap episode above the snapshot version.
		rs.backfillPending = true
		for v := range rs.buffered {
			if v > rs.backfillTo {
				rs.backfillTo = v
			}
		}
		r.emitBackfill(s.ResourceID, rs)
	}
}

func (r *Reconciler) applyNow(rs *resourceState, e Event) {
	if rs.tombstone && e.Type == EventUpsert && e.Version <= rs.tombVersion {
		return // defensive: a late update must not resurrect a tombstone
	}
	rs.lastVersion = e.Version
	rs.lastIssuedAt = e.IssuedAt
	if e.Type == EventDelete {
		rs.tombstone = true
		rs.tombVersion = e.Version
	} else {
		rs.tombstone = false
	}
	r.publish(OutboundRecord{
		ResourceID: e.ResourceID,
		Version:    e.Version,
		Type:       e.Type,
		Payload:    e.Payload,
		EventID:    e.ID,
	})
}

// drain applies buffered events that have become contiguous.
func (r *Reconciler) drain(rs *resourceState) {
	for {
		next, ok := rs.buffered[rs.lastVersion+1]
		if !ok {
			break
		}
		delete(rs.buffered, rs.lastVersion+1)
		r.applyNow(rs, next)
	}
	if len(rs.buffered) == 0 {
		rs.backfillPending = false
	}
}

func (r *Reconciler) publish(rec OutboundRecord) {
	r.seq++
	rec.Seq = r.seq
	r.outbox = append(r.outbox, rec)
	if !r.replaying && r.sink != nil {
		r.sink(rec)
	}
}

func (r *Reconciler) emitBackfill(resourceID string, rs *resourceState) {
	if r.replaying {
		return
	}
	req := BackfillRequest{
		ResourceID:  resourceID,
		FromVersion: rs.lastVersion,
		ToVersion:   rs.backfillTo,
	}
	select {
	case r.backfills <- req:
	default:
		// Channel full: the pending flag survives and is re-emitted
		// after recovery.
	}
}
