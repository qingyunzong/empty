// Package workgroup provides task groups that can wait on each other.
//
// A Group tracks a set of member tasks. Closing a group first freezes
// membership (no new members may join) and then blocks until every
// member that joined before the freeze has exited. Groups form a wait
// graph: an edge u -> v means u waits for v to fully close. The graph
// rejects any edge that would create a wait cycle and reports the
// cycle as evidence.
package workgroup

import (
	"errors"
	"sync"
)

// ErrFrozen is returned by Add when the group has already been frozen
// by Close.
var ErrFrozen = errors.New("workgroup: group is frozen")

// Group is a set of member tasks that can be waited on as a unit.
type Group struct {
	name  string
	graph *Graph

	mu     sync.Mutex
	frozen bool
	active int
	done   chan struct{}
}

// Name returns the group's name.
func (g *Group) Name() string { return g.name }

// Add registers a new member task. It fails with ErrFrozen once Close
// has frozen the group. Add and Close are serialized on the same
// mutex, so a member is never lost: every successful Add is observed
// by Close, which then waits for the matching Done.
func (g *Group) Add() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.frozen {
		return ErrFrozen
	}
	g.active++
	return nil
}

// Done marks one member task as exited. It must be called once for
// every successful Add.
func (g *Group) Done() {
	g.mu.Lock()
	g.active--
	if g.active < 0 {
		g.mu.Unlock()
		panic("workgroup: Done called without matching Add")
	}
	finished := g.frozen && g.active == 0
	g.mu.Unlock()
	if finished {
		close(g.done)
	}
}

// Go runs fn as a member task in a new goroutine. It reports whether
// the task was admitted (i.e. the group was not yet frozen).
func (g *Group) Go(fn func()) error {
	if err := g.Add(); err != nil {
		return err
	}
	go func() {
		defer g.Done()
		fn()
	}()
	return nil
}

// Close freezes the group and then blocks until every member admitted
// before the freeze has exited. It is idempotent and safe to call
// concurrently.
func (g *Group) Close() {
	g.mu.Lock()
	if !g.frozen {
		g.frozen = true
		if g.active == 0 {
			close(g.done)
		}
	}
	g.mu.Unlock()
	<-g.done
}

// Wait blocks until the group has fully closed without freezing it.
// Unlike Close it does not change membership; it only observes.
func (g *Group) Wait() {
	<-g.done
}

// Closed reports whether the group has fully closed: frozen and all
// members exited.
func (g *Group) Closed() bool {
	select {
	case <-g.done:
		return true
	default:
		return false
	}
}
