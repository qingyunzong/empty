package rulecheck

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Rule grants access to the paths matched by Include, except those matched
// by any of the Excludes globs (exception patterns).
type Rule struct {
	ID       string
	Include  string
	Excludes []string
}

// compiledRule is a Rule plus its compiled form.
type compiledRule struct {
	rule Rule
	inc  glob
	excl []glob
	spec specificity
	eff  *Automaton // effective language: Include minus Excludes
}

// Library is an immutable, compiled rule set. Rules are ordered by
// specificity (literal segment count, then total segment count); the first
// matching rule wins. Rule sets containing equally specific rules whose
// languages overlap are rejected as ambiguous.
type Library struct {
	rules []compiledRule // sorted by specificity, most specific first
}

// NewLibrary parses, validates and compiles the given rules.
func NewLibrary(rules []Rule) (*Library, error) {
	seen := map[string]bool{}
	compiled := make([]compiledRule, 0, len(rules))
	litSet := map[string]bool{}
	for _, r := range rules {
		if r.ID == "" {
			return nil, fmt.Errorf("rule with empty ID")
		}
		if seen[r.ID] {
			return nil, fmt.Errorf("duplicate rule ID %q", r.ID)
		}
		seen[r.ID] = true
		inc, err := parseGlob(r.Include)
		if err != nil {
			return nil, fmt.Errorf("rule %q: %w", r.ID, err)
		}
		cr := compiledRule{rule: r, inc: inc, spec: inc.specificity()}
		for _, s := range inc.segs {
			if s.kind == segLiteral {
				litSet[s.lit] = true
			}
		}
		for _, ex := range r.Excludes {
			g, err := parseGlob(ex)
			if err != nil {
				return nil, fmt.Errorf("rule %q exclude: %w", r.ID, err)
			}
			cr.excl = append(cr.excl, g)
			for _, s := range g.segs {
				if s.kind == segLiteral {
					litSet[s.lit] = true
				}
			}
		}
		compiled = append(compiled, cr)
	}

	lits := make([]string, 0, len(litSet))
	for l := range litSet {
		lits = append(lits, l)
	}
	sort.Strings(lits)

	for i := range compiled {
		inc := compileGlob(compiled[i].inc, lits)
		if len(compiled[i].excl) == 0 {
			compiled[i].eff = inc
			continue
		}
		parts := make([]*Automaton, 0, len(compiled[i].excl))
		for _, g := range compiled[i].excl {
			parts = append(parts, compileGlob(g, lits))
		}
		compiled[i].eff = subtractAll(inc, parts...)
	}

	// Reject ambiguous rule sets: two rules with identical specificity whose
	// effective languages overlap have no well-defined winner.
	for i := 0; i < len(compiled); i++ {
		for j := i + 1; j < len(compiled); j++ {
			a, b := compiled[i], compiled[j]
			if a.spec != b.spec {
				continue
			}
			both := intersect(a.eff, b.eff)
			if w, ok := both.shortestWord(); ok {
				return nil, fmt.Errorf("ambiguous rules %q and %q: equal specificity, both match %q",
					a.rule.ID, b.rule.ID, strings.Join(w, "/"))
			}
		}
	}

	sort.SliceStable(compiled, func(i, j int) bool {
		si, sj := compiled[i].spec, compiled[j].spec
		if si.literals != sj.literals {
			return si.literals > sj.literals
		}
		if si.total != sj.total {
			return si.total > sj.total
		}
		return compiled[i].rule.ID < compiled[j].rule.ID
	})
	return &Library{rules: compiled}, nil
}

// Rules returns the compiled rules in priority order (most specific first).
func (l *Library) Rules() []Rule {
	out := make([]Rule, len(l.rules))
	for i, r := range l.rules {
		out[i] = r.rule
	}
	return out
}

// Automaton returns the effective automaton of the named rule, for
// inspection. Returns nil if the rule does not exist.
func (l *Library) Automaton(ruleID string) *Automaton {
	for _, r := range l.rules {
		if r.rule.ID == ruleID {
			return r.eff
		}
	}
	return nil
}

// Decision is the outcome of matching a path against the rule set.
type Decision struct {
	Matched bool   // whether any rule matched
	RuleID  string // ID of the hit rule (the most specific match)
	Include string // include pattern of the hit rule
}

// Matcher decides paths against a Library. Positive and negative decisions
// are cached. Reload swaps in a freshly compiled Library and a brand-new
// cache: no state from the old automata is ever reused.
type Matcher struct {
	mu    sync.Mutex
	lib   *Library
	cache map[string]Decision
	gen   uint64
}

// Matcher returns a new Matcher for the library.
func (l *Library) Matcher() *Matcher {
	return &Matcher{lib: l, cache: make(map[string]Decision)}
}

// Reload hot-swaps the rule set. The new Library must be compiled with
// NewLibrary; the old automata and all cached decisions are discarded.
func (m *Matcher) Reload(lib *Library) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lib = lib
	m.cache = make(map[string]Decision)
	m.gen++
}

// CacheSize reports the number of cached decisions (for tests/inspection).
func (m *Matcher) CacheSize() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.cache)
}

// Generation identifies the current rule-set generation; it increases on
// every Reload.
func (m *Matcher) Generation() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.gen
}

// Match decides a path, consulting and populating the decision cache.
func (m *Matcher) Match(path string) (Decision, error) {
	segs, err := splitPath(path)
	if err != nil {
		return Decision{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.cache[path]; ok {
		return d, nil
	}
	d := m.lib.decide(segs)
	m.cache[path] = d
	return d, nil
}

// MatchNoCache decides a path without reading or writing the cache. It is
// the cache-free matcher used to cross-check cached results.
func (m *Matcher) MatchNoCache(path string) (Decision, error) {
	segs, err := splitPath(path)
	if err != nil {
		return Decision{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lib.decide(segs), nil
}

// decide walks the per-rule automata in priority order; the first accepting
// rule wins. Rules are sorted by specificity and equal-specificity rules are
// disjoint, so the first hit is the unique most specific match.
func (l *Library) decide(segs []string) Decision {
	for i := range l.rules {
		if l.rules[i].eff.Match(segs) {
			return Decision{Matched: true, RuleID: l.rules[i].rule.ID, Include: l.rules[i].rule.Include}
		}
	}
	return Decision{}
}
