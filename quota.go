// Package quota implements a quota store whose principals are resolved
// through an alias graph. Principals can be renamed, merged and split;
// consumption through an old alias is billed to the current root.
package quota

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Principal is a quota-bearing entity. Balance is the remaining spendable
// quota, Consumed is the total billed so far, and Leases holds quota that
// is temporarily locked by active leases.
type Principal struct {
	ID       string
	Limit    int64
	Balance  int64
	Consumed int64
	Leases   map[string]int64
}

func (p *Principal) leased() int64 {
	var total int64
	for _, amount := range p.Leases {
		total += amount
	}
	return total
}

// CycleError is returned when alias resolution encounters a cycle.
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("quota: alias cycle detected: %s", strings.Join(e.Path, " -> "))
}

// ErrUnknown is returned when a name resolves to no principal.
var ErrUnknown = errors.New("quota: unknown principal")

// ErrInsufficient is returned when a principal lacks spendable balance.
var ErrInsufficient = errors.New("quota: insufficient balance")

// ErrActiveLeases is returned by Split when the principal has active leases.
var ErrActiveLeases = errors.New("quota: split requires no active leases")

// ErrExists is returned when a name is already taken.
var ErrExists = errors.New("quota: name already exists")

// Store keeps principals and the alias graph.
type Store struct {
	principals map[string]*Principal
	alias      map[string]string
	leaseOwner map[string]string // lease ID -> owning root
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{
		principals: make(map[string]*Principal),
		alias:      make(map[string]string),
		leaseOwner: make(map[string]string),
	}
}

// AddPrincipal registers a new principal with the given quota limit.
func (s *Store) AddPrincipal(id string, limit int64) error {
	if limit < 0 {
		return fmt.Errorf("quota: negative limit %d", limit)
	}
	if s.taken(id) {
		return fmt.Errorf("%w: %q", ErrExists, id)
	}
	s.principals[id] = &Principal{ID: id, Limit: limit, Balance: limit, Leases: make(map[string]int64)}
	return nil
}

// liveRoot reports whether name is a principal root with no outgoing
// alias edge, i.e. a name Resolve would return.
func (s *Store) liveRoot(name string) (string, bool) {
	if _, ok := s.principals[name]; !ok {
		return "", false
	}
	_, aliased := s.alias[name]
	return name, !aliased
}

func (s *Store) taken(name string) bool {
	if _, ok := s.principals[name]; ok {
		return true
	}
	_, ok := s.alias[name]
	return ok
}

// Resolve follows the alias graph from name to its root principal ID.
// A cycle in the graph is reported as *CycleError.
func (s *Store) Resolve(name string) (string, error) {
	seen := map[string]int{}
	var path []string
	cur := name
	for {
		if _, ok := s.principals[cur]; ok {
			if _, aliased := s.alias[cur]; !aliased {
				return cur, nil
			}
		}
		if idx, ok := seen[cur]; ok {
			return "", &CycleError{Path: append(append([]string{}, path[idx:]...), cur)}
		}
		seen[cur] = len(path)
		path = append(path, cur)
		next, ok := s.alias[cur]
		if !ok {
			return "", fmt.Errorf("%w: %q", ErrUnknown, name)
		}
		cur = next
	}
}

func (s *Store) lookup(name string) (*Principal, error) {
	root, err := s.Resolve(name)
	if err != nil {
		return nil, err
	}
	return s.principals[root], nil
}

// ReportCycles returns every cycle currently present in the alias graph.
// Each cycle is reported once, as the list of names forming the loop.
func (s *Store) ReportCycles() [][]string {
	const (
		white = iota // unvisited
		gray         // on the current DFS stack
		black        // fully explored
	)
	color := map[string]int{}
	var stack []string
	var cycles [][]string
	inCycle := map[string]bool{}

	names := make([]string, 0, len(s.alias))
	for name := range s.alias {
		names = append(names, name)
	}
	sort.Strings(names)

	var visit func(name string)
	visit = func(name string) {
		color[name] = gray
		stack = append(stack, name)
		if next, ok := s.alias[name]; ok {
			switch color[next] {
			case gray:
				idx := 0
				for i, n := range stack {
					if n == next {
						idx = i
						break
					}
				}
				cycle := append([]string{}, stack[idx:]...)
				// Canonicalize so each cycle is reported once.
				dup := false
				for _, n := range cycle {
					if inCycle[n] {
						dup = true
						break
					}
				}
				if !dup {
					for _, n := range cycle {
						inCycle[n] = true
					}
					cycles = append(cycles, cycle)
				}
			case white:
				visit(next)
			}
		}
		stack = stack[:len(stack)-1]
		color[name] = black
	}
	for _, name := range names {
		if color[name] == white {
			visit(name)
		}
	}
	return cycles
}

// Rename points the name old at the name new. If old is currently a root
// principal, its record is re-keyed to new and an alias old -> new is left
// behind, so requests via the old name are billed to the new root. The new
// name must not be a live principal root (use Merge for that); renaming
// onto an existing alias is allowed and may strand the record behind a
// cycle, which ReportCycles will surface. Re-pointing an existing alias is
// allowed as well.
func (s *Store) Rename(old, new string) error {
	if old == new {
		return fmt.Errorf("quota: cannot rename %q to itself", old)
	}
	if p, ok := s.principals[old]; ok {
		if _, aliased := s.alias[old]; !aliased {
			if _, live := s.liveRoot(new); live {
				return fmt.Errorf("%w: %q is a live principal, use Merge", ErrExists, new)
			}
			delete(s.principals, old)
			p.ID = new
			s.principals[new] = p
			for leaseID, owner := range s.leaseOwner {
				if owner == old {
					s.leaseOwner[leaseID] = new
				}
			}
			s.alias[old] = new
			return nil
		}
	}
	// Re-pointing an alias (or unknown name): just set the edge.
	if _, ok := s.alias[old]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknown, old)
	}
	s.alias[old] = new
	return nil
}

// Merge atomically folds the principal resolved from src into the one
// resolved from dst: limits, balances, consumed totals and active leases
// are combined under dst's root, and src's root becomes an alias of it.
// If the two names already share a root, Merge is a no-op. A lease-ID
// clash aborts the merge before any state is mutated.
func (s *Store) Merge(dst, src string) error {
	rdst, err := s.Resolve(dst)
	if err != nil {
		return err
	}
	rsrc, err := s.Resolve(src)
	if err != nil {
		return err
	}
	if rdst == rsrc {
		return nil
	}
	pdst := s.principals[rdst]
	psrc := s.principals[rsrc]
	// Validate first so the merge is atomic.
	for leaseID := range psrc.Leases {
		if _, clash := pdst.Leases[leaseID]; clash {
			return fmt.Errorf("quota: merge aborted, lease %q exists on both principals", leaseID)
		}
	}
	pdst.Limit += psrc.Limit
	pdst.Balance += psrc.Balance
	pdst.Consumed += psrc.Consumed
	for leaseID, amount := range psrc.Leases {
		pdst.Leases[leaseID] = amount
		s.leaseOwner[leaseID] = rdst
	}
	delete(s.principals, rsrc)
	s.alias[rsrc] = rdst
	return nil
}

// Split carves amount of quota out of the principal resolved from root
// into a brand-new principal newID. Split is only allowed when the source
// principal has no active leases.
func (s *Store) Split(root, newID string, amount int64) error {
	if s.taken(newID) {
		return fmt.Errorf("%w: %q", ErrExists, newID)
	}
	p, err := s.lookup(root)
	if err != nil {
		return err
	}
	if len(p.Leases) > 0 {
		return fmt.Errorf("%w: %q has %d active lease(s)", ErrActiveLeases, p.ID, len(p.Leases))
	}
	if amount <= 0 || amount > p.Balance {
		return fmt.Errorf("%w: cannot split %d from balance %d", ErrInsufficient, amount, p.Balance)
	}
	p.Limit -= amount
	p.Balance -= amount
	s.principals[newID] = &Principal{ID: newID, Limit: amount, Balance: amount, Leases: make(map[string]int64)}
	return nil
}

// Consume bills amount against the principal resolved from name. Requests
// arriving through an old alias are billed to the current root.
func (s *Store) Consume(name string, amount int64) error {
	p, err := s.lookup(name)
	if err != nil {
		return err
	}
	if amount <= 0 {
		return fmt.Errorf("quota: non-positive amount %d", amount)
	}
	if p.Balance < amount {
		return fmt.Errorf("%w: %q has %d, need %d", ErrInsufficient, p.ID, p.Balance, amount)
	}
	p.Balance -= amount
	p.Consumed += amount
	return nil
}

// AcquireLease locks amount of balance under leaseID on the principal
// resolved from name.
func (s *Store) AcquireLease(name, leaseID string, amount int64) error {
	if _, ok := s.leaseOwner[leaseID]; ok {
		return fmt.Errorf("%w: lease %q", ErrExists, leaseID)
	}
	p, err := s.lookup(name)
	if err != nil {
		return err
	}
	if amount <= 0 {
		return fmt.Errorf("quota: non-positive amount %d", amount)
	}
	if p.Balance < amount {
		return fmt.Errorf("%w: %q has %d, need %d", ErrInsufficient, p.ID, p.Balance, amount)
	}
	p.Balance -= amount
	p.Leases[leaseID] = amount
	s.leaseOwner[leaseID] = p.ID
	return nil
}

// ReleaseLease returns the leased amount to the owner's balance.
func (s *Store) ReleaseLease(leaseID string) error {
	p, amount, err := s.lease(leaseID)
	if err != nil {
		return err
	}
	delete(p.Leases, leaseID)
	delete(s.leaseOwner, leaseID)
	p.Balance += amount
	return nil
}

// CommitLease converts the leased amount into consumed quota.
func (s *Store) CommitLease(leaseID string) error {
	p, amount, err := s.lease(leaseID)
	if err != nil {
		return err
	}
	delete(p.Leases, leaseID)
	delete(s.leaseOwner, leaseID)
	p.Consumed += amount
	return nil
}

func (s *Store) lease(leaseID string) (*Principal, int64, error) {
	owner, ok := s.leaseOwner[leaseID]
	if !ok {
		return nil, 0, fmt.Errorf("%w: lease %q", ErrUnknown, leaseID)
	}
	p := s.principals[owner]
	amount, ok := p.Leases[leaseID]
	if !ok {
		return nil, 0, fmt.Errorf("quota: lease %q not held by %q", leaseID, owner)
	}
	return p, amount, nil
}

// Principal returns the principal resolved from name, or nil.
func (s *Store) Principal(name string) *Principal {
	p, err := s.lookup(name)
	if err != nil {
		return nil
	}
	return p
}

// VerifyConservation checks the global quota invariant: for every
// principal, balance + leased + consumed equals its limit, and every
// tracked lease points at its owner. It returns the first violation found.
func (s *Store) VerifyConservation() error {
	var limitTotal, heldTotal int64
	seenLeases := map[string]bool{}
	ids := make([]string, 0, len(s.principals))
	for id := range s.principals {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := s.principals[id]
		held := p.Balance + p.leased() + p.Consumed
		if held != p.Limit {
			return fmt.Errorf("quota: conservation violated on %q: balance %d + leased %d + consumed %d = %d, limit %d",
				id, p.Balance, p.leased(), p.Consumed, held, p.Limit)
		}
		for leaseID := range p.Leases {
			if seenLeases[leaseID] {
				return fmt.Errorf("quota: lease %q held by more than one principal", leaseID)
			}
			seenLeases[leaseID] = true
			if s.leaseOwner[leaseID] != id {
				return fmt.Errorf("quota: lease %q owner index points at %q, held by %q", leaseID, s.leaseOwner[leaseID], id)
			}
		}
		limitTotal += p.Limit
		heldTotal += held
	}
	if limitTotal != heldTotal {
		return fmt.Errorf("quota: global conservation violated: limits %d, held %d", limitTotal, heldTotal)
	}
	for leaseID, owner := range s.leaseOwner {
		if !seenLeases[leaseID] {
			return fmt.Errorf("quota: lease %q tracked for %q but not held", leaseID, owner)
		}
	}
	return nil
}
