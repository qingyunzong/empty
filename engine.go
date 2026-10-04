package rulelib

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// Decision is the access outcome for a path.
type Decision int

const (
	Deny Decision = iota
	Allow
)

func (d Decision) String() string {
	if d == Allow {
		return "allow"
	}
	return "deny"
}

// ErrAmbiguous is returned when two or more rules with identical
// specificity match the same path: ties are rejected.
var ErrAmbiguous = errors.New("rulelib: ambiguous match (tied specificity)")

// Result is the outcome of matching a path against the rule set.
type Result struct {
	Decision Decision
	Rule     string // name of the matched rule, "" when nothing matched
	Path     string
}

// snapshot is an immutable compiled rule set plus its own match cache.
// Hot reload swaps the whole snapshot, so no old automaton state or stale
// cache entry is ever reused.
type snapshot struct {
	rules []Rule // sorted by descending specificity
	dfas  []*dfa // per-rule language automaton, aligned with rules
	cache map[string]cacheEntry
}

type cacheEntry struct {
	res Result
	err error
}

// Engine matches paths against a compiled rule set with caching.
type Engine struct {
	mu   sync.RWMutex
	snap *snapshot
	gen  uint64
}

// NewEngine compiles rules into an Engine. Rules are ordered by
// specificity: literal segment count first, then total segment count.
func NewEngine(rules []Rule) (*Engine, error) {
	e := &Engine{}
	if err := e.Update(rules); err != nil {
		return nil, err
	}
	return e, nil
}

// Update hot-reloads the rule set: it compiles a brand new automaton
// snapshot with a fresh cache and atomically swaps it in. No state from
// the previous automaton is reused.
func (e *Engine) Update(rules []Rule) error {
	sorted := sortRules(rules)
	alpha, err := newAlphabet(sorted)
	if err != nil {
		return err
	}
	snap := &snapshot{
		rules: sorted,
		dfas:  make([]*dfa, len(sorted)),
		cache: make(map[string]cacheEntry),
	}
	for i, r := range sorted {
		snap.dfas[i] = ruleLanguage(r, alpha)
	}
	e.mu.Lock()
	e.snap = snap
	e.gen++
	e.mu.Unlock()
	return nil
}

// Generation returns the current snapshot generation (bumps on Update).
func (e *Engine) Generation() uint64 {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.gen
}

// Match decides access for path and reports the rule that fired.
func (e *Engine) Match(path string) (Result, error) {
	e.mu.RLock()
	snap := e.snap
	e.mu.RUnlock()
	if snap == nil {
		return Result{Decision: Deny, Path: path}, fmt.Errorf("rulelib: engine has no rules")
	}

	e.mu.RLock()
	entry, ok := snap.cache[path]
	e.mu.RUnlock()
	if ok {
		return entry.res, entry.err
	}

	res, err := snap.match(path)

	e.mu.Lock()
	// Re-check under write lock: the snapshot may have been hot-reloaded
	// while we were matching; never write into a stale snapshot's cache.
	if e.snap == snap {
		snap.cache[path] = cacheEntry{res: res, err: err}
	}
	e.mu.Unlock()
	return res, err
}

// match runs the uncached automaton-based match on a snapshot.
func (s *snapshot) match(path string) (Result, error) {
	segs := splitPath(path)
	best := -1
	tied := false
	for i, r := range s.rules {
		if !s.dfas[i].match(segs) {
			continue
		}
		if best < 0 {
			best = i
			tied = false
			continue
		}
		// Rules are sorted by descending specificity, so any later match
		// is either a tie (reject) or less specific (stop).
		if s.rules[best].specificity().compare(r.specificity()) == 0 {
			tied = true
		} else {
			break
		}
	}
	if best < 0 {
		return Result{Decision: Deny, Path: path}, nil
	}
	if tied {
		return Result{Decision: Deny, Rule: s.rules[best].Name, Path: path}, ErrAmbiguous
	}
	decision := Deny
	if s.rules[best].Allow {
		decision = Allow
	}
	return Result{Decision: decision, Rule: s.rules[best].Name, Path: path}, nil
}

// matchDirect is the reference matcher: pure glob matching, no automaton,
// no cache. Used to cross-check the engine.
func matchDirect(rules []Rule, path string) (Result, error) {
	sorted := sortRules(rules)
	segs := splitPath(path)
	best := -1
	tied := false
	for i := range sorted {
		if !sorted[i].matchesDirect(segs) {
			continue
		}
		if best < 0 {
			best = i
			continue
		}
		if sorted[best].specificity().compare(sorted[i].specificity()) == 0 {
			tied = true
		} else {
			break
		}
	}
	if best < 0 {
		return Result{Decision: Deny, Path: path}, nil
	}
	if tied {
		return Result{Decision: Deny, Rule: sorted[best].Name, Path: path}, ErrAmbiguous
	}
	decision := Deny
	if sorted[best].Allow {
		decision = Allow
	}
	return Result{Decision: decision, Rule: sorted[best].Name, Path: path}, nil
}

// Verify enumerates every path up to maxLen segments over tokens and
// cross-checks the cached engine against the uncached reference matcher.
// It returns the number of paths checked, or the first mismatch.
func Verify(e *Engine, rules []Rule, tokens []string, maxLen int) (int, error) {
	checked := 0
	var walk func(prefix []string) error
	walk = func(prefix []string) error {
		path := strings.Join(prefix, "/")
		got, gotErr := e.Match(path)
		want, wantErr := matchDirect(rules, path)
		checked++
		if (gotErr != nil) != (wantErr != nil) {
			return fmt.Errorf("rulelib: verify %q: engine err=%v direct err=%v", path, gotErr, wantErr)
		}
		if got.Decision != want.Decision || got.Rule != want.Rule {
			return fmt.Errorf("rulelib: verify %q: engine=%v/%q direct=%v/%q",
				path, got.Decision, got.Rule, want.Decision, want.Rule)
		}
		if len(prefix) >= maxLen {
			return nil
		}
		for _, tok := range tokens {
			if err := walk(append(prefix, tok)); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(nil); err != nil {
		return checked, err
	}
	return checked, nil
}
