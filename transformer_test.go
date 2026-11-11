package q159

import (
	"context"
	"errors"
	"testing"
)

// A batch admitted before the barrier must finish against the old target
// even though SetTarget happens while its transformation is blocked. A batch
// admitted afterwards routes to the new target.
func TestBarrierSwitchDuringTransform(t *testing.T) {
	g := newGate()
	edges := []Edge{
		gated(incEdge("e1", "a", "b", 1), g),
		gated(incEdge("e2", "b", "c", 1), g),
		gated(incEdge("e3", "b", "d", 1), g),
	}
	tr, err := New(edges, "c")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	type result struct {
		out []Record
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 0}})
		done <- result{out, err}
	}()

	g.waitEntered()
	if err := tr.SetTarget("d"); err != nil {
		t.Fatalf("SetTarget: %v", err)
	}
	if got := tr.Target(); got != "d" {
		t.Fatalf("target after switch = %q, want d", got)
	}

	g.releaseAll()
	old := <-done
	if old.err != nil {
		t.Fatalf("old batch: %v", old.err)
	}
	if len(old.out) != 1 || old.out[0].Schema != "c" {
		t.Fatalf("old batch output = %+v, want schema c", old.out)
	}
	if old.out[0].Payload != 2 {
		t.Fatalf("old batch payload = %v, want 2 (a->b->c)", old.out[0].Payload)
	}

	out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 0}})
	if err != nil {
		t.Fatalf("new batch: %v", err)
	}
	if out[0].Schema != "d" || out[0].Payload != 2 {
		t.Fatalf("new batch output = %+v, want schema d payload 2 (a->b->d)", out)
	}
}

// Any record without a route to the current target rejects the whole batch,
// and no transformation function may run for that batch.
func TestNoPathRejectsWholeBatch(t *testing.T) {
	calls := 0
	counting := func(e Edge) Edge {
		inner := e.Apply
		e.Apply = func(ctx context.Context, in any) (any, error) {
			calls++
			return inner(ctx, in)
		}
		return e
	}
	edges := []Edge{
		counting(incEdge("e1", "a", "b", 1)),
		incEdge("e2", "x", "y", 1),
	}
	tr, err := New(edges, "b")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	batch := []Record{
		{Schema: "a", Payload: 1},
		{Schema: "x", Payload: 1},
	}
	out, err := tr.ApplyBatch(context.Background(), batch)
	if !errors.Is(err, ErrNoPath) {
		t.Fatalf("err = %v, want ErrNoPath", err)
	}
	if out != nil {
		t.Fatalf("out = %v, want nil on rejection", out)
	}
	if calls != 0 {
		t.Fatalf("transform ran %d times, want 0 before rejection", calls)
	}

	// A fully routable batch on the same transformer still works.
	ok, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 1}})
	if err != nil {
		t.Fatalf("routable batch: %v", err)
	}
	if ok[0].Payload != 2 || ok[0].Schema != "b" {
		t.Fatalf("routable batch output = %+v", ok)
	}
}

// A graph update that would introduce a cycle is rejected atomically: the
// version stays put and the old graph keeps routing.
func TestCyclicUpdateRejected(t *testing.T) {
	tr, err := New([]Edge{incEdge("e1", "a", "b", 1)}, "b")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	cyclic := []Edge{
		incEdge("e1", "a", "b", 1),
		incEdge("e2", "b", "c", 1),
		incEdge("e3", "c", "a", 1),
	}
	v, err := tr.ReplaceEdges(cyclic)
	if !errors.Is(err, ErrCycle) {
		t.Fatalf("ReplaceEdges err = %v, want ErrCycle", err)
	}
	if v != 1 || tr.Version() != 1 {
		t.Fatalf("version = %d/%d, want 1 (update must not advance)", v, tr.Version())
	}

	out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 0}})
	if err != nil {
		t.Fatalf("old graph routing after rejected update: %v", err)
	}
	if out[0].Schema != "b" {
		t.Fatalf("output schema = %q, want b", out[0].Schema)
	}

	// A valid update is still accepted afterwards.
	v, err = tr.ReplaceEdges([]Edge{
		incEdge("e1", "a", "b", 1),
		incEdge("e4", "b", "d", 1),
	})
	if err != nil || v != 2 {
		t.Fatalf("valid ReplaceEdges: v=%d err=%v", v, err)
	}

	// Construction itself must reject cycles too.
	if _, err := New(cyclic, "a"); !errors.Is(err, ErrCycle) {
		t.Fatalf("New with cycle err = %v, want ErrCycle", err)
	}
}

// Old batches finish on an old immutable snapshot whose cache can never be
// written by the new version, and the new version starts with an empty
// cache.
func TestOldBatchCannotPolluteNewVersionCache(t *testing.T) {
	g := newGate()
	tr, err := New([]Edge{
		gated(incEdge("e1", "a", "b", 1), g),
		gated(incEdge("e2", "b", "c", 1), g),
	}, "c")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	done := make(chan struct{})
	var oldOut []Record
	var oldErr error
	go func() {
		defer close(done)
		oldOut, oldErr = tr.ApplyBatch(context.Background(),
			[]Record{{Schema: "a", Payload: 0}})
	}()
	g.waitEntered()

	oldSnap := currentSnapshot(tr)
	newVersion, err := tr.ReplaceEdges([]Edge{
		incEdge("e1", "a", "b", 1),
		incEdge("e2", "b", "c", 1),
		incEdge("e3", "c", "d", 1),
	})
	if err != nil || newVersion != 2 {
		t.Fatalf("ReplaceEdges: v=%d err=%v", newVersion, err)
	}
	newSnap := currentSnapshot(tr)
	if newSnap == oldSnap {
		t.Fatal("new version must use a distinct snapshot")
	}
	if cacheSourceCount(newSnap) != 0 {
		t.Fatalf("new snapshot cache = %d sources, want empty", cacheSourceCount(newSnap))
	}

	g.releaseAll()
	<-done
	if oldErr != nil || oldOut[0].Schema != "c" || oldOut[0].Payload != 2 {
		t.Fatalf("old batch = %+v err=%v, want a->b->c on old snapshot", oldOut, oldErr)
	}

	// The old snapshot cached only its own version's routes.
	if cacheSourceCount(oldSnap) != 1 {
		t.Fatalf("old snapshot cache = %d sources, want 1", cacheSourceCount(oldSnap))
	}
	if _, ok := cachePath(oldSnap, "a", "d"); ok {
		t.Fatal("old snapshot must not contain a route that only exists in v2")
	}

	// The new version's cache is populated only by new batches.
	if _, err := tr.ApplyBatch(context.Background(),
		[]Record{{Schema: "a", Payload: 0}}); err != nil {
		t.Fatalf("new version batch: %v", err)
	}
	if cacheSourceCount(newSnap) != 1 {
		t.Fatalf("new snapshot cache = %d sources after batch, want 1",
			cacheSourceCount(newSnap))
	}
	if path, ok := cachePath(newSnap, "a", "d"); !ok || len(path) != 3 {
		t.Fatalf("new snapshot a->d path = %v ok=%v, want 3 edges", path, ok)
	}
	if cacheSourceCount(oldSnap) != 1 {
		t.Fatal("new-version batch must not mutate the old snapshot's cache")
	}
}
