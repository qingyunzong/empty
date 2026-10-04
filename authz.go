// Package authz implements resource-tree authorization.
//
// Rules are attached to resource nodes and inherited down the tree.
// Evaluation walks from the target resource toward the root: the nearest
// level that has any rule matching the subject decides the outcome and
// shadows all ancestors. Within one level, deny wins over allow.
//
// Subjects are users or groups. Groups may nest and may even form cycles;
// membership closure is computed with a visited set, so it is always finite.
package authz

import (
	"fmt"
	"sort"
	"strings"
)

// Effect is the outcome of a single rule.
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

// Rule grants or denies a subject (user or group name) on a node.
type Rule struct {
	Subject string
	Effect  Effect
}

// Node is a resource in the tree. Each node has at most one parent.
type Node struct {
	Name     string
	Parent   *Node
	Children []*Node
	Rules    []Rule
}

// NewNode creates a detached node.
func NewNode(name string) *Node { return &Node{Name: name} }

// AddChild attaches child under n and returns the child.
func (n *Node) AddChild(child *Node) *Node {
	child.Parent = n
	n.Children = append(n.Children, child)
	return child
}

// SetParent reparents n under newParent. It fails if the move would create
// a cycle, i.e. if newParent is n itself or one of its descendants.
func (n *Node) SetParent(newParent *Node) error {
	if newParent == nil {
		return fmt.Errorf("authz: parent of %q cannot be nil", n.Name)
	}
	for cur := newParent; cur != nil; cur = cur.Parent {
		if cur == n {
			return fmt.Errorf("authz: reparenting %q under %q would create a cycle", n.Name, newParent.Name)
		}
	}
	if n.Parent != nil {
		siblings := n.Parent.Children[:0]
		for _, c := range n.Parent.Children {
			if c != n {
				siblings = append(siblings, c)
			}
		}
		n.Parent.Children = siblings
	}
	n.Parent = newParent
	newParent.Children = append(newParent.Children, n)
	return nil
}

// Path returns node names from the root down to n.
func (n *Node) Path() []string {
	var rev []string
	for cur := n; cur != nil; cur = cur.Parent {
		rev = append(rev, cur.Name)
	}
	path := make([]string, len(rev))
	for i, name := range rev {
		path[len(rev)-1-i] = name
	}
	return path
}

// Directory tracks users, groups and direct group membership.
type Directory struct {
	users   map[string]bool
	groups  map[string]bool
	parents map[string]map[string]bool // member -> groups directly containing it
}

// NewDirectory creates an empty directory.
func NewDirectory() *Directory {
	return &Directory{
		users:   map[string]bool{},
		groups:  map[string]bool{},
		parents: map[string]map[string]bool{},
	}
}

// AddUser registers a user.
func (d *Directory) AddUser(name string) { d.users[name] = true }

// AddGroup registers a group.
func (d *Directory) AddGroup(name string) { d.groups[name] = true }

// AddMember makes member (user or group) a direct member of group.
// Cycles are allowed; closure computation stays finite.
func (d *Directory) AddMember(group, member string) error {
	if !d.groups[group] {
		return fmt.Errorf("authz: unknown group %q", group)
	}
	if !d.users[member] && !d.groups[member] {
		return fmt.Errorf("authz: unknown member %q", member)
	}
	if d.parents[member] == nil {
		d.parents[member] = map[string]bool{}
	}
	d.parents[member][group] = true
	return nil
}

// RemoveMember deletes a direct membership edge, if present.
func (d *Directory) RemoveMember(group, member string) {
	if set, ok := d.parents[member]; ok {
		delete(set, group)
		if len(set) == 0 {
			delete(d.parents, member)
		}
	}
}

// GroupPaths returns, for every group user belongs to transitively, one
// membership chain from the user to that group (shortest, BFS order).
// Cycles in group nesting are cut by the visited set.
func (d *Directory) GroupPaths(user string) map[string][]string {
	paths := map[string][]string{}
	visited := map[string]bool{user: true}
	type item struct {
		name string
		path []string
	}
	queue := []item{{user, []string{user}}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		groups := make([]string, 0, len(d.parents[cur.name]))
		for g := range d.parents[cur.name] {
			groups = append(groups, g)
		}
		sort.Strings(groups)
		for _, g := range groups {
			if visited[g] {
				continue
			}
			visited[g] = true
			p := append(append([]string{}, cur.path...), g)
			paths[g] = p
			queue = append(queue, item{g, p})
		}
	}
	return paths
}

// Hit records one rule that matched at the deciding level.
type Hit struct {
	Node    string   // node carrying the rule
	Subject string   // subject named by the rule
	Via     []string // membership chain user->...->Subject; nil for direct match
	Effect  Effect
}

func (h Hit) String() string {
	if len(h.Via) == 0 {
		return fmt.Sprintf("%s[%s: %s]", h.Node, h.Subject, h.Effect)
	}
	return fmt.Sprintf("%s[%s via %s: %s]", h.Node, h.Subject, strings.Join(h.Via, "->"), h.Effect)
}

// Decision is the outcome of evaluating one user against one resource.
type Decision struct {
	Allowed bool
	Matched bool     // false when no rule matched on any ancestor level
	Path    []string // nodes walked from the resource up to the deciding node
	Hits    []Hit    // rules that decided the outcome
}

func (dec Decision) String() string {
	if !dec.Matched {
		return fmt.Sprintf("%s: no matching rule (default deny)", strings.Join(dec.Path, " <- "))
	}
	var hits []string
	for _, h := range dec.Hits {
		hits = append(hits, h.String())
	}
	return fmt.Sprintf("%s: %s by %s", strings.Join(dec.Path, " <- "), dec.effect(), strings.Join(hits, ", "))
}

func (dec Decision) effect() string {
	if dec.Allowed {
		return "allow"
	}
	return "deny"
}

// Evaluate decides whether user may access the resource n.
//
// It walks from n toward the root. At each level it collects the rules
// matching the user directly or through a group in the user's membership
// closure. The first level with any match decides: deny if any matched rule
// denies, allow otherwise. Ancestor levels are shadowed. If no level
// matches, the decision is an unmatched (default deny) result.
func Evaluate(n *Node, d *Directory, user string) Decision {
	paths := d.GroupPaths(user)
	dec := Decision{}
	for cur := n; cur != nil; cur = cur.Parent {
		dec.Path = append(dec.Path, cur.Name)
		var hits []Hit
		for _, r := range cur.Rules {
			switch {
			case r.Subject == user:
				hits = append(hits, Hit{Node: cur.Name, Subject: r.Subject, Effect: r.Effect})
			default:
				if via, ok := paths[r.Subject]; ok {
					hits = append(hits, Hit{Node: cur.Name, Subject: r.Subject, Via: via, Effect: r.Effect})
				}
			}
		}
		if len(hits) > 0 {
			dec.Matched = true
			dec.Allowed = true
			for _, h := range hits {
				if h.Effect == Deny {
					dec.Allowed = false
					break
				}
			}
			dec.Hits = hits
			return dec
		}
	}
	return dec
}
