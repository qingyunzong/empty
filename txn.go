// Package txnlib implements a transaction manager that records read
// predicates and write sets, certifies commits by detecting
// anti-dependency cycles in the serialization graph (range phantoms
// included), and aborts the newest commit requester on conflict.
//
// Histories are limited to MaxTransactions transactions so the accepted
// history can always be re-checked by the independent serial-order
// enumerator in verify.go.
package txnlib

import (
	"fmt"
	"sync"
)

// MaxTransactions bounds a history so the independent verifier
// (subset DP over serial orders, 2^n states) stays tractable.
const MaxTransactions = 12

// TxnID identifies a transaction within a Manager.
type TxnID int

// Predicate is an inclusive key range [Lo, Hi]; Lo == Hi is a point read.
type Predicate struct {
	Lo, Hi string
}

// Covers reports whether key falls inside the predicate range.
func (p Predicate) Covers(key string) bool { return p.Lo <= key && key <= p.Hi }

func (p Predicate) String() string {
	if p.Lo == p.Hi {
		return p.Lo
	}
	return "[" + p.Lo + "," + p.Hi + "]"
}

// ReadOp records one predicate read and the values it observed.
type ReadOp struct {
	Seq    int
	Pred   Predicate
	Values map[string]string
}

// WriteOp records one write; Seq is assigned at commit time, when the
// write becomes atomically visible.
type WriteOp struct {
	Seq   int
	Key   string
	Value string
}

type txnState int

const (
	stateActive txnState = iota
	stateCommitted
	stateAborted
)

// Txn holds the recorded read predicates and write set of a transaction.
type Txn struct {
	ID     TxnID
	Reads  []ReadOp
	Writes []WriteOp

	reqSeq int // commit-request sequence number
	state  txnState
	windex map[string]int // key -> index in Writes
}

// State reports whether the transaction is active, committed, or aborted.
func (t *Txn) State() string {
	switch t.state {
	case stateActive:
		return "active"
	case stateCommitted:
		return "committed"
	default:
		return "aborted"
	}
}

// Manager serializes commits against the committed history.
type Manager struct {
	mu        sync.Mutex
	clock     int
	store     map[string]string
	txns      map[TxnID]*Txn
	committed []*Txn // in commit order
	nextID    int
}

// NewManager returns an empty manager with an empty committed store.
func NewManager() *Manager {
	return &Manager{
		store: make(map[string]string),
		txns:  make(map[TxnID]*Txn),
	}
}

// Begin starts a transaction. Histories are capped at MaxTransactions.
func (m *Manager) Begin() (*Txn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.txns) >= MaxTransactions {
		return nil, fmt.Errorf("txnlib: history limited to %d transactions", MaxTransactions)
	}
	m.nextID++
	t := &Txn{ID: TxnID(m.nextID), windex: make(map[string]int)}
	m.txns[t.ID] = t
	return t, nil
}

// Read records the predicate and returns the committed key/value pairs
// it covers, overlaid with the transaction's own pending writes.
func (m *Manager) Read(t *Txn, p Predicate) (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.state != stateActive {
		return nil, fmt.Errorf("txnlib: read on non-active transaction T%d", t.ID)
	}
	m.clock++
	vals := make(map[string]string)
	for k, v := range m.store {
		if p.Covers(k) {
			vals[k] = v
		}
	}
	for _, w := range t.Writes {
		if p.Covers(w.Key) {
			vals[w.Key] = w.Value
		}
	}
	t.Reads = append(t.Reads, ReadOp{Seq: m.clock, Pred: p, Values: vals})
	return vals, nil
}

// Write buffers a write in the transaction's write set.
func (m *Manager) Write(t *Txn, key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.state != stateActive {
		return fmt.Errorf("txnlib: write on non-active transaction T%d", t.ID)
	}
	if i, ok := t.windex[key]; ok {
		t.Writes[i].Value = value
		return nil
	}
	t.windex[key] = len(t.Writes)
	t.Writes = append(t.Writes, WriteOp{Key: key, Value: value})
	return nil
}

// Commit certifies the transaction against the committed history. It
// builds the serialization graph over committed transactions plus the
// requester; if an anti-dependency cycle exists, the cycle member with
// the newest commit-request sequence (the requester, by induction) is
// aborted and a *CommitError carrying the cycle evidence is returned.
func (m *Manager) Commit(t *Txn) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.state != stateActive {
		return fmt.Errorf("txnlib: commit on non-active transaction T%d", t.ID)
	}
	m.clock++
	t.reqSeq = m.clock
	for i := range t.Writes {
		m.clock++
		t.Writes[i].Seq = m.clock
	}
	set := append(append([]*Txn{}, m.committed...), t)
	edges := buildEdges(set)
	if cycle, cycEdges := findCycle(set, edges); cycle != nil {
		victim := t
		for _, id := range cycle {
			if m.txns[id].reqSeq > victim.reqSeq {
				victim = m.txns[id]
			}
		}
		// The committed prefix is acyclic by induction, so any new cycle
		// involves the requester, which holds the newest request seq.
		if victim.state != stateActive {
			victim = t
		}
		victim.state = stateAborted
		return &CommitError{Victim: victim.ID, Cycle: cycle, Edges: cycEdges}
	}
	t.state = stateCommitted
	for _, w := range t.Writes {
		m.store[w.Key] = w.Value
	}
	m.committed = append(m.committed, t)
	return nil
}

// Abort rolls back an active transaction without certification.
func (m *Manager) Abort(t *Txn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.state == stateActive {
		t.state = stateAborted
	}
}

// Committed returns the committed transactions in commit order.
func (m *Manager) Committed() []*Txn {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]*Txn{}, m.committed...)
}

// Data returns a snapshot of the committed store.
func (m *Manager) Data() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]string, len(m.store))
	for k, v := range m.store {
		out[k] = v
	}
	return out
}
