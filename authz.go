// Package authz implements resource-tree authorization.
//
// Semantics:
//   - Rules attach to resource-tree nodes and are inherited downward.
//   - Evaluation walks from the target resource up to the root; the
//     nearest level carrying at least one matching rule decides the
//     outcome and shadows all ancestors.
//   - Within one level, any matching deny wins over allows.
//   - Groups nest arbitrarily and may contain cycles; the transitive
//     member closure is computed with a visited set, so it is always
//     finite and terminates.
package authz

import (
	"fmt"
	"strings"
)

// Effect is the outcome a rule grants when it matches.
type Effect int

const (
	Deny Effect = iota
	Allow
)

func (e Effect) String() string {
	if e == Allow {
		return "allow"
	}
	return "deny"
}

// Rule binds a subject (user id or group id) to an action on the node
// it is attached to. Action "*" matches any action.
type Rule struct {
	Subject string
	Action  string
	Effect  Effect
}

func (r Rule) matchesAction(action string) bool {
	return r.Action == "*" || r.Action == action
}

// Node is a resource-tree node. Parent pointers form the inheritance
// chain; a nil Parent marks the root.
type Node struct {
	ID     string
	Parent *Node
	Rules  []Rule
}

// PathToRoot returns the chain from n (inclusive) up to the root.
func (n *Node) PathToRoot() []*Node {
	var path []*Node
	for cur := n; cur != nil; cur = cur.Parent {
		path = append(path, cur)
	}
	return path
}

// Groups stores direct group memberships. A member is either a user id
// or another group id; cycles between groups are allowed.
type Groups struct {
	members map[string][]string
}

func NewGroups() *Groups {
	return &Groups{members: make(map[string][]string)}
}

// Add records direct members of group. Members may be users or groups.
func (g *Groups) Add(group string, members ...string) {
	g.members[group] = append(g.members[group], members...)
}

// memberToGroups builds the reverse index: entity -> groups containing it.
func (g *Groups) memberToGroups() map[string][]string {
	idx := make(map[string][]string)
	for group, ms := range g.members {
		for _, m := range ms {
			idx[m] = append(idx[m], group)
		}
	}
	return idx
}

// Reachable returns every group that transitively contains user, mapped
// to one witness chain (user, ..., group). BFS with a visited set keeps
// the closure finite even when group nesting contains cycles.
func (g *Groups) Reachable(user string) map[string][]string {
	idx := g.memberToGroups()
	seen := map[string]bool{user: true}
	paths := make(map[string][]string)
	type item struct {
		entity string
		path   []string
	}
	queue := []item{{entity: user, path: []string{user}}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, group := range idx[cur.entity] {
			if seen[group] {
				continue
			}
			seen[group] = true
			path := append(append([]string{}, cur.path...), group)
			paths[group] = path
			queue = append(queue, item{entity: group, path: path})
		}
	}
	return paths
}

// Hit is one rule that matched during evaluation.
type Hit struct {
	Node       *Node
	Rule       Rule
	Depth      int      // 0 = target resource, 1 = its parent, ...
	GroupChain []string // witness chain from user to Rule.Subject
}

// Decision is the outcome of Evaluate, including the hit path for audit.
type Decision struct {
	Allowed bool
	Matched bool     // false when no rule on any ancestor matched
	Hits    []Hit    // all matching rules at the deciding (nearest) level
	Path    []string // node ids from the target resource up to the deciding node
}

// HitPath renders the inheritance path from the target resource to the
// deciding node, plus the winning rules and group witness chains.
func (d Decision) HitPath() string {
	if !d.Matched {
		return "no matching rule on any ancestor (default deny)"
	}
	var b strings.Builder
	node := d.Hits[0].Node
	fmt.Fprintf(&b, "deciding node %q (hit path: %s), depth %d\n",
		node.ID, strings.Join(d.Path, " -> "), d.Hits[0].Depth)
	for _, h := range d.Hits {
		fmt.Fprintf(&b, "  %s subject=%q action=%q via %s\n",
			h.Rule.Effect, h.Rule.Subject, h.Rule.Action,
			strings.Join(h.GroupChain, " -> "))
	}
	return b.String()
}

// Evaluate decides whether user may perform action on res.
//
// It walks level by level from res to the root. The first level with at
// least one matching rule decides (shadowing all ancestors); at that
// level any deny wins. If nothing matches, the default is deny.
func Evaluate(user, action string, res *Node, gs *Groups) Decision {
	reach := gs.Reachable(user)
	subjectChain := func(subject string) ([]string, bool) {
		if subject == user {
			return []string{user}, true
		}
		if path, ok := reach[subject]; ok {
			return path, true
		}
		return nil, false
	}

	depth := 0
	var walked []string
	for node := res; node != nil; node = node.Parent {
		walked = append(walked, node.ID)
		var hits []Hit
		for _, r := range node.Rules {
			if !r.matchesAction(action) {
				continue
			}
			chain, ok := subjectChain(r.Subject)
			if !ok {
				continue
			}
			hits = append(hits, Hit{Node: node, Rule: r, Depth: depth, GroupChain: chain})
		}
		if len(hits) > 0 {
			allowed := true
			for _, h := range hits {
				if h.Rule.Effect == Deny {
					allowed = false
					break
				}
			}
			return Decision{Allowed: allowed, Matched: true, Hits: hits, Path: walked}
		}
		depth++
	}
	return Decision{Allowed: false, Matched: false}
}
