// Package rolelib implements a role library with role inheritance, user
// grants, session activation, and static/dynamic separation-of-duty
// constraints (SSD/DSD).
//
//   - Inheritance: role A inheriting role B means a holder of A also holds B
//     (transitively). Inheritance cycles are rejected.
//   - SSD (static): two roles may not be held together, directly or through
//     inheritance. Checked on grant and on constraint/inheritance changes.
//   - DSD (dynamic): two roles may not be active in the same session.
//     Checked on activation and on constraint/inheritance changes.
//   - Batch grants are atomic: either the whole batch is granted or nothing
//     changes. Conflicts introduced indirectly via inheritance are rejected
//     as well, and the reported error carries the shortest conflicting
//     inheritance chain.
package rolelib

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Kind identifies the kind of separation-of-duty constraint.
type Kind int

const (
	// SSD is a static constraint: the two roles may not be held together.
	SSD Kind = iota
	// DSD is a dynamic constraint: the two roles may not be activated
	// together in one session.
	DSD
)

func (k Kind) String() string {
	if k == SSD {
		return "SSD"
	}
	return "DSD"
}

// Conflict describes a separation-of-duty violation. ChainA and ChainB are
// the shortest inheritance chains from a granted (SSD) or activated (DSD)
// role down to RoleA and RoleB respectively.
type Conflict struct {
	Kind   Kind
	RoleA  string
	RoleB  string
	ChainA []string
	ChainB []string
}

func (c Conflict) String() string {
	return fmt.Sprintf("%s conflict between %q and %q: %s | %s",
		c.Kind, c.RoleA, c.RoleB,
		strings.Join(c.ChainA, " -> "), strings.Join(c.ChainB, " -> "))
}

// ConflictError is returned when an operation is rejected because it would
// violate a separation-of-duty constraint.
type ConflictError struct{ Conflict Conflict }

func (e *ConflictError) Error() string { return "rolelib: " + e.Conflict.String() }

// CycleError is returned when an inheritance edge would create a cycle.
// Path is the cyclic chain, starting and ending at the same role.
type CycleError struct{ Path []string }

func (e *CycleError) Error() string {
	return "rolelib: inheritance cycle: " + strings.Join(e.Path, " -> ")
}

var (
	// ErrNotGranted is returned when activating a role the user does not
	// effectively hold.
	ErrNotGranted = errors.New("rolelib: role not granted to user")
	// ErrUnknownSession is returned for operations on a closed or never
	// opened session.
	ErrUnknownSession = errors.New("rolelib: unknown session")
	// ErrSelfExclusion is returned when a role is excluded from itself.
	ErrSelfExclusion = errors.New("rolelib: cannot exclude a role from itself")
)

type session struct {
	user      string
	activated map[string]bool
	effective map[string]bool
}

// Library is a role library. The zero value is not usable; use New.
type Library struct {
	parents   map[string]map[string]bool // role -> direct parent roles it inherits
	children  map[string]map[string]bool // role -> direct child roles inheriting it
	ssd       map[[2]string]struct{}
	dsd       map[[2]string]struct{}
	grants    map[string]map[string]bool // user -> directly granted roles
	effective map[string]map[string]bool // user -> effective roles (inheritance closure)
	sessions  map[int]*session
	nextSess  int
}

// New returns an empty role library.
func New() *Library {
	return &Library{
		parents:   map[string]map[string]bool{},
		children:  map[string]map[string]bool{},
		ssd:       map[[2]string]struct{}{},
		dsd:       map[[2]string]struct{}{},
		grants:    map[string]map[string]bool{},
		effective: map[string]map[string]bool{},
		sessions:  map[int]*session{},
	}
}

func pair(a, b string) [2]string {
	if a > b {
		a, b = b, a
	}
	return [2]string{a, b}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (l *Library) ensureRole(r string) {
	if _, ok := l.parents[r]; !ok {
		l.parents[r] = map[string]bool{}
	}
	if _, ok := l.children[r]; !ok {
		l.children[r] = map[string]bool{}
	}
}

func (l *Library) ensureUser(u string) {
	if _, ok := l.grants[u]; !ok {
		l.grants[u] = map[string]bool{}
		l.effective[u] = map[string]bool{}
	}
}

// closure returns all roles reachable from roots via inheritance, roots
// included.
func (l *Library) closure(roots ...string) map[string]bool {
	out := map[string]bool{}
	stack := append([]string{}, roots...)
	for len(stack) > 0 {
		r := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if out[r] {
			continue
		}
		out[r] = true
		for p := range l.parents[r] {
			stack = append(stack, p)
		}
	}
	return out
}

// shortestChains computes, for every role reachable from sources via
// inheritance, a shortest inheritance chain starting at one of the sources.
// Multi-source BFS guarantees minimality; deterministic neighbor ordering
// keeps the result stable.
func (l *Library) shortestChains(sources []string) map[string][]string {
	chains := map[string][]string{}
	var queue []string
	for _, s := range sources {
		if _, ok := chains[s]; !ok {
			chains[s] = []string{s}
			queue = append(queue, s)
		}
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, p := range sortedKeys(l.parents[cur]) {
			if _, ok := chains[p]; ok {
				continue
			}
			chains[p] = append(append([]string{}, chains[cur]...), p)
			queue = append(queue, p)
		}
	}
	return chains
}

// conflictLess orders conflicts by total chain length, breaking ties
// deterministically.
func conflictLess(a, b *Conflict) bool {
	sa := len(a.ChainA) + len(a.ChainB)
	sb := len(b.ChainA) + len(b.ChainB)
	if sa != sb {
		return sa < sb
	}
	return a.String() < b.String()
}

// conflictFromChains returns the violated constraint pair with the shortest
// total inheritance chain, or nil if no pair is violated. Ties are broken
// deterministically.
func conflictFromChains(kind Kind, pairs map[[2]string]struct{}, chains map[string][]string) *Conflict {
	var best *Conflict
	for p := range pairs {
		ca, okA := chains[p[0]]
		cb, okB := chains[p[1]]
		if !okA || !okB {
			continue
		}
		c := &Conflict{Kind: kind, RoleA: p[0], RoleB: p[1], ChainA: ca, ChainB: cb}
		if best == nil || conflictLess(c, best) {
			best = c
		}
	}
	return best
}

// AddInheritance makes child inherit parent. It fails with *CycleError if
// the edge would create a cycle, and with *ConflictError if the edge would
// introduce a (direct or indirect) SSD/DSD violation for any existing user
// or session. On failure nothing changes.
func (l *Library) AddInheritance(child, parent string) error {
	if child == parent {
		return &CycleError{Path: []string{child, parent}}
	}
	l.ensureRole(child)
	l.ensureRole(parent)
	if l.parents[child][parent] {
		return nil
	}
	if l.closure(parent)[child] {
		chain := l.shortestChains([]string{parent})[child]
		return &CycleError{Path: append([]string{child}, chain...)}
	}
	l.parents[child][parent] = true
	l.children[parent][child] = true
	if err := l.revalidate(); err != nil {
		delete(l.parents[child], parent)
		delete(l.children[parent], child)
		return err
	}
	l.recomputeAll()
	return nil
}

// RemoveInheritance removes a direct inheritance edge if present and
// recomputes all derived state. Activated roles that fall out of the user's
// effective set are deactivated.
func (l *Library) RemoveInheritance(child, parent string) {
	if !l.parents[child][parent] {
		return
	}
	delete(l.parents[child], parent)
	delete(l.children[parent], child)
	l.recomputeAll()
	for _, s := range l.sessions {
		l.pruneSession(s)
	}
}

// AddSSD declares that roles a and b may not be held together. It fails with
// *ConflictError if some user already (transitively) holds both.
func (l *Library) AddSSD(a, b string) error {
	if a == b {
		return ErrSelfExclusion
	}
	l.ensureRole(a)
	l.ensureRole(b)
	p := pair(a, b)
	l.ssd[p] = struct{}{}
	if err := l.revalidate(); err != nil {
		delete(l.ssd, p)
		return err
	}
	return nil
}

// AddDSD declares that roles a and b may not be activated together in one
// session. It fails with *ConflictError if some session already
// (transitively) activates both.
func (l *Library) AddDSD(a, b string) error {
	if a == b {
		return ErrSelfExclusion
	}
	l.ensureRole(a)
	l.ensureRole(b)
	p := pair(a, b)
	l.dsd[p] = struct{}{}
	if err := l.revalidate(); err != nil {
		delete(l.dsd, p)
		return err
	}
	return nil
}

// Grant grants a single role to a user.
func (l *Library) Grant(user, role string) error {
	return l.GrantBatch(user, role)
}

// GrantBatch grants several roles atomically: if granting the whole batch
// would violate any SSD constraint (directly or via inheritance, against
// existing grants or within the batch itself), nothing is granted and a
// *ConflictError carrying the shortest conflicting chain is returned.
func (l *Library) GrantBatch(user string, roles ...string) error {
	if len(roles) == 0 {
		return nil
	}
	l.ensureUser(user)
	gset := map[string]bool{}
	for g := range l.grants[user] {
		gset[g] = true
	}
	for _, r := range roles {
		l.ensureRole(r)
		gset[r] = true
	}
	sources := sortedKeys(gset)
	if c := conflictFromChains(SSD, l.ssd, l.shortestChains(sources)); c != nil {
		return &ConflictError{*c}
	}
	for _, r := range roles {
		l.grants[user][r] = true
	}
	l.effective[user] = l.closure(sources...)
	return nil
}

// Revoke removes a direct grant and recomputes the user's effective roles.
// Activated roles that are no longer held are deactivated.
func (l *Library) Revoke(user, role string) {
	if !l.grants[user][role] {
		return
	}
	delete(l.grants[user], role)
	l.effective[user] = l.closure(sortedKeys(l.grants[user])...)
	for _, s := range l.sessions {
		if s.user == user {
			l.pruneSession(s)
		}
	}
}

// pruneSession deactivates roles the session's user no longer effectively
// holds and recomputes the session's effective roles.
func (l *Library) pruneSession(s *session) {
	for r := range s.activated {
		if !l.effective[s.user][r] {
			delete(s.activated, r)
		}
	}
	s.effective = l.closure(sortedKeys(s.activated)...)
}

// OpenSession opens a session for a user and returns its ID.
func (l *Library) OpenSession(user string) int {
	l.ensureUser(user)
	id := l.nextSess
	l.nextSess++
	l.sessions[id] = &session{user: user, activated: map[string]bool{}, effective: map[string]bool{}}
	return id
}

// CloseSession closes a session.
func (l *Library) CloseSession(id int) {
	delete(l.sessions, id)
}

// Activate activates a role in a session. The user must effectively hold the
// role, and the activation must not violate any DSD constraint (directly or
// via inheritance). On failure nothing changes.
func (l *Library) Activate(id int, role string) error {
	s, ok := l.sessions[id]
	if !ok {
		return ErrUnknownSession
	}
	if !l.effective[s.user][role] {
		return ErrNotGranted
	}
	if s.activated[role] {
		return nil
	}
	sources := append(sortedKeys(s.activated), role)
	if c := conflictFromChains(DSD, l.dsd, l.shortestChains(sources)); c != nil {
		return &ConflictError{*c}
	}
	s.activated[role] = true
	s.effective = l.closure(sources...)
	return nil
}

// Deactivate removes a role from a session's active set.
func (l *Library) Deactivate(id int, role string) error {
	s, ok := l.sessions[id]
	if !ok {
		return ErrUnknownSession
	}
	if !s.activated[role] {
		return nil
	}
	delete(s.activated, role)
	s.effective = l.closure(sortedKeys(s.activated)...)
	return nil
}

// EffectiveRoles returns the sorted effective roles of a user (direct grants
// plus everything reachable via inheritance).
func (l *Library) EffectiveRoles(user string) []string {
	return sortedKeys(l.effective[user])
}

// SessionRoles returns the sorted effective active roles of a session.
func (l *Library) SessionRoles(id int) ([]string, error) {
	s, ok := l.sessions[id]
	if !ok {
		return nil, ErrUnknownSession
	}
	return sortedKeys(s.effective), nil
}

// revalidate checks every user against all SSD constraints and every session
// against all DSD constraints, returning the conflict with the shortest
// total inheritance chain across all users and sessions.
func (l *Library) revalidate() error {
	var best *Conflict
	consider := func(c *Conflict) {
		if c != nil && (best == nil || conflictLess(c, best)) {
			best = c
		}
	}
	for u := range l.grants {
		consider(conflictFromChains(SSD, l.ssd, l.shortestChains(sortedKeys(l.grants[u]))))
	}
	for _, s := range l.sessions {
		consider(conflictFromChains(DSD, l.dsd, l.shortestChains(sortedKeys(s.activated))))
	}
	if best != nil {
		return &ConflictError{*best}
	}
	return nil
}

// recomputeAll rebuilds all cached effective sets from the raw facts.
func (l *Library) recomputeAll() {
	for u := range l.grants {
		l.effective[u] = l.closure(sortedKeys(l.grants[u])...)
	}
	for _, s := range l.sessions {
		s.effective = l.closure(sortedKeys(s.activated)...)
	}
}
