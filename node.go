package idalloc

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

var (
	ErrNoLease   = errors.New("idalloc: node holds no lease")
	ErrExhausted = errors.New("idalloc: lease exhausted")
)

// NodeState is the durable per-node record: which range generation it holds
// and the next id it will issue (Cursor). Cursor is persisted before the id
// is handed out, so a crash burns the id (a hole) instead of reissuing it.
type NodeState struct {
	RangeID    int64  `json:"rangeId"`
	Generation uint64 `json:"generation"`
	Start      int64  `json:"start"`
	End        int64  `json:"end"` // inclusive
	Cursor     int64  `json:"cursor"`
}

func nodeKey(nodeID string) string { return fmt.Sprintf("node-%s.json", nodeID) }

// LoadNodeState reads a node's durable state directly from storage, e.g. to
// obtain a crashed owner's cursor before transferring its range.
func LoadNodeState(store Storage, nodeID string) (NodeState, error) {
	data, err := store.Read(nodeKey(nodeID))
	if err != nil {
		return NodeState{}, err
	}
	var st NodeState
	if err := json.Unmarshal(data, &st); err != nil {
		return NodeState{}, fmt.Errorf("idalloc: corrupt node state: %w", err)
	}
	return st, nil
}

// Node issues ids from its current lease. After a restart, Load resumes
// from the durable cursor, so only the unconsumed tail of the range is used
// and no consumed id is ever reissued.
type Node struct {
	mu       sync.Mutex
	id       string
	store    Storage
	alloc    *Allocator
	gen      uint64
	state    NodeState
	hasLease bool
}

func NewNode(id string, store Storage, alloc *Allocator) *Node {
	return &Node{id: id, store: store, alloc: alloc, gen: store.Generation()}
}

func (n *Node) checkAlive() error {
	if n.store.Generation() != n.gen {
		return ErrCrashed
	}
	return nil
}

func (n *Node) persist(st *NodeState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := n.store.Write(nodeKey(n.id), data); err != nil {
		return err
	}
	if err := n.store.Sync(); err != nil {
		return err
	}
	return n.checkAlive()
}

// Load restores durable state after a restart. A lease whose generation was
// superseded by a transfer is fenced off and the node starts without one.
func (n *Node) Load() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkAlive(); err != nil {
		return err
	}
	st, err := LoadNodeState(n.store, n.id)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := n.alloc.Validate(st.RangeID, st.Generation); err != nil {
		if errors.Is(err, ErrFenced) || errors.Is(err, ErrRangeNotFound) {
			return nil
		}
		return err
	}
	n.state = st
	n.hasLease = true
	return nil
}

// Acquire allocates a fresh range and adopts it as the node's lease.
func (n *Node) Acquire(size int64) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkAlive(); err != nil {
		return err
	}
	lease, err := n.alloc.Allocate(n.id, size)
	if err != nil {
		return err
	}
	return n.adoptLocked(lease)
}

// Attach adopts a lease obtained from Allocator.Transfer.
func (n *Node) Attach(lease Lease) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkAlive(); err != nil {
		return err
	}
	if err := n.alloc.Validate(lease.RangeID, lease.Generation); err != nil {
		return err
	}
	return n.adoptLocked(lease)
}

func (n *Node) adoptLocked(lease Lease) error {
	st := NodeState{
		RangeID:    lease.RangeID,
		Generation: lease.Generation,
		Start:      lease.Start,
		End:        lease.End,
		Cursor:     lease.Start,
	}
	if err := n.persist(&st); err != nil {
		return err // range stays reserved but unused: a hole, never a duplicate
	}
	n.state = st
	n.hasLease = true
	return nil
}

// HandOver closes this node's generation at the allocator and transfers the
// unconsumed tail to newNodeID, returning the new owner's lease. The node's
// in-memory cursor always equals its durable cursor, so the tail starts
// exactly at the first unissued id.
func (n *Node) HandOver(newNodeID string) (Lease, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkAlive(); err != nil {
		return Lease{}, err
	}
	if !n.hasLease {
		return Lease{}, ErrNoLease
	}
	// Refuse to hand over a lease that was already transferred away:
	// our cursor would no longer reflect the range's consumed prefix.
	if err := n.alloc.Validate(n.state.RangeID, n.state.Generation); err != nil {
		return Lease{}, err
	}
	// n.mu is held for the whole handover, so no concurrent Issue can
	// advance the cursor before the old generation is closed.
	cursor := n.state.Cursor
	lease, err := n.alloc.Transfer(n.state.RangeID, newNodeID, func() (int64, error) {
		return cursor, nil
	})
	if err != nil {
		return Lease{}, err
	}
	n.hasLease = false
	return lease, nil
}

// Issue returns the next id of the lease. The advanced cursor is persisted
// before the id is returned; if persisting fails the id is not consumed and
// the caller gets an error instead.
func (n *Node) Issue() (int64, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkAlive(); err != nil {
		return 0, err
	}
	if !n.hasLease {
		return 0, ErrNoLease
	}
	if err := n.alloc.Validate(n.state.RangeID, n.state.Generation); err != nil {
		return 0, err
	}
	if n.state.Cursor > n.state.End {
		return 0, ErrExhausted
	}
	id := n.state.Cursor
	st := n.state
	st.Cursor++
	if err := n.persist(&st); err != nil {
		return 0, err
	}
	// Re-validate now that the cursor is durable: if a transfer closed
	// this generation in between, burn the id (a hole) rather than hand
	// out an integer the new owner may also issue.
	if err := n.alloc.Validate(n.state.RangeID, n.state.Generation); err != nil {
		return 0, err
	}
	n.state = st
	return id, nil
}
