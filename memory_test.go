package q190_test

import (
	"context"
	"sync"
	"testing"

	q190 "example.com/dlks/q190"
)

func TestConcurrentDistinctPacketIDs(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)

	const n = 40
	var wg sync.WaitGroup
	errs := make(chan error, n)
	wg.Add(n)
	for i := 1; i <= n; i++ {
		id := uint16(i)
		go func() {
			defer wg.Done()
			if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); err != nil {
				errs <- err
				return
			}
			pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id})
			if err != nil {
				errs <- err
				return
			}
			if pa.Applied {
				sink.markCommitted()
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	if applied, committed := sink.counts(); applied != n || committed != n {
		t.Fatalf("want %d effects, got applied=%d committed=%d", n, applied, committed)
	}
	if len(store.Completions()) != n {
		t.Fatalf("completions = %d, want %d", len(store.Completions()), n)
	}
}

func TestConcurrentSamePacketIDAppliesOnce(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	const id uint16 = 123

	var wg sync.WaitGroup
	errs := make(chan error, 8)

	// Establish PhasePublished first, so the concurrent duplicate PUBLISHes
	// all race inside one well-defined generation instead of racing a new
	// PUBLISH against PUBREL across phases.
	if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	var publishWG sync.WaitGroup
	for i := 0; i < 7; i++ {
		publishWG.Add(1)
		go func() {
			defer publishWG.Done()
			<-ready
			if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p"), Dup: true}); err != nil {
				errs <- err
			}
		}()
	}
	close(ready)
	publishWG.Wait()

	pubrelReady := make(chan struct{})
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-pubrelReady
			pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id})
			if err != nil {
				errs <- err
				return
			}
			if pa.Applied {
				sink.markCommitted()
			}
		}()
	}
	close(pubrelReady)

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	rec := mustRecord(t, r, id)
	if rec.Generation != 1 || rec.Phase != q190.PhaseComplete {
		t.Fatalf("unexpected record %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 1 || committed != 1 {
		t.Fatalf("same packet ID must apply exactly once, got applied=%d committed=%d", applied, committed)
	}
}

func TestMemoryTxRollbackAndCommitIdempotence(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()

	tx, err := store.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.PutPublish(q190.Record{PacketID: 1, Generation: 1, Phase: q190.PhasePublished, Payload: []byte("a")}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback after close must be a no-op: %v", err)
	}

	if rec, _ := store.Load(ctx, 1); rec != nil {
		t.Fatalf("rolled-back mutation visible: %+v", rec)
	}

	tx, err = store.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.PutPublish(q190.Record{PacketID: 1, Generation: 1, Phase: q190.PhasePublished, Payload: []byte("b")}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit after commit must be a no-op: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback after commit must be a no-op: %v", err)
	}

	rec, err := store.Load(ctx, 1)
	if err != nil || rec == nil || string(rec.Payload) != "b" {
		t.Fatalf("committed record mismatch: %+v err=%v", rec, err)
	}

	// Stored payloads must be independent of caller slices.
	buf := rec.Payload
	buf[0] = 'X'
	again, _ := store.Load(ctx, 1)
	if string(again.Payload) != "b" {
		t.Fatalf("store payload aliases caller memory: %q", again.Payload)
	}
}

func TestMemorySnapshotCopies(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	r := q190.NewReceiver(store, &countingSink{})
	if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: 4, Payload: []byte("snap")}); err != nil {
		t.Fatal(err)
	}

	snap := store.Snapshot()
	snap[4].Payload[0] = 'Z'
	rec := mustRecord(t, r, 4)
	if string(rec.Payload) != "snap" {
		t.Fatalf("snapshot must be a defensive copy, got %q", rec.Payload)
	}
}

func TestMemoryTxRecordVisibility(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	r := q190.NewReceiver(store, &countingSink{})

	// One committed record visible to a freshly opened transaction.
	if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: 1, Payload: []byte("committed")}); err != nil {
		t.Fatal(err)
	}

	tx, err := store.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := tx.Record(1)
	if err != nil || committed == nil || string(committed.Payload) != "committed" {
		t.Fatalf("committed record not visible: %+v err=%v", committed, err)
	}
	missing, err := tx.Record(2)
	if err != nil || missing != nil {
		t.Fatalf("unknown id should be nil: %+v err=%v", missing, err)
	}

	// A staged record shadows the committed one inside the transaction.
	if err := tx.PutPublish(q190.Record{PacketID: 1, Generation: 2, Phase: q190.PhasePublished, Payload: []byte("staged")}); err != nil {
		t.Fatal(err)
	}
	staged, err := tx.Record(1)
	if err != nil || staged.Generation != 2 || string(staged.Payload) != "staged" {
		t.Fatalf("staged record mismatch: %+v err=%v", staged, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}

	rec := mustRecord(t, r, 1)
	if rec.Generation != 1 || string(rec.Payload) != "committed" {
		t.Fatalf("rollback must restore committed visibility: %+v", rec)
	}
}
