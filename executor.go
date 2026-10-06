package boolexec

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
)

// PanicError reports a panic raised by a LeafFunc. The panicking node and all
// ancestors that began evaluation keep their started counts.
type PanicError struct {
	NodeID string
	Value  any
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("boolexec: panic in leaf %q: %v", e.NodeID, e.Value)
}

// session is one immutable generation of counters bound to an AST version.
type session struct {
	version int
	counts  map[string]*atomic.Uint64
	hashes  map[string]uint64
}

// Executor evaluates boolean ASTs and records per-node start counts. It is
// safe for concurrent use; counts are never rolled back by cancellation,
// errors, panics, or version replacement.
type Executor struct {
	mu  sync.RWMutex
	ses *session
}

// NewExecutor builds an Executor bound to the given AST version.
func NewExecutor(root *Node) (*Executor, error) {
	if err := Validate(root); err != nil {
		return nil, err
	}
	e := &Executor{}
	e.ses = newSession(0, root, nil)
	return e, nil
}

func newSession(version int, root *Node, prev *session) *session {
	s := &session{
		version: version,
		counts:  make(map[string]*atomic.Uint64),
		hashes:  make(map[string]uint64),
	}
	var walk func(n *Node)
	walk = func(n *Node) {
		h := StructuralHash(n)
		s.hashes[n.ID] = h
		c := &atomic.Uint64{}
		if prev != nil {
			if ph, ok := prev.hashes[n.ID]; ok && ph == h {
				if pc, ok := prev.counts[n.ID]; ok {
					c.Store(pc.Load())
				}
			}
		}
		s.counts[n.ID] = c
		for _, child := range n.Children {
			walk(child)
		}
	}
	walk(root)
	return s
}

// Replace swaps in a new AST version. Counts migrate to the new session for
// nodes whose stable ID still exists and whose structural hash is unchanged;
// structurally changed or new nodes start at zero, and removed nodes are
// dropped. In-flight evaluations never lose a count: every increment happens
// under a read lock, and Replace takes the write lock, so a count lands
// either in the old session before its snapshot or in the new one after.
func (e *Executor) Replace(root *Node) error {
	if err := Validate(root); err != nil {
		return err
	}
	e.mu.Lock()
	e.ses = newSession(e.ses.version+1, root, e.ses)
	e.mu.Unlock()
	return nil
}

// Version returns the current AST version (0-based, bumped by Replace).
func (e *Executor) Version() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.ses.version
}

// countStarted atomically records that node id began evaluation. It runs
// under the read lock so it cannot race with a Replace snapshot/swap.
func (e *Executor) countStarted(id string) {
	e.mu.RLock()
	if c, ok := e.ses.counts[id]; ok {
		c.Add(1)
	}
	e.mu.RUnlock()
}

// Eval evaluates the given node (typically the root of the current AST) with
// short-circuit semantics: And stops at the first false child, Or stops at
// the first true child, and unvisited children are neither evaluated nor
// counted. Every node whose evaluation begins is counted exactly once,
// including nodes that error, panic, or observe cancellation mid-flight.
func (e *Executor) Eval(ctx context.Context, n *Node) (bool, error) {
	return e.eval(ctx, n)
}

func (e *Executor) eval(ctx context.Context, n *Node) (val bool, err error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	e.countStarted(n.ID)
	defer func() {
		if r := recover(); r != nil {
			val = false
			err = &PanicError{NodeID: n.ID, Value: r}
		}
	}()
	switch n.Kind {
	case Leaf:
		return n.Leaf(ctx)
	case Not:
		v, err := e.eval(ctx, n.Children[0])
		if err != nil {
			return false, err
		}
		return !v, nil
	case And:
		for _, c := range n.Children {
			v, err := e.eval(ctx, c)
			if err != nil {
				return false, err
			}
			if !v {
				return false, nil
			}
		}
		return true, nil
	case Or:
		for _, c := range n.Children {
			v, err := e.eval(ctx, c)
			if err != nil {
				return false, err
			}
			if v {
				return true, nil
			}
		}
		return false, nil
	}
	return false, fmt.Errorf("boolexec: invalid node kind %d", n.Kind)
}
