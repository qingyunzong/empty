package faultinj

import (
	"context"
	"sync"
	"sync/atomic"
)

// Injector evaluates failure rules against operations and records every
// actual hit in its Ledger. Create one per test or per subsystem with New.
type Injector struct {
	ledger *Ledger
}

// New returns an Injector with an empty hit ledger.
func New() *Injector {
	return &Injector{ledger: &Ledger{}}
}

// Ledger returns the ledger recording the hits of this injector.
func (inj *Injector) Ledger() *Ledger { return inj.ledger }

// scopeNode is one frame of the scope chain carried by a context.
// active flips to false when the scope exits; Check skips inactive
// frames, which is what restores the parent rules.
type scopeNode struct {
	label  string
	parent *scopeNode
	rules  []*Rule
	active atomic.Bool
}

type scopeKey struct{}

// WithScope stacks rules on top of the scope chain carried by ctx and
// returns the derived context together with an exit function.
//
// The inner rules take priority over the parent chain while the scope is
// active. Calling exit deactivates the scope and restores the parent
// rules; exit is idempotent and safe to defer, so a
//
//	ctx, exit := inj.WithScope(ctx, "label", rules...)
//	defer exit()
//
// pair restores the parent rules even when the wrapped code panics.
// Because each call derives a fresh chain from ctx, concurrent goroutines
// holding different contexts never observe each other's scopes.
func (inj *Injector) WithScope(ctx context.Context, label string, rules ...*Rule) (context.Context, func()) {
	node := &scopeNode{label: label, rules: rules}
	node.active.Store(true)
	if parent, ok := ctx.Value(scopeKey{}).(*scopeNode); ok {
		node.parent = parent
	}
	var once sync.Once
	exit := func() { once.Do(func() { node.active.Store(false) }) }
	return context.WithValue(ctx, scopeKey{}, node), exit
}

// Check walks the scope chain from the innermost scope outward and fires
// the first matching rule that is still armed. Exhausted rules are
// skipped, so an operation may fall through to an outer scope. It returns
// nil when no armed rule matches.
func (inj *Injector) Check(ctx context.Context, op Operation) error {
	node, _ := ctx.Value(scopeKey{}).(*scopeNode)
	for n := node; n != nil; n = n.parent {
		if !n.active.Load() {
			continue
		}
		for _, r := range n.rules {
			if r.fire(op) {
				inj.ledger.record(Hit{Rule: r.Name(), Scope: n.label, Op: op})
				return r.Err()
			}
		}
	}
	return nil
}
