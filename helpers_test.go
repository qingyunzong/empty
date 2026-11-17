package formal

import (
	"context"
	"sync"
	"testing"
	"time"
)

func newTestExecutor(t *testing.T, backend Backend) *Executor {
	t.Helper()
	e, err := NewExecutor(backend)
	if err != nil {
		t.Fatalf("NewExecutor: %v", err)
	}
	return e
}

func waitReport(t *testing.T, run *Run) Report {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rep, err := run.Wait(ctx)
	if err != nil {
		t.Fatalf("wait for run %q/%d: %v", run.PlanID(), run.Generation(), err)
	}
	return rep
}

type heldCall struct {
	nodeID     string
	generation uint64
	done       func(ApplyOutcome)

	claimed   bool
	delivered bool
}

// heldBackend stores every Apply callback so a test can release completions in
// an explicitly chosen order.
type heldBackend struct {
	mu        sync.Mutex
	calls     []*heldCall
	rollbacks []string
	notify    chan struct{}
}

func newHeldBackend() *heldBackend {
	return &heldBackend{notify: make(chan struct{}, 1024)}
}

func (b *heldBackend) Apply(_ context.Context, req ApplyRequest, done func(ApplyOutcome)) error {
	b.mu.Lock()
	b.calls = append(b.calls, &heldCall{
		nodeID:     req.Node.ID,
		generation: req.Generation,
		done:       done,
	})
	b.mu.Unlock()
	b.notify <- struct{}{}
	return nil
}

func (b *heldBackend) Rollback(_ context.Context, req RollbackRequest) error {
	b.mu.Lock()
	b.rollbacks = append(b.rollbacks, req.Node.ID)
	b.mu.Unlock()
	return nil
}

func (b *heldBackend) waitForCall(t *testing.T, generation uint64, nodeID string) *heldCall {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		b.mu.Lock()
		for _, c := range b.calls {
			if c.generation == generation && c.nodeID == nodeID && !c.claimed {
				c.claimed = true
				b.mu.Unlock()
				return c
			}
		}
		b.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for apply of %s generation %d", nodeID, generation)
		}
		select {
		case <-b.notify:
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (b *heldBackend) release(c *heldCall, out ApplyOutcome) {
	b.mu.Lock()
	if c.delivered {
		b.mu.Unlock()
		return
	}
	c.delivered = true
	b.mu.Unlock()
	c.done(out)
}

func (b *heldBackend) applyCount(generation uint64) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	count := 0
	for _, c := range b.calls {
		if c.generation == generation {
			count++
		}
	}
	return count
}

func (b *heldBackend) hasCall(generation uint64, nodeID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.calls {
		if c.generation == generation && c.nodeID == nodeID {
			return true
		}
	}
	return false
}

func okOutcome(nodeID string) ApplyOutcome {
	return ApplyOutcome{Effected: true, Token: nodeID + "/token"}
}

func diamondPlan(generation uint64) Plan {
	return Plan{
		ID:         "stack",
		Generation: generation,
		Nodes: []Node{
			{ID: "a", Action: ActionCreate, Reversible: true},
			{ID: "b", Action: ActionUpdate, Deps: []string{"a"}, Reversible: true},
			{ID: "c", Action: ActionDelete, Deps: []string{"a"}, Reversible: true},
			{ID: "d", Action: ActionCreate, Deps: []string{"b", "c"}, Reversible: true},
		},
	}
}
