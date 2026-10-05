package rolelib

import (
	"fmt"
	"sort"
)

// ClosureModel is a reference implementation of the same semantics as
// Library. It keeps no derived state: every check recomputes the full
// inheritance closure from scratch and scans every pair of effective roles
// against the exclusion sets. Tests cross-check Library against this model.
type ClosureModel struct {
	parents map[string][]string
	static  map[pair]bool
	dynamic map[pair]bool
	held    map[string]bool
	active  map[string]bool
}

// NewClosureModel returns an empty reference model.
func NewClosureModel() *ClosureModel {
	return &ClosureModel{
		parents: make(map[string][]string),
		static:  make(map[pair]bool),
		dynamic: make(map[pair]bool),
		held:    make(map[string]bool),
		active:  make(map[string]bool),
	}
}

// AddRole registers a new role.
func (m *ClosureModel) AddRole(name string) error {
	if name == "" {
		return fmt.Errorf("role name must not be empty")
	}
	if _, ok := m.parents[name]; !ok {
		m.parents[name] = nil
	}
	return nil
}

// AddInheritance makes role inherit from parent, rejecting cycles.
func (m *ClosureModel) AddInheritance(role, parent string) error {
	if _, ok := m.parents[role]; !ok {
		return fmt.Errorf("unknown role %q", role)
	}
	if _, ok := m.parents[parent]; !ok {
		return fmt.Errorf("unknown role %q", parent)
	}
	if role == parent {
		return fmt.Errorf("role %q cannot inherit from itself", role)
	}
	for _, p := range m.parents[role] {
		if p == parent {
			return nil
		}
	}
	if m.fullClosure([]string{parent})[role] {
		return fmt.Errorf("inheritance %q -> %q would create a cycle", role, parent)
	}
	m.parents[role] = append(m.parents[role], parent)
	return nil
}

// AddStaticExclusion forbids holding a and b together.
func (m *ClosureModel) AddStaticExclusion(a, b string) error {
	return m.addExclusion(m.static, Static, a, b)
}

// AddDynamicExclusion forbids activating a and b together.
func (m *ClosureModel) AddDynamicExclusion(a, b string) error {
	return m.addExclusion(m.dynamic, Dynamic, a, b)
}

func (m *ClosureModel) addExclusion(set map[pair]bool, kind Kind, a, b string) error {
	if _, ok := m.parents[a]; !ok {
		return fmt.Errorf("unknown role %q", a)
	}
	if _, ok := m.parents[b]; !ok {
		return fmt.Errorf("unknown role %q", b)
	}
	if a == b {
		return fmt.Errorf("%s exclusion requires two distinct roles", kind)
	}
	set[makePair(a, b)] = true
	return nil
}

// Grant atomically grants a batch of roles after a full-closure static check.
func (m *ClosureModel) Grant(roles ...string) error {
	for _, r := range roles {
		if _, ok := m.parents[r]; !ok {
			return fmt.Errorf("unknown role %q", r)
		}
	}
	next := make(map[string]bool, len(m.held)+len(roles))
	for r := range m.held {
		next[r] = true
	}
	for _, r := range roles {
		next[r] = true
	}
	if c := m.violation(next, m.static, Static); c != nil {
		return c
	}
	m.held = next
	return nil
}

// Revoke removes a directly granted role and prunes dangling activations.
func (m *ClosureModel) Revoke(role string) error {
	if _, ok := m.parents[role]; !ok {
		return fmt.Errorf("unknown role %q", role)
	}
	delete(m.held, role)
	eff := m.fullClosure(keys(m.held))
	for r := range m.active {
		if !eff[r] {
			delete(m.active, r)
		}
	}
	return nil
}

// Activate atomically activates a batch of roles after a full-closure
// dynamic check.
func (m *ClosureModel) Activate(roles ...string) error {
	eff := m.fullClosure(keys(m.held))
	for _, r := range roles {
		if _, ok := m.parents[r]; !ok {
			return fmt.Errorf("unknown role %q", r)
		}
		if !eff[r] {
			return fmt.Errorf("role %q is not held and cannot be activated", r)
		}
	}
	next := make(map[string]bool, len(m.active)+len(roles))
	for r := range m.active {
		next[r] = true
	}
	for _, r := range roles {
		next[r] = true
	}
	if c := m.violation(next, m.dynamic, Dynamic); c != nil {
		return c
	}
	m.active = next
	return nil
}

// Deactivate removes roles from the active set.
func (m *ClosureModel) Deactivate(roles ...string) error {
	for _, r := range roles {
		if _, ok := m.parents[r]; !ok {
			return fmt.Errorf("unknown role %q", r)
		}
	}
	for _, r := range roles {
		delete(m.active, r)
	}
	return nil
}

// Held returns the directly granted roles in sorted order.
func (m *ClosureModel) Held() []string { return sortedKeys(m.held) }

// Active returns the active roles in sorted order.
func (m *ClosureModel) Active() []string { return sortedKeys(m.active) }

// EffectiveHeld returns the full closure of the held roles.
func (m *ClosureModel) EffectiveHeld() []string { return sortedKeys(m.fullClosure(keys(m.held))) }

// EffectiveActive returns the full closure of the active roles.
func (m *ClosureModel) EffectiveActive() []string { return sortedKeys(m.fullClosure(keys(m.active))) }

// violation scans every unordered pair of effective roles and returns a
// Conflict for the first excluded pair found, or nil.
func (m *ClosureModel) violation(direct map[string]bool, excl map[pair]bool, kind Kind) *Conflict {
	closure := m.fullClosure(keys(direct))
	members := sortedKeys(closure)
	for i := 0; i < len(members); i++ {
		for j := i + 1; j < len(members); j++ {
			if excl[makePair(members[i], members[j])] {
				return &Conflict{
					Kind:   kind,
					A:      members[i],
					B:      members[j],
					ChainA: m.shortestChain(direct, members[i]),
					ChainB: m.shortestChain(direct, members[j]),
				}
			}
		}
	}
	return nil
}

// fullClosure computes seeds plus all transitive ancestors via BFS.
func (m *ClosureModel) fullClosure(seeds []string) map[string]bool {
	out := make(map[string]bool, len(seeds))
	queue := make([]string, 0, len(seeds))
	for _, s := range seeds {
		if !out[s] {
			out[s] = true
			queue = append(queue, s)
		}
	}
	for len(queue) > 0 {
		r := queue[0]
		queue = queue[1:]
		for _, p := range m.parents[r] {
			if !out[p] {
				out[p] = true
				queue = append(queue, p)
			}
		}
	}
	return out
}

// shortestChain is a multi-source BFS from sources up to target over parent
// edges, returning the chain with both endpoints included.
func (m *ClosureModel) shortestChain(sources map[string]bool, target string) []string {
	prev := make(map[string]string)
	queue := make([]string, 0, len(sources))
	for _, s := range sortedKeys(sources) {
		if _, seen := prev[s]; !seen {
			prev[s] = ""
			queue = append(queue, s)
		}
	}
	for len(queue) > 0 {
		r := queue[0]
		queue = queue[1:]
		if r == target {
			chain := []string{target}
			for prev[chain[len(chain)-1]] != "" {
				chain = append(chain, prev[chain[len(chain)-1]])
			}
			for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
				chain[i], chain[j] = chain[j], chain[i]
			}
			return chain
		}
		parents := append([]string(nil), m.parents[r]...)
		sort.Strings(parents)
		for _, p := range parents {
			if _, seen := prev[p]; !seen {
				prev[p] = r
				queue = append(queue, p)
			}
		}
	}
	return nil
}

func keys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	return out
}

func sortedKeys(set map[string]bool) []string {
	out := keys(set)
	sort.Strings(out)
	return out
}
