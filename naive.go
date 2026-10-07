package rolelib

// Naive is a reference implementation of the same semantics as Library,
// built directly on the full-closure model: it stores only raw facts and,
// on every query or mutation, recomputes the complete inheritance closure
// from scratch and validates every constraint by exhaustive pair scanning.
// It is intentionally simple and independent of Library's internals so that
// tests can cross-check the two implementations against each other.
type Naive struct {
	parents  map[string]map[string]bool
	ssd      map[[2]string]struct{}
	dsd      map[[2]string]struct{}
	grants   map[string]map[string]bool
	sessions map[int]*NaiveSession
	nextSess int
}

// NaiveSession holds the raw facts of a session in the Naive model.
type NaiveSession struct {
	User      string
	Activated map[string]bool
}

// NewNaive returns an empty full-closure reference model.
func NewNaive() *Naive {
	return &Naive{
		parents:  map[string]map[string]bool{},
		ssd:      map[[2]string]struct{}{},
		dsd:      map[[2]string]struct{}{},
		grants:   map[string]map[string]bool{},
		sessions: map[int]*NaiveSession{},
	}
}

func (n *Naive) ensureRole(r string) {
	if _, ok := n.parents[r]; !ok {
		n.parents[r] = map[string]bool{}
	}
}

func (n *Naive) ensureUser(u string) {
	if _, ok := n.grants[u]; !ok {
		n.grants[u] = map[string]bool{}
	}
}

// fullClosure computes the complete inheritance closure of roots by DFS.
func (n *Naive) fullClosure(roots []string) map[string]bool {
	out := map[string]bool{}
	var visit func(r string)
	visit = func(r string) {
		if out[r] {
			return
		}
		out[r] = true
		for p := range n.parents[r] {
			visit(p)
		}
	}
	for _, r := range roots {
		visit(r)
	}
	return out
}

// chainTo finds a shortest inheritance chain from any of the sources to
// target by running an independent BFS per source. Returns nil if target is
// unreachable from all sources.
func (n *Naive) chainTo(sources []string, target string) []string {
	var best []string
	for _, s := range sources {
		prev := map[string]string{s: ""}
		queue := []string{s}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if cur == target {
				break
			}
			for p := range n.parents[cur] {
				if _, ok := prev[p]; !ok {
					prev[p] = cur
					queue = append(queue, p)
				}
			}
		}
		if _, ok := prev[target]; !ok {
			continue
		}
		var path []string
		for cur := target; ; cur = prev[cur] {
			path = append([]string{cur}, path...)
			if cur == s {
				break
			}
		}
		if best == nil || len(path) < len(best) {
			best = path
		}
	}
	return best
}

// validate scans every user against every SSD pair and every session
// against every DSD pair over the full closures, and returns the violation
// with the shortest total inheritance chain, or nil.
func (n *Naive) validate() *ConflictError {
	var best *Conflict
	bestScore := 0
	consider := func(kind Kind, p [2]string, sources []string) {
		ca := n.chainTo(sources, p[0])
		cb := n.chainTo(sources, p[1])
		if ca == nil || cb == nil {
			return
		}
		c := &Conflict{Kind: kind, RoleA: p[0], RoleB: p[1], ChainA: ca, ChainB: cb}
		score := len(ca) + len(cb)
		if best == nil || score < bestScore || (score == bestScore && c.String() < best.String()) {
			best, bestScore = c, score
		}
	}
	for _, g := range n.grants {
		sources := sortedKeys(g)
		eff := n.fullClosure(sources)
		for p := range n.ssd {
			if eff[p[0]] && eff[p[1]] {
				consider(SSD, p, sources)
			}
		}
	}
	for _, s := range n.sessions {
		sources := sortedKeys(s.Activated)
		eff := n.fullClosure(sources)
		for p := range n.dsd {
			if eff[p[0]] && eff[p[1]] {
				consider(DSD, p, sources)
			}
		}
	}
	if best != nil {
		return &ConflictError{*best}
	}
	return nil
}

// AddInheritance mirrors Library.AddInheritance on the full-closure model.
func (n *Naive) AddInheritance(child, parent string) error {
	if child == parent {
		return &CycleError{Path: []string{child, parent}}
	}
	n.ensureRole(child)
	n.ensureRole(parent)
	if n.parents[child][parent] {
		return nil
	}
	if n.fullClosure([]string{parent})[child] {
		return &CycleError{Path: append([]string{child}, n.chainTo([]string{parent}, child)...)}
	}
	n.parents[child][parent] = true
	if c := n.validate(); c != nil {
		delete(n.parents[child], parent)
		return c
	}
	return nil
}

// RemoveInheritance mirrors Library.RemoveInheritance.
func (n *Naive) RemoveInheritance(child, parent string) {
	if !n.parents[child][parent] {
		return
	}
	delete(n.parents[child], parent)
	for _, s := range n.sessions {
		n.pruneSession(s)
	}
}

// AddSSD mirrors Library.AddSSD.
func (n *Naive) AddSSD(a, b string) error {
	if a == b {
		return ErrSelfExclusion
	}
	n.ensureRole(a)
	n.ensureRole(b)
	p := pair(a, b)
	n.ssd[p] = struct{}{}
	if c := n.validate(); c != nil {
		delete(n.ssd, p)
		return c
	}
	return nil
}

// AddDSD mirrors Library.AddDSD.
func (n *Naive) AddDSD(a, b string) error {
	if a == b {
		return ErrSelfExclusion
	}
	n.ensureRole(a)
	n.ensureRole(b)
	p := pair(a, b)
	n.dsd[p] = struct{}{}
	if c := n.validate(); c != nil {
		delete(n.dsd, p)
		return c
	}
	return nil
}

// Grant mirrors Library.Grant.
func (n *Naive) Grant(user, role string) error {
	return n.GrantBatch(user, role)
}

// GrantBatch mirrors Library.GrantBatch: the batch is validated as a whole
// and rolled back entirely on conflict.
func (n *Naive) GrantBatch(user string, roles ...string) error {
	if len(roles) == 0 {
		return nil
	}
	n.ensureUser(user)
	g := n.grants[user]
	var added []string
	for _, r := range roles {
		n.ensureRole(r)
		if !g[r] {
			g[r] = true
			added = append(added, r)
		}
	}
	if c := n.validate(); c != nil {
		for _, r := range added {
			delete(g, r)
		}
		return c
	}
	return nil
}

// Revoke mirrors Library.Revoke.
func (n *Naive) Revoke(user, role string) {
	if !n.grants[user][role] {
		return
	}
	delete(n.grants[user], role)
	for _, s := range n.sessions {
		if s.User == user {
			n.pruneSession(s)
		}
	}
}

func (n *Naive) pruneSession(s *NaiveSession) {
	eff := n.fullClosure(sortedKeys(n.grants[s.User]))
	for r := range s.Activated {
		if !eff[r] {
			delete(s.Activated, r)
		}
	}
}

// OpenSession mirrors Library.OpenSession.
func (n *Naive) OpenSession(user string) int {
	n.ensureUser(user)
	id := n.nextSess
	n.nextSess++
	n.sessions[id] = &NaiveSession{User: user, Activated: map[string]bool{}}
	return id
}

// CloseSession mirrors Library.CloseSession.
func (n *Naive) CloseSession(id int) {
	delete(n.sessions, id)
}

// Activate mirrors Library.Activate.
func (n *Naive) Activate(id int, role string) error {
	s, ok := n.sessions[id]
	if !ok {
		return ErrUnknownSession
	}
	if !n.fullClosure(sortedKeys(n.grants[s.User]))[role] {
		return ErrNotGranted
	}
	if s.Activated[role] {
		return nil
	}
	s.Activated[role] = true
	if c := n.validate(); c != nil {
		delete(s.Activated, role)
		return c
	}
	return nil
}

// Deactivate mirrors Library.Deactivate.
func (n *Naive) Deactivate(id int, role string) error {
	s, ok := n.sessions[id]
	if !ok {
		return ErrUnknownSession
	}
	delete(s.Activated, role)
	return nil
}

// EffectiveRoles mirrors Library.EffectiveRoles.
func (n *Naive) EffectiveRoles(user string) []string {
	return sortedKeys(n.fullClosure(sortedKeys(n.grants[user])))
}

// SessionRoles mirrors Library.SessionRoles.
func (n *Naive) SessionRoles(id int) ([]string, error) {
	s, ok := n.sessions[id]
	if !ok {
		return nil, ErrUnknownSession
	}
	return sortedKeys(n.fullClosure(sortedKeys(s.Activated))), nil
}
