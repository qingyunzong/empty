// Package txnlib implements a transaction library that records read
// predicates and write sets, detects anti-dependency cycles at commit
// time, and aborts the newest commit requester in the cycle.
package txnlib

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// MaxHistory bounds how many committed transactions the store retains.
const MaxHistory = 12

// ErrAborted is returned by Commit when the committer is chosen as the
// victim of a dependency cycle.
var ErrAborted = errors.New("txnlib: transaction aborted (dependency cycle)")

// Predicate is a half-open key range [Lo, Hi) used by range scans.
// An empty Hi means unbounded above.
type Predicate struct {
	Lo string
	Hi string
}

// Matches reports whether key falls inside the predicate range.
func (p Predicate) Matches(key string) bool {
	if key < p.Lo {
		return false
	}
	return p.Hi == "" || key < p.Hi
}

func (p Predicate) String() string {
	if p.Hi == "" {
		return fmt.Sprintf("[%s,∞)", p.Lo)
	}
	return fmt.Sprintf("[%s,%s)", p.Lo, p.Hi)
}

// EdgeKind classifies a dependency between two transactions.
type EdgeKind int

const (
	// WR: the source wrote a version the target read.
	WR EdgeKind = iota
	// WW: the source wrote a version the target overwrote.
	WW
	// RW: anti-dependency; the source read a version the target replaced.
	RW
)

func (k EdgeKind) String() string {
	switch k {
	case WR:
		return "wr"
	case WW:
		return "ww"
	case RW:
		return "rw"
	}
	return "?"
}

// Edge is a directed dependency From -> To with a human-readable reason.
type Edge struct {
	From int
	To   int
	Kind EdgeKind
	Key  string
	// Phantom is true when the edge arises from a range predicate match
	// rather than a point read.
	Phantom bool
}

func (e Edge) String() string {
	via := "key"
	if e.Phantom {
		via = "phantom"
	}
	return fmt.Sprintf("T%d -%s(%s %q)-> T%d", e.From, e.Kind, via, e.Key, e.To)
}

// Status is the lifecycle state of a transaction.
type Status int

const (
	Active Status = iota
	Committed
	Aborted
)

// Txn records the read predicates and write set of one transaction.
type Txn struct {
	ID        int
	BeginSeq  int64
	CommitSeq int64

	ReadKeys   map[string]struct{}
	Predicates []Predicate
	Writes     map[string]struct{}

	Status Status
}

// CycleEvidence describes one dependency cycle found at commit time.
type CycleEvidence struct {
	// Txns lists the transaction IDs on the cycle, in edge order.
	Txns []int
	// Edges lists the dependencies forming the cycle.
	Edges []Edge
	// Victim is the transaction chosen for abort: the newest commit
	// requester on the cycle.
	Victim int
}

func (c *CycleEvidence) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "cycle over %v, victim T%d:", c.Txns, c.Victim)
	for _, e := range c.Edges {
		fmt.Fprintf(&b, "\n  %s", e)
	}
	return b.String()
}

// Store serializes commit requests, keeps the accepted history (bounded
// to MaxHistory transactions), and the dependency edges among them.
type Store struct {
	mu        sync.Mutex
	clock     int64
	nextID    int
	committed []*Txn
	edges     []Edge
}

// NewStore returns an empty store.
func NewStore() *Store { return &Store{} }

// Begin starts a new transaction and snapshots the commit clock.
func (s *Store) Begin() *Txn {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	return &Txn{
		ID:       s.nextID,
		BeginSeq: s.clock,
		ReadKeys: map[string]struct{}{},
		Writes:   map[string]struct{}{},
	}
}

// Read records a point read of key.
func (t *Txn) Read(key string) { t.ReadKeys[key] = struct{}{} }

// Scan records a range read over the half-open interval [lo, hi).
// Writes by other transactions whose keys fall in this range create
// phantom edges.
func (t *Txn) Scan(lo, hi string) { t.Predicates = append(t.Predicates, Predicate{Lo: lo, Hi: hi}) }

// Write records key in the transaction's write set.
func (t *Txn) Write(key string) { t.Writes[key] = struct{}{} }

// readsKey reports whether the transaction read key, either by a point
// read or through a matching range predicate.
func (t *Txn) readsKey(key string) bool {
	if _, ok := t.ReadKeys[key]; ok {
		return true
	}
	for _, p := range t.Predicates {
		if p.Matches(key) {
			return true
		}
	}
	return false
}

// readsKeyViaPredicate reports whether a predicate (not a point read)
// is responsible for the transaction reading key.
func (t *Txn) readsKeyViaPredicate(key string) bool {
	if _, ok := t.ReadKeys[key]; ok {
		return false
	}
	for _, p := range t.Predicates {
		if p.Matches(key) {
			return true
		}
	}
	return false
}

// edgesBetween computes every dependency edge between committed
// transactions a and b, where a requested commit before b
// (a.CommitSeq < b.CommitSeq).
func edgesBetween(a, b *Txn) []Edge {
	var out []Edge
	keys := map[string]struct{}{}
	for k := range a.Writes {
		keys[k] = struct{}{}
	}
	for k := range b.Writes {
		keys[k] = struct{}{}
	}
	for k := range a.ReadKeys {
		keys[k] = struct{}{}
	}
	for k := range b.ReadKeys {
		keys[k] = struct{}{}
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)

	for _, k := range sorted {
		aWrote := contains(a.Writes, k)
		bWrote := contains(b.Writes, k)
		aRead := a.readsKey(k)
		bRead := b.readsKey(k)

		switch {
		case aWrote && bWrote:
			out = append(out, Edge{From: a.ID, To: b.ID, Kind: WW, Key: k})
		case aWrote && bRead:
			if a.CommitSeq <= b.BeginSeq {
				// b observed a's version.
				out = append(out, Edge{From: a.ID, To: b.ID, Kind: WR, Key: k, Phantom: b.readsKeyViaPredicate(k)})
			} else {
				// Concurrent: b read a stale version, a overwrote it.
				out = append(out, Edge{From: b.ID, To: a.ID, Kind: RW, Key: k, Phantom: b.readsKeyViaPredicate(k)})
			}
		}
		if aRead && bWrote {
			// b commits after a, so a never observed b's version.
			out = append(out, Edge{From: a.ID, To: b.ID, Kind: RW, Key: k, Phantom: a.readsKeyViaPredicate(k)})
		}
	}
	return out
}

func contains(set map[string]struct{}, k string) bool {
	_, ok := set[k]
	return ok
}

// Commit requests commitment of t. Commit requests are serialized, so
// t is the newest requester; if adding t closes a dependency cycle, the
// newest requester on the cycle is aborted and the cycle evidence is
// returned. On success the accepted history is trimmed to MaxHistory.
func (s *Store) Commit(t *Txn) (*CycleEvidence, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.Status != Active {
		return nil, fmt.Errorf("txnlib: transaction T%d is not active", t.ID)
	}
	s.clock++
	t.CommitSeq = s.clock

	var newEdges []Edge
	for _, u := range s.committed {
		newEdges = append(newEdges, edgesBetween(u, t)...)
	}

	nodes := make([]*Txn, 0, len(s.committed)+1)
	nodes = append(nodes, s.committed...)
	nodes = append(nodes, t)
	allEdges := make([]Edge, 0, len(s.edges)+len(newEdges))
	allEdges = append(allEdges, s.edges...)
	allEdges = append(allEdges, newEdges...)

	if cyc := findCycle(nodes, allEdges, t.ID); cyc != nil {
		victim := newestRequester(nodes, cyc)
		ev := &CycleEvidence{Txns: cyc, Edges: cycleEdges(allEdges, cyc), Victim: victim}
		if victim == t.ID {
			t.Status = Aborted
			return ev, ErrAborted
		}
		// A previously committed transaction is the victim: evict it
		// and accept t instead.
		s.evict(victim)
		for _, u := range s.committed {
			if u.ID == victim {
				u.Status = Aborted
			}
		}
	}

	t.Status = Committed
	s.committed = append(s.committed, t)
	s.edges = append(s.edges, newEdges...)
	s.trim()
	return nil, nil
}

// evict removes the transaction with the given id and its edges.
func (s *Store) evict(id int) {
	kept := s.committed[:0]
	for _, u := range s.committed {
		if u.ID == id {
			u.Status = Aborted
			continue
		}
		kept = append(kept, u)
	}
	s.committed = kept
	keptEdges := s.edges[:0]
	for _, e := range s.edges {
		if e.From == id || e.To == id {
			continue
		}
		keptEdges = append(keptEdges, e)
	}
	s.edges = keptEdges
}

// trim drops the oldest committed transactions beyond MaxHistory.
func (s *Store) trim() {
	for len(s.committed) > MaxHistory {
		s.evict(s.committed[0].ID)
	}
}

// History returns the retained committed transactions, oldest first.
func (s *Store) History() []*Txn {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Txn, len(s.committed))
	copy(out, s.committed)
	return out
}

// Edges returns the dependency edges among the retained history.
func (s *Store) Edges() []Edge {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Edge, len(s.edges))
	copy(out, s.edges)
	return out
}

// newestRequester returns the ID of the transaction on the cycle with
// the largest commit-request sequence number.
func newestRequester(nodes []*Txn, cycle []int) int {
	seq := map[int]int64{}
	for _, n := range nodes {
		seq[n.ID] = n.CommitSeq
	}
	victim, best := cycle[0], seq[cycle[0]]
	for _, id := range cycle[1:] {
		if seq[id] > best {
			best, victim = seq[id], id
		}
	}
	return victim
}

// findCycle looks for a directed cycle that passes through start and
// returns the cycle's node IDs in edge order, or nil.
func findCycle(nodes []*Txn, edges []Edge, start int) []int {
	adj := map[int][]int{}
	for _, e := range edges {
		adj[e.From] = append(adj[e.From], e.To)
	}
	// Deterministic traversal.
	for from := range adj {
		sort.Ints(adj[from])
	}
	var path []int
	onPath := map[int]bool{}
	var visit func(n int) []int
	visit = func(n int) []int {
		path = append(path, n)
		onPath[n] = true
		for _, m := range adj[n] {
			if m == start && len(path) >= 1 {
				return append([]int(nil), path...)
			}
			if !onPath[m] {
				if cyc := visit(m); cyc != nil {
					return cyc
				}
			}
		}
		path = path[:len(path)-1]
		delete(onPath, n)
		return nil
	}
	return visit(start)
}

// cycleEdges returns, for each consecutive pair on the cycle (including
// the closing pair), the first edge that connects them.
func cycleEdges(edges []Edge, cycle []int) []Edge {
	var out []Edge
	n := len(cycle)
	for i := 0; i < n; i++ {
		from, to := cycle[i], cycle[(i+1)%n]
		for _, e := range edges {
			if e.From == from && e.To == to {
				out = append(out, e)
				break
			}
		}
	}
	return out
}
