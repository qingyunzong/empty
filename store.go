// Package quota implements a limit store whose principals are resolved
// through an alias graph. Aliasing two names merges their principals
// atomically (balances and active leases included); requests addressed to
// an old alias are charged to the new root. A principal may be split back
// apart only while it holds no active leases.
package quota

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrLimitExceeded is returned when a charge or lease would push a
	// principal past its limit.
	ErrLimitExceeded = errors.New("quota: limit exceeded")
	// ErrActiveLeases is returned when a split is attempted on a
	// principal that still holds active leases.
	ErrActiveLeases = errors.New("quota: split requires no active leases")
	// ErrUnknownLease is returned when releasing a lease that does not
	// exist on the resolved principal.
	ErrUnknownLease = errors.New("quota: unknown lease")
	// ErrNotAliased is returned when splitting names that are not
	// directly linked by an alias edge.
	ErrNotAliased = errors.New("quota: names are not directly aliased")
)

// share is the per-member ledger entry tracking how much limit and used
// balance a single name contributed to its principal. Keeping the ledger
// per member makes splits exact and keeps global quota conserved.
type share struct {
	limit int64
	used  int64
}

// Principal is the quota account of one connected component of the alias
// graph. Only graph roots carry a Principal.
type Principal struct {
	members map[string]*share
	leases  map[string]int64
}

// Limit is the total limit of the principal.
func (p *Principal) Limit() int64 {
	var total int64
	for _, s := range p.members {
		total += s.limit
	}
	return total
}

// Used is the total consumed balance of the principal.
func (p *Principal) Used() int64 {
	var total int64
	for _, s := range p.members {
		total += s.used
	}
	return total
}

// Leased is the total amount held by active leases.
func (p *Principal) Leased() int64 {
	var total int64
	for _, amount := range p.leases {
		total += amount
	}
	return total
}

// Available is the remaining chargeable quota.
func (p *Principal) Available() int64 {
	return p.Limit() - p.Used() - p.Leased()
}

// Cycle describes an alias request that was rejected because both names
// already resolve to the same principal; accepting it would create a
// cycle in the alias graph.
type Cycle struct {
	A string
	B string
}

// Store is a goroutine-safe limit store. All mutations that touch
// principals hold the same mutex, so merges are atomic with respect to
// charges, leases and splits.
type Store struct {
	mu     sync.Mutex
	parent map[string]string
	rank   map[string]int
	prin   map[string]*Principal // keyed by root name
	adj    map[string]map[string]bool
	cycles []Cycle

	granted  int64 // total limit ever granted via SetLimit
	consumed int64 // total amount ever consumed successfully
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{
		parent: make(map[string]string),
		rank:   make(map[string]int),
		prin:   make(map[string]*Principal),
		adj:    make(map[string]map[string]bool),
	}
}

func (s *Store) ensure(name string) {
	if _, ok := s.parent[name]; ok {
		return
	}
	s.parent[name] = name
	s.prin[name] = &Principal{
		members: map[string]*share{name: {}},
		leases:  make(map[string]int64),
	}
}

func (s *Store) find(name string) string {
	root := name
	for s.parent[root] != root {
		root = s.parent[root]
	}
	for s.parent[name] != root {
		s.parent[name], name = root, s.parent[name]
	}
	return root
}

// Resolve returns the canonical principal name for name, following alias
// links to the current root.
func (s *Store) Resolve(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	return s.find(name)
}

// SetLimit grants limit to the principal that name resolves to. The grant
// is recorded against the member ledger of name itself so later splits
// restore exactly the granted amounts.
func (s *Store) SetLimit(name string, limit int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root := s.find(name)
	p := s.prin[root]
	p.members[name].limit += limit
	s.granted += limit
}

// AddAlias links alias to target. If the two names already resolve to the
// same principal the request is recorded as a cycle report and rejected.
// Otherwise the two principals are merged atomically: the new root
// inherits the combined limit, used balance and all active leases, and
// later requests to either name are charged to the merged root.
func (s *Store) AddAlias(alias, target string) (merged bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(alias)
	s.ensure(target)
	ra, rb := s.find(alias), s.find(target)
	if ra == rb {
		s.cycles = append(s.cycles, Cycle{A: alias, B: target})
		return false, fmt.Errorf("quota: alias %q -> %q would close a cycle", alias, target)
	}
	// Union by rank; the surviving root keeps its name.
	if s.rank[ra] < s.rank[rb] {
		ra, rb = rb, ra
	}
	s.parent[rb] = ra
	if s.rank[ra] == s.rank[rb] {
		s.rank[ra]++
	}
	pa, pb := s.prin[ra], s.prin[rb]
	for name, sh := range pb.members {
		pa.members[name] = sh
	}
	for id, amount := range pb.leases {
		pa.leases[id] = amount
	}
	delete(s.prin, rb)
	if s.adj[alias] == nil {
		s.adj[alias] = make(map[string]bool)
	}
	if s.adj[target] == nil {
		s.adj[target] = make(map[string]bool)
	}
	s.adj[alias][target] = true
	s.adj[target][alias] = true
	return true, nil
}

// Cycles returns the cycle reports accumulated so far.
func (s *Store) Cycles() []Cycle {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Cycle, len(s.cycles))
	copy(out, s.cycles)
	return out
}

// Consume charges amount to the principal that name resolves to. Requests
// addressed to an old alias are charged along to the new root.
func (s *Store) Consume(name string, amount int64) error {
	if amount < 0 {
		return fmt.Errorf("quota: negative consume amount %d", amount)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root := s.find(name)
	p := s.prin[root]
	if p.Available() < amount {
		return fmt.Errorf("%w: %q has %d available, need %d", ErrLimitExceeded, root, p.Available(), amount)
	}
	p.members[name].used += amount
	s.consumed += amount
	return nil
}

// AcquireLease holds amount of quota under id on the principal that name
// resolves to.
func (s *Store) AcquireLease(name, id string, amount int64) error {
	if amount < 0 {
		return fmt.Errorf("quota: negative lease amount %d", amount)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root := s.find(name)
	p := s.prin[root]
	if p.Available() < amount {
		return fmt.Errorf("%w: %q has %d available, need %d", ErrLimitExceeded, root, p.Available(), amount)
	}
	p.leases[id] += amount
	return nil
}

// ReleaseLease returns the quota held under id.
func (s *Store) ReleaseLease(name, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root := s.find(name)
	p := s.prin[root]
	if _, ok := p.leases[id]; !ok {
		return fmt.Errorf("%w: %q on %q", ErrUnknownLease, id, root)
	}
	delete(p.leases, id)
	return nil
}

// Snapshot returns a consistent view of the principal that name resolves
// to: canonical root, limit, used and leased totals.
func (s *Store) Snapshot(name string) (root string, limit, used, leased int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root = s.find(name)
	p := s.prin[root]
	return root, p.Limit(), p.Used(), p.Leased()
}

// Split removes the direct alias edge between a and b and rebuilds the
// affected component(s) from the remaining edges. It fails with
// ErrActiveLeases while the principal holds any active lease, because a
// lease cannot be attributed to exactly one side of the split. Member
// limit/used shares follow their names, so the split conserves quota.
func (s *Store) Split(a, b string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(a)
	s.ensure(b)
	if s.find(a) != s.find(b) {
		return fmt.Errorf("%w: %q and %q are not in the same principal", ErrNotAliased, a, b)
	}
	if !s.adj[a][b] {
		return fmt.Errorf("%w: no direct alias edge between %q and %q", ErrNotAliased, a, b)
	}
	root := s.find(a)
	p := s.prin[root]
	if len(p.leases) > 0 {
		return fmt.Errorf("%w: %q holds %d active leases", ErrActiveLeases, root, len(p.leases))
	}

	delete(s.adj[a], b)
	delete(s.adj[b], a)

	// Collect the old component's members.
	members := make([]string, 0, len(p.members))
	for name := range p.members {
		members = append(members, name)
	}
	// Detach every member, then re-union along the remaining edges.
	for _, name := range members {
		s.parent[name] = name
		s.rank[name] = 0
	}
	delete(s.prin, root)
	for x, ys := range s.adj {
		if p.members[x] == nil {
			continue
		}
		for y := range ys {
			if p.members[y] == nil {
				continue
			}
			s.unionRoots(x, y)
		}
	}
	// Rebuild principals from the per-member shares.
	roots := make(map[string]*Principal)
	for _, name := range members {
		r := s.find(name)
		np, ok := roots[r]
		if !ok {
			np = &Principal{members: make(map[string]*share), leases: make(map[string]int64)}
			roots[r] = np
		}
		np.members[name] = p.members[name]
	}
	for r, np := range roots {
		s.prin[r] = np
	}
	return nil
}

// unionRoots merges the sets containing x and y without touching
// principals; used only while rebuilding after a split.
func (s *Store) unionRoots(x, y string) {
	rx, ry := s.find(x), s.find(y)
	if rx == ry {
		return
	}
	if s.rank[rx] < s.rank[ry] {
		rx, ry = ry, rx
	}
	s.parent[ry] = rx
	if s.rank[rx] == s.rank[ry] {
		s.rank[rx]++
	}
}

// Members returns the sorted member names of the principal that name
// resolves to.
func (s *Store) Members(name string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure(name)
	root := s.find(name)
	out := make([]string, 0, len(s.prin[root].members))
	for m := range s.prin[root].members {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// VerifyConservation checks global quota conservation across all roots:
// the sum of root limits must equal everything ever granted, and the sum
// of used balances must equal everything ever consumed. It returns a
// detailed error on the first violation found.
func (s *Store) VerifyConservation() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var limitSum, usedSum int64
	for _, p := range s.prin {
		limitSum += p.Limit()
		usedSum += p.Used()
	}
	if limitSum != s.granted {
		return fmt.Errorf("quota: limit not conserved: roots hold %d, granted %d", limitSum, s.granted)
	}
	if usedSum != s.consumed {
		return fmt.Errorf("quota: usage not conserved: roots hold %d, consumed %d", usedSum, s.consumed)
	}
	return nil
}
