// Package main implements a CLI that, given up to 18 integer-interval
// rules and one request, finds the minimum subset of rules that still
// proves the request is denied.
//
// Public semantics (see README.md):
//   - Each rule has a unique ID, an integer layer, an action
//     (allow or deny), and an inclusive integer interval [Lo, Hi].
//   - A rule matches a request value v iff Lo <= v <= Hi.
//   - Inheritance layers: among matching rules, only those at the
//     highest (most specific) layer decide the outcome; lower layers
//     are inherited away (child overrides parent).
//   - Deny priority: within the deciding layer, any matching deny rule
//     makes the outcome deny, regardless of matching allow rules.
//   - Default allow: if no rule matches, the request is allowed, so a
//     denial must be actively proven by the rules present.
package main

import "fmt"

// Action is the effect of a matching rule.
type Action int

const (
	Allow Action = iota
	Deny
)

// Rule is a single integer-interval rule.
type Rule struct {
	ID    string
	Layer int
	Act   Action
	Lo    int
	Hi    int
}

// Matches reports whether the rule's interval contains v (inclusive).
func (r Rule) Matches(v int) bool {
	return r.Lo <= v && v <= r.Hi
}

// Denies evaluates the public semantics: it reports whether the given
// rule set proves denial of a request for value v.
func Denies(rules []Rule, v int) bool {
	topLayer := 0
	any := false
	for _, r := range rules {
		if !r.Matches(v) {
			continue
		}
		if !any || r.Layer > topLayer {
			topLayer = r.Layer
			any = true
		}
	}
	if !any {
		return false // default allow
	}
	for _, r := range rules {
		if r.Matches(v) && r.Layer == topLayer && r.Act == Deny {
			return true // deny priority at the deciding layer
		}
	}
	return false
}

// parseAction converts a token to an Action.
func parseAction(s string) (Action, error) {
	switch s {
	case "allow":
		return Allow, nil
	case "deny":
		return Deny, nil
	}
	return Allow, fmt.Errorf("unknown action %q (want allow|deny)", s)
}
