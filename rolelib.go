// Package rolelib implements a role library with inheritance, granting and
// activation. Static mutual-exclusion constraints restrict which roles may be
// held together; dynamic mutual-exclusion constraints restrict which roles may
// be activated together. Constraints are checked against the full inheritance
// closure, so indirect conflicts introduced by inheritance are rejected too.
package rolelib

import (
	"fmt"
	"sort"
	"strings"
)

// Kind identifies which constraint class a Conflict belongs to.
type Kind string

const (
	// Static constraints forbid holding two roles at the same time.
	Static Kind = "static"
	// Dynamic constraints forbid activating two roles in the same session.
	Dynamic Kind = "dynamic"
)

// Conflict reports a mutual-exclusion violation. ChainA and ChainB are the
// shortest inheritance chains from a directly held (or activated) role up to
// the excluded roles A and B respectively; each chain includes both endpoints.
type Conflict struct {
	Kind   Kind
	A, B   string
	ChainA []string
	ChainB []string
}

func (c *Conflict) Error() string {
	return fmt.Sprintf("%s exclusion violated: %s conflicts with %s (via %s and %s)",
		c.Kind, c.A, c.B,
		strings.Join(c.ChainA, " -> "), strings.Join(c.ChainB, " -> "))
}

type pair struct{ a, b string }

func makePair(a, b string) pair {
	if a > b {
		a, b = b, a
	}
	return pair{a, b}
}

// Library is a role registry with inheritance and exclusion constraints.
// It caches the effective held-role closure and recomputes it lazily.
type Library struct {
	parents map[string]map[string]bool
	static  map[pair]bool
	dynamic map[pair]bool
	held    map[string]bool
	active  map[string]bool

	heldClosure  map[string]bool
	closureDirty bool
}

// New returns an empty Library.
func New() *Library {
	return &Library{
		parents: make(map[string]map[string]bool),
		static:  make(map[pair]bool),
		dynamic: make(map[pair]bool),
		held:    make(map[string]bool),
		active:  make(map[string]bool),
	}
}

// AddRole registers a new role. Registering an existing role is a no-op.
func (l *Library) AddRole(name string) error {
	if name == "" {
		return fmt.Errorf("role name must not be empty")
	}
	if _, ok := l.parents[name]; !ok {
		l.parents[name] = make(map[string]bool)
	}
	return nil
}

// Has reports whether the role exists.
func (l *Library) Has(name string) bool {
	_, ok := l.parents[name]
	return ok
}

// AddInheritance makes role inherit from parent. The inheritance graph must
// remain acyclic; an edge that would close a cycle is rejected.
func (l *Library) AddInheritance(role, parent string) error {
	if !l.Has(role) {
		return fmt.Errorf("unknown role %q", role)
	}
	if !l.Has(parent) {
		return fmt.Errorf("unknown role %q", parent)
	}
	if role == parent {
		return fmt.Errorf("role %q cannot inherit from itself", role)
	}
	if l.parents[role][parent] {
		return nil
	}
	if l.closureOf([]string{parent})[role] {
		return fmt.Errorf("inheritance %q -> %q would create a cycle", role, parent)
	}
	l.parents[role][parent] = true
	l.closureDirty = true
	return nil
}

// AddStaticExclusion forbids holding a and b (or any roles inheriting from
// them) at the same time.
func (l *Library) AddStaticExclusion(a, b string) error {
	return l.addExclusion(l.static, Static, a, b)
}

// AddDynamicExclusion forbids activating a and b (or any roles inheriting
// from them) in the same session.
func (l *Library) AddDynamicExclusion(a, b string) error {
	return l.addExclusion(l.dynamic, Dynamic, a, b)
}

func (l *Library) addExclusion(set map[pair]bool, kind Kind, a, b string) error {
	if !l.Has(a) {
		return fmt.Errorf("unknown role %q", a)
	}
	if !l.Has(b) {
		return fmt.Errorf("unknown role %q", b)
	}
	if a == b {
		return fmt.Errorf("%s exclusion requires two distinct roles", kind)
	}
	set[makePair(a, b)] = true
	return nil
}

// Grant atomically grants a batch of roles. If the resulting held set would
// violate a static exclusion — directly or through inheritance — no role in
// the batch is granted and a *Conflict is returned.
func (l *Library) Grant(roles ...string) error {
	for _, r := range roles {
		if !l.Has(r) {
			return fmt.Errorf("unknown role %q", r)
		}
	}
	prospective := make(map[string]bool, len(l.held)+len(roles))
	for r := range l.held {
		prospective[r] = true
	}
	for _, r := range roles {
		prospective[r] = true
	}
	if c := l.checkStatic(prospective); c != nil {
		return c
	}
	l.held = prospective
	l.closureDirty = true
	return nil
}

// Revoke removes a directly granted role. Active roles that are no longer
// effectively held are deactivated.
func (l *Library) Revoke(role string) error {
	if !l.Has(role) {
		return fmt.Errorf("unknown role %q", role)
	}
	if !l.held[role] {
		return nil
	}
	delete(l.held, role)
	l.closureDirty = true
	eff := l.effectiveHeld()
	for r := range l.active {
		if !eff[r] {
			delete(l.active, r)
		}
	}
	return nil
}

// Activate atomically activates a batch of roles for the session. Every role
// must be effectively held. If the resulting active set would violate a
// dynamic exclusion — directly or through inheritance — no role in the batch
// is activated and a *Conflict is returned.
func (l *Library) Activate(roles ...string) error {
	eff := l.effectiveHeld()
	for _, r := range roles {
		if !l.Has(r) {
			return fmt.Errorf("unknown role %q", r)
		}
		if !eff[r] {
			return fmt.Errorf("role %q is not held and cannot be activated", r)
		}
	}
	prospective := make(map[string]bool, len(l.active)+len(roles))
	for r := range l.active {
		prospective[r] = true
	}
	for _, r := range roles {
		prospective[r] = true
	}
	if c := l.checkDynamic(prospective); c != nil {
		return c
	}
	l.active = prospective
	return nil
}

// Deactivate removes roles from the active set.
func (l *Library) Deactivate(roles ...string) error {
	for _, r := range roles {
		if !l.Has(r) {
			return fmt.Errorf("unknown role %q", r)
		}
	}
	for _, r := range roles {
		delete(l.active, r)
	}
	return nil
}

// Held returns the directly granted roles in sorted order.
func (l *Library) Held() []string { return sorted(l.held) }

// Active returns the active roles in sorted order.
func (l *Library) Active() []string { return sorted(l.active) }

// EffectiveHeld returns the held roles plus all inherited ancestors.
func (l *Library) EffectiveHeld() []string { return sorted(l.effectiveHeld()) }

// EffectiveActive returns the active roles plus all inherited ancestors.
func (l *Library) EffectiveActive() []string { return sorted(l.closureOf(maps(l.active))) }

func (l *Library) effectiveHeld() map[string]bool {
	if l.closureDirty || l.heldClosure == nil {
		l.heldClosure = l.closureOf(maps(l.held))
		l.closureDirty = false
	}
	return l.heldClosure
}

func maps(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	return out
}

func sorted(set map[string]bool) []string {
	out := maps(set)
	sort.Strings(out)
	return out
}

// closureOf returns seeds plus all transitive ancestors.
func (l *Library) closureOf(seeds []string) map[string]bool {
	out := make(map[string]bool, len(seeds))
	stack := make([]string, 0, len(seeds))
	for _, s := range seeds {
		if !out[s] {
			out[s] = true
			stack = append(stack, s)
		}
	}
	for len(stack) > 0 {
		r := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for p := range l.parents[r] {
			if !out[p] {
				out[p] = true
				stack = append(stack, p)
			}
		}
	}
	return out
}

// checkStatic returns the first static exclusion violated by the closure of
// heldSet, or nil. Iteration order is deterministic.
func (l *Library) checkStatic(heldSet map[string]bool) *Conflict {
	closure := l.closureOf(maps(heldSet))
	for _, p := range sortedPairs(l.static) {
		if closure[p.a] && closure[p.b] {
			return &Conflict{
				Kind:   Static,
				A:      p.a,
				B:      p.b,
				ChainA: l.shortestChain(heldSet, p.a),
				ChainB: l.shortestChain(heldSet, p.b),
			}
		}
	}
	return nil
}

// checkDynamic returns the first dynamic exclusion violated by the closure of
// activeSet, or nil. Iteration order is deterministic.
func (l *Library) checkDynamic(activeSet map[string]bool) *Conflict {
	closure := l.closureOf(maps(activeSet))
	for _, p := range sortedPairs(l.dynamic) {
		if closure[p.a] && closure[p.b] {
			return &Conflict{
				Kind:   Dynamic,
				A:      p.a,
				B:      p.b,
				ChainA: l.shortestChain(activeSet, p.a),
				ChainB: l.shortestChain(activeSet, p.b),
			}
		}
	}
	return nil
}

func sortedPairs(set map[pair]bool) []pair {
	out := make([]pair, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].a != out[j].a {
			return out[i].a < out[j].a
		}
		return out[i].b < out[j].b
	})
	return out
}

// shortestChain returns a shortest inheritance chain from any role in sources
// up to target, including both endpoints. Sources equal to target yield a
// single-element chain. Neighbours are visited in sorted order so the result
// is deterministic.
func (l *Library) shortestChain(sources map[string]bool, target string) []string {
	prev := make(map[string]string)
	queue := make([]string, 0, len(sources))
	for _, s := range sorted(sources) {
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
		for _, p := range sorted(l.parents[r]) {
			if _, seen := prev[p]; !seen {
				prev[p] = r
				queue = append(queue, p)
			}
		}
	}
	return nil
}
