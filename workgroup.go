// Package workgroup provides groups of cooperating tasks where a task in
// one group may wait for another group to drain. Wait edges between groups
// must form a DAG: adding an edge that would close a cycle is rejected and
// the cycle is reported as evidence.
package workgroup

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// CycleError is returned when adding a wait edge would create a cycle.
// Path holds the cycle as group names, with Path[0] == Path[len(Path)-1].
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return "workgroup: wait edge would create cycle: " + strings.Join(e.Path, " -> ")
}

// Environment owns a set of groups and the wait edges between them.
type Environment struct {
	mu     sync.Mutex
	groups map[string]*Group
	edges  map[string]map[string]bool // edges[a][b]: a waits on b
}

func NewEnvironment() *Environment {
	return &Environment{
		groups: make(map[string]*Group),
		edges:  make(map[string]map[string]bool),
	}
}

// NewGroup registers a group with a unique name.
func (env *Environment) NewGroup(name string) (*Group, error) {
	env.mu.Lock()
	defer env.mu.Unlock()
	if _, ok := env.groups[name]; ok {
		return nil, fmt.Errorf("workgroup: group %q already exists", name)
	}
	g := &Group{env: env, name: name}
	g.cond = sync.NewCond(&g.mu)
	env.groups[name] = g
	return g, nil
}

// Snapshot returns the current nodes and wait edges (from waits on to) so an
// independent checker can verify the graph.
func (env *Environment) Snapshot() (nodes []string, edges [][2]string) {
	env.mu.Lock()
	defer env.mu.Unlock()
	for name := range env.groups {
		nodes = append(nodes, name)
	}
	for from, tos := range env.edges {
		for to := range tos {
			edges = append(edges, [2]string{from, to})
		}
	}
	return nodes, edges
}

// findPathLocked returns a path from src to dst following wait edges, or nil.
func (env *Environment) findPathLocked(src, dst string) []string {
	visited := map[string]bool{src: true}
	var dfs func(node string) []string
	dfs = func(node string) []string {
		if node == dst {
			return []string{node}
		}
		for next := range env.edges[node] {
			if visited[next] {
				continue
			}
			visited[next] = true
			if rest := dfs(next); rest != nil {
				return append([]string{node}, rest...)
			}
		}
		return nil
	}
	return dfs(src)
}

// dependsOn adds a wait edge from -> to, rejecting cycles.
func (env *Environment) dependsOn(from, to string) error {
	env.mu.Lock()
	defer env.mu.Unlock()
	if _, ok := env.groups[from]; !ok {
		return fmt.Errorf("workgroup: unknown group %q", from)
	}
	if _, ok := env.groups[to]; !ok {
		return fmt.Errorf("workgroup: unknown group %q", to)
	}
	if from == to {
		return &CycleError{Path: []string{from, from}}
	}
	if env.edges[from][to] {
		return nil // edge already present
	}
	if path := env.findPathLocked(to, from); path != nil {
		// The new edge from->to plus the existing to->...->from closes a cycle.
		cycle := append([]string{from}, path...)
		return &CycleError{Path: cycle}
	}
	if env.edges[from] == nil {
		env.edges[from] = make(map[string]bool)
	}
	env.edges[from][to] = true
	return nil
}

// Group is a set of tasks. Membership is frozen by Shutdown; after that Go
// refuses new tasks. The freeze and the member count are guarded by the same
// mutex, so a task is either counted before the freeze or rejected after it.
type Group struct {
	env  *Environment
	name string

	mu     sync.Mutex
	cond   *sync.Cond
	frozen bool
	active int
}

func (g *Group) Name() string { return g.name }

// Go runs fn as a member of the group. It reports whether the task was
// accepted; once the group is frozen by Shutdown, Go returns false and fn
// is not run.
func (g *Group) Go(fn func()) bool {
	g.mu.Lock()
	if g.frozen {
		g.mu.Unlock()
		return false
	}
	g.active++
	g.mu.Unlock()
	go func() {
		defer g.leave()
		fn()
	}()
	return true
}

func (g *Group) leave() {
	g.mu.Lock()
	g.active--
	g.cond.Broadcast()
	g.mu.Unlock()
}

// Wait blocks until the currently active members have exited. Like
// sync.WaitGroup.Wait, it does not prevent new members from being added
// unless the group is frozen.
func (g *Group) Wait() {
	g.mu.Lock()
	for g.active != 0 {
		g.cond.Wait()
	}
	g.mu.Unlock()
}

// Shutdown freezes membership and then blocks until every member that was
// accepted before the freeze has exited.
func (g *Group) Shutdown() {
	g.mu.Lock()
	g.frozen = true
	for g.active != 0 {
		g.cond.Wait()
	}
	g.mu.Unlock()
}

// Frozen reports whether Shutdown has been called.
func (g *Group) Frozen() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.frozen
}

// DependsOn records that this group waits on other. It fails with a
// *CycleError (carrying the cycle as evidence) if the new edge would close
// a cycle of waits between groups.
func (g *Group) DependsOn(other *Group) error {
	if g.env != other.env {
		return errors.New("workgroup: groups belong to different environments")
	}
	return g.env.dependsOn(g.name, other.name)
}

// WaitOn records the wait edge and then blocks until other drains.
func (g *Group) WaitOn(other *Group) error {
	if err := g.DependsOn(other); err != nil {
		return err
	}
	other.Wait()
	return nil
}
