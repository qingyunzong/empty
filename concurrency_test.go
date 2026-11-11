package q159

import (
	"context"
	"sync"
	"testing"
)

// Controlled concurrency: N batches start together behind a WaitGroup while
// graph updates and target switches run concurrently. Every batch must be
// internally consistent: its output schema is the target of exactly one
// snapshot generation, and the payload proves the full path ran.
func TestControlledConcurrentBatchesAndUpdates(t *testing.T) {
	tr, err := New([]Edge{
		incEdge("e1", "a", "b", 1),
		incEdge("e2", "b", "c", 1),
	}, "c")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	const workers = 32
	const iterations = 200

	var wg sync.WaitGroup
	start := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		lastVersion := uint64(1)
		for i := 0; i < iterations; i++ {
			edges := []Edge{
				incEdge("e1", "a", "b", 1),
				incEdge("e2", "b", "c", 1),
				incEdge("e3", "c", "d", 1),
			}
			v, err := tr.ReplaceEdges(edges)
			if err != nil {
				t.Errorf("ReplaceEdges extended: %v", err)
				return
			}
			if v <= lastVersion {
				t.Errorf("version must increase: got %d after %d", v, lastVersion)
				return
			}
			lastVersion = v
			v, err = tr.ReplaceEdges(edges[:2])
			if err != nil {
				t.Errorf("ReplaceEdges base: %v", err)
				return
			}
			if v <= lastVersion {
				t.Errorf("version must increase: got %d after %d", v, lastVersion)
				return
			}
			lastVersion = v
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < iterations; i++ {
			if err := tr.SetTarget("c"); err != nil {
				t.Errorf("SetTarget c: %v", err)
				return
			}
			if err := tr.SetTarget("b"); err != nil {
				t.Errorf("SetTarget b: %v", err)
				return
			}
			if err := tr.SetTarget("c"); err != nil {
				t.Errorf("SetTarget c again: %v", err)
				return
			}
		}
	}()

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < iterations; i++ {
				out, err := tr.ApplyBatch(context.Background(),
					[]Record{{Schema: "a", Payload: 0}})
				if err != nil {
					t.Errorf("ApplyBatch: %v", err)
					return
				}
				if len(out) != 1 {
					t.Errorf("output len = %d, want 1", len(out))
					return
				}
				switch out[0].Schema {
				case "b":
					if out[0].Payload != 1 {
						t.Errorf("target b payload = %v, want 1", out[0].Payload)
						return
					}
				case "c":
					if out[0].Payload != 2 {
						t.Errorf("target c payload = %v, want 2", out[0].Payload)
						return
					}
				default:
					t.Errorf("unexpected target schema %q", out[0].Schema)
					return
				}
			}
		}()
	}

	close(start)
	wg.Wait()
}

// Many batches block inside their transformations while the barrier moves;
// every batch keeps the target it was admitted with.
func TestConcurrentBatchesAcrossBarrier(t *testing.T) {
	g := newGate()
	tr, err := New([]Edge{
		gated(incEdge("e1", "a", "b", 1), g),
		gated(incEdge("e2", "b", "c", 1), g),
		gated(incEdge("e3", "b", "d", 1), g),
	}, "c")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	const batches = 16
	var wg sync.WaitGroup
	results := make([]error, batches)
	outputs := make([][]Record, batches)
	for i := 0; i < batches; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			outputs[idx], results[idx] = tr.ApplyBatch(context.Background(),
				[]Record{{Schema: "a", Payload: 0}})
		}(i)
	}

	for i := 0; i < batches; i++ {
		g.waitEntered()
	}
	if err := tr.SetTarget("d"); err != nil {
		t.Fatalf("SetTarget: %v", err)
	}
	g.releaseAll()
	wg.Wait()

	for i := 0; i < batches; i++ {
		if results[i] != nil {
			t.Fatalf("batch %d: %v", i, results[i])
		}
		if outputs[i][0].Schema != "c" || outputs[i][0].Payload != 2 {
			t.Fatalf("batch %d = %+v, want old target c payload 2", i, outputs[i])
		}
	}

	out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 0}})
	if err != nil {
		t.Fatalf("post-barrier batch: %v", err)
	}
	if out[0].Schema != "d" {
		t.Fatalf("post-barrier schema = %q, want d", out[0].Schema)
	}
}
