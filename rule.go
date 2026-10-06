// Package faultinj provides a scope-based fault injection library.
//
// Failure rules are stacked by scope: inner scopes take priority over
// outer ones, and exiting a scope (normally or via panic, as long as the
// returned exit function is deferred) restores the parent rules. Scopes
// are carried by context.Context, so concurrent goroutines each see only
// their own scope chain. Every rule is one-shot: once it fires it is
// exhausted, and the actual hits are recorded in a shared Ledger.
package faultinj

import "sync/atomic"

// Operation identifies the unit of work a failure may be injected into.
type Operation struct {
	Name  string
	Attrs map[string]string
}

// Op builds an Operation with the given name.
func Op(name string) Operation { return Operation{Name: name} }

// WithAttr returns a copy of the operation carrying an extra attribute.
func (o Operation) WithAttr(key, value string) Operation {
	attrs := make(map[string]string, len(o.Attrs)+1)
	for k, v := range o.Attrs {
		attrs[k] = v
	}
	attrs[key] = value
	return Operation{Name: o.Name, Attrs: attrs}
}

// Matcher reports whether a rule applies to an operation.
type Matcher func(Operation) bool

// MatchOp matches operations by name.
func MatchOp(name string) Matcher {
	return func(o Operation) bool { return o.Name == name }
}

// MatchAttr matches operations carrying the given attribute key/value.
func MatchAttr(key, value string) Matcher {
	return func(o Operation) bool { return o.Attrs[key] == value }
}

// MatchAll matches every operation.
func MatchAll() Matcher {
	return func(Operation) bool { return true }
}

// Rule is a one-shot failure rule. The first operation that matches
// consumes the rule; later matches fall through to the remaining rules
// of the scope chain. Consumption is atomic, so a rule shared across
// goroutines still fires exactly once.
type Rule struct {
	name     string
	err      error
	match    Matcher
	consumed atomic.Bool
}

// NewRule builds a rule that fails matching operations with err.
func NewRule(name string, err error, match Matcher) *Rule {
	if err == nil {
		panic("faultinj: rule requires a non-nil error")
	}
	if match == nil {
		panic("faultinj: rule requires a matcher")
	}
	return &Rule{name: name, err: err, match: match}
}

// Name returns the rule name used in hit accounting.
func (r *Rule) Name() string { return r.name }

// Err returns the error injected when the rule fires.
func (r *Rule) Err() error { return r.err }

// Exhausted reports whether the rule has already fired.
func (r *Rule) Exhausted() bool { return r.consumed.Load() }

// fire attempts to consume the rule for op; it reports whether the
// rule matched and was still armed.
func (r *Rule) fire(op Operation) bool {
	return r.match(op) && r.consumed.CompareAndSwap(false, true)
}
