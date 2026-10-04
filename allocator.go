package idalloc

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	ErrRangeNotFound  = errors.New("idalloc: range not found")
	ErrRangeExhausted = errors.New("idalloc: range fully consumed")
	ErrFenced         = errors.New("idalloc: lease fenced by a newer generation")
	ErrInvalidSize    = errors.New("idalloc: size must be positive")
)

const allocatorKey = "allocator.json"

// Range is a persistent record of one integer interval [Start, End]
// assigned to a node under a fencing generation.
type Range struct {
	ID         int64  `json:"id"`
	NodeID     string `json:"nodeId"`
	Start      int64  `json:"start"`
	End        int64  `json:"end"` // inclusive
	Generation uint64 `json:"generation"`
	Closed     bool   `json:"closed"`
}

// Lease authorizes a node to issue ids from [Start, End] while Generation
// remains the current generation of RangeID.
type Lease struct {
	RangeID    int64
	Start      int64
	End        int64
	Generation uint64
}

type allocState struct {
	Next   int64            `json:"next"` // next never-issued integer
	Seq    int64            `json:"seq"`  // range id counter
	Ranges map[int64]*Range `json:"ranges"`
}

// Allocator durably hands out non-overlapping integer ranges. Every
// mutation is persisted (Write+Sync) before it is acknowledged, so a crash
// or a lost acknowledgment can strand a range (a hole) but can never make
// the allocator hand the same integer out twice.
//
// Exactly one Allocator instance may be live per Storage at a time; after a
// crash, reopen with OpenAllocator instead of reusing the stale instance.
type Allocator struct {
	mu    sync.Mutex
	store Storage
	gen   uint64
	state allocState
}

// OpenAllocator loads the persisted allocator state, or initializes a fresh
// one (issuing starts at 1) when the store is empty.
func OpenAllocator(store Storage) (*Allocator, error) {
	a := &Allocator{store: store, gen: store.Generation()}
	data, err := store.Read(allocatorKey)
	if errors.Is(err, ErrNotFound) {
		a.state = allocState{Next: 1, Ranges: map[int64]*Range{}}
		return a, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &a.state); err != nil {
		return nil, fmt.Errorf("idalloc: corrupt allocator state: %w", err)
	}
	if a.state.Ranges == nil {
		a.state.Ranges = map[int64]*Range{}
	}
	return a, nil
}

func (a *Allocator) checkAlive() error {
	if a.store.Generation() != a.gen {
		return ErrCrashed
	}
	return nil
}

// persist makes st durable, then verifies the instance survived (a crash
// may have landed between Write and Sync, silently dropping the write).
func (a *Allocator) persist(st *allocState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := a.store.Write(allocatorKey, data); err != nil {
		return err
	}
	if err := a.store.Sync(); err != nil {
		return err
	}
	return a.checkAlive()
}

func (a *Allocator) cloneState() *allocState {
	st := &allocState{
		Next:   a.state.Next,
		Seq:    a.state.Seq,
		Ranges: make(map[int64]*Range, len(a.state.Ranges)),
	}
	for id, r := range a.state.Ranges {
		cp := *r
		st.Ranges[id] = &cp
	}
	return st
}

// Allocate reserves a fresh range of size integers for nodeID and returns
// its lease. The range is durable before Allocate returns; if the caller
// never learns of it (lost ack, failed node persist) the integers are
// simply never used.
func (a *Allocator) Allocate(nodeID string, size int64) (Lease, error) {
	if size <= 0 {
		return Lease{}, ErrInvalidSize
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkAlive(); err != nil {
		return Lease{}, err
	}
	st := a.cloneState()
	rec := &Range{
		ID:         st.Seq + 1,
		NodeID:     nodeID,
		Start:      st.Next,
		End:        st.Next + size - 1,
		Generation: 1,
	}
	st.Seq = rec.ID
	st.Next = rec.End + 1
	st.Ranges[rec.ID] = rec
	if err := a.persist(st); err != nil {
		return Lease{}, err
	}
	a.state = *st
	return Lease{RangeID: rec.ID, Start: rec.Start, End: rec.End, Generation: rec.Generation}, nil
}

// Transfer moves the unconsumed tail of rangeID to newNodeID.
//
// The old generation is closed and persisted FIRST; only then is cursorFn
// invoked to learn the old owner's durable cursor (its next unissued id,
// e.g. via LoadNodeState), and only then is the tail re-issued under a
// bumped generation. Reading the cursor after the close is what makes the
// handover safe: any old-generation id delivered before the close already
// advanced the durable cursor (Node.Issue re-validates after persisting),
// so the new owner can never reissue it. cursorFn is called with the
// allocator locked and must not call back into the Allocator.
//
// A crash between close and re-issue leaves the range closed (a hole), and
// holders of the old generation are fenced by Validate.
func (a *Allocator) Transfer(rangeID int64, newNodeID string, cursorFn func() (int64, error)) (Lease, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkAlive(); err != nil {
		return Lease{}, err
	}
	if a.state.Ranges[rangeID] == nil {
		return Lease{}, ErrRangeNotFound
	}
	st := a.cloneState()
	rec := st.Ranges[rangeID]
	if !rec.Closed {
		rec.Closed = true
		if err := a.persist(st); err != nil {
			return Lease{}, err
		}
		a.state = *st
		st = a.cloneState()
		rec = st.Ranges[rangeID]
	}
	cursor, err := cursorFn()
	if err != nil {
		return Lease{}, err
	}
	if cursor < rec.Start {
		cursor = rec.Start
	}
	if cursor > rec.End {
		return Lease{}, ErrRangeExhausted
	}
	rec.Closed = false
	rec.NodeID = newNodeID
	rec.Start = cursor
	rec.Generation++
	if err := a.persist(st); err != nil {
		return Lease{}, err
	}
	a.state = *st
	return Lease{RangeID: rec.ID, Start: rec.Start, End: rec.End, Generation: rec.Generation}, nil
}

// Validate reports whether generation is still the live generation of
// rangeID. Nodes call it before issuing, so a stale generation is fenced.
func (a *Allocator) Validate(rangeID int64, generation uint64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkAlive(); err != nil {
		return err
	}
	rec := a.state.Ranges[rangeID]
	if rec == nil {
		return ErrRangeNotFound
	}
	if rec.Closed || rec.Generation != generation {
		return ErrFenced
	}
	return nil
}

// Next returns the next never-allocated integer; every id ever reserved is
// strictly below it.
func (a *Allocator) Next() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state.Next
}

// Ranges returns a snapshot of all range records, sorted by Start.
func (a *Allocator) Ranges() []Range {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Range, 0, len(a.state.Ranges))
	for _, r := range a.state.Ranges {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}
