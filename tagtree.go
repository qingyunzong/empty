// Package tagtree implements a statistics library whose labels form a tree.
// An event may carry multiple tag nodes; aggregation at an ancestor counts
// each event at most once. Removing a tree edge changes aggregation
// membership but never rewrites the original tags stored on events.
package tagtree

import (
	"errors"
	"fmt"
	"sort"
)

// Tree is a forest-shaped label hierarchy. Nodes are identified by int IDs.
type Tree struct {
	children map[int]map[int]bool
	parent   map[int]int
}

// NewTree returns an empty tree.
func NewTree() *Tree {
	return &Tree{
		children: make(map[int]map[int]bool),
		parent:   make(map[int]int),
	}
}

// AddNode registers a node. Adding an existing node is a no-op.
func (t *Tree) AddNode(id int) {
	if _, ok := t.children[id]; !ok {
		t.children[id] = make(map[int]bool)
	}
}

// Has reports whether the node exists.
func (t *Tree) Has(id int) bool {
	_, ok := t.children[id]
	return ok
}

// Parent returns the parent of id and whether it has one.
func (t *Tree) Parent(id int) (int, bool) {
	p, ok := t.parent[id]
	return p, ok
}

// Children returns the sorted child IDs of id.
func (t *Tree) Children(id int) []int {
	out := make([]int, 0, len(t.children[id]))
	for c := range t.children[id] {
		out = append(out, c)
	}
	sort.Ints(out)
	return out
}

// AddEdge links parent -> child. It fails if either node is missing, the
// child already has a parent, or the edge would create a cycle.
func (t *Tree) AddEdge(parent, child int) error {
	if !t.Has(parent) {
		return fmt.Errorf("parent node %d does not exist", parent)
	}
	if !t.Has(child) {
		return fmt.Errorf("child node %d does not exist", child)
	}
	if parent == child {
		return errors.New("self edge not allowed")
	}
	if _, ok := t.parent[child]; ok {
		return fmt.Errorf("node %d already has a parent", child)
	}
	if t.isAncestor(child, parent) {
		return fmt.Errorf("edge %d -> %d would create a cycle", parent, child)
	}
	t.children[parent][child] = true
	t.parent[child] = parent
	return nil
}

// RemoveEdge detaches child from parent. The child's subtree stays intact
// under child; only the membership under the old ancestors changes.
func (t *Tree) RemoveEdge(parent, child int) error {
	p, ok := t.parent[child]
	if !ok || p != parent {
		return fmt.Errorf("edge %d -> %d does not exist", parent, child)
	}
	delete(t.children[parent], child)
	delete(t.parent, child)
	return nil
}

// isAncestor reports whether anc is a strict ancestor of id.
func (t *Tree) isAncestor(anc, id int) bool {
	for cur, ok := t.parent[id]; ok; cur, ok = t.parent[cur] {
		if cur == anc {
			return true
		}
	}
	return false
}

// Subtree returns the set of node IDs reachable from root, including root.
func (t *Tree) Subtree(root int) map[int]bool {
	out := make(map[int]bool)
	var walk func(int)
	walk = func(id int) {
		if out[id] {
			return
		}
		out[id] = true
		for c := range t.children[id] {
			walk(c)
		}
	}
	if t.Has(root) {
		walk(root)
	}
	return out
}

// Contribution is the evidence that one event contributed to an aggregate:
// the event ID plus the event's own tag nodes that lie inside the subtree.
type Contribution struct {
	EventID string
	Via     []int
}

// Library stores tagged events over a label tree and answers aggregates.
type Library struct {
	tree   *Tree
	events map[string]map[int]bool
}

// NewLibrary returns a Library over the given tree.
func NewLibrary(tree *Tree) *Library {
	return &Library{tree: tree, events: make(map[string]map[int]bool)}
}

// AddEvent records an event with one or more tag nodes. Tags are stored
// verbatim and are never rewritten by later tree edits.
func (l *Library) AddEvent(id string, tags ...int) error {
	if len(tags) == 0 {
		return errors.New("event needs at least one tag")
	}
	set := make(map[int]bool, len(tags))
	for _, tag := range tags {
		if !l.tree.Has(tag) {
			return fmt.Errorf("tag node %d does not exist", tag)
		}
		set[tag] = true
	}
	l.events[id] = set
	return nil
}

// Tags returns the sorted original tag nodes stored for an event.
func (l *Library) Tags(eventID string) []int {
	set, ok := l.events[eventID]
	if !ok {
		return nil
	}
	out := make([]int, 0, len(set))
	for tag := range set {
		out = append(out, tag)
	}
	sort.Ints(out)
	return out
}

// Evidence lists every event contributing to the aggregate at node, each
// with the tag nodes through which it reaches node. Events are deduplicated:
// an event tagged at several descendants appears once, with all of them in
// Via. Output is sorted by event ID, and Via is sorted ascending.
func (l *Library) Evidence(node int) []Contribution {
	if !l.tree.Has(node) {
		return nil
	}
	sub := l.tree.Subtree(node)
	out := make([]Contribution, 0, len(l.events))
	for id, tags := range l.events {
		var via []int
		for tag := range tags {
			if sub[tag] {
				via = append(via, tag)
			}
		}
		if len(via) > 0 {
			sort.Ints(via)
			out = append(out, Contribution{EventID: id, Via: via})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EventID < out[j].EventID })
	return out
}

// Count aggregates at node: the number of distinct events with at least one
// tag inside node's subtree. Each event counts at most once.
func (l *Library) Count(node int) int {
	return len(l.Evidence(node))
}
